const {readFileSync} = require("node:fs");
const path = require("path");
const fs = require("fs");

function loadTeams() {
    const data = readFileSync(path.join(__dirname, '../data/teams.json'), 'utf-8');
    return JSON.parse(data);
}

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/auth/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user !== 'Admin') {
        return res.status(403).send('Přístup odepřen, nejsi admin.');
    }
    next();
}

function updateTeamsPoints(currentMatches) {
    let teams;
    try {
        teams = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/teams.json'), 'utf-8'));
    } catch (err) {
        console.error('Chyba při čtení teams.json:', err);
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
                console.log('Remíza bez overtime winner, nelze určit vítěze.');
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
        fs.writeFileSync(path.join(__dirname, '../data/teams.json'), JSON.stringify(teams, null, 2));
    } catch (err) {
        console.error('Chyba při zápisu do teams.json:', err);
    }
}

function evaluateAndAssignPoints(liga, season) {
    const matches = JSON.parse(fs.readFileSync('./data/matches.json'));
    const users = JSON.parse(fs.readFileSync('./data/users.json'));

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

    // Zápis do souboru
    fs.writeFileSync('./data/users.json', JSON.stringify(users, null, 2));
}

function generateSeasonRange(startYear, numberOfSeasons) {
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


function removeTipsForDeletedMatch(matchId) {
    let league = null;
    let season = null;

    try {
        const matches = JSON.parse(fs.readFileSync('./data/matches.json'));
        const match = matches.find(m => m.id === matchId);

        if (match) {
            console.log(`Zápas ID ${matchId} stále existuje. Tipy se nemazaly.`);
            return;
        }

        const usersData = JSON.parse(fs.readFileSync('./data/users.json'));

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
            console.log(`Nepodařilo se zjistit ligu/sezónu pro zápas ID ${matchId}.`);
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
                    console.log(`Smazán tip u uživatele ${user.username}`);
                }
            }
        }

        if (changesMade) {
            fs.writeFileSync('./data/users.json', JSON.stringify(usersData, null, 2));
            console.log(`Tipy na zápas ID ${matchId} (liga: ${league}, sezóna: ${season}) byly smazány.`);
        } else {
            console.log(`Nebyly nalezeny žádné tipy na zápas ID ${matchId}.`);
        }

    } catch (err) {
        console.error("Chyba při mazání tipů:", err);
    }
}

function calculateTeamScores(matches, selectedSeason, selectedLiga) {
    const scores = {};

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

    return scores;
}
function getLeagueZones(leagueObj) {
    if (!leagueObj) return { quarterfinal: 0, playin: 0, relegation: 0 };
    return {
        quarterfinal: Number(leagueObj.quarterfinal || 0),
        playin: Number(leagueObj.playin || 0),
        relegation: Number(leagueObj.relegation || 0)
    };
}

function getTeamZone(index, totalTeams, cfg) {
    const pos = index + 1;
    if (pos <= cfg.quarterfinal) return "quarterfinal";
    if (pos <= cfg.playin) return "playin";
    if (pos > totalTeams - cfg.relegation) return "relegation";
    return "neutral";
}

function getTeamStats(team, season, maxMatches) {
    if (!team) {
        return { points: 0, maxPoints: Number.MAX_SAFE_INTEGER, remaining: Number.MAX_SAFE_INTEGER };
    }
    const stats = team.stats?.[season] || {};
    const points = stats.points || 0;
    const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0);

    let remaining;
    if (played > maxMatches) {
        remaining = 0;
    } else {
        remaining = maxMatches - played;
    }

    const maxPoints = points + (remaining * 3);
    return { points, maxPoints };
}

const paths = {
    allowedLeagues: path.join(__dirname, '../data/allowedLeagues.json'),
    leagues: path.join(__dirname, '../data/leagues.json'),
    teams: path.join(__dirname, '../data/teams.json'),
    matches: path.join(__dirname, '../data/matches.json'),
    users: path.join(__dirname, '../data/users.json'),
    playoff: path.join(__dirname, '../data/playoff.json')
};

const loadJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const saveJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));

function renameLeagueGlobal(oldName, newName) {
    console.log(`🚨 START: Přejmenovávám ligu "${oldName}" na "${newName}"`);

    // 1. ALLOWEDLEAGUES.JSON (Pole stringů)
    try {
        const allowed = loadJSON(paths.allowedLeagues);
        const index = allowed.indexOf(oldName);
        if (index !== -1) {
            allowed[index] = newName;
            saveJSON(paths.allowedLeagues, allowed);
            console.log('✅ allowedLeagues.json: Název v poli upraven.');
        }
    } catch (e) { console.error('Chyba allowedLeagues:', e.message); }

    // 2. LEAGUES.JSON (OPRAVENO: Iterace přes sezóny)
    // -------------------------------------
    try {
        const leaguesData = loadJSON(paths.leagues);
        let leaguesChanged = false;

        // Projdeme všechny klíče (sezóny), např. "24/25", "25/26"
        Object.keys(leaguesData).forEach(seasonKey => {
            const seasonObj = leaguesData[seasonKey];

            // Pokud má sezóna pole 'leagues'
            if (seasonObj && Array.isArray(seasonObj.leagues)) {
                const leagueToUpdate = seasonObj.leagues.find(l => l.name === oldName);

                if (leagueToUpdate) {
                    leagueToUpdate.name = newName;
                    leaguesChanged = true;
                }
            }
        });

        if (leaguesChanged) {
            saveJSON(paths.leagues, leaguesData);
            console.log('✅ leagues.json: Název upraven napříč sezónami.');
        }
    } catch (e) { console.error('Chyba leagues:', e.message); }

    // 3. TEAMS.JSON
    try {
        const teams = loadJSON(paths.teams);
        let count = 0;
        teams.forEach(t => {
            if (t.liga === oldName) {
                t.liga = newName;
                count++;
            }
        });
        if (count > 0) {
            saveJSON(paths.teams, teams);
            console.log(`✅ teams.json: Upraveno u ${count} týmů.`);
        }
    } catch (e) { console.error('Chyba teams:', e.message); }

    // 4. MATCHES.JSON
    try {
        const matches = loadJSON(paths.matches);
        let count = 0;

        // Pomocná funkce, protože matches může být pole nebo objekt
        const updateMatchesList = (list) => {
            let c = 0;
            list.forEach(m => {
                if (m.liga === oldName) { m.liga = newName; c++; }
            });
            return c;
        };

        if (Array.isArray(matches)) {
            count = updateMatchesList(matches);
        } else {
            // Pokud je matches rozděleno po sezónách/ligách
            Object.keys(matches).forEach(key => {
                if (Array.isArray(matches[key])) {
                    count += updateMatchesList(matches[key]);
                }
            });
        }

        if (count > 0) {
            saveJSON(paths.matches, matches);
            console.log(`✅ matches.json: Upraveno u ${count} zápasů.`);
        }
    } catch (e) { console.error('Chyba matches:', e.message); }

    // 5. PLAYOFF.JSON (Textová náhrada)
    try {
        let rawPlayoff = fs.readFileSync(paths.playoff, 'utf8');
        const regex = new RegExp(`"${oldName}"`, 'g');
        const newPlayoff = rawPlayoff.replace(regex, `"${newName}"`);

        if (rawPlayoff !== newPlayoff) {
            fs.writeFileSync(paths.playoff, newPlayoff);
            console.log('✅ playoff.json: Textově nahrazeny výskyty názvu.');
        }
    } catch (e) { console.error('Chyba playoff:', e.message); }

    // 6. USERS.JSON (Statistiky - Klíče)
    try {
        const users = loadJSON(paths.users);
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
            saveJSON(paths.users, users);
            console.log(`✅ users.json: Přejmenovány statistiky u ${usersUpdated} uživatelů.`);
        }
    } catch (e) { console.error('Chyba users:', e.message); }

    console.log('🏁 HOTOVO. Všechny ligy přejmenovány.');
}

function isLockedPosition(index, totalTeams, sortedTeams, cfg, season, maxMatches, allTeamsFinished) {
    if (cfg.quarterfinal === 0 && cfg.playin === 0 && cfg.relegation === 0) {
        return false;
    }
    if (allTeamsFinished) {
        return true;
    }
    const myTeam = sortedTeams[index];
    if (!myTeam) return false;

    const { points: myPoints, maxPoints: myMaxPoints } = getTeamStats(myTeam, season, maxMatches);

    const lastQfIndex = cfg.quarterfinal - 1;
    const lastPlayinIndex = cfg.playin - 1;
    const firstRelegationIndex = totalTeams - cfg.relegation;

    if (index <= lastQfIndex) {
        const chaser = sortedTeams[lastQfIndex + 1];
        if (!chaser) return true;

        const { maxPoints: chaserMaxPoints } = getTeamStats(chaser, season, maxMatches);

        return chaserMaxPoints < myPoints;
    }

    else if (index <= lastPlayinIndex) {
        const chaser = sortedTeams[lastPlayinIndex + 1];
        const cannotFall = !chaser || (getTeamStats(chaser, season, maxMatches).maxPoints < myPoints);

        const leader = sortedTeams[lastQfIndex];
        const cannotRise = !leader || (myMaxPoints < getTeamStats(leader, season, maxMatches).points);

        return cannotFall && cannotRise;
    }

    else if (index >= firstRelegationIndex) {
        const leader = sortedTeams[firstRelegationIndex - 1];
        if (!leader) return true;

        const { points: leaderPoints } = getTeamStats(leader, season, maxMatches);

        return myMaxPoints < leaderPoints;
    }

    else {
        const chaser = sortedTeams[firstRelegationIndex];
        const cannotFall = !chaser || (getTeamStats(chaser, season, maxMatches).maxPoints < myPoints);

        const leader = sortedTeams[lastPlayinIndex];
        const cannotRise = !leader || (myMaxPoints < getTeamStats(leader, season, maxMatches).points);

        return cannotFall && cannotRise;
    }
}
// utils/fileUtils.js

// ... tvé existující importy ...

function evaluateRegularSeasonTable(season, liga) {
    const fs = require('fs');

    // 1. Načtení dat
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    // Filtrujeme týmy jen pro danou ligu
    const teams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf8')).filter(t => t.active && t.liga === liga);
    const users = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));

    // Zjistíme, jestli je liga multigroup (pro správné párování)
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    const isMultigroup = allSeasonData[season]?.leagues.find(l => l.name === liga)?.isMultigroup || false;

    let tableTips = {};
    try { tableTips = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8')); } catch (e) {}

    // 2. Vypočítat REÁLNÉ SKÓRE a BODY (Live tabulka)
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

    // 3. Příprava "Reálných skupin" (abychom věděli, kdo patří do Skupiny A, kdo do B)
    const groupedTeamsReal = {};
    teams.forEach(t => {
        // Klíč musí být stejný jako při ukládání (string)
        const gKey = isMultigroup ? String(t.group || 1) : "default";
        if (!groupedTeamsReal[gKey]) groupedTeamsReal[gKey] = [];
        groupedTeamsReal[gKey].push(t);
    });

    // 4. Vyhodnocení každého uživatele
    users.forEach(user => {
        let userTipData = tableTips?.[season]?.[liga]?.[user.username];
        if (!userTipData) return;

        // BACKWARD COMPATIBILITY: Pokud má uživatel starý formát (pole), převedeme na objekt
        if (Array.isArray(userTipData)) {
            userTipData = { "default": userTipData };
        }

        let totalCorrect = 0;
        let totalDeviation = 0;

        // Projdeme všechny reálné skupiny (A, B, C...) a porovnáme s tipem
        Object.keys(groupedTeamsReal).forEach(gKey => {
            const realTeamsInGroup = groupedTeamsReal[gKey];

            // Seřadíme reálné týmy ve skupině podle bodů
            const realOrderIds = realTeamsInGroup.sort((a, b) => {
                const sa = scores[a.id];
                const sb = scores[b.id];
                if (sb.points !== sa.points) return sb.points - sa.points;
                return (sb.gf - sb.ga) - (sa.gf - sa.ga);
            }).map(t => t.id);

            // Vytáhneme uživatelův tip pro tuto skupinu
            const userGroupTip = userTipData[gKey] || [];

            // Porovnáváme
            realOrderIds.forEach((realId, realIndex) => {
                const userIndex = userGroupTip.indexOf(realId);

                if (userIndex !== -1) {
                    // Tým nalezen v tipu -> počítáme rozdíl
                    const diff = Math.abs(realIndex - userIndex);
                    totalDeviation += diff;
                    if (diff === 0) totalCorrect++;
                } else {
                    // Tým v tipu chybí (uživatel netipoval tuto skupinu kompletně)
                    // Penalizace: Přičteme počet týmů ve skupině (nebo jiná logika)
                    totalDeviation += realOrderIds.length;
                }
            });
        });

        // Uložení výsledků
        if (!user.stats) user.stats = {};
        if (!user.stats[season]) user.stats[season] = {};
        if (!user.stats[season][liga]) user.stats[season][liga] = {};

        user.stats[season][liga].tableCorrect = totalCorrect;
        user.stats[season][liga].tableDeviation = totalDeviation;
    });

    fs.writeFileSync('./data/users.json', JSON.stringify(users, null, 2));
}

module.exports = {
    requireLogin,
    requireAdmin,
    loadTeams,
    updateTeamsPoints,
    evaluateAndAssignPoints,
    generateSeasonRange,
    removeTipsForDeletedMatch,
    calculateTeamScores,
    getLeagueZones,
    getTeamZone,
    isLockedPosition,
    renameLeagueGlobal,
    evaluateRegularSeasonTable,
}