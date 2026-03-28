require('fs');
require("path");
const fs = require("fs");

const { Teams, Users, Matches, Leagues, AllowedLeagues, ChosenSeason, Settings, TeamBonuses, LeagueStatus, TableTips, Playoff, PlayoffTemplates, Transfers, TransferLeagues} = require('./mongoDataAccess');

async function requireLogin(req, res, next) {
    if (!req.session.user) {
        // Buď přesměrovat:
        // return res.redirect('/login');

        // Nebo hezká chybová hláška:
        return res.status(401).send(`
            <!DOCTYPE html>
            <html lang="cs">
            <head>
                <meta charset="UTF-8">
                <title>Přihlášení vyžadováno</title>
                <link rel="icon" href="/images/logo.png">
                <style>
                    body { background-color: #121212; color: white; font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    h1 { color: orangered; }
                    .btn { background: orangered; color: black; padding: 10px 20px; text-decoration: none; font-weight: bold; margin-top: 20px; }
                    .btn:hover { background: white; }
                </style>
            </head>
            <body>
                <img style="width: 400px" src="/images/logo.png" alt="Logo" class="logo-large-margin">
                <h1>Musíš se přihlásit</h1>
                <p>Pro zobrazení této stránky je nutné přihlášení.</p>
                <a href="/auth/login" class="btn">Přejít na přihlášení</a>
            </body>
            </html>
        `);
    }
    next();
}

async function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.role !== 'admin') {
        return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="cs">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Přístup odepřen</title>
                
                <link rel="icon" href="/images/logo.png">
                
                <style>
                    body {
                        background-color: #121212;
                        color: white;
                        font-family: Arial, sans-serif;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        margin: 0;
                    }
                    h1 { color: orangered; }
                    a { color: white; text-decoration: underline; }
                    a:hover { color: orangered; }
                </style>
            </head>
            <body>
                <img style="width: 400px" src="/images/logo.png" alt="Logo" class="logo-large-margin">
                <h1>403 - Přístup odepřen</h1>
                <p>Gratuluji, našel jsi dveře pro Admina. Bohužel na to nemáš klíče ani mozek. Zkus to znova, až vyhraješ v loterii, ty žebráku.</p>
                <p>Zároveň byl zaznamenán pokus o ojebání systému. Tvoje IP adresa byla odeslána na svaz a tvoje stará už ví, že jsi prohrál výplatu. Tady velí mafie, ne ty zmrde.</p>
                <a href="/">Zpět na hlavní stránku</a>
            </body>
            </html>
        `);
    }
    next();
}

async function updateTeamsPoints(currentMatches) {
    let teams;
    try {
        teams = await Teams.findAll();
    } catch (err) {
        return;
    }

    for (const team of teams) {
        if (!team.stats) team.stats = {};
        for (const season of Object.keys(team.stats)) {
            team.stats[season] = {
                points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0
            };
        }
    }

    currentMatches.forEach(match => {
        if (!match.result || typeof match.result.scoreHome !== 'number' || typeof match.result.scoreAway !== 'number') return;
        if (match.isPlayoff) return;

        const season = match.season;
        const r = match.result;
        const ot = !!r.ot;

        const homeTeam = teams.find(t => t.id === match.homeTeamId && t.liga === match.liga);
        const awayTeam = teams.find(t => t.id === match.awayTeamId && t.liga === match.liga);
        if (!homeTeam || !awayTeam) return;

        if (!homeTeam.stats[season]) homeTeam.stats[season] = {points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0};
        if (!awayTeam.stats[season]) awayTeam.stats[season] = {points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0};

        let winner;
        if (r.scoreHome === r.scoreAway) {
            if (ot && (r.overtimeWinner === 'home' || r.overtimeWinner === 'away')) {
                winner = r.overtimeWinner;
            } else {
                return;
            }
        } else {
            winner = r.scoreHome > r.scoreAway ? 'home' : 'away';
        }

        const homeStats = homeTeam.stats[season];
        const awayStats = awayTeam.stats[season];

        if (winner === 'home') {
            if (ot) {
                homeStats.points += 2; homeStats.otWins++;
                awayStats.points += 1; awayStats.otLosses++;
            } else {
                homeStats.points += 3; homeStats.wins++;
                awayStats.losses++;
            }
        } else {
            if (ot) {
                awayStats.points += 2; awayStats.otWins++;
                homeStats.points += 1; homeStats.otLosses++;
            } else {
                awayStats.points += 3; awayStats.wins++;
                homeStats.losses++;
            }
        }
    });

    try {
        // Uložení do MongoDB
        await Teams.replaceAll(teams);
    } catch (err) {
    }
}

async function evaluateAndAssignPoints(liga, season) {
    const matches = await Matches.findAll();
    const users = await Users.findAll();

    for (const user of users) {
        const tipsInSeason = user.tips?.[season]?.[liga] || [];
        let correctPoints = 0;
        let totalRegular = 0;
        let totalPlayoff = 0;

        for (const tip of tipsInSeason) {
            const match = matches.find(m => m.id === tip.matchId);
            // Pokud zápas nemá výsledek nebo vítěze, přeskakujeme
            if (!match?.result || !match.result.winner) continue;

            // ---------------------------------------------------------
            // 1. PLAYOFF BO1 (Jeden zápas)
            // ---------------------------------------------------------
            if (match.isPlayoff && Number(match.bo) === 1) {
                totalPlayoff++;

                const realHome = Number(match.result.scoreHome ?? 0);
                const realAway = Number(match.result.scoreAway ?? 0);

                // Ošetření různých názvů proměnných v datech
                const tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                const tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);

                if (Number.isNaN(tipHome) || Number.isNaN(tipAway)) {
                    continue;
                }

                // Zjistíme "směr" výsledku (1 = výhra domácích, -1 = výhra hostů)
                const realOutcome = Math.sign(realHome - realAway);
                const tipOutcome = Math.sign(tipHome - tipAway);

                // DŮLEŽITÉ: Pokud netrefil vítěze, automaticky 0 bodů a jdeme dál
                if (realOutcome !== tipOutcome) {
                    continue;
                }

                // Pokud trefil vítěze, počítáme přesnost skóre
                if (tipHome === realHome && tipAway === realAway) {
                    correctPoints += 5; // Přesný výsledek
                } else {
                    const delta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);

                    if (delta === 1) correctPoints += 4;
                    else if (delta === 2) correctPoints += 3;
                    else correctPoints += 1; // Delta 3 a více
                }

                continue;
            }

            // ---------------------------------------------------------
            // 2. PLAYOFF BO > 1 (Série na více vítězných map)
            // ---------------------------------------------------------
            if (match.isPlayoff && Number(match.bo) > 1) {
                totalPlayoff++;

                const realWinner = match.result.winner;
                const tipWinner = tip.winner;

                // Pokud netrefil vítěze série, 0 bodů
                if (tipWinner !== realWinner) {
                    continue;
                }

                // Pokud trefil vítěze, zkontrolujeme přesný počet map poraženého
                const realLoserWins = realWinner === "home"
                    ? Number(match.result.scoreAway ?? 0)
                    : Number(match.result.scoreHome ?? 0);

                const tipLoserWins = Number.isFinite(Number(tip.loserWins)) ? Number(tip.loserWins) : -1;

                if (tipLoserWins === realLoserWins) {
                    correctPoints += 3; // Správný vítěz I přesné skóre série
                } else {
                    correctPoints += 1; // Správný vítěz, ale špatné skóre
                }

                continue;
            }

            // ---------------------------------------------------------
            // 3. OBYČEJNÝ ZÁPAS (Regular Season)
            // ---------------------------------------------------------
            if (!match.isPlayoff) {
                totalRegular++;
                if (tip.winner === match.result.winner) {
                    correctPoints += 1;
                }
            }
        }

        // Uložení statistik do objektu uživatele
        if (!user.stats) user.stats = {};
        if (!user.stats[season]) user.stats[season] = {};
        if (!user.stats[season][liga]) user.stats[season][liga] = {};

        user.stats[season][liga].correct = correctPoints;
        user.stats[season][liga].totalRegular = totalRegular;
        user.stats[season][liga].totalPlayoff = totalPlayoff;
    }

    // Zápis do MongoDB
    try {
        await Users.updateAll(users);
    } catch (err) {
    }
}

async function generateSeasonRange(startYear, numberOfSeasons) {
    const seasons = [];
    for (let i = 0; i < numberOfSeasons; i++) {
        const y1 = startYear + i;
        const y2 = y1 + 1;
        const shortY1 = String(y1 % 100).padStart(2, '0');
        const shortY2 = String(y2 % 100).padStart(2, '0');

        seasons.push(`${shortY1}/${shortY2}`);
    }
    return seasons;
}


async function removeTipsForDeletedMatch(matchId) {
    let league = null;
    let season = null;

    try {
        const matches = await Matches.findAll();
        const match = matches.find(m => m.id === matchId);

        if (match) {
            return;
        }

        const usersData = await Users.findAll();

        for (const user of usersData) {
            if (!user.tips) continue;

            for (const [s, leagues] of Object.entries(user.tips)) {
                for (const [l, tips] of Object.entries(leagues)) {
                    if (tips.some(t => t.matchId === matchId)) {
                        season = s;
                        league = l;
                        break;
                    }
                }
                if (season && league) break;
            }
            if (season && league) break;
        }

        if (!season || !league) {
            return;
        }

        let changesMade = false;

        for (const user of usersData) {
            if (
                user.tips &&
                user.tips[season] &&
                user.tips[season][league]
            ) {
                const originalTips = user.tips[season][league];
                const filteredTips = originalTips.filter(tip => tip.matchId !== matchId);

                if (filteredTips.length !== originalTips.length) {
                    user.tips[season][league] = filteredTips;
                    changesMade = true;
                }
            }
        }

        if (changesMade) {
            // Uložení do MongoDB
            await Users.replaceAll(usersData);
        }

    } catch (err) {
    }
}

async function calculateTeamScores(matches, selectedSeason, selectedLiga) {
    const scores = {};

    // 1. Spočítání gólů z reálných zápasů (matches.json)
    matches.forEach(match => {
        const result = match.result;

        if (
            match.season !== selectedSeason ||
            match.liga !== selectedLiga ||
            match.isPlayoff ||
            !result ||
            result.scoreHome == null ||
            result.scoreAway == null
        ) {
            return;
        }

        const homeId = match.homeTeamId;
        const awayId = match.awayTeamId;

        if (!scores[homeId]) scores[homeId] = { gf: 0, ga: 0 };
        if (!scores[awayId]) scores[awayId] = { gf: 0, ga: 0 };

        scores[homeId].gf += result.scoreHome;
        scores[homeId].ga += result.scoreAway;

        scores[awayId].gf += result.scoreAway;
        scores[awayId].ga += result.scoreHome;
    });

    // 2. PŘIDÁNO: Přičtení manuálních gólů z teamBonuses.json
    try {
        const teamBonusData = await TeamBonuses.findAll();
        const leagueBonuses = teamBonusData[selectedSeason]?.[selectedLiga] || {};

        for (const teamId in leagueBonuses) {
            const bonus = leagueBonuses[teamId];
            if (!scores[teamId]) scores[teamId] = { gf: 0, ga: 0 };

            // Ošetříme, pokud jsou bonusy zadané jako objekt (nový formát)
            if (bonus && typeof bonus === 'object') {
                scores[teamId].gf += (bonus.gf || 0); // Vstřelené
                scores[teamId].ga += (bonus.ga || 0); // Obdržené
            }
        }
    } catch (e) {
        // Pokud soubor neexistuje, nic se neděje
    }

    return scores;
}
async function getLeagueZones(leagueObj) {
    if (!leagueObj) return { quarterfinal: 0, playin: 0, relegation: 0 };
    return {
        quarterfinal: Number(leagueObj.quarterfinal || 0),
        playin: Number(leagueObj.playin || 0),
        relegation: Number(leagueObj.relegation || 0)
    };
}

async function getTeamZone(index, totalTeams, cfg) {
    const pos = index + 1;
    if (pos <= cfg.quarterfinal) return "quarterfinal";
    if (pos <= cfg.playin) return "playin";
    if (pos > totalTeams - cfg.relegation) return "relegation";
    return "neutral";
}

/**
 * Calculate clinch statuses for teams in a group.
 * Returns teams with added clinch status properties.
 * This function contains the same logic as generateLeftPanel for consistency.
 */
function calculateClinchStatusesForGroup(
    teamsInGroup,
    leagueObj,
    selectedSeason,
    clinchMode,
    scores
) {
    if (!teamsInGroup || teamsInGroup.length === 0) return [];

    const zoneConfig = { 
        quarterfinal: Number(leagueObj?.quarterfinal || 0),
        playin: Number(leagueObj?.playin || 0),
        relegation: Number(leagueObj?.relegation || 0)
    };

    const sorted = [...teamsInGroup];
    let matchesPerTeam = leagueObj?.isMultigroup 
        ? Math.max(1, teamsInGroup.length - 1) 
        : Math.ceil((leagueObj?.maxMatches * 2) / teamsInGroup.length);

    const qfLimit = zoneConfig.quarterfinal;
    const playinLimit = zoneConfig.playin;
    const relegationLimit = zoneConfig.relegation;
    const totalAdvancing = playinLimit;
    const safeZoneIndex = sorted.length - relegationLimit - 1;

    // Helper to get max potential of teams from a starting index
    const getMaxPotentialOfZone = (fromIndex) => {
        let globalMax = 0;
        if (fromIndex >= sorted.length) return 0;
        for (let i = fromIndex; i < sorted.length; i++) {
            const s = sorted[i].stats?.[selectedSeason] || {};
            const played = (s.wins || 0) + (s.otWins || 0) + (s.otLosses || 0) + (s.losses || 0) + (s.manualGames || 0);
            const remaining = Math.max(0, matchesPerTeam - played);
            const potential = (s.points || 0) + (remaining * 3);
            if (potential > globalMax) globalMax = potential;
        }
        return globalMax;
    };

    const thresholdQF = getMaxPotentialOfZone(qfLimit);
    const thresholdPlayin = getMaxPotentialOfZone(totalAdvancing);
    const safetyPoints = (relegationLimit > 0 && safeZoneIndex >= 0 && sorted.length > safeZoneIndex) 
        ? (sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0) 
        : 0;

    return sorted.map((team, index) => {
        const currentZone = getTeamZone(index, teamsInGroup.length, zoneConfig);
        const stats = team.stats?.[selectedSeason] || {};
        const myPoints = stats.points || 0;
        const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0) + (stats.manualGames || 0);
        const remaining = Math.max(0, matchesPerTeam - played);
        const myMaxPoints = myPoints + (remaining * 3);
        const myTie = stats.tiebreaker || 0;

        let canDrop = false, canRise = false;

        // Check if team below can catch up
        for (let i = index + 1; i < sorted.length; i++) {
            const s = sorted[i].stats?.[selectedSeason] || {};
            const p = (s.wins || 0) + (s.otWins || 0) + (s.otLosses || 0) + (s.losses || 0) + (s.manualGames || 0);
            const rem = Math.max(0, matchesPerTeam - p);
            const chaserMax = (s.points || 0) + (rem * 3);
            const chaserTie = s.tiebreaker || 0;

            if (chaserMax > myPoints) { canDrop = true; break; }
            if (chaserMax === myPoints) {
                if (myTie > 0 && chaserTie > 0 && myTie < chaserTie) continue;
                if (rem > 0 || remaining > 0) { canDrop = true; break; }
            }
        }

        // Check if team above can be caught
        if (index > 0) {
            const leaderStats = sorted[index - 1].stats?.[selectedSeason] || {};
            const leaderPoints = leaderStats.points || 0;
            const leadTie = leaderStats.tiebreaker || 0;

            if (myMaxPoints > leaderPoints) canRise = true;
            else if (myMaxPoints === leaderPoints) {
                if (myTie > 0 && leadTie > 0 && myTie > leadTie) canRise = false;
                else if (remaining > 0) canRise = true;
            }
        }

        const locked = !canDrop && !canRise;
        const thresholdRelegation = (relegationLimit > 0 && safeZoneIndex >= 0 && safeZoneIndex + 1 < sorted.length) 
            ? getMaxPotentialOfZone(safeZoneIndex + 1) 
            : 0;

        let clinchedQF = false, clinchedPlayin = false, clinchedRelegation = false, clinchedNeutral = false;

        if (clinchMode === 'strict') {
            const ptsGatekeeperQF = (qfLimit > 0 && sorted[qfLimit - 1]) 
                ? (sorted[qfLimit - 1].stats?.[selectedSeason]?.points || 0) 
                : 0;
            const ptsGatekeeperPlayin = (totalAdvancing > 0 && sorted[totalAdvancing - 1]) 
                ? (sorted[totalAdvancing - 1].stats?.[selectedSeason]?.points || 0) 
                : 0;
            const ptsGatekeeperSafe = (safeZoneIndex >= 0 && sorted[safeZoneIndex]) 
                ? (sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0) 
                : 0;

            if (locked) {
                if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                else clinchedNeutral = true;
            } else {
                if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;
                if (totalAdvancing > 0 && (myPoints > thresholdPlayin || totalAdvancing >= sorted.length)) {
                    if (qfLimit === 0 || myMaxPoints < ptsGatekeeperQF) clinchedPlayin = true;
                }
                if (relegationLimit === 0 || myPoints > thresholdRelegation) {
                    if (totalAdvancing === 0 || myMaxPoints < ptsGatekeeperPlayin) clinchedNeutral = true;
                }
                if (relegationLimit > 0 && myMaxPoints < ptsGatekeeperSafe) clinchedRelegation = true;
            }
        } else {
            if (locked) {
                if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                else clinchedNeutral = true;
            } else {
                if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;
                if (totalAdvancing > 0 && (myPoints > thresholdPlayin || totalAdvancing >= sorted.length)) clinchedPlayin = true;
                if (relegationLimit > 0 && myPoints > thresholdRelegation) clinchedNeutral = true;
                else if (relegationLimit === 0) clinchedNeutral = true;
                if (relegationLimit > 0 && index > safeZoneIndex && myMaxPoints < safetyPoints) clinchedRelegation = true;
            }
        }

        const teamStats = scores[team.id] || { gf: 0, ga: 0 };
        const goalDiff = teamStats.gf - teamStats.ga;

        return {
            ...team,
            _clinchStatus: {
                currentZone,
                locked,
                clinchedQF,
                clinchedPlayin,
                clinchedRelegation,
                clinchedNeutral,
                matchesPlayed: played,
                goalDiff,
                gf: teamStats.gf,
                ga: teamStats.ga
            }
        };
    });
}

async function renameLeagueGlobal(oldName, newName) {
    // 1. ALLOWEDLEAGUES (MongoDB)
    try {
        const allowed = await AllowedLeagues.findAll();
        const index = allowed.indexOf(oldName);
        if (index !== -1) {
            allowed[index] = newName;
            await AllowedLeagues.replaceAll(allowed);
        }
    } catch (e) { }

    // 2. LEAGUES (MongoDB)
    try {
        const leaguesData = await Leagues.findAll();
        let leaguesChanged = false;

        Object.keys(leaguesData).forEach(seasonKey => {
            const seasonObj = leaguesData[seasonKey];
            if (seasonObj && Array.isArray(seasonObj.leagues)) {
                const leagueToUpdate = seasonObj.leagues.find(l => l.name === oldName);
                if (leagueToUpdate) {
                    leagueToUpdate.name = newName;
                    leaguesChanged = true;
                }
            }
        });

        if (leaguesChanged) {
            await Leagues.replaceAll(leaguesData);
        }
    } catch (e) { }

    // 3. TEAMS (MongoDB)
    try {
        const teams = await Teams.findAll();
        let count = 0;
        teams.forEach(t => {
            if (t.liga === oldName) {
                t.liga = newName;
                count++;
            }
        });
        if (count > 0) {
            await Teams.replaceAll(teams);
        }
    } catch (e) { }

    // 4. MATCHES (MongoDB)
    try {
        const matches = await Matches.findAll();
        let count = 0;
        matches.forEach(m => {
            if (m.liga === oldName) { m.liga = newName; count++; }
        });
        if (count > 0) {
            await Matches.replaceAll(matches);
        }
    } catch (e) { }

    // 5. PLAYOFF (MongoDB)
    try {
        const playoffData = await Playoff.findAll();
        if (playoffData && typeof playoffData === 'object') {
            let changed = false;
            const updatePlayoffData = (obj) => {
                Object.keys(obj).forEach(key => {
                    if (typeof obj[key] === 'object' && obj[key] !== null) {
                        updatePlayoffData(obj[key]);
                    } else if (typeof obj[key] === 'string' && obj[key] === oldName) {
                        obj[key] = newName;
                        changed = true;
                    }
                });
            };
            updatePlayoffData(playoffData);
            if (changed) {
                await Playoff.replaceAll(playoffData);
            }
        }
    } catch (e) { }

    // 6. USERS (MongoDB) - Statistiky
    try {
        const users = await Users.findAll();
        let usersUpdated = 0;

        users.forEach(user => {
            if (!user.stats) return;

            Object.keys(user.stats).forEach(season => {
                const seasonStats = user.stats[season];
                if (seasonStats && seasonStats.hasOwnProperty(oldName)) {
                    seasonStats[newName] = seasonStats[oldName];
                    delete seasonStats[oldName];
                    usersUpdated++;
                }
            });
        });

        if (usersUpdated > 0) {
            await Users.updateAll(users);
        }
    } catch (e) { }
}

async function evaluateRegularSeasonTable(season, liga, groupKey = null, isForLeftPanel = false) {
    // Pokud je specifická skupina a NENÍ pro levý panel, kontrolujeme její zamčení
    if (groupKey && !isForLeftPanel) {
        const statusData = await getLeagueStatusData();
        const isTipsLocked = statusData?.[season]?.[liga]?.tableTipsLocked;
        const isGroupLocked = (isTipsLocked === true) || (Array.isArray(isTipsLocked) && isTipsLocked.includes(groupKey));
        
        // Pokud je skupina ODEMCENÁ a není pro levý panel, nevyhodnocujeme (může se tipovat)
        if (!isGroupLocked) {
            return;
        }
        // Zamčené skupiny se vyhodnocují
    } else if (!isForLeftPanel) {
        // Pokud je voláno pro celou ligu a NENÍ pro levý panel, vyhodnocujeme pouze zamčené skupiny
        const statusData = await getLeagueStatusData();
        const isTipsLocked = statusData?.[season]?.[liga]?.tableTipsLocked;
        
        // Pokud je vše zamčené, vyhodnocujeme celou ligu
        if (isTipsLocked === true) {
            // Pokračujeme s vyhodnocováním celé ligy
        } else if (Array.isArray(isTipsLocked)) {
            // Pokud jsou zamčené jen některé skupiny, vyhodnocujeme jen tyto skupiny
            // Musíme upravit logiku pro multiligy
            const allSeasonData = await Leagues.findAll();
            const isMultigroup = allSeasonData[season]?.leagues.find(l => l.name === liga)?.isMultigroup || false;
            
            if (isMultigroup) {
                // Pro multiligy vyhodnocujeme jen zamčené skupiny
                // Pokud nejsou žádné zamčené skupiny, nevyhodnocujeme
                if (isTipsLocked.length === 0) {
                    return;
                }
                // Pro teď vyhodnotíme jen pokud je něco zamčené
            }
        } else {
            // Nic není zamčené, nevyhodnocujeme
            return;
        }
    }
    
    // 1. Načtení dat
    const matches = await Matches.findAll();
    const teams = (await Teams.findAll()).filter(t => t.active && t.liga === liga);
    const users = await Users.findAll();
    const allSeasonData = await Leagues.findAll();
    const isMultigroup = allSeasonData[season]?.leagues.find(l => l.name === liga)?.isMultigroup || false;

    let tableTips = {};
    try { tableTips = await TableTips.findAll(); } catch (e) {}

    // Načtení stavu zámků
    let statusData = {};
    try { statusData = await LeagueStatus.findAll(); } catch (e) {}
    const isTipsLocked = statusData?.[season]?.[liga]?.tableTipsLocked || false;

    // 2. Výpočet skóre a reálných bodů
    const scores = {};
    teams.forEach(t => scores[t.id] = { points: 0, gf: 0, ga: 0 });

    matches.filter(m => m.season === season && m.liga === liga && m.result && !m.isPlayoff).forEach(m => {
        const homeId = m.homeTeamId;
        const awayId = m.awayTeamId;
        if(scores[homeId] && scores[awayId]) {
            const sH = parseInt(m.result.scoreHome);
            const sA = parseInt(m.result.scoreAway);
            scores[homeId].gf += sH; scores[homeId].ga += sA;
            scores[awayId].gf += sA; scores[awayId].ga += sH;

            if (m.result.ot) {
                if (sH > sA) { scores[homeId].points += 2; scores[awayId].points += 1; }
                else { scores[awayId].points += 2; scores[homeId].points += 1; }
            } else {
                if (sH > sA) scores[homeId].points += 3;
                else if (sA > sH) scores[awayId].points += 3;
                else { scores[homeId].points += 1; scores[awayId].points += 1; }
            }
        }
    });

    // Započítání manuálních bodů/bonusů + tiebreakerů
    try {
        const teamBonusData = await TeamBonuses.findAll();
        const leagueBonuses = teamBonusData[season]?.[liga] || {};
        for (const teamId in leagueBonuses) {
            const bonus = leagueBonuses[teamId];
            if (scores[teamId]) {
                if (bonus && typeof bonus === 'object') {
                    scores[teamId].points += (bonus.points || 0);
                    scores[teamId].gf += (bonus.gf || 0);
                    scores[teamId].ga += (bonus.ga || 0);

                    const teamRef = teams.find(t => t.id === Number(teamId) || t.id === String(teamId));
                    if (teamRef) {
                        if(!teamRef.stats) teamRef.stats = {};
                        if(!teamRef.stats[season]) teamRef.stats[season] = {};
                        teamRef.stats[season].tiebreaker = bonus.tiebreaker || 0;
                    }
                } else if (typeof bonus === 'number') {
                    scores[teamId].points += bonus;
                }
            }
        }
    } catch(e) {}

    // Naplnění bodů přímo do týmů (aby fungoval IIHF sort)
    teams.forEach(t => {
        if(!t.stats) t.stats = {};
        if(!t.stats[season]) t.stats[season] = {};
        t.stats[season].points = scores[t.id].points;
    });

    // Rozřazení do skupin pro backend
    const groupedTeamsReal = {};
    teams.forEach(t => {
        const gKey = isMultigroup ? String(t.group || 1) : "default";
        if (!groupedTeamsReal[gKey]) groupedTeamsReal[gKey] = [];
        groupedTeamsReal[gKey].push(t);
    });

    // 3. SEŘAZENÍ PODLE SPRÁVNÝCH IIHF PRAVIDEL (Vloženo z tvého frontendu)
    const globalRealRankMap = {};

    Object.keys(groupedTeamsReal).forEach(gKey => {
        const teamsInGroup = groupedTeamsReal[gKey];

        teamsInGroup.sort((a, b) => {
            const aStats = a.stats?.[season] || {};
            const bStats = b.stats?.[season] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;

            if (pB !== pA) return pB - pA; // 1. Body

            const tieA = aStats.tiebreaker || 0;
            const tieB = bStats.tiebreaker || 0;
            if (tieB !== tieA) return tieA - tieB; // Manuální Tiebreaker

            const tiedTeamIds = teamsInGroup
                .filter(t => (t.stats?.[season]?.points || 0) === pA)
                .map(t => Number(t.id));

            const getMiniStats = (teamId) => {
                let mPts = 0, mDiff = 0, mGF = 0;
                const groupMatches = matches.filter(m =>
                    m.season === season &&
                    m.liga === liga &&
                    m.result &&
                    !m.isPlayoff &&
                    tiedTeamIds.includes(Number(m.homeTeamId)) &&
                    tiedTeamIds.includes(Number(m.awayTeamId)) &&
                    (Number(m.homeTeamId) === teamId || Number(m.awayTeamId) === teamId)
                );

                groupMatches.forEach(m => {
                    const isHome = Number(m.homeTeamId) === teamId;
                    let sH = m.result?.scoreHome !== undefined ? Number(m.result.scoreHome) : (m.scoreHome !== undefined ? Number(m.scoreHome) : 0);
                    let sA = m.result?.scoreAway !== undefined ? Number(m.result.scoreAway) : (m.scoreAway !== undefined ? Number(m.scoreAway) : 0);
                    const isOt = m.result?.ot || m.ot;

                    let hPts, aPts;
                    if (sH > sA) { hPts = isOt ? 2 : 3; aPts = isOt ? 1 : 0; }
                    else if (sA > sH) { aPts = isOt ? 2 : 3; hPts = isOt ? 1 : 0; }
                    else { hPts = 1; aPts = 1; }

                    let pts, gf, ga;
                    if (isHome) { pts = hPts; gf = sH; ga = sA; }
                    else { pts = aPts; gf = sA; ga = sH; }

                    mPts += pts; mDiff += (gf - ga); mGF += gf;
                });
                return {pts: mPts, diff: mDiff, gf: mGF};
            };

            const msA = getMiniStats(Number(a.id));
            const msB = getMiniStats(Number(b.id));

            if (msB.pts !== msA.pts) return msB.pts - msA.pts; // 2. Body v minitabulce
            if (msB.diff !== msA.diff) return msB.diff - msA.diff; // 3. Rozdíl skóre minitab.
            if (msB.gf !== msA.gf) return msB.gf - msA.gf; // 4. Vstřelené góly minitab.

            const directMatch = matches.find(m =>
                m.season === season && m.liga === liga && m.result && !m.isPlayoff &&
                ((Number(m.homeTeamId) === Number(a.id) && Number(m.awayTeamId) === Number(b.id)) ||
                    (Number(m.homeTeamId) === Number(b.id) && Number(m.awayTeamId) === Number(a.id)))
            );

            if (directMatch) {
                const isAHome = Number(directMatch.homeTeamId) === Number(a.id);
                let sH = directMatch.result?.scoreHome ?? directMatch.scoreHome ?? 0;
                let sA = directMatch.result?.scoreAway ?? directMatch.scoreAway ?? 0;

                if (isAHome) { if (sH > sA) return -1; if (sA > sH) return 1; }
                else { if (sA > sH) return -1; if (sH > sA) return 1; }
            }

            const sA_overall = scores[a.id] || {gf: 0, ga: 0};
            const sB_overall = scores[b.id] || {gf: 0, ga: 0};
            const diffA = sA_overall.gf - sA_overall.ga;
            const diffB = sB_overall.gf - sB_overall.ga;
            if (diffA !== diffB) return diffB - diffA; // 5. Celkové skóre

            return 0;
        });

        // Uložení reálného pořadí
        teamsInGroup.forEach((t, i) => {
            globalRealRankMap[t.id] = i + 1;
        });
    });

    // 4. VYHODNOCENÍ UŽIVATELŮ VŮČI IIHF POŘADÍ
    // 4. VYHODNOCENÍ UŽIVATELŮ VŮČI IIHF POŘADÍ
    users.forEach(user => {
        if (!user.stats) user.stats = {};
        if (!user.stats[season]) user.stats[season] = {};
        if (!user.stats[season][liga]) user.stats[season][liga] = {};

        // KONTROLA ZÁMKU: Pokud není zamčeno nic, vynulujeme body a jdeme dál
        if (isTipsLocked === false || (Array.isArray(isTipsLocked) && isTipsLocked.length === 0)) {
            user.stats[season][liga].tableCorrect = 0;
            user.stats[season][liga].tableDeviation = 0;
            return;
        }

        let userTipData = tableTips?.[season]?.[liga]?.[user.username];

        // Pokud uživatel nemá vůbec žádné tipy
        if (!userTipData) {
            user.stats[season][liga].tableCorrect = 0;
            user.stats[season][liga].tableDeviation = 0;
            return;
        }

        // --- KONTROLA KOMPLETNOSTI TIPU ---
        // Zjistíme, jestli natipoval VŠECHNY dostupné skupiny a všechny týmy v nich
        const requiredGroups = Object.keys(groupedTeamsReal);
        let hasAllTips = true;

        if (Array.isArray(userTipData)) {
            // Zpětná kompatibilita (starý formát s jednou skupinou)
            if (requiredGroups.length > 1) {
                hasAllTips = false;
            } else {
                userTipData = { "default": userTipData };
            }
        } else {
            // Multigroup / Nový objektový formát
            for (const gKey of requiredGroups) {
                if (!userTipData[gKey] || userTipData[gKey].length === 0 || userTipData[gKey].length !== groupedTeamsReal[gKey].length) {
                    hasAllTips = false;
                    break;
                }
            }
        }

        // Pokud mu chybí byť jen jedna skupina z multiligy nebo nemá seřazené všechny týmy, NEHODNOTÍME HO.
        if (!hasAllTips) {
            user.stats[season][liga].tableCorrect = 0;
            user.stats[season][liga].tableDeviation = 0;
            return;
        }

        let totalCorrect = 0;
        let totalDeviation = 0;

        Object.keys(groupedTeamsReal).forEach(gKey => {
            // Zkontrolujeme, jestli je zrovna TATO skupina zamčená (počítáme odchylku jen z uzamčených)
            const isGroupLocked = isTipsLocked === true || (Array.isArray(isTipsLocked) && isTipsLocked.includes(gKey));

            if (!isGroupLocked) return;

            const userGroupTip = userTipData[gKey] || [];
            const realTeamsInGroup = groupedTeamsReal[gKey];

            realTeamsInGroup.forEach((realTeam) => {
                const realRank = globalRealRankMap[realTeam.id];
                const userIndexNum = userGroupTip.indexOf(Number(realTeam.id));
                const userIndexStr = userGroupTip.indexOf(String(realTeam.id));
                const finalUserIndex = userIndexNum !== -1 ? userIndexNum : userIndexStr;

                if (finalUserIndex !== -1) {
                    const diff = Math.abs((finalUserIndex + 1) - realRank);
                    if (diff === 0) {
                        totalCorrect++;
                    } else {
                        totalDeviation += diff;
                    }
                } else {
                    totalDeviation += realTeamsInGroup.length; // Pro jistotu, i když to chytí hasAllTips
                }
            });
        });

        user.stats[season][liga].tableCorrect = totalCorrect;
        user.stats[season][liga].tableDeviation = totalDeviation;
    });

    // Uložení do MongoDB
    try {
        await Users.updateAll(users);
    } catch (err) {
    }
}

async function renderErrorHtml(res, message, code = 500) {
    res.status(code).send(`
        <!DOCTYPE html>
        <html lang="cs">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Chyba ${code}</title>
            <link rel="icon" href="/images/logo.png">
            <style>
                body { background-color: #121212; color: white; font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
                h1 { color: orangered; margin-bottom: 20px; }
                p { font-size: 1.2em; color: #ccc; margin-bottom: 30px; }
                a { color: white; text-decoration: none; border: 1px solid orangered; padding: 10px 20px; transition: 0.3s; }
                a:hover { background-color: orangered; color: black; }
                .logo { width: 80px; margin-bottom: 20px; }
            </style>
        </head>
        <body>
            <img src="/images/logo.png" alt="Logo" class="logo">
            <h1>Jejda, chyba ${code}</h1>
            <p>${message}</p>
            <a href="javascript:history.back()">Zpět</a>
        </body>
        </html>
    `);
}

async function getTableMode(req, isRegularSeasonFinished) {
    // 1. Priorita: Co je v URL (pokud uživatel klikne na tlačítko)
    if (req.query.tableMode === 'regular' || req.query.tableMode === 'playoff') {
        return req.query.tableMode;
    }

    // 2. Default: Pokud v URL nic není, rozhodne stav ligy (hotovo -> playoff, probíhá -> regular)
    return isRegularSeasonFinished ? 'playoff' : 'regular';
}
// --- POMOCNÉ ČTECÍ FUNKCE (Vlož nahoru do fileUtils.js) ---
async function getChosenSeason() {
    try { return await ChosenSeason.findAll(); } catch (e) { return "Neurčeno"; }
}
async function loadTeams() {
    try { return await Teams.findAll(); } catch (e) { return []; }
}
async function getMatches() {
    try { return await Matches.findAll(); } catch (e) { return []; }
}
async function getAllowedLeagues() {
    try { return await AllowedLeagues.findAll(); } catch (e) { return []; }
}
async function getLeaguesData() {
    try { return await Leagues.findAll(); } catch (e) { return {}; }
}
async function getSettingsData() {
    try { return await Settings.findAll(); } catch (e) { return {}; }
}
async function getLeagueStatusData() {
    try { return await LeagueStatus.findAll(); } catch (e) { return {}; }
}
async function getTeamBonusesData() {
    try { return await TeamBonuses.findAll(); } catch (e) { return {}; }
}
async function getTableTipsData() {
    try { return await TableTips.findAll(); } catch (e) { return {}; }
}
async function getUsersData() {
    try { return await Users.findAll(); } catch (e) { return []; }
}
async function getPlayoffData() {
    try { return await Playoff.findAll(); } catch (e) { return {}; }
}
async function getTransfersData() {
    try { return await Transfers.findAll(); } catch (e) { return {}; }
}
async function getActiveTransferLeagues() {
    try { return await TransferLeagues.findAll(); } catch (e) { return []; }
}
const getGroupDisplayLabel = (gKey) => {
    if (gKey === 'default') return '';
    const num = parseInt(gKey);
    return `Skupina ${String.fromCharCode(64 + num)}`;
};

async function prepareDashboardData(req, isHistory = false, isImageExporter = false) {
    const username = req.session ? req.session.user : null;

    // 1. Zjištění sezóny (pokud jsme v historii, bereme z URL, jinak globální)
    let selectedSeason = await getChosenSeason();
    if (isHistory && req.query.season) {
        selectedSeason = req.query.season;
    }

    // 2. Načtení základních dat
    const teams = (await loadTeams()).filter(t => t.active);
    
    const matches = await getMatches();
    
    const allowedLeagues = await getAllowedLeagues();
    const allSeasonData = await getLeaguesData();
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];

    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];

    const uniqueLeagues = isHistory || isImageExporter
        ? allLeagues
        : allLeagues.filter(l => allowedLeagues.includes(l));

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga)
        ? req.query.liga
        : (uniqueLeagues[0] || "Neurčeno");

    const teamsInSelectedLiga = teams.filter(t => 
    t.liga === selectedLiga || 
    t.liga === selectedLiga.trim() ||
    t.liga.toLowerCase() === selectedLiga.toLowerCase()
);

    const leagueObj = leagues.find(l => l.name === selectedLiga) || {
        name: selectedLiga || "Neznámá liga",
        maxMatches: 0, quarterfinal: 0, playin: 0, relegation: 0, isMultigroup: false
    };

    // 3. Stavy a Módy (Kaskáda / Striktní a Základní / Playoff)
    let clinchMode = 'strict';
    try {
        const settingsData = await getSettingsData();
        if (settingsData.clinchMode) clinchMode = settingsData.clinchMode;
    } catch (e) {}

    if (req.query.mode === 'strict' || req.query.mode === 'cascade') {
        if (req.session) req.session.userClinchMode = req.query.mode;
    }
    if (req.session && req.session.userClinchMode) clinchMode = req.session.userClinchMode;

    let isRegularSeasonFinished = false;
    let isTipsLocked = false;
    try {
        const statusData = await getLeagueStatusData();
        isRegularSeasonFinished = statusData?.[selectedSeason]?.[selectedLiga]?.regularSeasonFinished || false;
        isTipsLocked = statusData?.[selectedSeason]?.[selectedLiga]?.tableTipsLocked || false;
    } catch (e) {}

    const tableMode = await getTableMode(req, isRegularSeasonFinished);

    // 4. Výpočet bodů a bonusů
    // Původní logika - výpočet jen pro plně zamčené ligy
    
    let scores = {};
    
    if (!isTipsLocked || (Array.isArray(isTipsLocked) && isTipsLocked.length === 0)) {
        // Nic není zamčené - žádný výpočet
    } else if (Array.isArray(isTipsLocked)) {
        // Částečně zamčené skupiny - žádný výpočet
        scores = {};
    } else {
        // Vše je zamčené - výpočet skóre
        scores = await calculateTeamScores(matches, selectedSeason, selectedLiga);
    }
    let teamBonusData = {};
    try { 
        teamBonusData = await getTeamBonusesData(); 
    } catch (e) {}

    teamsInSelectedLiga.forEach(t => {
        if (!t.stats) t.stats = {};
        if (!t.stats[selectedSeason]) t.stats[selectedSeason] = { points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0 };

        let naturalPoints = t.stats[selectedSeason].points || 0;
        let bonusEntry = teamBonusData[selectedSeason]?.[selectedLiga]?.[t.id] || { points: 0, games: 0 };
        if (typeof bonusEntry === 'number') bonusEntry = { points: bonusEntry, games: 0 };

        // Původní logika - jen pro plně zamčené ligy
        if (!Array.isArray(isTipsLocked)) {
            t.stats[selectedSeason].points = naturalPoints + (bonusEntry.points || 0);
        }
        // Pro částečně zamčené - zachováme původní body (pro tipování)
        
        t.stats[selectedSeason].manualGames = bonusEntry.games || 0;
        t.stats[selectedSeason].tiebreaker = bonusEntry.tiebreaker || 0;
    });

    // 5. Rozdělení do skupin
    const teamsByGroup = {};
    const groupedTeams = {};

    teamsInSelectedLiga.forEach((team) => {
        const groupLetter = team.group ? String.fromCharCode(team.group + 64) : 'X';
        if (!teamsByGroup[groupLetter]) teamsByGroup[groupLetter] = [];
        teamsByGroup[groupLetter].push(team);

        let gKey = "default";
        if (leagueObj.isMultigroup) gKey = String(team.group || 1);
        if (!groupedTeams[gKey]) groupedTeams[gKey] = [];
        groupedTeams[gKey].push(team);
    });

    const sortedGroups = Object.keys(teamsByGroup).sort();
    const sortedGroupKeys = Object.keys(groupedTeams).sort((a, b) => a === 'default' ? -1 : parseInt(a) - parseInt(b));

    // 6. IIHF Řazení (Záchrana stovek řádků!)
    const globalRealRankMap = {};
    
    // Kontrola zamčení - pro levý panel vždy seřadíme pro přehled
    // Lockování se týká POUZE pravého panelu (tipování)
    for (const group of sortedGroups) {
        // Levý panel vždy seřadí pro přehled reálného stavu
        // ŽÁDNÁ PODMÍNKA - vždy seřadíme
        
        teamsByGroup[group].sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;

            if (pB !== pA) return pB - pA;
            const tieA = aStats.tiebreaker || 0;
            const tieB = bStats.tiebreaker || 0;
            if (tieB !== tieA) return tieA - tieB;

            const tiedTeamIds = teamsByGroup[group].filter(t => (t.stats?.[selectedSeason]?.points || 0) === pA).map(t => Number(t.id));

            const getMiniStats = (teamId) => {
                let mPts = 0, mDiff = 0, mGF = 0;
                const groupMatches = matches.filter(m =>
                    m.season === selectedSeason && m.result && !m.isPlayoff &&
                    tiedTeamIds.includes(Number(m.homeTeamId)) && tiedTeamIds.includes(Number(m.awayTeamId)) &&
                    (Number(m.homeTeamId) === teamId || Number(m.awayTeamId) === teamId)
                );
                groupMatches.forEach(m => {
                    const isHome = Number(m.homeTeamId) === teamId;
                    let sH = m.result?.scoreHome !== undefined ? Number(m.result.scoreHome) : (m.scoreHome !== undefined ? Number(m.scoreHome) : 0);
                    let sA = m.result?.scoreAway !== undefined ? Number(m.result.scoreAway) : (m.scoreAway !== undefined ? Number(m.scoreAway) : 0);
                    const isOt = m.result?.ot || m.ot;
                    let hPts, aPts;
                    if (sH > sA) { hPts = isOt ? 2 : 3; aPts = isOt ? 1 : 0; }
                    else if (sA > sH) { aPts = isOt ? 2 : 3; hPts = isOt ? 1 : 0; }
                    else { hPts=1; aPts=1; }
                    if (isHome) { mPts += hPts; mDiff += (sH - sA); mGF += sH; }
                    else { mPts += aPts; mDiff += (sA - sH); mGF += sA; }
                });
                return { pts: mPts, diff: mDiff, gf: mGF };
            };

            const msA = getMiniStats(Number(a.id));
            const msB = getMiniStats(Number(b.id));

            if (msB.pts !== msA.pts) return msB.pts - msA.pts;
            if (msB.diff !== msA.diff) return msB.diff - msA.diff;
            if (msB.gf !== msA.gf) return msB.gf - msA.gf;

            const directMatch = matches.find(m =>
                m.season === selectedSeason && m.result && !m.isPlayoff &&
                ((Number(m.homeTeamId) === Number(a.id) && Number(m.awayTeamId) === Number(b.id)) ||
                    (Number(m.homeTeamId) === Number(b.id) && Number(m.awayTeamId) === Number(a.id)))
            );

            if (directMatch) {
                const isAHome = Number(directMatch.homeTeamId) === Number(a.id);
                let sH = directMatch.result?.scoreHome ?? directMatch.scoreHome ?? 0;
                let sA = directMatch.result?.scoreAway ?? directMatch.scoreAway ?? 0;
                if (isAHome) { if (sH > sA) return -1; if (sA > sH) return 1; }
                else { if (sA > sH) return -1; if (sH > sA) return 1; }
            }

            const sA = scores[a.id] || {gf:0, ga:0};
            const sB = scores[b.id] || {gf:0, ga:0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;

            return 0;
        });

        // Uložení pořadí pro křížové tabulky
        teamsByGroup[group].forEach((t, i) => globalRealRankMap[t.id] = i + 1);
    }

    // 7. Statistiky uživatelů a Playoff
    let tableTips = {};
    try { tableTips = await getTableTipsData(); } catch (e) {}

    let allUsers = [];
    try { allUsers = await getUsersData(); } catch (e) {}

    const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);

    const userStats = allUsers.filter(u => {
        // 1. Skryjeme Admina (pro jistotu ošetříme i velká/malá písmena)
        if (!u.username || u.username.toLowerCase() === "admin") return false;

        const seasonStats = u.stats?.[selectedSeason]?.[selectedLiga] || {};
        const seasonTips = u.tips?.[selectedSeason]?.[selectedLiga];
        const tableTip = tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username];

        // 2. Kontrola, jestli má uložené tipy na zápasy (ověříme, že je to pole a není prázdné)
        const hasMatchTips = Array.isArray(seasonTips) && seasonTips.length > 0;

        // 3. Kontrola, jestli má uložený tip tabulky v databázi (stačí, že objekt existuje)
        const hasTableTip = tableTip !== undefined && tableTip !== null;

        // 4. Kontrola historie (pokud už mu v této lize backend někdy vyhodnotil zápas)
        const hasPlayedMatches = (seasonStats.totalRegular || 0) > 0 || (seasonStats.totalPlayoff || 0) > 0;

        // Pokud platí alespoň jedna podmínka, uživatel ligu prokazatelně hraje. Jinak ho vyškrtneme.
        return hasMatchTips || hasTableTip || hasPlayedMatches;
    }).map(u => {
        const stats = u.stats?.[selectedSeason]?.[selectedLiga] || {};
        const userTips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
        
        // KONTROLA ZÁMKU: Pokud liga není zamčená, ignorujeme data z databáze a ukážeme 0
        let tCorrect = 0;
        let tDeviation = 0;
        
        if (isTipsLocked === true || (Array.isArray(isTipsLocked) && isTipsLocked.length > 0)) {
            // Jen pokud je něco zamčené, načteme data z databáze
            tCorrect = stats.tableCorrect || 0;
            tDeviation = stats.tableDeviation || 0;
        }
        // Pokud nic není zamčené, zůstává tCorrect = 0 a tDeviation = 0

        if (tCorrect === 0 && tDeviation === 0) {
            // Vyhodnocujeme "za letu" POUZE pokud je z adminu zamčeno
            const isGloballyLocked = isTipsLocked === true;
            const hasLockedGroups = Array.isArray(isTipsLocked) && isTipsLocked.length > 0;

            if (isGloballyLocked || hasLockedGroups) {
                const userTableTip = tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username];
                if (userTableTip) {
                    // --- KONTROLA KOMPLETNOSTI TIPU PŘI "ON THE FLY" VÝPOČTU ---
                    let hasAllTips = true;
                    let normalizedTip = userTableTip;

                    if (Array.isArray(userTableTip)) {
                        if (sortedGroupKeys.length > 1) hasAllTips = false;
                        else normalizedTip = { "default": userTableTip };
                    } else {
                        for (const gKey of sortedGroupKeys) {
                            if (!normalizedTip[gKey] || normalizedTip[gKey].length === 0 || normalizedTip[gKey].length !== groupedTeams[gKey].length) {
                                hasAllTips = false; break;
                            }
                        }
                    }

                    if (hasAllTips) {
                        for (const gKey of sortedGroupKeys) {
                            // Vyhodnocujeme jen zamčené skupiny
                            if (isGloballyLocked || (Array.isArray(isTipsLocked) && isTipsLocked.includes(gKey))) {
                                let tipIds = normalizedTip[gKey] || [];
                                tipIds.forEach((tid, idx) => {
                                    const realRank = globalRealRankMap[tid];
                                    if (realRank) {
                                        const diff = Math.abs((idx + 1) - realRank);
                                        tDeviation += diff;
                                        if (diff === 0) tCorrect++;
                                    }
                                });
                            }
                        }
                    }
                }
            }
        }

        const maxFromTips = userTips.reduce((sum, tip) => {
            const match = matchesInLiga.find(m => Number(m.id) === Number(tip.matchId));
            if (!match || !match.result) return sum;
            if (!match.isPlayoff) return sum + 1;
            return sum + (match.bo === 1 ? 5 : 3);
        }, 0);

        const totalPoints = matchesInLiga.reduce((sum, match) => {
            if (!match.result) return sum;
            if (!match.isPlayoff) return sum + 1;
            return sum + (match.bo === 1 ? 5 : 3);
        }, 0);

        return {
            username: u.username, correct: stats.correct || 0, total: totalPoints, maxFromTips: maxFromTips,
            totalRegular: stats.totalRegular || 0, totalPlayoff: stats.totalPlayoff || 0,
            tableCorrect: tCorrect, tableDeviation: tDeviation
        };
    });

    const currentUserStats = userStats.find(u => u.username === username);
    const userTipData = tableTips?.[selectedSeason]?.[selectedLiga]?.[username] || null;
    const currentUserMatchTips = allUsers.find(u => u.username === username)?.tips?.[selectedSeason]?.[selectedLiga] || [];

    let playoffData = {};
    try {
        const allPlayoffs = await getPlayoffData();
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) playoffData = allPlayoffs[selectedSeason][selectedLiga];
    } catch (e) {}

    // --- PŘIDÁNO: Načtení dat pro PŘESTUPY ---
    let activeTransferLeagues = [];
    try { activeTransferLeagues = await getActiveTransferLeagues(); } catch(e) {}

    let transfersData = {};
    try { transfersData = await getTransfersData(); } catch(e) {}
    const currentTransfers = transfersData[selectedSeason]?.[selectedLiga] || {};

    // Všechna "vysátá" data pošleme zpět
    return {
        username, selectedSeason, selectedLiga, uniqueLeagues, teamsInSelectedLiga, matches,
        clinchMode, tableMode, isRegularSeasonFinished, isTipsLocked,
        leagueObj, sortedGroups, teamsByGroup, sortedGroupKeys, groupedTeams,
        globalRealRankMap, userStats, currentUserStats,
        userTipData, currentUserMatchTips, playoffData, scores, allUsers, teams,
        activeTransferLeagues, currentTransfers, tableTips // <-- TOTO JSME PŘIDALI NA KONEC
    };
}

async function generateStatsHtml(username, currentUserStats, userStats, isRegularSeasonFinished) {
    if (!username) return ''; // Pokud není uživatel přihlášený, statistiky se neukazují

    const statusStyle = isRegularSeasonFinished ? "color: lightgrey; font-weight: bold;" : "color: white; opacity: 0.7; background-color: black";

    let html = `
    <section class="user_stats">
        <h2>Tvoje statistiky</h2>
         ${currentUserStats ? `
            <p>Správně tipnuto z maximálního počtu všech vyhodnocených zápasů: 
                <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.total}</strong> 
                (${(currentUserStats.total > 0 ? (currentUserStats.correct / currentUserStats.total * 100).toFixed(2) : '0.00')} %)
            </p>
            ${currentUserStats.total !== currentUserStats.maxFromTips ? `
            <p>Správně tipnuto z tipovaných zápasů: 
                <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.maxFromTips}</strong> 
                (${(currentUserStats.maxFromTips > 0 ? (currentUserStats.correct / currentUserStats.maxFromTips * 100).toFixed(2) : '0.00')} %)
            </p>` : ''}
        ` : `<p>Nemáš pro tuto sezónu/ligu žádná data.</p>`}
        
        ${currentUserStats?.tableCorrect > 0 || currentUserStats?.tableDeviation > 0 ? `
            <hr>
            <h3>Výsledek tipovačky tabulky</h3>
            <p>Správně trefených pozic: <strong>${currentUserStats?.tableCorrect}</strong> (bodů)</p>
            <p>Celková odchylka v umístění: <strong>${currentUserStats?.tableDeviation}</strong> (menší je lepší)</p>
       ` : `<p><em>Tipovačka tabulky zatím nebyla vyhodnocena (nebo nemáš žádné body).</em></p>`}
    </section>
    
    <section class="global_stats">
        <table class="points-table">
            <thead>
                <tr><th scope="col" id="points-table-header" colspan="8"><h2>Statistiky všech</h2></th></tr>
                <tr>
                    <th class="position">Místo</th>
                    <th>Uživatel</th>
                    <th>Úspěšnost</th>
                    <th>Počet bodů</th>
                    <th>Celkem tipů v ZČ</th>
                    <th>Celkem tipů v Playoff</th>
                    <th>Trefené pozice (Tabulka)</th>
                    <th>Odchylka (Tabulka)</th>
                </tr>
            </thead>
            <tbody>`;

    userStats.sort((a, b) => {
        if (b.correct !== a.correct) return b.correct - a.correct;
        if (b.tableCorrect !== a.tableCorrect) return b.tableCorrect - a.tableCorrect;
        return a.tableDeviation - b.tableDeviation;
    }).forEach((user, index) => {
        const successRate = user.total > 0 ? ((user.correct / user.total) * 100).toFixed(2) : '0.00';
        const successRateOverall = user.maxFromTips > 0 ? ((user.correct / user.maxFromTips) * 100).toFixed(2) : '0.00';

        // Zjistíme, jestli byl vůbec uživatel z tabulky hodnocen
        const isTableEvaluated = user.tableCorrect > 0 || user.tableDeviation > 0;

        html += `
            <tr>
                <td>${index + 1}.</td>
                <td>${user.username}</td>
                <td>${successRateOverall}%${user.total !== user.maxFromTips ? ` (${successRate}%)` : ''}</td>
                <td>${user.correct}</td>
                <td>${user.totalRegular}</td>
                <td>${user.totalPlayoff}</td>
                <td style="${statusStyle}">${isTableEvaluated ? user.tableCorrect : '-'}</td>
                <td style="${statusStyle}">${isTableEvaluated ? user.tableDeviation : '-'}</td>
            </tr>`;
    });

    html += `
            </tbody>
        </table>
        <br>
        <table style="color: black; font-size: 12px" class="points-table">
            <tr style="background-color: #00FF00"><td colspan="3">Za správný tip zápasu v základní části</td><td colspan="3">1 bod</td></tr>
            <tr style="background-color: #FF0000"><td colspan="3">Za správný tip vítěze dané série v playoff ale špatný tip počtu vyhraných zápasů</td><td colspan="3">1 bod</td></tr>
            <tr style="background-color: #00FF00"><td colspan="3">Za správný tip vítěze dané série v playoff + počet vyhraných zápasů</td><td colspan="3">3 body</td></tr>
            <tr style="background-color: #00FF00"><td colspan="3">Za správný tip vítěze zápasu v playoff + správné skóre</td><td colspan="3">5 bodů</td></tr>
            <tr style="background-color: #FFFF00"><td colspan="3">Za správný tip vítěze zápasu v playoff + chyba o 1 gól</td><td colspan="3">4 body</td></tr>
            <tr style="background-color: #FF6600"><td colspan="3">Za správný tip vítěze zápasu v playoff + chyba o 2 góly</td><td colspan="3">3 body</td></tr>
            <tr style="background-color: #FF0000"><td colspan="3">Za správný tip vítěze zápasu v playoff + chyba o 3+ gólů</td><td colspan="3">1 bod</td></tr>
            <tr style="background-color: #00FF00"><td colspan="3">Za přesné trefení pozice v konečné tabulce</td><td colspan="3">1 bod</td></tr>
            <tr style="background-color: #ff4500"><td colspan="3">Odchylka tipu tabulky</td><td colspan="3">Sčítá se (čím méně, tím lépe)</td></tr>
        </table>
    </section>`;

    return html;
}

async function generateLeftPanel(data, isHistory = false) {
    const {
        username, selectedSeason, selectedLiga, teamsInSelectedLiga,
        matches, clinchMode, tableMode, isRegularSeasonFinished,
        leagueObj, sortedGroups, teamsByGroup, playoffData, scores,
        currentUserStats, userStats, teams
    } = data;

    let html = `
    <section class="stats-container">
    <div class="left-panel">
    
    <div style="display: flex; flex-direction: row; justify-content: space-around; margin:20px 0; text-align:center;">
        <a href="?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}&mode=${clinchMode}&tableMode=regular" 
           style="cursor: pointer; width: 120px; text-decoration: none; border: none; padding: 10px; ${tableMode === 'regular' ? 'color: black; background-color: orangered;' : 'color: orangered; background-color: black;'}" 
           class="history-btn">
           Základní část
        </a>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}&mode=${clinchMode}&tableMode=playoff" 
           style="cursor: pointer; width: 120px; text-decoration: none; border: none; padding: 10px; ${tableMode === 'playoff' ? 'color: black; background-color: orangered;' : 'color: orangered; background-color: black;'}" 
           class="history-btn">
           Playoff
        </a>
    </div>

    <div id="regularTable" style="display:${tableMode === 'regular' ? 'block' : 'none'};">
        <div style="display: flex; justify-content: flex-start; align-items: center; margin-bottom: 10px; gap: 10px;">
            <span style="color: gray; font-size: 0.85em;">Logika obarvování:</span>
            <a href="?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}&mode=strict&tableMode=${tableMode}" 
               style="${clinchMode === 'strict' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; text-decoration: none; font-size: 0.85em;">
               Striktní (Jistá meta)
            </a>
            <a href="?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}&mode=cascade&tableMode=${tableMode}" 
               style="${clinchMode === 'cascade' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; text-decoration: none; font-size: 0.85em;">
               Kaskádová (Minimální meta)
            </a>
        </div>
    `;

    const crossGroupTeams = [];
    const zoneConfig = getLeagueZones(leagueObj);

    // ==========================================
    // 1. ZÁKLADNÍ TABULKY (Skupiny)
    // ==========================================
    for (const group of sortedGroups) {
        const teamsInGroup = teamsByGroup[group];
        
        // Levý panel (tabulka základní části) VŽDY zobrazí tabulky
        // Je to přehled reálného stavu, nezávisí na tipování
        // Kontrola zamčení se týká POUZE pravého panelu (tipování)
        // ŽÁDNÁ PODMÍNKA - levý panel vždy zobrazí
        
        // Pro levý panel vždy vyhodnotíme clinching pro přehled
        await evaluateRegularSeasonTable(selectedSeason, selectedLiga, group, true);

        // ULOŽENÍ TÝMU DO CROSS-TABLE
        if (leagueObj.crossGroupTable && leagueObj.crossGroupPosition > 0) {
            const targetIndex = leagueObj.crossGroupPosition - 1;
            if (teamsInGroup[targetIndex]) crossGroupTeams.push(teamsInGroup[targetIndex]);
        }

        html += `
        <table class="points-table">
        <thead>
        <tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část ${leagueObj?.isMultigroup ? `(Skupina ${group})` : ''}</h2></th></tr>
        <tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
        </thead>
        <tbody>`;

        const sorted = teamsInGroup;
        let matchesPerTeam = leagueObj.isMultigroup ? Math.max(1, teamsInGroup.length - 1) : Math.ceil((leagueObj.maxMatches * 2) / teamsInGroup.length);

        const qfLimit = leagueObj.quarterfinal || 0;
        const playinLimit = leagueObj.playin || 0;
        const relegationLimit = leagueObj.relegation || 0;
        const totalAdvancing = playinLimit;
        const safeZoneIndex = sorted.length - relegationLimit - 1;

        const getMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            if (fromIndex >= sorted.length) return 0;
            for (let i = fromIndex; i < sorted.length; i++) {
                const s = sorted[i].stats?.[selectedSeason] || {};
                const played = (s.wins || 0) + (s.otWins || 0) + (s.otLosses || 0) + (s.losses || 0) + (s.manualGames || 0);
                const remaining = Math.max(0, matchesPerTeam - played);
                const potential = (s.points || 0) + (remaining * 3);
                if (potential > globalMax) globalMax = potential;
            }
            return globalMax;
        };

        const thresholdQF = getMaxPotentialOfZone(qfLimit);
        const thresholdPlayin = getMaxPotentialOfZone(totalAdvancing);
        let safetyPoints = (relegationLimit > 0 && safeZoneIndex >= 0 && sorted.length > safeZoneIndex) ? (sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

        teamsInGroup.forEach((team, index) => {
            const currentZone = getTeamZone(index, teamsInGroup.length, zoneConfig);
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0) + (stats.manualGames || 0);
            const remaining = Math.max(0, matchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);
            const myTie = stats.tiebreaker || 0;

            let canDrop = false, canRise = false;

            for (let i = index + 1; i < sorted.length; i++) {
                const s = sorted[i].stats?.[selectedSeason] || {};
                const p = (s.wins || 0) + (s.otWins || 0) + (s.otLosses || 0) + (s.losses || 0) + (s.manualGames || 0);
                const rem = Math.max(0, matchesPerTeam - p);
                const chaserMax = (s.points || 0) + (rem * 3);
                const chaserTie = s.tiebreaker || 0;

                if (chaserMax > myPoints) { canDrop = true; break; }
                if (chaserMax === myPoints) {
                    if (myTie > 0 && chaserTie > 0 && myTie < chaserTie) continue;
                    if (rem > 0 || remaining > 0) { canDrop = true; break; }
                }
            }

            if (index > 0) {
                const leaderStats = sorted[index - 1].stats?.[selectedSeason] || {};
                const leaderPoints = leaderStats.points || 0;
                const leadTie = leaderStats.tiebreaker || 0;

                if (myMaxPoints > leaderPoints) canRise = true;
                else if (myMaxPoints === leaderPoints) {
                    if (myTie > 0 && leadTie > 0 && myTie > leadTie) canRise = false;
                    else if (remaining > 0) canRise = true;
                }
            }

            const locked = !canDrop && !canRise;
            let thresholdRelegation = (relegationLimit > 0 && safeZoneIndex >= 0 && safeZoneIndex + 1 < sorted.length) ? getMaxPotentialOfZone(safeZoneIndex + 1) : 0;

            let clinchedQF = false, clinchedPlayin = false, clinchedRelegation = false, clinchedNeutral = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                const ptsGatekeeperQF = (qfLimit > 0 && sorted[qfLimit - 1]) ? (sorted[qfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperPlayin = (totalAdvancing > 0 && sorted[totalAdvancing - 1]) ? (sorted[totalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperSafe = (safeZoneIndex >= 0 && sorted[safeZoneIndex]) ? (sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;
                    if (totalAdvancing > 0 && (myPoints > thresholdPlayin || totalAdvancing >= sorted.length)) {
                        if (qfLimit === 0 || myMaxPoints < ptsGatekeeperQF) clinchedPlayin = true;
                    }
                    if (relegationLimit === 0 || myPoints > thresholdRelegation) {
                        if (totalAdvancing === 0 || myMaxPoints < ptsGatekeeperPlayin) clinchedNeutral = true;
                    }
                    if (relegationLimit > 0 && myMaxPoints < ptsGatekeeperSafe) clinchedRelegation = true;
                }
            } else {
                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;
                    if (totalAdvancing > 0 && myPoints > thresholdPlayin || totalAdvancing >= sorted.length) clinchedPlayin = true;
                    if (relegationLimit > 0 && myPoints > thresholdRelegation) clinchedNeutral = true;
                    else if (relegationLimit === 0) clinchedNeutral = true;
                    if (relegationLimit > 0 && index > safeZoneIndex && myMaxPoints < safetyPoints) clinchedRelegation = true;
                }
            }

            if (clinchedRelegation) rowClass = 'clinched-relegation';
            else if (clinchedNeutral) rowClass = 'clinched-neutral';
            else if (clinchedPlayin) rowClass = 'clinched-playin';
            else if (clinchedQF) rowClass = 'clinched-quarterfinal';

            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition && locked) rowClass = 'clinched-crosstable';
            if (locked) rowClass += ' locked';

            let rankClass = currentZone;
            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition) rankClass = 'crosstable';

            const teamStats = scores[team.id] || { gf: 0, ga: 0 };
            const goalDiff = teamStats.gf - teamStats.ga;

            html += `<tr class="${rowClass}">
                <td class="rank-cell ${rankClass}">${index + 1}.</td>
                <td>${team.name}</td>
                <td class="points numbers">${myPoints}</td>
                <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
                <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
                <td class="numbers">${played}</td>
                <td class="numbers">${stats.wins || 0}</td>
                <td class="numbers">${stats.otWins || 0}</td>
                <td class="numbers">${stats.otLosses || 0}</td>
                <td class="numbers">${stats.losses || 0}</td>
            </tr>`;
        });
        html += `</tbody></table><br>`;
    }

    // ==========================================
    // 2. CROSS-TABLE (X-té týmy)
    // ==========================================
    if (leagueObj.crossGroupTable && crossGroupTeams.length > 0) {
        const crossConfig = leagueObj.crossGroupConfig || { quarterfinal: 0, playin: 0, relegation: 0 };
        html += `<h2 style="text-align: center; margin-top: 30px; border-top: 2px solid #444; padding-top: 20px;">Tabulka týmů na ${leagueObj.crossGroupPosition}. místě</h2>`;

        crossGroupTeams.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;
            if (pB !== pA) return pB - pA;

            const sA = scores[a.id] || {gf:0, ga:0};
            const sB = scores[b.id] || {gf:0, ga:0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;
            if (sA.gf !== sB.gf) return sB.gf - sA.gf;
            return 0;
        });

        html += `
        <table class="points-table">
        <thead>
        <tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
        </thead>
        <tbody>`;

        const cQfLimit = crossConfig.quarterfinal || 0;
        const cPlayinLimit = crossConfig.playin || 0;
        const cRelLimit = crossConfig.relegation || 0;
        let cTotalAdvancing = cPlayinLimit > 0 ? cPlayinLimit : cQfLimit;
        cTotalAdvancing = Math.min(cTotalAdvancing, crossGroupTeams.length);
        const cSafeZoneIndex = crossGroupTeams.length - cRelLimit - 1;

        let cMatchesPerTeam = 52;
        if (leagueObj.isMultigroup) {
            const estimatedGroupSize = teamsInSelectedLiga.length / (leagueObj.groupCount || 1);
            cMatchesPerTeam = Math.max(1, Math.ceil(estimatedGroupSize) - 1);
        } else if (leagueObj.maxMatches) {
            cMatchesPerTeam = leagueObj.maxMatches > 100 ? Math.ceil((leagueObj.maxMatches * 2) / teamsInSelectedLiga.length) : leagueObj.maxMatches;
        }

        const getCrossTeamPotential = (idx) => {
            if (idx >= crossGroupTeams.length) return 0;
            const t = crossGroupTeams[idx];
            const s = t.stats?.[selectedSeason] || {};
            const played = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
            if (isRegularSeasonFinished) return s.points || 0;
            return (s.points || 0) + (Math.max(0, cMatchesPerTeam - played) * 3);
        };

        const getCrossMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            if (fromIndex >= crossGroupTeams.length) return 0;
            for (let i = fromIndex; i < crossGroupTeams.length; i++) {
                globalMax = Math.max(globalMax, getCrossTeamPotential(i));
            }
            return globalMax;
        };

        let cThresholdQF = (cQfLimit > 0 && cQfLimit < crossGroupTeams.length) ? getCrossMaxPotentialOfZone(cQfLimit) : 0;
        let cThresholdPlayin = (cTotalAdvancing > 0 && cTotalAdvancing < crossGroupTeams.length) ? getCrossMaxPotentialOfZone(cTotalAdvancing) : 0;

        crossGroupTeams.forEach((team, index) => {
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins||0) + (stats.otWins||0) + (stats.otLosses||0) + (stats.losses||0) + (stats.manualGames || 0);
            const remaining = Math.max(0, cMatchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);
            const teamStats = scores[team.id] || {gf:0, ga:0};
            const goalDiff = teamStats.gf - teamStats.ga;

            let currentZone = "neutral";
            if (cRelLimit > 0 && index > cSafeZoneIndex) currentZone = "relegation";
            else if (cQfLimit > 0 && index < cQfLimit) currentZone = "quarterfinal";
            else if (cTotalAdvancing > 0 && index < cTotalAdvancing) currentZone = "playin";

            let canDrop = false;
            for (let i = index + 1; i < crossGroupTeams.length; i++) {
                const chaserMax = getCrossTeamPotential(i);
                if (chaserMax > myPoints) { canDrop = true; break; }
                const chaserPlayed = (crossGroupTeams[i].stats?.[selectedSeason]?.wins||0) + (crossGroupTeams[i].stats?.[selectedSeason]?.losses||0);
                if (chaserMax === myPoints && !isRegularSeasonFinished && (remaining > 0 || chaserPlayed < cMatchesPerTeam)) { canDrop = true; break; }
            }

            let canRise = false;
            if (index > 0) {
                const prevTeamCurrentPoints = crossGroupTeams[index - 1].stats?.[selectedSeason]?.points || 0;
                if (myMaxPoints > prevTeamCurrentPoints) canRise = true;
                if (myMaxPoints === prevTeamCurrentPoints && !isRegularSeasonFinished && remaining > 0) canRise = true;
            }

            const cLocked = !canDrop && !canRise;
            let cThresholdRelegation = (cRelLimit > 0 && cSafeZoneIndex >= 0 && cSafeZoneIndex + 1 < crossGroupTeams.length) ? getCrossMaxPotentialOfZone(cSafeZoneIndex + 1) : 0;

            let cSafeQF = false, cSafePlayin = false, cRelegated = false, cNeutralLocked = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                const cPtsGatekeeperQF = (cQfLimit > 0 && crossGroupTeams[cQfLimit - 1]) ? (crossGroupTeams[cQfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperPlayin = (cTotalAdvancing > 0 && crossGroupTeams[cTotalAdvancing - 1]) ? (crossGroupTeams[cTotalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperSafe = (cSafeZoneIndex >= 0 && crossGroupTeams[cSafeZoneIndex]) ? (crossGroupTeams[cSafeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;
                    if (cTotalAdvancing > 0 && (myPoints > cThresholdPlayin || cTotalAdvancing >= crossGroupTeams.length)) {
                        if (cQfLimit === 0 || myMaxPoints < cPtsGatekeeperQF) cSafePlayin = true;
                    }
                    if (cRelLimit === 0 || myPoints > cThresholdRelegation) {
                        if (cTotalAdvancing === 0 || myMaxPoints < cPtsGatekeeperPlayin) cNeutralLocked = true;
                    }
                    if (cRelLimit > 0 && myMaxPoints < cPtsGatekeeperSafe) cRelegated = true;
                }
            } else {
                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;
                    if (cTotalAdvancing > 0 && myPoints > cThresholdPlayin) cSafePlayin = true;
                    if (cRelLimit > 0 && myPoints > cThresholdRelegation) cNeutralLocked = true;
                    else if (cRelLimit === 0) cNeutralLocked = true;
                    if (cRelLimit > 0 && index > cSafeZoneIndex) {
                        const safetyTarget = crossGroupTeams[cSafeZoneIndex]?.stats?.[selectedSeason]?.points || 0;
                        if (myMaxPoints < safetyTarget) cRelegated = true;
                    }
                }
            }

            if (cRelegated) rowClass = "clinched-relegation";
            else if (cNeutralLocked) rowClass = "clinched-neutral";
            else if (cSafePlayin) rowClass = "clinched-playin";
            else if (cSafeQF) rowClass = "clinched-quarterfinal";

            if (cLocked) rowClass += " locked";

            html += `<tr class="${rowClass}">
                <td class="rank-cell ${currentZone}">${index + 1}.</td>
                <td>${team.name}</td>
                <td class="points numbers">${myPoints}</td>
                <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
                <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
                <td class="numbers">${played}</td>
                <td class="numbers">${stats.wins || 0}</td>
                <td class="numbers">${stats.otWins || 0}</td>
                <td class="numbers">${stats.otLosses || 0}</td>
                <td class="numbers">${stats.losses || 0}</td>
            </tr>`;
        });

        html += `</tbody></table><br>`;
    }

    html += `</div>`; // Ukončení divu regularTable

    // ==========================================
    // 3. PLAYOFF TABULKA (NOVÝ AUTOMATICKÝ PAVOUK)
    // ==========================================
    const format = leagueObj?.playoffFormat || 'none';
    const savedSlots = playoffData || {};

    async function getSeriesInfo(slotKey) {
        const seriesIdStr = savedSlots[slotKey];

        // Pokud admin nevybral hotovou sérii, zjistíme, jestli nenaklikal čekající týmy
        if (!seriesIdStr) {
            const t1 = savedSlots[`${slotKey}_t1`];
            const t2 = savedSlots[`${slotKey}_t2`];
            if (t1 || t2) {
                return {
                    isWaiting: true, // Značka, že jde o čekací mezistav
                    home: t1 || 'TBD',
                    away: t2 || 'TBD',
                    scoreH: '-', scoreA: '-',
                    hWinner: false, aWinner: false
                };
            }
            return null; // Slot je úplně prázdný
        }

        const mId = parseInt(seriesIdStr.replace('series-', ''));
        const match = matches.find(m => m.id === mId);
        if (!match) return null;

        const homeTeam = teams.find(t => t.id === match.homeTeamId) || { name: 'Neznámý' };
        const awayTeam = teams.find(t => t.id === match.awayTeamId) || { name: 'Neznámý' };

        let scoreH = 0; let scoreA = 0;
        if (match.result) {
            scoreH = match.result.scoreHome;
            scoreA = match.result.scoreAway;
        } else if (match.playedMatches && match.playedMatches.length > 0) {
            match.playedMatches.forEach(pm => {
                if (pm.scoreHome > pm.scoreAway) scoreH++;
                else if (pm.scoreAway > pm.scoreHome) scoreA++;
            });
        }

        const winsNeeded = match.bo > 1 ? Math.ceil(match.bo / 2) : 1;
        const hWinner = scoreH >= winsNeeded;
        const aWinner = scoreA >= winsNeeded;

        // Výpočet seedingu (pořadí z tabulky základní části)
        const getTeamSeed = (teamId) => {
            const allTeamsInLiga = teams.filter(t => t.liga === selectedLiga);
            const sortedTeams = allTeamsInLiga.sort((a, b) => {
                const aStats = a.stats?.[selectedSeason] || {};
                const bStats = b.stats?.[selectedSeason] || {};
                return (bStats.points || 0) - (aStats.points || 0);
            });
            const index = sortedTeams.findIndex(t => t.id === teamId);
            return index >= 0 ? index + 1 : null;
        };

        const homeSeed = getTeamSeed(match.homeTeamId);
        const awaySeed = getTeamSeed(match.awayTeamId);

        return {
            isWaiting: false,
            home: homeTeam.name, away: awayTeam.name,
            scoreH, scoreA, hWinner, aWinner,
            bo: match.bo || 1,
            winsNeeded,
            homeSeed, awaySeed
        };
    }

    async function renderBox(slotKey) {
        const info = await getSeriesInfo(slotKey);
        const seriesId = `series-${slotKey}`;

        // Zcela prázdný slot (TBD vs TBD)
        if (!info) {
            return `
            <div class="playoff-series waiting">
                <div class="playoff-series-header">
                    <div class="playoff-series-info">
                        <div class="playoff-status-icon waiting">⏸️</div>
                        <span>Čekání na týmy</span>
                    </div>
                    <div class="playoff-series-score">-</div>
                </div>
                <div class="playoff-series-teams">
                    <div class="playoff-team">
                        <span class="playoff-team-name">TBD</span>
                    </div>
                    <div class="playoff-team">
                        <span class="playoff-team-name">TBD</span>
                    </div>
                </div>
                <div class="playoff-dropdown" id="${seriesId}-dropdown">
                    <div class="playoff-match">
                        <span style="color: #888;">Žádné zápasy</span>
                    </div>
                </div>
            </div>`;
        }

        // Čekající mezistav (např. Sparta vs TBD)
        if (info.isWaiting) {
            return `
            <div class="playoff-series waiting" onclick="togglePlayoffDropdown('${seriesId}')">
                <div class="playoff-series-header">
                    <div class="playoff-series-info">
                        <div class="playoff-status-icon waiting">⏸️</div>
                        <span>Čeká se</span>
                    </div>
                    <div class="playoff-series-score">-</div>
                </div>
                <div class="playoff-series-teams">
                    <div class="playoff-team">
                        <span class="playoff-team-name">${info.home}</span>
                    </div>
                    <div class="playoff-team">
                        <span class="playoff-team-name">${info.away}</span>
                    </div>
                </div>
                <div class="playoff-progress-bar">
                    <div class="playoff-progress-fill" style="width: 0"></div>
                </div>
                <div class="playoff-dropdown" id="${seriesId}-dropdown">
                    <div class="playoff-match">
                        <div class="playoff-match-teams">
                            <span class="playoff-match-team">${info.home}</span>
                            <span>vs</span>
                            <span class="playoff-match-team">${info.away}</span>
                        </div>
                    </div>
                </div>
            </div>`;
        }

        // Klasický vyhodnocovaný zápas (Série)
        const isCompleted = info.hWinner || info.aWinner;
        const isInProgress = !isCompleted && (info.scoreH > 0 || info.scoreA > 0);
        const statusClass = isCompleted ? 'completed' : (isInProgress ? 'in-progress' : 'waiting');
        const statusIcon = isCompleted ? '🔥' : (isInProgress ? '⏳' : '⏸️');
        
        // Progress bar - zapnuto pro BO3 a výše
        const showProgressBar = info.bo > 1;
        const currentWins = Math.max(info.scoreH, info.scoreA);
        const progressPercent = info.winsNeeded > 0 ? (currentWins / info.winsNeeded) * 100 : 0;

        return `
        <div class="playoff-series ${statusClass}" onclick="togglePlayoffDropdown('${seriesId}')">
            <div class="playoff-series-header">
                <div class="playoff-series-info">
                    <div class="playoff-status-icon ${statusClass}">${statusIcon}</div>
                    <span>${isCompleted ? 'Hotovo' : (isInProgress ? 'Probíhá' : 'Čeká')}</span>
                </div>
                <div class="playoff-series-score">${info.scoreH}:${info.scoreA}</div>
            </div>
            <div class="playoff-series-teams">
                <div class="playoff-team ${info.hWinner ? 'winner' : 'loser'}">
                    <span class="playoff-seed">${info.homeSeed ? '#' + info.homeSeed : ''}</span>
                    <span class="playoff-team-name">${info.home}</span>
                </div>
                <div class="playoff-team ${info.aWinner ? 'winner' : 'loser'}">
                    <span class="playoff-seed">${info.awaySeed ? '#' + info.awaySeed : ''}</span>
                    <span class="playoff-team-name">${info.away}</span>
                </div>
            </div>
            ${showProgressBar ? `
            <div class="playoff-progress-bar">
                <div class="playoff-progress-fill" style="width: ${progressPercent}%"></div>
            </div>` : ''}
            <div class="playoff-dropdown" id="${seriesId}-dropdown">
                ${await renderPlayoffMatches(slotKey)}
            </div>
        </div>`;
    }

    // Nová funkce pro vykreslení jednotlivých zápasů v dropdownu
    async function renderPlayoffMatches(slotKey) {
        const seriesIdStr = savedSlots[slotKey];
        if (!seriesIdStr) return '<div class="playoff-match"><span style="color: #888;">Žádné zápasy</span></div>';

        const mId = parseInt(seriesIdStr.replace('series-', ''));
        const match = matches.find(m => m.id === mId);
        if (!match) return '<div class="playoff-match"><span style="color: #888;">Zápas nenalezen</span></div>';

        const homeTeam = teams.find(t => t.id === match.homeTeamId) || { name: 'Neznámý' };
        const awayTeam = teams.find(t => t.id === match.awayTeamId) || { name: 'Neznámý' };

        let matchesHtml;

        // BO1 speciální případ
        if (match.bo === 1) {
            const result = match.result;
            const winner = result ? (result.scoreHome > result.scoreAway ? 'home' : 'away') : null;
            
            matchesHtml = `
            <div class="playoff-bo1-special">
                ${homeTeam.name} vs ${awayTeam.name}
                ${result ? `${result.scoreHome}:${result.scoreAway}` : 'Čeká se'}
                ${winner ? `(${winner === 'home' ? homeTeam.name : awayTeam.name} vyhrál)` : ''}
            </div>`;
        } 
        // BO3+ případ s playedMatches
        else if (match.playedMatches && match.playedMatches.length > 0) {
            matchesHtml = match.playedMatches.map((pm) => {
                const displayHome = pm.sideSwap ? awayTeam.name : homeTeam.name;
                const displayAway = pm.sideSwap ? homeTeam.name : awayTeam.name;
                const displayScoreH = pm.sideSwap ? pm.scoreAway : pm.scoreHome;
                const displayScoreA = pm.sideSwap ? pm.scoreHome : pm.scoreAway;
                const hWinner = (pm.scoreHome > pm.scoreAway && !pm.sideSwap) || (pm.scoreAway > pm.scoreHome && pm.sideSwap);
                const aWinner = (pm.scoreAway > pm.scoreHome && !pm.sideSwap) || (pm.scoreHome > pm.scoreAway && pm.sideSwap);
                
                // PP/SN indikace
                let otIndicator = '';
                if (pm.ot) {
                    otIndicator = ' <span style="color: #ff9800; font-size: 0.65em;">p</span>';
                }

                return `
                <div class="playoff-match">
                    <div class="playoff-match-teams">
                        <span class="playoff-match-team ${hWinner ? 'winner' : ''}">${displayHome}</span>
                        <span class="playoff-match-score">${displayScoreH}:${displayScoreA}${otIndicator}</span>
                        <span class="playoff-match-team ${aWinner ? 'winner' : ''}">${displayAway}</span>
                    </div>
                </div>`;
            }).join('');
        } 
        // Jiný případ (čekající zápas)
        else {
            matchesHtml = `
            <div class="playoff-match">
                <div class="playoff-match-teams">
                    <span class="playoff-match-team">${homeTeam.name}</span>
                    <span>vs</span>
                    <span class="playoff-match-team">${awayTeam.name}</span>
                </div>
            </div>`;
        }

        return matchesHtml;
    }

    html += `<div class="playoff-bracket" id="playoffTablePreview" style="display:${tableMode === 'playoff' ? 'block' : 'none'};">`;

    // Načtení šablony z MongoDB
    const allTemplates = await PlayoffTemplates.findAll();
    const currentTemplate = allTemplates?.[format] || {};

    if (currentTemplate && currentTemplate.columns) {
        html += `<h2 style="text-align:center; color:white; margin-bottom: 30px;">Playoff - ${selectedLiga} ${selectedSeason}</h2>`;

        // Flex container pro všechny sloupce - horizontální scroll, vertikálně na střed
        html += `<div style="display: flex; gap: 15px; justify-content: flex-start; align-items: center; overflow-x: auto; padding-bottom: 10px; scrollbar-width: thin; scrollbar-color: orangered #1a1a1a;">`;
        
        for (const col of currentTemplate.columns) {
            const boxes = await Promise.all(col.slots.map(slotId => renderBox(slotId)));
            html += `
            <div class="playoff-column">
                <div class="playoff-column-title">${col.title}</div>
                ${boxes.join('')}
                <div class="playoff-column-title">${col.title}</div>
            </div>`;
        }
        
        html += `</div>`; // Zavření flex kontejneru
    } else {
        html += `<h2 style="text-align:center; color:gray; margin-bottom: 30px;">Pro ligu ${selectedLiga} není nastaven formát pavouka.</h2>`;
    }

    html += `</div>`; // Zavření playoff-bracket

    // ==========================================
    // 4. PROGRESS BAR (Zobrazí se jen když NENÍ isHistory)
    // ==========================================
    if (!isHistory) {
        let filledMatches = matches.filter(m => m.result && m.isPlayoff === false && m.liga === selectedLiga && m.season === selectedSeason).length;
        const totalManualGames = teamsInSelectedLiga.reduce((sum, t) => sum + (t.stats?.[selectedSeason]?.manualGames || 0), 0);
        filledMatches += Math.floor(totalManualGames / 2);
        const percentage = leagueObj.maxMatches > 0 ? Math.round((filledMatches / leagueObj.maxMatches) * 100) : 0;

        html += `
        <section class="progress-section">
            <h3>Odehráno zápasů v základní části</h3>
            <div class="progress-container">
                <div class="progress-bar" style="width:${percentage}%;">${percentage}%</div>
            </div>
            <p id="progress-text"></p>
        </section>
        `;
    }

    // ==========================================
    // 5. STATISTIKY UŽIVATELŮ
    // ==========================================
    html += await generateStatsHtml(username, currentUserStats, userStats, isRegularSeasonFinished);

    // ==========================================
    // DŮLEŽITÉ: UZAVŘENÍ LEVÉHO PANELU
    // ==========================================
    html += `
    </div> </section> `;

    html += addPlayoffScript();

    return html;
}

async function logAdminAction(username, action, details) {
    // Vytvoříme hezký časový údaj
    const time = new Date().toLocaleString('cs-CZ', { timeZone: 'Europe/Prague' });

    // Složíme textovou zprávu
    const logMessage = `[${time}] ADMIN: ${username} | AKCE: ${action} | DETAILY: ${details}\n`;

    // Připíšeme na konec souboru (pokud neexistuje, sám se vytvoří)
    fs.appendFileSync('./data/admin_log.txt', logMessage);
}

async function generateTimeWidget() {
    return `
    <p id="current-time"></p>
    <script>
        function updateTime() {
            const now = new Date();
            const timeString = now.toLocaleString('cs-CZ', { 
                timeZone: 'Europe/Prague',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            const timeElement = document.getElementById('current-time');
            if (timeElement) {
                const [hours, minutes, seconds] = timeString.split(':');
                timeElement.innerHTML = 
                    '<span class="digit">' + hours + '</span>' +
                    '<span class="colon">:</span>' +
                    '<span class="digit">' + minutes + '</span>' +
                    '<span class="colon">:</span>' +
                    '<span class="digit">' + seconds + '</span>';
            }
        }
        document.addEventListener('DOMContentLoaded', () => {
            updateTime();
            setInterval(updateTime, 1000);
        });
    </script>
    `;
}

async function drawWatermark(ctx, width, height) {
    const { loadImage } = require('canvas');
    const path = require('path');
    
    try {
        const logoPath = path.join(process.cwd(), 'public/images/logo.png');
        const logoImg = await loadImage(logoPath);
        
        // Draw logo directly in bottom right corner - clean, no background
        const logoSize = 45;
        const padding = 8;
        
        // Calculate aspect ratio to maintain proportions
        const ratio = Math.min(logoSize / logoImg.width, logoSize / logoImg.height);
        const drawWidth = logoImg.width * ratio;
        const drawHeight = logoImg.height * ratio;
        
        // Position in bottom right corner
        const drawX = width - drawWidth - padding;
        const drawY = height - drawHeight - padding;
        
        ctx.drawImage(logoImg, drawX, drawY, drawWidth, drawHeight);
    } catch (e) {
        // Silently fail if logo can't be loaded
    }
}


async function createMatchImage(homeTeam, awayTeam, scoreHome = null, scoreAway = null, title = null, withWatermark = true, seriesData = null) {
    const { createCanvas, loadImage } = require('canvas');
    const path = require('path');
    const width = 800; 
    const height = 500;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#1a1a1a');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255, 69, 0, 0.15)';
    ctx.lineWidth = 3;
    for (let i = -100; i < width; i += 40) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 200, height);
        ctx.stroke();
    }

    const drawLogo = async (team, x, teamColor) => {
        const logoName = team?.logo;
        const teamName = team?.name || '???';
        const size = 200;
        
        ctx.fillStyle = teamColor + '40';
        ctx.beginPath();
        ctx.roundRect(x - 10, 60, size + 20, size + 20, 20);
        ctx.fill();
        
        ctx.strokeStyle = teamColor;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.roundRect(x - 10, 60, size + 20, size + 20, 20);
        ctx.stroke();
        
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        ctx.shadowBlur = 20;
        ctx.shadowOffsetX = 5;
        ctx.shadowOffsetY = 10;
        
        if (logoName) {
            try {
                const imgPath = path.join(process.cwd(), 'data/images', logoName);
                const img = await loadImage(imgPath);
                const ratio = Math.min(size / img.width, size / img.height);
                const nw = img.width * ratio;
                const nh = img.height * ratio;
                ctx.drawImage(img, x + (size - nw) / 2, 70 + (size - nh) / 2, nw, nh);
            } catch (e) {
                const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
                ctx.fillStyle = teamColor;
                ctx.beginPath();
                ctx.arc(x + size / 2, 70 + size / 2, 100, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 80px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(initials, x + size / 2, 70 + size / 2);
            }
        } else {
            const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
            ctx.fillStyle = teamColor;
            ctx.beginPath();
            ctx.arc(x + size / 2, 70 + size / 2, 100, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 80px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(initials, x + size / 2, 70 + size / 2);
        }
        ctx.shadowBlur = 0;
    };

    const homeColor = '#ff4500';
    const awayColor = '#0064ff';
    
    await drawLogo(homeTeam, 40, homeColor);
    await drawLogo(awayTeam, 560, awayColor);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.beginPath();
    ctx.roundRect(width/2 - 100, height/2 - 60, 200, 120, 20);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 69, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.shadowColor = 'rgba(255, 69, 0, 0.5)';
    ctx.shadowBlur = 10;

    const isResult = scoreHome !== null && scoreAway !== null;

    if (isResult) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 90px Arial';
        ctx.fillText(`${scoreHome}:${scoreAway}`, width / 2, height / 2 + 5);
        ctx.fillStyle = '#ff4500';
        ctx.font = 'bold 20px Arial';
        const displayText = title || 'KONEČNÝ VÝSLEDEK';
        ctx.fillText(displayText, width / 2, height / 2 + 85);
        
        // Zobrazeni stavu serie pro playoff
        if (seriesData) {
            ctx.fillStyle = '#ffd700';
            ctx.font = 'bold 28px Arial';
            ctx.fillText('Serie: ' + seriesData.homeWins + ' - ' + seriesData.awayWins, width / 2, height / 2 + 125);
        }
    } else {
        ctx.fillStyle = '#ff4500';
        ctx.font = 'bold 100px Arial';
        ctx.fillText('VS', width / 2, height / 2 + 5);
    }
    
    ctx.shadowBlur = 0;

    if (withWatermark) {
        await drawWatermark(ctx, width, height);
    }

    return canvas.toBuffer('image/png');
}
async function createTransferImage(team1, team2, playerName = null, withWatermark = true, playerPhotoPath = null) {
    const { createCanvas, loadImage } = require('canvas');
    const path = require('path');
    const width = 800; 
    const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#001a33');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(0, 212, 255, 0.1)';
    ctx.lineWidth = 2;
    for (let i = 0; i < width; i += 30) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, height); ctx.stroke();
    }

    const drawLogo = async (team, x) => {
        const logoName = team?.logo;
        const teamName = team?.name || '???';
        
        if (logoName) {
            try {
                const img = await loadImage(path.join(process.cwd(), 'data/images', logoName));
                ctx.shadowColor = 'rgba(0, 212, 255, 0.3)';
                ctx.shadowBlur = 15;
                const size = 240;
                const ratio = Math.min(size / img.width, size / img.height);
                ctx.drawImage(img, x + (size - img.width*ratio)/2, 80 + (size - img.height*ratio)/2, img.width*ratio, img.height*ratio);
                ctx.shadowBlur = 0;
            } catch (e) {
                const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
                const size = 240;
                const centerX = x + size / 2;
                const centerY = 80 + size / 2;
                ctx.fillStyle = '#00d4ff';
                ctx.beginPath();
                ctx.arc(centerX, centerY, 90, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 70px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(initials, centerX, centerY);
            }
        } else {
            const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
            const size = 240;
            const centerX = x + size / 2;
            const centerY = 80 + size / 2;
            ctx.fillStyle = '#00d4ff';
            ctx.beginPath();
            ctx.arc(centerX, centerY, 90, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 70px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(initials, centerX, centerY);
        }
    };

    await drawLogo(team1, 60);
    await drawLogo(team2, 500);

    ctx.fillStyle = '#00d4ff';
    ctx.font = 'bold 80px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('>>>', width / 2, height / 2 + 10);

    ctx.font = 'bold 40px Arial';
    ctx.fillText('PŘESTUP', width / 2, height / 2 - 55);

    // Draw player photo if provided
    if (playerPhotoPath) {
        try {
            const playerImg = await loadImage(playerPhotoPath);
            const photoSize = 120;
            const photoX = (width - photoSize) / 2;
            const photoY = height - 160;
            
            // Circular mask for player photo
            ctx.save();
            ctx.beginPath();
            ctx.arc(photoX + photoSize/2, photoY + photoSize/2, photoSize/2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            
            // Draw photo maintaining aspect ratio
            const ratio = Math.max(photoSize / playerImg.width, photoSize / playerImg.height);
            const nw = playerImg.width * ratio;
            const nh = playerImg.height * ratio;
            ctx.drawImage(playerImg, photoX + (photoSize - nw)/2, photoY + (photoSize - nh)/2, nw, nh);
            ctx.restore();
            
            // Border around photo
            ctx.strokeStyle = '#00d4ff';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(photoX + photoSize/2, photoY + photoSize/2, photoSize/2, 0, Math.PI * 2);
            ctx.stroke();
        } catch (e) {
            // Silently fail if photo can't be loaded
        }
    }

    if (playerName) {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 24px Arial';
        ctx.fillText(playerName, width / 2, height - 20);
    }

    if (withWatermark) {
        await drawWatermark(ctx, width, height);
    }

    return canvas.toBuffer('image/png');
}


async function createWinnerImage(winnerTeam, title, withWatermark = true, options = {}) {
    const { createCanvas, loadImage } = require('canvas');
    const path = require('path');
    const width = 800; 
    const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Options
    const {
        accentColor = '#ffd700',
        showTrophy = true
    } = options;

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    // Adjust gradient based on accent color (darken it)
    const baseColor = accentColor === '#ffd700' ? '#1a0f00' : '#0d0d0d';
    const midColor = accentColor === '#ffd700' ? '#2d1f00' : '#1a1a1a';
    grad.addColorStop(0, baseColor);
    grad.addColorStop(0.5, midColor);
    grad.addColorStop(1, '#0d0d0d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = hexToRgba(accentColor, 0.2);
    ctx.lineWidth = 3;
    for (let i = -100; i < width; i += 50) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 150, height);
        ctx.stroke();
    }
    
    const glowGrad = ctx.createRadialGradient(width/2, height/2, 50, width/2, height/2, 250);
    glowGrad.addColorStop(0, hexToRgba(accentColor, 0.15));
    glowGrad.addColorStop(1, hexToRgba(accentColor, 0));
    ctx.fillStyle = glowGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = accentColor;
    ctx.font = 'bold 30px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = hexToRgba(accentColor, 0.8);
    ctx.shadowBlur = 20;
    const titleText = showTrophy ? `🏆 ${title}` : title;
    ctx.fillText(titleText, width / 2, 50);
    ctx.shadowBlur = 0;

    const logoName = winnerTeam?.logo;
    const teamName = winnerTeam?.name || '???';
    const x = 300;
    const y = 90;
    const size = 200;
    
    ctx.shadowColor = hexToRgba(accentColor, 0.5);
    ctx.shadowBlur = 30;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 10;
    
    if (logoName) {
        try {
            const imgPath = path.join(process.cwd(), 'data/images', logoName);
            const img = await loadImage(imgPath);
            const ratio = Math.min(size / img.width, size / img.height);
            const nw = img.width * ratio;
            const nh = img.height * ratio;
            ctx.drawImage(img, x + (size - nw) / 2, y + (size - nh) / 2, nw, nh);
        } catch (e) {
            const centerX = x + size / 2;
            const centerY = y + size / 2;
            const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
            ctx.fillStyle = accentColor;
            ctx.beginPath();
            ctx.arc(centerX, centerY, 100, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#000000';
            ctx.font = 'bold 80px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(initials, centerX, centerY);
        }
    } else {
        const centerX = x + size / 2;
        const centerY = y + size / 2;
        const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
        ctx.fillStyle = accentColor;
        ctx.beginPath();
        ctx.arc(centerX, centerY, 100, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000000';
        ctx.font = 'bold 80px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials, centerX, centerY);
    }
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(teamName.toUpperCase(), width / 2, 340);

    if (withWatermark) {
        await drawWatermark(ctx, width, height);
    }

    return canvas.toBuffer('image/png');
}

// Helper function to convert hex to rgba
function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}


async function createStandingsImage(teamsData, title, withWatermark = true, options = {}) {
    const { createCanvas } = require('canvas');
    const width = 950;
    
    // Options with defaults - MUST be first before using these values
    const {
        isPlayoff = false,
        quarterfinal = 0,
        playin = 0,
        relegation = 0,
        clinchMode = 'cascade',
    } = options;
    
    // Group teams by their group property
    const teamsByGroup = {};
    teamsData.forEach(team => {
        const group = team.group || 'default';
        if (!teamsByGroup[group]) teamsByGroup[group] = [];
        teamsByGroup[group].push(team);
    });
    const sortedGroups = Object.keys(teamsByGroup).sort();
    const isMultiGroup = sortedGroups.length > 1;
    
    // Calculate height based on number of groups and teams
    const headerHeight = 110;
    const legendHeight = (!isPlayoff && (quarterfinal > 0 || playin > 0 || relegation > 0)) ? 35 : 0;
    const groupHeaderHeight = isMultiGroup ? 35 : 0;
    const tableHeaderHeight = 50;
    const rowHeight = 30;
    const groupSpacing = isMultiGroup ? 25 : 0;
    const footerPadding = 50;
    
    // Výpočet výšky
    let contentHeight = headerHeight + legendHeight;
    sortedGroups.forEach(group => {
        const teamCount = teamsByGroup[group].length;
        contentHeight += groupHeaderHeight + tableHeaderHeight + (teamCount * rowHeight);
    });
    contentHeight += (sortedGroups.length - 1) * groupSpacing + footerPadding;
    
    const height = Math.max(650, contentHeight);
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#1a1a1a');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Title
    ctx.fillStyle = '#ff4500';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title || 'TABULKA', width / 2, 40);
    
    // Mode indicator
    if (!isPlayoff && (quarterfinal > 0 || playin > 0 || relegation > 0)) {
        ctx.fillStyle = '#888';
        ctx.font = '12px Arial';
        ctx.fillText(`Mód: ${clinchMode === 'strict' ? 'Přísný' : 'Kaskádový'}`, width / 2, 65);
    }

    // Legend for zones
    let legendY = 85;
    if (!isPlayoff && (quarterfinal > 0 || playin > 0 || relegation > 0)) {
        ctx.font = '11px Arial';
        ctx.textAlign = 'left';
        let x = 30;
        if (quarterfinal > 0) {
            ctx.fillStyle = '#ffd700';
            ctx.fillText('■ ČF', x, legendY);
            x += 45;
        }
        if (playin > 0 && playin > quarterfinal) {
            ctx.fillStyle = '#00d4ff';
            ctx.fillText('■ Předkolo', x, legendY);
            x += 75;
        }
        if (relegation > 0) {
            ctx.fillStyle = '#ff4444';
            ctx.fillText('■ Baráž', x, legendY);
        }
        legendY += 20;
    }

    // Calculate clinch statuses - use pre-calculated _clinchStatus if available
    const calculateClinchStatus = (team, index, totalTeamsInGroup) => {
        if (team._clinchStatus) {
            return team._clinchStatus;
        }
        
        const pos = index + 1;
        let currentZone;
        if (quarterfinal > 0 && pos <= quarterfinal) {
            currentZone = 'quarterfinal';
        } else if (playin > 0 && pos <= playin) {
            currentZone = 'playin';
        } else if (relegation > 0 && pos > totalTeamsInGroup - relegation) {
            currentZone = 'relegation';
        } else {
            currentZone = 'neutral';
        }
        
        return { 
            currentZone, 
            locked: false, 
            clinchedQF: currentZone === 'quarterfinal',
            clinchedPlayin: currentZone === 'playin', 
            clinchedRelegation: currentZone === 'relegation',
            clinchedNeutral: currentZone === 'neutral'
        };
    };

    // Render each group
    let currentY = legendY + 25;
    
    sortedGroups.forEach((group) => {
        const groupTeams = teamsByGroup[group];
        
        // Group header for multi-group leagues
        if (isMultiGroup) {
            ctx.fillStyle = '#444';
            ctx.fillRect(30, currentY - 5, width - 60, 30);
            ctx.fillStyle = '#ff4500';
            ctx.font = 'bold 16px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(`Skupina ${group}`, width / 2, currentY + 12);
            currentY += 35;
        }
        
        // Header row
        const headerY = currentY;
        ctx.fillStyle = '#333';
        ctx.fillRect(30, headerY, width - 60, 35);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'left';
        ctx.fillText('#', 40, headerY + 22);
        ctx.fillText('Tým', 75, headerY + 22);
        ctx.textAlign = 'center';
        ctx.fillText('Z', 380, headerY + 22);
        ctx.fillText('V', 415, headerY + 22);
        ctx.fillText('Vpp', 450, headerY + 22);
        ctx.fillText('Ppp', 490, headerY + 22);
        ctx.fillText('P', 525, headerY + 22);
        ctx.fillText('Skóre', 590, headerY + 22);
        ctx.fillText('Body', 660, headerY + 22);
        if (!isPlayoff && (quarterfinal > 0 || playin > 0 || relegation > 0)) {
            ctx.fillText('Stav', 740, headerY + 22);
        }

        // Team rows
        let y = headerY + 50;
        groupTeams.forEach((team, index) => {
            // Row background alternating
            if (index % 2 === 0) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
                ctx.fillRect(30, y - 12, width - 60, 30);
            }
            
            // Get clinch status (per group)
            const status = !isPlayoff && (quarterfinal > 0 || playin > 0 || relegation > 0) 
                ? calculateClinchStatus(team, index, groupTeams.length) 
                : null;
            
            // Row color based on zone
            if (status) {
                let rowColor = null;
                if (status.clinchedQF) rowColor = 'rgba(255, 215, 0, 0.15)';
                else if (status.clinchedPlayin) rowColor = 'rgba(0, 212, 255, 0.15)';
                else if (status.clinchedRelegation) rowColor = 'rgba(255, 68, 68, 0.15)';
                else if (status.clinchedNeutral) rowColor = 'rgba(100, 255, 100, 0.1)';
                
                if (rowColor) {
                    ctx.fillStyle = rowColor;
                    ctx.fillRect(30, y - 12, width - 60, 30);
                }
                
                // Locked indicator
                if (status.locked) {
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
                    ctx.fillRect(30, y - 12, width - 60, 30);
                }
            }

            // Position color coding (within group)
            const pos = index + 1;
            let posColor = '#fff';
            if (status) {
                if (status.currentZone === 'quarterfinal') posColor = '#ffd700';
                else if (status.currentZone === 'playin') posColor = '#00d4ff';
                else if (status.currentZone === 'relegation') posColor = '#ff4444';
                else posColor = '#64ff64';
            }

            ctx.fillStyle = posColor;
            ctx.font = 'bold 16px Arial';
            ctx.textAlign = 'left';
            ctx.fillText(pos + '.', 40, y + 3);

            // Team name (remove group suffix if present)
            let displayName = team.name;
            if (isMultiGroup && displayName.includes(` (${group})`)) {
                displayName = displayName.replace(` (${group})`, '');
            }
            ctx.fillStyle = '#fff';
            ctx.font = '14px Arial';
            ctx.fillText(displayName.substring(0, 25), 75, y + 3);

            // Stats
            ctx.textAlign = 'center';
            ctx.fillStyle = '#aaa';
            const played = (team.wins || 0) + (team.otWins || 0) + (team.otLosses || 0) + (team.losses || 0);
            ctx.fillText(String(played), 380, y + 3);
            ctx.fillText(String(team.wins || 0), 415, y + 3);
            ctx.fillText(String(team.otWins || 0), 450, y + 3);
            ctx.fillText(String(team.otLosses || 0), 490, y + 3);
            ctx.fillText(String(team.losses || 0), 525, y + 3);

            const gf = team.gf || 0;
            const ga = team.ga || 0;
            const diff = gf - ga;
            const diffStr = diff > 0 ? '+' + diff : String(diff);
            ctx.fillText(gf + ':' + ga + ' (' + diffStr + ')', 590, y + 3);

            ctx.fillStyle = '#ff4500';
            ctx.font = 'bold 16px Arial';
            ctx.fillText(String(team.points || 0), 660, y + 3);
            
            // Status column
            if (status) {
                ctx.font = '12px Arial';
                let statusText = '';
                let statusColor = '#888';
                
                if (status.locked) {
                    if (status.clinchedQF) { statusText = '! Čtvrtfinále'; statusColor = '#ffd700'; }
                    else if (status.clinchedPlayin) { statusText = '! Předkolo'; statusColor = '#00d4ff'; }
                    else if (status.clinchedRelegation) { statusText = '! Baráž'; statusColor = '#ff4444'; }
                    else { statusText = '! Jistota'; statusColor = '#64ff64'; }
                } else {
                    if (status.clinchedQF) { statusText = '? Čtvrtfinále'; statusColor = '#ffd700'; }
                    else if (status.clinchedPlayin) { statusText = '? Předkolo'; statusColor = '#00d4ff'; }
                    else if (status.clinchedNeutral) { statusText = '? Jistota'; statusColor = '#64ff64'; }
                    else if (status.currentZone === 'quarterfinal') { statusText = 'Čtvrtfinále'; statusColor = '#ffd700'; }
                    else if (status.currentZone === 'playin') { statusText = 'Předkolo'; statusColor = '#00d4ff'; }
                    else if (status.currentZone === 'neutral') { statusText = ''; statusColor = '#888'; }
                    else if (status.currentZone === 'relegation') { statusText = 'Baráž'; statusColor = '#ff4444'; }
                }
                
                if (statusText) {
                    ctx.fillStyle = statusColor;
                    ctx.fillText(statusText, 740, y + 3);
                }
            }

            y += 30;
        });
        
        currentY = y + (isMultiGroup ? 20 : 0);
    });

    if (withWatermark) {
        await drawWatermark(ctx, width, height);
    }

    return canvas.toBuffer('image/png');
}

async function createStatisticsImage(usersStats, title, withWatermark = true) {
    const { createCanvas } = require('canvas');
    const width = 800;
    const height = Math.max(500, 150 + usersStats.length * 40);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Background
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#1a1a1a');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Title
    ctx.fillStyle = '#ff4500';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title || 'STATISTIKY TIPUJÍCÍCH', width / 2, 40);

    // Header
    ctx.fillStyle = '#333';
    ctx.fillRect(30, 70, width - 60, 35);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('#', 40, 87);
    ctx.fillText('Uživatel', 75, 87);
    ctx.textAlign = 'center';
    ctx.fillText('Úspěšnost', 360, 87);
    ctx.fillText('Body', 430, 87);
    ctx.fillText('ZČ', 480, 87);
    ctx.fillText('PO', 525, 87);
    ctx.fillText('Trefené pozice', 615, 87);
    ctx.fillText('Odchylka', 715, 87);

    // User rows
    let y = 110;
    usersStats.forEach((user, index) => {
        if (index % 2 === 0) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.fillRect(30, y - 12, width - 60, 30);
        }

        // Position
        const pos = index + 1;
        let posColor = '#fff';
        if (pos === 1) posColor = '#ffd700';
        else if (pos === 2) posColor = '#c0c0c0';
        else if (pos === 3) posColor = '#cd7f32';

        ctx.fillStyle = posColor;
        ctx.font = 'bold 16px Arial';
        ctx.textAlign = 'left';
        ctx.fillText(pos + '.', 40, y + 3);

        // Username
        ctx.fillStyle = '#fff';
        ctx.font = '14px Arial';
        ctx.fillText(user.username.substring(0, 20), 75, y + 3);

        // Stats
        ctx.textAlign = 'center';
        ctx.fillStyle = '#aaa';
        const successRate = user.total > 0 ? ((user.correct / user.total) * 100).toFixed(1) : '0.0';
        ctx.fillText(successRate + '%', 360, y + 3);

        ctx.fillStyle = '#00d4ff';
        ctx.font = 'bold 14px Arial';
        ctx.fillText(String(user.correct || 0), 430, y + 3);

        ctx.fillStyle = '#aaa';
        ctx.font = '14px Arial';
        ctx.fillText(String(user.totalRegular || 0), 480, y + 3);
        ctx.fillText(String(user.totalPlayoff || 0), 525, y + 3);

        // Table stats - always show values or 0
        ctx.fillText(String(user.tableCorrect || 0), 615, y + 3);
        ctx.fillText(String(user.tableDeviation || 0), 715, y + 3);

        y += 30;
    });

    // Legend
    ctx.fillStyle = '#888';
    ctx.font = '11px Arial';
    ctx.textAlign = 'left';
    ctx.fillText('ZČ = tipy v základní části, PO = tipy v playoff, Trefené pozice = správně trefené pozice v tabulce, Odchylka = odchylka tipů tabulky', 30, height - 30);

    if (withWatermark) {
        await drawWatermark(ctx, width, height);
    }

    return canvas.toBuffer('image/png');
}

async function createPlayoffBracketImage(data, withWatermark = true) {
    const { createCanvas } = require('canvas');
    const { playoffData, matches, teams, selectedLiga, title, standings } = data;
    
    const savedSlots = playoffData || {};
    
    // Canvas dimensions - larger overall
    let width = 1800;
    let height = 1000;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Background
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#1a1a1a');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    
    // Title
    ctx.fillStyle = '#ff4500';
    ctx.font = 'bold 32px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title || `Playoff - ${selectedLiga}`, width / 2, 40);
    
    // Helper function to get series info
    function getSeriesInfo(slotKey) {
        const seriesIdStr = savedSlots[slotKey];
        
        // If there's a series assignment, try to get teams from the match
        if (seriesIdStr && seriesIdStr.startsWith('series-')) {
            const mId = parseInt(seriesIdStr.replace('series-', ''));
            const match = matches.find(m => m.id === mId);
            
            if (match) {
                const homeTeam = teams.find(t => t.id === match.homeTeamId);
                const awayTeam = teams.find(t => t.id === match.awayTeamId);
                
                let scoreH = 0, scoreA = 0;
                const bo = match.bo || 3; // Get BO dynamically
                
                if (match.result) {
                    scoreH = match.result.scoreHome;
                    scoreA = match.result.scoreAway;
                } else if (match.playedMatches && match.playedMatches.length > 0) {
                    match.playedMatches.forEach(pm => {
                        if (pm.scoreHome > pm.scoreAway) scoreH++;
                        else if (pm.scoreAway > pm.scoreHome) scoreA++;
                    });
                }
                
                // Calculate wins based on actual BO format
                const homeWins = scoreH >= Math.ceil(bo / 2);
                const awayWins = scoreA >= Math.ceil(bo / 2);
                const isFinished = homeWins || awayWins;
                const isOngoing = !isFinished && (scoreH > 0 || scoreA > 0);
                
                // Get seed from team data or standings
                function getTeamSeed(teamId) {
                    // Try to get from team data first
                    const team = teams.find(t => t.id === teamId);
                    if (team && team.seed) return team.seed;
                    
                    // Try to get from standings if available
                    if (standings && Array.isArray(standings)) {
                        const standingEntry = standings.find(s => s.teamId === teamId || s.teamName === team?.name);
                        if (standingEntry && standingEntry.position) {
                            return standingEntry.position;
                        }
                        // Find by index in sorted standings
                        const sortedStandings = [...standings].sort((a, b) => (b.points || 0) - (a.points || 0));
                        const index = sortedStandings.findIndex(s => s.teamId === teamId || s.teamName === team?.name);
                        if (index !== -1) return index + 1;
                    }
                    
                    return null;
                }
                
                const homeSeed = getTeamSeed(match.homeTeamId);
                const awaySeed = getTeamSeed(match.awayTeamId);

                return {
                    home: homeTeam?.name || 'TBD',
                    away: awayTeam?.name || 'TBD',
                    homeSeed,
                    awaySeed,
                    scoreH, 
                    scoreA,
                    homeWins, 
                    awayWins,
                    isFinished,
                    isOngoing,
                    isWaiting: false,
                    bo,
                    playedMatches: match.playedMatches || []
                };
            }
            // Match not found but series assigned - show as waiting
            return {
                isWaiting: true,
                home: 'TBD',
                away: 'TBD',
                scoreH: '-',
                scoreA: '-'
            };
        }
        
        // Check for waiting teams (slot_t1, slot_t2 format) - for slots waiting on previous round winners
        const waitingT1 = savedSlots[`${slotKey}_t1`];
        const waitingT2 = savedSlots[`${slotKey}_t2`];
        
        if (waitingT1 || waitingT2) {
            // Try to find seed from team name in standings
            function getSeedFromTeamName(teamName) {
                if (!teamName || !standings || !Array.isArray(standings)) return null;
                const entry = standings.find(s => s.teamName === teamName);
                if (entry && entry.position) return entry.position;
                // Find by index
                const sorted = [...standings].sort((a, b) => (b.points || 0) - (a.points || 0));
                const idx = sorted.findIndex(s => s.teamName === teamName);
                return idx !== -1 ? idx + 1 : null;
            }
            
            return {
                isWaiting: true,
                home: waitingT1 || 'TBD',
                away: waitingT2 || 'TBD',
                homeSeed: getSeedFromTeamName(waitingT1),
                awaySeed: getSeedFromTeamName(waitingT2),
                scoreH: '-', 
                scoreA: '-'
            };
        }
        
        // Empty slot
        return null;
    }
    
    // Draw series box with improved design
    function drawSeriesBox(x, y, w, h, seriesInfo, label) {
        
        // Background with subtle gradient
        const boxGrad = ctx.createLinearGradient(x, y, x, y + h);
        if (seriesInfo && seriesInfo.isFinished) {
            boxGrad.addColorStop(0, 'rgba(40, 60, 40, 0.9)');
            boxGrad.addColorStop(1, 'rgba(30, 50, 30, 0.9)');
        } else if (seriesInfo && !seriesInfo.isWaiting) {
            boxGrad.addColorStop(0, 'rgba(50, 50, 50, 0.9)');
            boxGrad.addColorStop(1, 'rgba(35, 35, 35, 0.9)');
        } else {
            boxGrad.addColorStop(0, 'rgba(45, 45, 45, 0.7)');
            boxGrad.addColorStop(1, 'rgba(30, 30, 30, 0.7)');
        }
        ctx.fillStyle = boxGrad;
        
        // Draw rounded rectangle
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y);
        ctx.lineTo(x + w, y + h);
        ctx.quadraticCurveTo(x + w, y + h, x + w, y + h);
        ctx.lineTo(x, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h);
        ctx.lineTo(x, y);
        ctx.quadraticCurveTo(x, y, x, y);
        ctx.closePath();
        ctx.fill();
        
        // Border color based on status
        if (seriesInfo && seriesInfo.isFinished) {
            ctx.strokeStyle = '#00aa00'; // Green for finished
        } else if (seriesInfo && !seriesInfo.isWaiting) {
            ctx.strokeStyle = '#ff6600'; // Orange for ongoing
        } else {
            ctx.strokeStyle = '#666666'; // Gray for waiting
        }
        ctx.lineWidth = 2;
        ctx.stroke();
        
        if (seriesInfo) {
            const teamRowHeight = 22;
            const topPadding = 8;

            // Helper to draw team row with seed
            function drawTeamRow(teamName, seed, isWinner, rowY) {
                ctx.font = 'bold 14px Arial';
                ctx.textAlign = 'left';
                ctx.fillStyle = isWinner ? '#00ff00' : '#ffffff';
                
                // Seed indicator on the left
                if (seed) {
                    ctx.fillStyle = '#888888';
                    ctx.font = 'bold 12px Arial';
                    ctx.fillText(`(${seed})`, x + 6, rowY);
                    ctx.fillStyle = isWinner ? '#00ff00' : '#ffffff';
                    ctx.font = 'bold 14px Arial';
                    const displayName = teamName.length > 18 ? teamName.substring(0, 16) + '..' : teamName;
                    ctx.fillText(displayName, x + 30, rowY);
                } else {
                    const displayName = teamName.length > 20 ? teamName.substring(0, 18) + '..' : teamName;
                    ctx.fillText(displayName, x + 8, rowY);
                }
            }
            
            // Draw Home team
            drawTeamRow(seriesInfo.home, seriesInfo.homeSeed, seriesInfo.homeWins, y + topPadding + 12);
            
            // Draw Away team
            drawTeamRow(seriesInfo.away, seriesInfo.awaySeed, seriesInfo.awayWins, y + topPadding + teamRowHeight + 12);
            
            // Draw main score in center-right area
            ctx.textAlign = 'right';
            ctx.fillStyle = '#ffd700';
            ctx.font = 'bold 18px Arial';
            ctx.fillText(`${seriesInfo.scoreH} : ${seriesInfo.scoreA}`, x + w - 8, y + h/2 + 15);
            
            // Status text below score (small, clean)
            let statusColor = '#888888';
            let statusText = '';
            if (seriesInfo.isFinished) {
                statusColor = '#00aa00';
                statusText = 'Konec';
            } else if (seriesInfo.isOngoing) {
                statusColor = '#ff6600';
                statusText = 'Probíhá';
            }
            
            if (statusText) {
                ctx.fillStyle = statusColor;
                ctx.font = '12px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(statusText, x + w/2, y + h/2 + 18);
            }
            
            // Advance arrows on the right edge
            if (seriesInfo.homeWins) {
                ctx.textAlign = 'right';
                ctx.fillStyle = '#00ff00';
                ctx.font = 'bold 14px Arial';
                ctx.fillText('>>', x + w - 8, y + topPadding + 10);
            }
            if (seriesInfo.awayWins) {
                ctx.textAlign = 'right';
                ctx.fillStyle = '#00ff00';
                ctx.font = 'bold 14px Arial';
                ctx.fillText('>>', x + w - 8, y + topPadding + teamRowHeight + 10);
            }
            
            // Individual match scores (if available and enough space)
            if (seriesInfo.playedMatches && seriesInfo.playedMatches.length > 0 && w > 200) {
                ctx.font = '12px Arial';
                ctx.fillStyle = '#ffd700';
                ctx.textAlign = 'center';
                const matchScores = seriesInfo.playedMatches.map(pm => `${pm.scoreHome}:${pm.scoreAway}`).join(' | ');
                ctx.fillText(matchScores.substring(0, 30), x + w/2, y + h - 6);
            }
        } else {
            // Empty/waiting slot
            ctx.fillStyle = '#555555';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(label || 'Čeká na týmy', x + w/2, y + h/2 + 5);
        }
        
        // Round label above box
        if (label) {
            ctx.fillStyle = '#ff6600';
            ctx.font = 'bold 11px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(label, x + w/2, y - 8);
        }
    }
    
    // Draw connection lines with elbow/stepped style
    function drawConnection(x1, y1, x2, y2) {
        const midX = x1 + (x2 - x1) / 2;
        
        ctx.strokeStyle = '#ff6600';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(midX, y1);  // Horizontal from source
        ctx.lineTo(midX, y2);  // Vertical to target level
        ctx.lineTo(x2, y2);    // Horizontal to target
        ctx.stroke();
        
        // Draw small dot at connection point
        ctx.fillStyle = '#ff6600';
        ctx.beginPath();
        ctx.arc(x2, y2, 3, 0, Math.PI * 2);
        ctx.fill();
    }
    
    // Calculate max text width for dynamic box sizing
    function measureTextWidth(text) {
        ctx.font = 'bold 14px Arial';
        return ctx.measureText(text).width;
    }
    
    // Analyze playoff data structure
    const slotKeys = Object.keys(savedSlots).filter(k => !k.includes('_t1') && !k.includes('_t2'));
    
    // Group by round prefix - handle formats like: pk1, qf_1, qf1, sf1, fin, bronz
    const roundGroups = {};
    slotKeys.forEach(key => {
        // Match patterns like: pk1, pk_1, qf1, qf_2, sf1, fin, bronz, r16_1, etc.
        // pk1 -> pk + 1, qf1 -> qf + 1, fin -> fin (no number)
        const match = key.match(/^([a-z]+)_?(\d*)$/i);
        if (match) {
            const prefix = match[1].toLowerCase();
            const num = match[2] ? parseInt(match[2]) : 1; // default to 1 if no number
            if (!roundGroups[prefix]) roundGroups[prefix] = [];
            roundGroups[prefix].push({ key, num });
        }
    });
    
    // Define round order for sorting (more comprehensive)
    const roundOrder = ['playin', 'pk', 'r16', 'qf', 'sf', 'f', 'fin', 'final', 'bronz'];
    const roundLabels = {
        playin: 'Předkolo',
        pk: 'Předkolo',
        r16: 'Osmifinále',
        qf: 'Čtvrtfinále',
        sf: 'Semifinále',
        f: 'Finále',
        fin: 'Finále',
        final: 'Finále',
        bronz: 'O 3. místo'
    };
    
    // Get all unique round prefixes from data, sorted by roundOrder
    const allPrefixes = Object.keys(roundGroups).sort((a, b) => {
        const aIndex = roundOrder.indexOf(a);
        const bIndex = roundOrder.indexOf(b);
        // If both in order list, use that order
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        // If only one in order list, prioritize it
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        // Otherwise alphabetical
        return a.localeCompare(b);
    });
    
    // Filter to only rounds that have data
    const existingRounds = allPrefixes.filter(r => roundGroups[r] && roundGroups[r].length > 0);
    
    if (existingRounds.length === 0) {
        ctx.fillStyle = '#ff4500';
        ctx.font = 'bold 24px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Žádná playoff data k dispozici', width / 2, height / 2);
    } else {
        // First pass: calculate max box width based on team names
        let maxTextWidth = 0;
        existingRounds.forEach(round => {
            const slots = roundGroups[round].sort((a, b) => a.num - b.num);
            slots.forEach(slot => {
                const info = getSeriesInfo(slot.key);
                if (info) {
                    const homeWidth = measureTextWidth(info.home);
                    const awayWidth = measureTextWidth(info.away);
                    maxTextWidth = Math.max(maxTextWidth, homeWidth, awayWidth);
                }
            });
        });
        
        // Dynamic box width: at least 220, at most 350
        const boxW = Math.max(220, Math.min(350, maxTextWidth + 50));
        const boxH = 90; // Taller with seed info
        const startY = 120;
        const colSpacing = boxW + 100; // More spacing
        
        // Calculate layout - center the bracket
        const totalWidth = existingRounds.length * colSpacing;
        const startX = (width - totalWidth) / 2 + 30; // Center horizontally
        
        // Draw each round
        const roundPositions = {};
        
        existingRounds.forEach((round, colIndex) => {
            const slots = roundGroups[round].sort((a, b) => a.num - b.num);
            const colX = startX + colIndex * colSpacing;
            const roundHeight = slots.length * (boxH + 40);
            const roundStartY = startY + (height - startY - 120 - roundHeight) / 2;
            
            roundPositions[round] = {};
            
            slots.forEach((slot, i) => {
                const y = roundStartY + i * (boxH + 40);
                const info = getSeriesInfo(slot.key);
                const label = slots.length === 1 ? roundLabels[round] : `${roundLabels[round]} ${slot.num}`;
                
                drawSeriesBox(colX, y, boxW, boxH, info, label);
                roundPositions[round][slot.num] = { x: colX + boxW, y: y + boxH/2, slotX: colX };
            });
        });
        
        // Draw connections between rounds - based on actual slot data structure
        for (let i = 0; i < existingRounds.length - 1; i++) {
            const currentRound = existingRounds[i];
            const nextRound = existingRounds[i + 1];
            
            // Skip connection lines from play-in rounds (they connect directly to seeds, not to next round)
            const playInRounds = ['playin', 'pk', 'pi'];
            if (playInRounds.includes(currentRound)) {
                continue; // No connection lines from play-in to quarterfinals
            }
            
            const currentSlots = roundGroups[currentRound].sort((a, b) => a.num - b.num);
            const nextSlots = roundGroups[nextRound].sort((a, b) => a.num - b.num);
            
            // Determine connection type based on slot count ratio
            const ratio = currentSlots.length / nextSlots.length;
            
            if (ratio === 1) {
                // 1:1 connection - each current slot goes to one next slot (e.g., pk1->qf1, pk2->qf2)
                nextSlots.forEach((nextSlot, idx) => {
                    const currentSlot = currentSlots[idx];
                    if (currentSlot && roundPositions[currentRound][currentSlot.num] && roundPositions[nextRound][nextSlot.num]) {
                        const currentPos = roundPositions[currentRound][currentSlot.num];
                        const nextPos = roundPositions[nextRound][nextSlot.num];
                        drawConnection(currentPos.x, currentPos.y, nextPos.slotX, nextPos.y);
                    }
                });
            } else if (ratio === 2) {
                // 2:1 connection - two current slots go to one next slot (e.g., qf1+qf2->sf1)
                nextSlots.forEach((nextSlot, idx) => {
                    const nextPos = roundPositions[nextRound][nextSlot.num];
                    const currentSlot1 = currentSlots[idx * 2];
                    const currentSlot2 = currentSlots[idx * 2 + 1];
                    
                    if (currentSlot1 && roundPositions[currentRound][currentSlot1.num]) {
                        const pos1 = roundPositions[currentRound][currentSlot1.num];
                        drawConnection(pos1.x, pos1.y, nextPos.slotX, nextPos.y);
                    }
                    if (currentSlot2 && roundPositions[currentRound][currentSlot2.num]) {
                        const pos2 = roundPositions[currentRound][currentSlot2.num];
                        drawConnection(pos2.x, pos2.y, nextPos.slotX, nextPos.y);
                    }
                });
            } else {
                // Fallback: simple sequential connection
                nextSlots.forEach((nextSlot, idx) => {
                    const nextPos = roundPositions[nextRound][nextSlot.num];
                    const startIdx = Math.floor(idx * ratio);
                    const endIdx = Math.floor((idx + 1) * ratio);
                    
                    for (let j = startIdx; j < endIdx && j < currentSlots.length; j++) {
                        const currentSlot = currentSlots[j];
                        if (roundPositions[currentRound][currentSlot.num]) {
                            const pos = roundPositions[currentRound][currentSlot.num];
                            drawConnection(pos.x, pos.y, nextPos.slotX, nextPos.y);
                        }
                    }
                });
            }
        }
    }
    
    if (withWatermark) {
        await drawWatermark(ctx, width, height);
    }
    
    return canvas.toBuffer('image/png');
}

function addPlayoffScript() {
    return `
    <script>
    function togglePlayoffDropdown(seriesId) {
        const dropdown = document.getElementById(seriesId + '-dropdown');
        if (dropdown) {
            dropdown.classList.toggle('open');
            
            // Zavřeme ostatní dropdowny
            const allDropdowns = document.querySelectorAll('.playoff-dropdown');
            allDropdowns.forEach(d => {
                if (d.id !== seriesId + '-dropdown') {
                    d.classList.remove('open');
                }
            });
        }
    }

    // Kliknutí mimo dropdown ho zavře
    document.addEventListener('click', function(event) {
        if (!event.target.closest('.playoff-series')) {
            const allDropdowns = document.querySelectorAll('.playoff-dropdown.open');
            allDropdowns.forEach(d => d.classList.remove('open'));
        }
    });
    </script>`;
}

module.exports = {
    createStandingsImage,
    createStatisticsImage,
    createPlayoffBracketImage,
    requireLogin,
    requireAdmin,
    updateTeamsPoints,
    evaluateAndAssignPoints,
    generateSeasonRange,
    removeTipsForDeletedMatch,
    renameLeagueGlobal,
    evaluateRegularSeasonTable,
    renderErrorHtml,
    prepareDashboardData,
    getGroupDisplayLabel,
    generateLeftPanel,
    logAdminAction,
    getLeagueStatusData,
    getTableTipsData,
    generateTimeWidget,
    createMatchImage,
    createTransferImage,
    createWinnerImage,
    calculateClinchStatusesForGroup,
    getAllowedLeagues,
    getMatches,
    getLeaguesData,
    loadTeams,
}
