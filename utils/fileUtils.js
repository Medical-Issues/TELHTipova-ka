const {readFileSync} = require("node:fs");
const path = require("path");
const fs = require("fs");

function loadTeams() {
    const data = readFileSync(path.join(__dirname, '../data/teams.json'), 'utf-8');
    return JSON.parse(data);
}

function requireLogin(req, res, next) {
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
                <img src="/images/logo.png" alt="Logo" class="logo-large-margin">
                <h1>Musíš se přihlásit</h1>
                <p>Pro zobrazení této stránky je nutné přihlášení.</p>
                <a href="/auth/login" class="btn">Přejít na přihlášení</a>
            </body>
            </html>
        `);
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user !== 'Admin') {
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
                <img src="/images/logo.png" alt="Logo" class="logo-large-margin">
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
        const fs = require('fs');
        const teamBonusData = JSON.parse(fs.readFileSync('./data/teamBonuses.json', 'utf8'));
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

function evaluateRegularSeasonTable(season, liga) {
    const fs = require('fs');

    // 1. Načtení dat
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const teams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf8')).filter(t => t.active && t.liga === liga);
    const users = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    const isMultigroup = allSeasonData[season]?.leagues.find(l => l.name === liga)?.isMultigroup || false;

    let tableTips = {};
    try { tableTips = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8')); } catch (e) {}

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
        const teamBonusData = JSON.parse(fs.readFileSync('./data/teamBonuses.json', 'utf8'));
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
    users.forEach(user => {
        let userTipData = tableTips?.[season]?.[liga]?.[user.username];
        if (!userTipData) return;

        // Kvůli zpětné kompatibilitě (pole vs objekt)
        if (Array.isArray(userTipData)) {
            userTipData = { "default": userTipData };
        }

        let totalCorrect = 0;
        let totalDeviation = 0;

        Object.keys(groupedTeamsReal).forEach(gKey => {
            const userGroupTip = userTipData[gKey] || [];
            const realTeamsInGroup = groupedTeamsReal[gKey];

            realTeamsInGroup.forEach((realTeam) => {
                const realRank = globalRealRankMap[realTeam.id];

                // Zabrání bugu, kdy JS hledá string "12" a nenajde int 12
                const userIndexNum = userGroupTip.indexOf(Number(realTeam.id));
                const userIndexStr = userGroupTip.indexOf(String(realTeam.id));
                const finalUserIndex = userIndexNum !== -1 ? userIndexNum : userIndexStr;

                if (finalUserIndex !== -1) {
                    const diff = Math.abs((finalUserIndex + 1) - realRank);
                    totalDeviation += diff;
                    if (diff === 0) totalCorrect++;
                } else {
                    totalDeviation += realTeamsInGroup.length; // Penalizace, pokud tým v tipu úplně chybí
                }
            });
        });

        if (!user.stats) user.stats = {};
        if (!user.stats[season]) user.stats[season] = {};
        if (!user.stats[season][liga]) user.stats[season][liga] = {};

        user.stats[season][liga].tableCorrect = totalCorrect;
        user.stats[season][liga].tableDeviation = totalDeviation;
    });

    fs.writeFileSync('./data/users.json', JSON.stringify(users, null, 2));
}

function renderErrorHtml(res, message, code = 500) {
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

function getTableMode(req, isRegularSeasonFinished) {
    let mode = isRegularSeasonFinished ? 'playoff' : 'regular'; // Výchozí stav

    if (req.query.tableMode === 'regular' || req.query.tableMode === 'playoff') {
        if (req.session) req.session.userTableMode = req.query.tableMode;
        mode = req.query.tableMode;
    } else if (req.session && req.session.userTableMode) {
        mode = req.session.userTableMode;
    }

    return mode;
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
    renameLeagueGlobal,
    evaluateRegularSeasonTable,
    renderErrorHtml,
    getTableMode,
}