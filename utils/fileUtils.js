require('fs');
require("path");
const fs = require("fs");

const { Teams, Users, Matches, Leagues, AllowedLeagues, ChosenSeason, Settings, TeamBonuses, LeagueStatus, TableTips, Playoff, PlayoffTemplates, Transfers, TransferLeagues} = require('./mongoDataAccess');
async function loadTeams() {
    return await Teams.findAll();
}

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
                    .btn { background: orangered; color: black; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold; margin-top: 20px; }
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

    matches.filter(m => m.season === season && m.liga === liga && m.result).forEach(m => {
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
                a { color: white; text-decoration: none; border: 1px solid orangered; padding: 10px 20px; border-radius: 5px; transition: 0.3s; }
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

async function prepareDashboardData(req, isHistory = false) {
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

    const uniqueLeagues = isHistory
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

    let playoffData = [];
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

        return {
            isWaiting: false,
            home: homeTeam.name, away: awayTeam.name,
            scoreH, scoreA, hWinner, aWinner
        };
    }

    async function renderBox(slotKey) {
        const info = await getSeriesInfo(slotKey);

        // Zcela prázdný slot (TBD vs TBD)
        if (!info) {
            return `
            <div style="background: #111; border: 1px solid #333; border-radius: 6px; overflow: hidden; opacity: 0.5; min-width: 170px;">
                <div style="padding: 8px 10px; border-bottom: 1px solid #222; color: #666; font-size: 0.85em; display:flex; justify-content: space-between;"><span>TBD</span><span style="background: #000; padding: 2px 6px; border-radius: 3px;">-</span></div>
                <div style="padding: 8px 10px; color: #666; font-size: 0.85em; display:flex; justify-content: space-between;"><span>TBD</span><span style="background: #000; padding: 2px 6px; border-radius: 3px;">-</span></div>
            </div>`;
        }

        // Čekající mezistav (např. Sparta vs TBD)
        if (info.isWaiting) {
            const renderTeam = (name, isTop) => {
                const isTbd = name === 'TBD';
                const border = isTop ? 'border-bottom: 1px solid #222;' : '';
                return `
                <div style="padding: 8px 10px; ${border} font-size: 0.85em; display:flex; justify-content: space-between; align-items: center; color: ${isTbd ? '#666' : 'lightgrey'}; font-weight: ${!isTbd ? 'bold' : 'normal'};">
                    <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;">${name}</span>
                    <span style="background: #000; padding: 2px 6px; border-radius: 3px; margin-left: 5px; font-family: monospace; opacity: 0.5;">-</span>
                </div>`;
            };

            return `
            <div style="background: #111; border: 1px solid #444; border-radius: 6px; overflow: hidden; min-width: 170px; opacity: 0.8;">
                ${renderTeam(info.home, true)}
                ${renderTeam(info.away, false)}
            </div>`;
        }

        // Klasický vyhodnocovaný zápas (Série)
        return `
        <div style="background: #111; border: 1px solid #444; border-radius: 6px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.5); min-width: 170px; position: relative;">
            <div style="padding: 8px 10px; border-bottom: 1px solid #222; font-size: 0.85em; display:flex; justify-content: space-between; align-items: center; ${info.hWinner ? 'background: rgba(0,100,0,0.25); font-weight:bold; color:white;' : (info.aWinner ? 'color:#555;' : 'color:lightgrey;')}">
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;">${info.home}</span>
                <span style="background: #000; padding: 2px 6px; border-radius: 3px; margin-left: 5px; font-family: monospace;">${info.scoreH}</span>
            </div>
            <div style="padding: 8px 10px; font-size: 0.85em; display:flex; justify-content: space-between; align-items: center; ${info.aWinner ? 'background: rgba(0,100,0,0.25); font-weight:bold; color:white;' : (info.hWinner ? 'color:#555;' : 'color:lightgrey;')}">
                <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;">${info.away}</span>
                <span style="background: #000; padding: 2px 6px; border-radius: 3px; margin-left: 5px; font-family: monospace;">${info.scoreA}</span>
            </div>
        </div>`;
    }

    html += `<div id="playoffTablePreview" style="display:${tableMode === 'playoff' ? 'block' : 'none'}; overflow-x:auto; padding: 20px 0; max-width:100%;">
             <div style="display: flex; gap: 40px; min-width: min-content; margin: 0 auto; justify-content: center;">`;

    // Načtení šablony z MongoDB
    const allTemplates = await PlayoffTemplates.findAll();
    const currentTemplate = allTemplates?.[format] || {};

    // TOTO JE NOVÝ KÓD:
    if (currentTemplate && currentTemplate.columns) {
        html += `<div id="playoffTablePreview" style="display:${tableMode === 'playoff' ? 'block' : 'none'}; overflow-x:auto; padding: 20px 0; max-width:100%;">
                 <h2 style="text-align:center; color:white; margin-bottom: 30px;">Playoff - ${selectedLiga} ${selectedSeason}</h2>`;

        // 1. ŘÁDEK S NADPISY (Odděleno od samotných zápasů)
        html += `<div style="display: flex; gap: 40px; min-width: min-content; margin: 0 auto 15px auto; justify-content: center;">`;
        currentTemplate.columns.forEach(col => {
            html += `<div style="width: 170px; text-align:center; color:orangered; font-size:0.8em; font-weight:bold; text-transform:uppercase;">${col.title}</div>`;
        });
        html += `</div>`;

        // 2. ŘÁDEK SE SLOUPCI ZÁPASŮ (align-items: stretch zajistí stejnou výšku všech sloupců)
        html += `<div style="display: flex; gap: 40px; min-width: min-content; margin: 0 auto; justify-content: center; align-items: stretch;">`;
        for (const col of currentTemplate.columns) {
            // Přidán margin-top, který si bere hodnotu z col.gap (např. "60px")
            const boxes = await Promise.all(col.slots.map(slotId => renderBox(slotId)));
            html += `
            <div style="display: flex; gap: 20px; flex-direction: column; justify-content: space-around; width: 170px; margin-top: ${col.gap || '0px'};">
                ${boxes.join('')}
            </div>`;
        }
        html += `</div></div>`;
    } else {
        html += `<div id="playoffTablePreview" style="display:${tableMode === 'playoff' ? 'block' : 'none'}; width: 100%; text-align: center; padding: 40px 20px; background: #1a1a1a; border-radius: 8px; border: 1px dashed #444;">
            <p style="color: gray; margin: 0;">Pro ligu ${selectedLiga} není nastaven formát pavouka.</p>
        </div>`;
    }

    html += `</div></div>`;

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

module.exports = {
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
}


