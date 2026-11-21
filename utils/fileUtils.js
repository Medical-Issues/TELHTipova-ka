require('fs');
require("path");
require("fs");
const { Teams, Users, Matches, Leagues, AllowedLeagues, ChosenSeason, Settings, TeamBonuses, LeagueStatus, TableTips, Playoff, PlayoffTemplates, Transfers, TransferLeagues} = require('./mongoDataAccess');
const { renderPlayoffBracket } = require('./playoffBracket');
const brand = require('./imageBranding');
const { drawBrandedBackground } = brand;
const {
    calculateClinchStatusesForGroup,
    calculateCrossGroupClinchStatuses
} = require('./clinchStatus');
const { calculateZoneProbabilities } = require('./zoneProbability');
const { getStandingsCriteria, rankTeams } = require('./standings');

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
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Přihlášení vyžadováno – Tipovačka</title>
                <link rel="stylesheet" href="/css/modern-design.css" />
                <link rel="icon" href="/images/logo.png">
            </head>
            <body class="login_body">
                <div class="login-container">
                    <img src="/images/logo.png" alt="Logo" class="login-logo">
                    <h1>Musíte se přihlásit</h1>
                    <p class="login-subtitle">Pro zobrazení této stránky je nutné mít aktivní přihlášení.</p>
                    <a href="/auth/login" class="login_button" style="text-align:center; text-decoration:none;">Přejít na přihlášení ➔</a>
                </div>
            </body>
            </html>
        `);
    }
    next();
}

async function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.role !== 'admin') {
        // Logování neoprávněného přístupu s warning severity (ne critical podle požadavku uživatele)
        const username = req.session.user || 'anonymous';
        const path = req.path || req.originalUrl;
        
        logAdminAction(username, "UNAUTHORIZED_ADMIN_ACCESS", `Neoprávněný pokus o přístup k admin endpointu: ${path}`, 'admin', null, req, 'warning', false);
        
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
        let correctRegular = 0;
        let playoffBO1Correct = 0;
        let playoffBO1Tips = 0;
        let playoffBOSeriesCorrect = 0;
        let playoffBOSeriesTips = 0;

        for (const tip of tipsInSeason) {
            const match = matches.find(m => m.id === tip.matchId);
            // Pokud zápas nemá výsledek nebo vítěze, přeskakujeme
            if (!match?.result || !match.result.winner) continue;

            // ---------------------------------------------------------
            // 1. PLAYOFF BO1 (Jeden zápas)
            // ---------------------------------------------------------
            if (match.isPlayoff && Number(match.bo) === 1) {
                totalPlayoff++;
                playoffBO1Tips++;

                const realHome = Number(match.result.scoreHome ?? 0);
                const realAway = Number(match.result.scoreAway ?? 0);

                // Ošetření různých názvů proměnných v datech
                let tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                let tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);

                // OPRAVA: Pokud je zápas s prohozenými stranami, prohodíme tipy uživatele
                // (protože tipoval před prohozením, ale výsledek je uložen po prohození)
                if (match.result?.sideSwap === true) {
                    const temp = tipHome;
                    tipHome = tipAway;
                    tipAway = temp;
                }

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
                    playoffBO1Correct++;
                } else {
                    const delta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);

                    if (delta === 1) correctPoints += 4;
                    else if (delta === 2) correctPoints += 3;
                    else correctPoints += 1; // Delta 3 a více
                    playoffBO1Correct++;
                }

                continue;
            }

            // ---------------------------------------------------------
            // 2. PLAYOFF BO > 1 (Série na více vítězných map)
            // ---------------------------------------------------------
            if (match.isPlayoff && Number(match.bo) > 1) {
                totalPlayoff++;
                playoffBOSeriesTips++;

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
                playoffBOSeriesCorrect++;

                continue;
            }

            // ---------------------------------------------------------
            // 3. OBYČEJNÝ ZÁPAS (Regular Season)
            // ---------------------------------------------------------
            if (!match.isPlayoff) {
                totalRegular++;
                // OPRAVA: Pokud je zápas s prohozenými stranami, invertujeme vítěze tipu před porovnáním
                let evaluatedWinner = tip.winner;
                if (match.result?.sideSwap === true) {
                    evaluatedWinner = tip.winner === 'home' ? 'away' : 'home';
                }
                if (evaluatedWinner === match.result.winner) {
                    correctPoints += 1;
                    correctRegular++;
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
        user.stats[season][liga].correctRegular = correctRegular;
        user.stats[season][liga].playoffBO1Correct = playoffBO1Correct;
        user.stats[season][liga].playoffBO1Tips = playoffBO1Tips;
        user.stats[season][liga].playoffBOSeriesCorrect = playoffBOSeriesCorrect;
        user.stats[season][liga].playoffBOSeriesTips = playoffBOSeriesTips;
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

function parseTableTipsLockTime(value) {
    if (!value) return null;

    const rawValue = String(value).trim();
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(rawValue)) {
        const date = new Date(rawValue);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    const match = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
    if (!match) return null;

    const [, year, month, day, hour, minute, second = '0', millisecond = '0'] = match;
    const localTimeAsUtc = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        Number(millisecond.padEnd(3, '0'))
    );
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Prague',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    });

    let timestamp = localTimeAsUtc;
    for (let i = 0; i < 2; i++) {
        const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
            .filter(part => part.type !== 'literal')
            .map(part => [part.type, Number(part.value)]));
        const formattedAsUtc = Date.UTC(
            parts.year,
            parts.month - 1,
            parts.day,
            parts.hour,
            parts.minute,
            parts.second
        );
        timestamp = localTimeAsUtc - (formattedAsUtc - Math.floor(timestamp / 1000) * 1000);
    }

    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? null : date;
}

// Funkce pro kontrolu a aplikaci časovačů uzamčení tabulek (stejný princip jako u zápasů)
async function checkAndApplyTableTipsLockers(season, liga) {
    try {
        const allSeasonData = await Leagues.findAll();
        const statusData = await getLeagueStatusData();
        const now = new Date();
        let lockTriggered = false;

        const league = allSeasonData[season]?.leagues.find(l => l.name === liga);
        if (!league) return;

        const globalLockTime = league.tableTipsLockDateTime;
        const groupTimers = league.tableTipsLockTimer || {};

        // Kontrola globálního časovače
        if (globalLockTime) {
            const lockTime = parseTableTipsLockTime(globalLockTime);
            if (lockTime && now >= lockTime) {
                const currentLockStatus = statusData[season]?.[liga]?.tableTipsLocked;
                if (currentLockStatus !== true) {
                    if (!statusData[season]) statusData[season] = {};
                    if (!statusData[season][liga]) statusData[season][liga] = {};
                    statusData[season][liga].tableTipsLocked = true;

                    // Smazání časovače po spuštění
                    league.tableTipsLockDateTime = '';
                    await Leagues.replaceAll(allSeasonData);
                    await LeagueStatus.replaceAll(statusData);

                    console.log(`🔒 Automaticky zamčeno (globální): ${liga} v ${now.toISOString()}`);
                    lockTriggered = true;
                }
            }
        }

        // Kontrola skupinových časovačů
        for (const group in groupTimers) {
            const lockTimeStr = groupTimers[group];
            if (!lockTimeStr) continue;

            const lockTime = parseTableTipsLockTime(lockTimeStr);
            if (!lockTime) continue;

            if (now >= lockTime) {
                const currentLockStatus = statusData[season]?.[liga]?.tableTipsLocked;
                let shouldLock = false;

                let lockedGroups = [];
                if (Array.isArray(currentLockStatus)) {
                    lockedGroups = [...currentLockStatus];
                } else if (currentLockStatus === true) {
                    const totalGroups = league.groupCount || 1;
                    for (let i = 1; i <= totalGroups; i++) {
                        lockedGroups.push(String(i));
                    }
                }

                if (!lockedGroups.includes(group)) {
                    lockedGroups.push(group);
                    const totalGroups = league.groupCount || lockedGroups.length;
                    if (lockedGroups.length === totalGroups && totalGroups > 0) {
                        if (!statusData[season]) statusData[season] = {};
                        if (!statusData[season][liga]) statusData[season][liga] = {};
                        statusData[season][liga].tableTipsLocked = true;
                    } else {
                        if (!statusData[season]) statusData[season] = {};
                        if (!statusData[season][liga]) statusData[season][liga] = {};
                        statusData[season][liga].tableTipsLocked = lockedGroups;
                    }
                    shouldLock = true;
                }

                if (shouldLock) {
                    // Smazání časovače po spuštění
                    delete league.tableTipsLockTimer[group];
                    await Leagues.replaceAll(allSeasonData);
                    await LeagueStatus.replaceAll(statusData);

                    console.log(`🔒 Automaticky zamčeno (skupina): ${liga} - Skupina ${group} v ${now.toISOString()}`);
                    lockTriggered = true;
                }
            }
        }

        if (lockTriggered) {
            // Vyhodnocení tabulky po uzamčení
            await evaluateRegularSeasonTable(season, liga);
        }
    } catch (error) {
        console.error('❌ Chyba při kontrole časovačů uzamčení tabulek:', error);
    }
}

async function checkAllTableTipsLockers() {
    const allSeasonData = await Leagues.findAll();
    for (const [season, seasonData] of Object.entries(allSeasonData || {})) {
        for (const league of seasonData?.leagues || []) {
            const hasGlobalTimer = Boolean(league.tableTipsLockDateTime);
            const hasGroupTimer = Object.values(league.tableTipsLockTimer || {}).some(Boolean);
            if (hasGlobalTimer || hasGroupTimer) {
                await checkAndApplyTableTipsLockers(season, league.name);
            }
        }
    }
}

async function evaluateRegularSeasonTable(season, liga, groupKey = null, isForLeftPanel = false) {
    // Nejprve zkontrolujeme časovače (stejně jako u zápasů se kontroluje datetime při každém requestu)
    await checkAndApplyTableTipsLockers(season, liga);

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
    const leagueObj = allSeasonData[season]?.leagues.find(l => l.name === liga) || {};
    const isMultigroup = leagueObj.isMultigroup || false;
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
        t.stats[season].points = scores[t.id]?.points || 0; // OPRAVA: Bezpečné přiřazení
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
        const rankedTeams = rankTeams(groupedTeamsReal[gKey], {
            season,
            matches,
            liga,
            scores,
            criteria: getStandingsCriteria(leagueObj, 'group')
        });
        rankedTeams.forEach((team, index) => {
            globalRealRankMap[team.id] = index + 1;
        });
    });

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
            <title>Chyba ${code} – Tipovačka</title>
            <link rel="stylesheet" href="/css/modern-design.css" />
            <link rel="icon" href="/images/logo.png">
        </head>
        <body class="login_body">
            <div class="login-container">
                <img src="/images/logo.png" alt="Logo" class="login-logo">
                <h1>Jejda, chyba ${code}</h1>
                <p class="login-subtitle">${message}</p>
                <a href="javascript:history.back()" class="login_button" style="text-align:center; text-decoration:none;">➔ Zpět</a>
            </div>
        </body>
        </html>
    `);
}

async function getTableMode(req, isRegularSeasonFinished, leagueObj, playoffData, isHistory = false) {
    // 1. Priorita: Co je v URL (pokud uživatel klikne na tlačítko)
    if (req.query.tableMode === 'regular' || req.query.tableMode === 'playoff') {
        return req.query.tableMode;
    }

    // 2. Default: Pokud v URL nic není, rozhodne stav ligy
    const hasPlayoffTable = playoffData && Object.keys(playoffData).length > 0;
    if (isHistory) {
        return hasPlayoffTable ? 'playoff' : 'regular';
    }

    // V aktuálním režimu: hotovo -> playoff, probíhá -> regular
    if (isRegularSeasonFinished && hasPlayoffTable) {
        return 'playoff';
    }
    return 'regular';
}
// --- POMOCNÉ ČTECÍ FUNKCE (Vlož nahoru do fileUtils.js) ---
async function getChosenSeason() {
    try { 
        const season = await ChosenSeason.findAll();
        return season || "Neurčeno"; 
    } catch (e) { 
        console.error('❌ Chyba v getChosenSeason:', e);
        return "Neurčeno"; 
    }
}
async function loadTeams() {
    try { 
        const allTeams = await Teams.findAll();
        // Vracíme všechny AKTIVNÍ týmy bez ohledu na sezónu
        return allTeams.filter(t => t.active);
    } catch (e) { 
        console.error('❌ Chyba v loadTeams:', e);
        return []; 
    }
}
async function getMatches() {
    try { return await Matches.findAll(); } catch (e) { return []; }
}
async function getAllowedLeagues(season = null) {
    try {
        const data = await AllowedLeagues.findAll();
        // Pokud je zadána sezóna, vrátíme ligy pro tu sezónu
        if (season && data[season]) {
            return data[season] || [];
        }
        // Pokud není zadána sezóna, vrátíme všechny ligy ze všech sezón (pro zpětnou kompatibilitu)
        // nebo prázdné pole, pokud chceme striktní sezónní chování
        return [];
    } catch (e) { return []; }
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

    // 1. Zjištění sezóny (pokud jsme v historii nebo exportéru, bereme z URL, jinak globální)
    let selectedSeason = await getChosenSeason();
    if ((isHistory || isImageExporter) && req.query.season) {
        selectedSeason = req.query.season;
    }
    
    // 2. Načtení základních dat a filtrování podle aktuální sezóny
    const allTeams = await loadTeams();
    const allMatches = await getMatches();
    
    // Filtrování týmy a zápasů pouze pro aktuální sezónu
    // Změněno: Zobrazíme AKTIVNÍ týmy POUZE z aktuální sezóny (týmy bez sezóny se nezobrazí)
    const teams = allTeams.filter(t => {
        // Hlavní podmínka: tým musí být aktivní A patřit do aktuální sezóny
        const isActive = t.active === true;
        const isInSelectedSeason = t.season === selectedSeason;
        
        return isActive && isInSelectedSeason;
    });
    const matches = allMatches.filter(m => m.season === selectedSeason);
    
    const allowedLeagues = await getAllowedLeagues(selectedSeason);
    const allSeasonData = await getLeaguesData();
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];

    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const leaguesFromLeagues = [...new Set(leagues.map(l => l.name))];
    // OPRAVA: Prioritizovat pořadí z definice lig - nejprve definice, pak doplnit z týmů a zápasů
    const allLeagues = [...new Set([...leaguesFromLeagues, ...leaguesFromTeams, ...leaguesFromMatches])];

    const uniqueLeagues = isHistory || isImageExporter
        ? allLeagues
        : allLeagues.filter(l => allowedLeagues.includes(l));

    // Načtení defaultní ligy z Settings
    let defaultLeagueForSeason = null;
    try {
        const settingsData = await getSettingsData();
        defaultLeagueForSeason = settingsData?.defaultLeague?.[selectedSeason];
    } catch (e) {}

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga)
        ? req.query.liga
        : (defaultLeagueForSeason && uniqueLeagues.includes(defaultLeagueForSeason) ? defaultLeagueForSeason : (uniqueLeagues[0] || "Neurčeno"));

    const teamsInSelectedLiga = teams.filter(t =>
    t.liga && (
        t.liga === selectedLiga ||
        t.liga === selectedLiga.trim() ||
        t.liga.toLowerCase() === selectedLiga.toLowerCase()
    )
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

    // OPRAVA: Přepočet statistik týmů z aktuálních zápasů pro levý panel
    // Týmům se nastaví wins, otWins, otLosses, losses podle zápasů v sezóně/lize
    const teamStatsFromMatches = {};
    teamsInSelectedLiga.forEach(t => {
        teamStatsFromMatches[t.id] = { points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0, gf: 0, ga: 0 };
    });
    
    // Projít všechny zápasy a spočítat statistiky
    matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga && !m.isPlayoff && m.result).forEach(m => {
        const homeId = m.homeTeamId;
        const awayId = m.awayTeamId;
        if (!teamStatsFromMatches[homeId] || !teamStatsFromMatches[awayId]) return;
        
        const r = m.result;
        const sH = parseInt(r.scoreHome);
        const sA = parseInt(r.scoreAway);
        const ot = !!r.ot;
        
        // Góly
        teamStatsFromMatches[homeId].gf += sH;
        teamStatsFromMatches[homeId].ga += sA;
        teamStatsFromMatches[awayId].gf += sA;
        teamStatsFromMatches[awayId].ga += sH;
        
        // Určit vítěze
        let winner;
        if (sH === sA) {
            if (ot && (r.overtimeWinner === 'home' || r.overtimeWinner === 'away')) {
                winner = r.overtimeWinner;
            } else {
                // Remíza bez OT - oba dostanou 1 bod
                teamStatsFromMatches[homeId].points += 1;
                teamStatsFromMatches[awayId].points += 1;
                return;
            }
        } else {
            winner = sH > sA ? 'home' : 'away';
        }
        
        // Přidělit body a statistiky
        if (winner === 'home') {
            if (ot) {
                teamStatsFromMatches[homeId].points += 2;
                teamStatsFromMatches[homeId].otWins++;
                teamStatsFromMatches[awayId].points += 1;
                teamStatsFromMatches[awayId].otLosses++;
            } else {
                teamStatsFromMatches[homeId].points += 3;
                teamStatsFromMatches[homeId].wins++;
                teamStatsFromMatches[awayId].losses++;
            }
        } else {
            if (ot) {
                teamStatsFromMatches[awayId].points += 2;
                teamStatsFromMatches[awayId].otWins++;
                teamStatsFromMatches[homeId].points += 1;
                teamStatsFromMatches[homeId].otLosses++;
            } else {
                teamStatsFromMatches[awayId].points += 3;
                teamStatsFromMatches[awayId].wins++;
                teamStatsFromMatches[homeId].losses++;
            }
        }
    });

    teamsInSelectedLiga.forEach(t => {
        if (!t.stats) t.stats = {};
        if (!t.stats[selectedSeason]) t.stats[selectedSeason] = { points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0 };

        // Použít statistiky vypočtené ze zápasů
        const calculatedStats = teamStatsFromMatches[t.id] || { points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0, gf: 0, ga: 0 };
        let bonusEntry = teamBonusData[selectedSeason]?.[selectedLiga]?.[t.id] || { points: 0, games: 0 };
        if (typeof bonusEntry === 'number') bonusEntry = { points: bonusEntry, games: 0 };

        // Nastavit vypočtené statistiky + bonusy
        t.stats[selectedSeason].points = calculatedStats.points + (bonusEntry.points || 0);
        t.stats[selectedSeason].wins = calculatedStats.wins;
        t.stats[selectedSeason].otWins = calculatedStats.otWins;
        t.stats[selectedSeason].otLosses = calculatedStats.otLosses;
        t.stats[selectedSeason].losses = calculatedStats.losses;
        
        // Uložit gf/ga pro zobrazení v tabulce
        t.stats[selectedSeason].gf = calculatedStats.gf + (bonusEntry.gf || 0);
        t.stats[selectedSeason].ga = calculatedStats.ga + (bonusEntry.ga || 0);
        
        // Pro částečně zamčené ligy zachovat body z databáze pro tipování
        // Ale pro levý panel vždy zobrazit aktuální stav
        
        t.stats[selectedSeason].manualGames = bonusEntry.games || 0;
        t.stats[selectedSeason].tiebreaker = bonusEntry.tiebreaker || 0;
    });

    // Aktualizace scores objektu pro generateLeftPanel
    teamsInSelectedLiga.forEach(t => {
        if (!scores[t.id]) scores[t.id] = { gf: 0, ga: 0 };
        scores[t.id].gf = t.stats[selectedSeason].gf || 0;
        scores[t.id].ga = t.stats[selectedSeason].ga || 0;
    });

    // 5. Rozdělení do skupin
    const teamsByGroup = {};
    const groupedTeams = {};

    teamsInSelectedLiga.forEach((team) => {
        // OPRAVA: Pro jednoskupinové ligy ignorujeme hodnotu team.group z databáze
        // Jinak by tým z multigroup ligy (např. TELH skupina B) mohl být v samostatné skupině v jednoskupinové lize
        const groupLetter = leagueObj.isMultigroup && team.group ? String.fromCharCode(team.group + 64) : 'X';
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
        
        // OPRAVA: Vytvoříme kopii týmů před sortováním pro konzistentní minitabulku
        teamsByGroup[group] = rankTeams(teamsByGroup[group], {
            season: selectedSeason,
            matches,
            liga: selectedLiga,
            scores,
            criteria: getStandingsCriteria(
                leagueObj,
                isRegularSeasonFinished ? 'group' : 'groupInProgress'
            )
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

    const tableMode = await getTableMode(req, isRegularSeasonFinished, leagueObj, playoffData, isHistory);
    const referencedSeriesIds = new Set(
        Object.entries(playoffData || {})
            .map(([, value]) => String(value).match(/^series-(\d+)$/)?.[1])
            .map(id => Number(id))
            .filter(id => Number.isFinite(id))
    );
    const bracketMatches = allMatches.filter(match =>
        (match.season === selectedSeason && match.liga === selectedLiga) || referencedSeriesIds.has(Number(match.id))
    );
    const bracketNameTeams = [];
    const seenNameIds = new Set();
    const mappedLeagueByTeamId = new Map();
    Object.entries(playoffData || {}).forEach(([slotId, value]) => {
        const matchId = String(value).match(/^series-(\d+)$/)?.[1];
        if (!matchId) return;
        const match = allMatches.find(item => Number(item.id) === Number(matchId));
        if (!match) return;
        ['t1', 't2'].forEach(suffix => {
            const storedId = Number(playoffData[`${slotId}_${suffix}id`]);
            const id = storedId || Number(suffix === 't1' ? match.homeTeamId : match.awayTeamId);
            const savedName = playoffData[`${slotId}_${suffix}`];
            let league = playoffData[`${slotId}_${suffix}league`];
            if (!league && savedName) {
                const namedTeam = allTeams.find(team =>
                    Number(team.id) === id &&
                    team.season === selectedSeason &&
                    team.name === savedName
                );
                league = namedTeam?.liga;
            }
            if (id && league && [Number(match.homeTeamId), Number(match.awayTeamId)].includes(id)) {
                mappedLeagueByTeamId.set(id, league);
            }
        });
    });
    bracketMatches.forEach(match => {
        [match.homeTeamId, match.awayTeamId].forEach(rawId => {
            const id = Number(rawId);
            if (!Number.isFinite(id) || seenNameIds.has(id)) return;
            const mappedLeague = mappedLeagueByTeamId.get(id);
            const alreadyListed = teams.some(team =>
                Number(team.id) === id && (!mappedLeague || team.liga === mappedLeague)
            );
            if (alreadyListed) return;
            seenNameIds.add(id);
            const candidates = allTeams.filter(team =>
                Number(team.id) === id && team.name
            );
            const preferred = candidates.find(team =>
                team.season === selectedSeason && team.liga === mappedLeague
            ) || candidates.find(team =>
                team.season === selectedSeason && team.liga === selectedLiga
            ) || candidates.find(team =>
                team.liga === mappedLeague
            ) || candidates.find(team =>
                team.liga === selectedLiga
            ) || candidates[0];
            if (preferred) bracketNameTeams.push(preferred);
        });
    });

    // --- PŘIDÁNO: Načtení dat pro PŘESTUPY ---
    let activeTransferLeagues = [];
    try { activeTransferLeagues = await getActiveTransferLeagues(); } catch(e) {}

    let transfersData = {};
    try { transfersData = await getTransfersData(); } catch(e) {}
    const currentTransfers = transfersData[selectedSeason]?.[selectedLiga] || {};

    // 8. Pravděpodobnosti zón (Monte Carlo simulace) - přeskočeno pro skončenou sezónu
    const zoneProbabilities = {};
    if (!isRegularSeasonFinished) {
        try {
            for (const group of sortedGroups) {
                const teamsInGroup = teamsByGroup[group];
                if (!teamsInGroup || teamsInGroup.length === 0) continue;
                const probs = calculateZoneProbabilities(
                    teamsInGroup,
                    leagueObj,
                    matches,
                    selectedSeason,
                    selectedLiga,
                    scores,
                    { simulations: 10000 }
                );
                zoneProbabilities[group] = {};
                probs.forEach((prob, teamId) => {
                    zoneProbabilities[group][teamId] = prob;
                });
            }
        } catch (e) {
            console.error('Chyba při výpočtu pravděpodobností zón:', e);
        }
    }

    // Všechna "vysátá" data pošleme zpět
    return {
        username, selectedSeason, selectedLiga, uniqueLeagues, teamsInSelectedLiga, matches,
        clinchMode, tableMode, isRegularSeasonFinished, isTipsLocked,
        leagueObj, sortedGroups, teamsByGroup, sortedGroupKeys, groupedTeams,
        globalRealRankMap, userStats, currentUserStats,
        userTipData, currentUserMatchTips, playoffData, bracketMatches, bracketNameTeams, scores, allUsers, teams,
        activeTransferLeagues, currentTransfers, tableTips, leagues, // <-- TOTO JSME PŘIDALI NA KONEC
        zoneProbabilities
    };
}

async function generateStatsHtml(username, currentUserStats, userStats) {
    if (!username) return ''; // Pokud není uživatel přihlášený, statistiky se neukazují

    const isTableEvaluated = currentUserStats?.tableCorrect > 0 || currentUserStats?.tableDeviation > 0;

    let html = `
    <!-- 1. MOJE STATISTIKY -->
    <section class="user_stats modern-stats-card">
        <div class="stats-card-header" style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <div class="stats-card-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                Tvoje statistiky
            </div>
            <button type="button" class="btn-recent-activity" onclick="openRecentActivityModal()" title="Zobrazit přehled tvých nedávných bodů">
                ⚡ Nedávné body
            </button>
        </div>
        
        ${currentUserStats ? `
            <div class="user-stats-grid">
                <!-- Zápasy box 1 -->
                <div class="user-stat-box">
                    <div class="user-stat-label">Vyhodnocené zápasy</div>
                    <div class="user-stat-val">${currentUserStats.correct} <span class="user-stat-sub">/ ${currentUserStats.total}</span></div>
                    <div class="user-stat-pct">${(currentUserStats.total > 0 ? ((currentUserStats.correct / currentUserStats.total) * 100).toFixed(1) : '0.0')}% úspěšnost</div>
                </div>
                
                <!-- Zápasy box 2 (Volitelný) -->
                ${currentUserStats.total !== currentUserStats.maxFromTips ? `
                <div class="user-stat-box">
                    <div class="user-stat-label">Z tipovaných zápasů</div>
                    <div class="user-stat-val">${currentUserStats.correct} <span class="user-stat-sub">/ ${currentUserStats.maxFromTips}</span></div>
                    <div class="user-stat-pct">${(currentUserStats.maxFromTips > 0 ? ((currentUserStats.correct / currentUserStats.maxFromTips) * 100).toFixed(1) : '0.0')}% úspěšnost</div>
                </div>` : ''}

                <!-- Tabulka ZČ Box 1: Body za přesné pozice -->
                <div class="user-stat-box ${isTableEvaluated ? 'highlight' : ''}">
                    <div class="user-stat-label">Tabulka ZČ — Pozice</div>
                    <div class="user-stat-val">${isTableEvaluated ? currentUserStats.tableCorrect : '-'} <span class="user-stat-sub">bodů</span></div>
                    <div class="user-stat-pct">${isTableEvaluated ? 'Přesné zásahy týmů' : 'Čeká na vyhodnocení'}</div>
                </div>

                <!-- Tabulka ZČ Box 2: Celková odchylka -->
                <div class="user-stat-box ${isTableEvaluated ? 'highlight' : ''}">
                    <div class="user-stat-label">Tabulka ZČ — Odchylka</div>
                    <div class="user-stat-val">${isTableEvaluated ? currentUserStats.tableDeviation : '-'} <span class="user-stat-sub">b</span></div>
                    <div class="user-stat-pct">${isTableEvaluated ? 'Celková chyba tipu (Méně = lépe)' : 'Čeká na vyhodnocení'}</div>
                </div>
            </div>
        ` : `<p style="color: var(--text-dim); padding: 10px 0;">Nemáš pro tuto sezónu/ligu žádná data.</p>`}
    </section>
    
    <!-- 2. HLAVNÍ ŽEBŘÍČEK: ZÁPASY -->
    <section class="global_stats modern-stats-card" style="margin-top: 20px;">
        <div class="stats-card-header">
            <div class="stats-card-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
                Statistiky zápasů (Živý žebříček)
            </div>
        </div>
        <div class="table-responsive-wrapper">
            <table class="points-table stats-overview-table">
                <thead>
                    <tr>
                        <th class="position">Místo</th>
                        <th>Uživatel</th>
                        <th style="text-align: center;">Úspěšnost</th>
                        <th style="text-align: center;">Body Zápasy</th>
                        <th style="text-align: center;">ZČ</th>
                        <th style="text-align: center;">PO</th>
                    </tr>
                </thead>
                <tbody>`;

    // Řazení pro zápasový žebříček
    const matchStatsList = [...userStats].sort((a, b) => b.correct - a.correct);

    matchStatsList.forEach((user, index) => {
        const successRate = user.total > 0 ? ((user.correct / user.total) * 100).toFixed(1) : '0.0';
        const successRateOverall = user.maxFromTips > 0 ? ((user.correct / user.maxFromTips) * 100).toFixed(1) : '0.0';
        const isCurrent = user.username === username;

        html += `
            <tr class="${isCurrent ? 'current-user-row' : ''}">
                <td class="rank-cell"><span class="rank-badge rank-${index + 1}">${index + 1}.</span></td>
                <td><a href="javascript:void(0)" class="user-profile-link" onclick="openUserProfileModal('${user.username}')" title="Zobrazit profil a vzájemný duel"><strong style="color: ${isCurrent ? 'var(--primary)' : '#fff'};">${user.username}${isCurrent ? ' (ty)' : ''}</strong></a></td>
                <td class="numbers" style="text-align: center; color: var(--accent-green); font-weight: 700;">${successRateOverall}%${user.total !== user.maxFromTips ? `<span style="font-size:10px; color:var(--text-dim); margin-left:2px;">(${successRate}%)</span>` : ''}</td>
                <td class="points numbers" style="text-align: center;"><span class="points-pill">${user.correct} b</span></td>
                <td class="numbers" style="text-align: center;">${user.totalRegular ?? 0}</td>
                <td class="numbers" style="text-align: center;">${user.totalPlayoff ?? 0}</td>
            </tr>`;
    });

    html += `
                </tbody>
            </table>
        </div>
    </section>

    <!-- 3. DRUHÁ TABULKA: VYHODNOCENÍ TABULKY ZČ -->
    <section class="global_stats modern-stats-card" style="margin-top: 20px;">
        <div class="stats-card-header">
            <div class="stats-card-title">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>
                Vyhodnocení tipů na Celkovou Tabulku ZČ
            </div>
        </div>
        <div class="table-responsive-wrapper">
            <table class="points-table stats-overview-table">
                <thead>
                    <tr>
                        <th class="position">Místo</th>
                        <th>Uživatel</th>
                        <th style="text-align: center;">Body (Přesné pozice)</th>
                        <th style="text-align: center;">Celková odchylka</th>
                    </tr>
                </thead>
                <tbody>`;

    // Řazení pro Tipovačku tabulky: Nejdřív přesné body (b.tableCorrect - a.tableCorrect), pak odchylka (a.tableDeviation - b.tableDeviation)
    const tableStatsList = [...userStats].sort((a, b) => {
        if ((b.tableCorrect || 0) !== (a.tableCorrect || 0)) {
            return (b.tableCorrect || 0) - (a.tableCorrect || 0);
        }
        return (a.tableDeviation || 0) - (b.tableDeviation || 0);
    });

    tableStatsList.forEach((user, index) => {
        const isCurrent = user.username === username;
        const hasEvaluated = user.tableCorrect > 0 || user.tableDeviation > 0;

        html += `
            <tr class="${isCurrent ? 'current-user-row' : ''}">
                <td class="rank-cell"><span class="rank-badge rank-${index + 1}">${index + 1}.</span></td>
                <td><a href="javascript:void(0)" class="user-profile-link" onclick="openUserProfileModal('${user.username}')" title="Zobrazit profil a vzájemný duel"><strong style="color: ${isCurrent ? 'var(--primary)' : '#fff'};">${user.username}${isCurrent ? ' (ty)' : ''}</strong></a></td>
                <td class="points numbers" style="text-align: center;">
                    ${hasEvaluated ? `<span class="pts-pill pts-purple">+${user.tableCorrect || 0} b</span>` : '<span style="color:var(--text-dim);">-</span>'}
                </td>
                <td class="numbers" style="text-align: center; color: ${hasEvaluated ? 'var(--text-main)' : 'var(--text-dim)'}; font-weight: 600;">
                    ${hasEvaluated ? `${user.tableDeviation} <span style="font-size:10px; color:var(--text-dim);">(chyba)</span>` : '-'}
                </td>
            </tr>`;
    });

    html += `
                </tbody>
            </table>
        </div>
    </section>

    <!-- 4. PRAVIDLA BODODVÁNÍ -->
    <section class="modern-stats-card" style="margin-top: 20px;">
        <div class="scoring-rules-wrapper">
            <!-- 1. PRAVIDLA PRO ZÁPASY -->
            <div class="section-title" style="margin-bottom: 16px;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                Bodování zápasů
            </div>

            <div class="scoring-cards-grid" style="margin-bottom: 24px;">
                <!-- Základní část -->
                <div class="scoring-card">
                    <div class="scoring-card-header">
                        <span class="scoring-icon">🏒</span>
                        <h4>Základní část</h4>
                    </div>
                    <ul class="scoring-list">
                        <li>
                            <span>Správný tip vítěze zápasu</span>
                            <span class="pts-pill pts-blue">+1 b</span>
                        </li>
                    </ul>
                </div>

                <!-- Playoff BO1 -->
                <div class="scoring-card highlight-card">
                    <div class="scoring-card-header">
                        <span class="scoring-icon">🎯</span>
                        <h4>Playoff — Zápas (BO1)</h4>
                    </div>
                    <ul class="scoring-list">
                        <li>
                            <span>Vítěz + přesné skóre</span>
                            <span class="pts-pill pts-gold">+5 b</span>
                        </li>
                        <li>
                            <span>Vítěz + odchylka 1 gól</span>
                            <span class="pts-pill pts-green">+4 b</span>
                        </li>
                        <li>
                            <span>Vítěz + odchylka 2 góly</span>
                            <span class="pts-pill pts-amber">+3 b</span>
                        </li>
                        <li>
                            <span>Vítěz + odchylka 3+ gólů</span>
                            <span class="pts-pill pts-blue">+1 b</span>
                        </li>
                    </ul>
                </div>

                <!-- Playoff Série -->
                <div class="scoring-card">
                    <div class="scoring-card-header">
                        <span class="scoring-icon">🏆</span>
                        <h4>Playoff — Série</h4>
                    </div>
                    <ul class="scoring-list">
                        <li>
                            <span>Vítěz série + přesné skóre zápasů</span>
                            <span class="pts-pill pts-amber">+3 b</span>
                        </li>
                        <li>
                            <span>Vítěz série (špatný počet zápasů)</span>
                            <span class="pts-pill pts-blue">+1 b</span>
                        </li>
                    </ul>
                </div>
            </div>

            <!-- 2. PRAVIDLA PRO CELKOVOU TABULKU -->
            <div class="section-title" style="margin-bottom: 16px;">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>
                Vyhodnocení celkové tabulky (Sezónní bonus)
            </div>

            <div class="table-scoring-container">
                <div class="scoring-card table-card">
                    <div class="scoring-card-header">
                        <span class="scoring-icon">📊</span>
                        <h4>Tip na konečné pořadí základní části</h4>
                        <span class="season-badge">Vyhodnocuje se po ZČ</span>
                    </div>
                    <div class="table-scoring-content">
                        <div class="table-score-item">
                            <div class="table-score-info">
                                <strong>Přesná pozice týmu v tabulce</strong>
                                <small>Uděluje se za každý tým, jehož přesné konečné umístění uhádneš.</small>
                            </div>
                            <span class="pts-pill pts-purple">+1 b / tým</span>
                        </div>
                        
                        <div class="table-score-divider"></div>

                        <div class="table-score-item">
                            <div class="table-score-info">
                                <strong>Celková odchylka tipu (Kritérium pro remízy)</strong>
                                <small>Součet absolutních rozdílů mezi tvým tipem a reálným umístěním všech týmů. Nižší číslo znamená přesnější tip.</small>
                            </div>
                            <span class="pts-pill pts-subtle">Sčítá se (Méně = Lépe)</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>`;

    return html;
}

function formatZoneProb(prob, isClinched, isLocked, isSeasonFinished = false) {
    // Pokud je clinched - 100% (jen když sezóna není skončená)
    if (!isSeasonFinished && (isClinched || isLocked)) return 100;
    
    // Pro skončenou sezónu - vrať reálná procenta bez capů
    if (isSeasonFinished) {
        return Math.round(prob);
    }
    
    // Reálná procenta s 2 desetinnými místy pro krajní hodnoty
    if (prob >= 99.99) return 99.99;
    if (prob <= 0.01) return 0.01;
    if (prob > 99 || prob < 1) return Math.round(prob * 100) / 100;
    
    // Normální rozsah - celé číslo
    return Math.round(prob);
}

async function generateLeftPanel(data, isHistory = false) {
    const {
        username, selectedSeason, selectedLiga, teamsInSelectedLiga,
        matches, bracketMatches, bracketNameTeams, clinchMode, tableMode, isRegularSeasonFinished,
        leagueObj, sortedGroups, teamsByGroup, playoffData, scores,
        currentUserStats, userStats, teams, globalRealRankMap, leagues: seasonLeagues,
        zoneProbabilities
    } = data;

    const lockedTeamIds = new Set();

    let html = `
    <section class="stats-container">
    <div class="left-panel">
    
    <div style="display: flex; flex-direction: row; justify-content: center; margin: 12px 0 18px; text-align: center; gap: 8px;">
        <a href="?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}&mode=${clinchMode}&tableMode=regular" 
           class="segmented-btn ${tableMode === 'regular' ? 'active' : ''}">
           Základní část
        </a>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}&mode=${clinchMode}&tableMode=playoff" 
           class="segmented-btn ${tableMode === 'playoff' ? 'active' : ''}">
           Playoff
        </a>
    </div>

    <div id="regularTable" style="display:${tableMode === 'regular' ? 'block' : 'none'};">
        <div class="clinch-switch">
            <span>Logika obarvování:</span>
            <a href="?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}&mode=strict&tableMode=${tableMode}" 
               class="mini-pill ${clinchMode === 'strict' ? 'active' : ''}">
               Striktní (Jistá meta)
            </a>
            <a href="?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}&mode=cascade&tableMode=${tableMode}" 
               class="mini-pill ${clinchMode === 'cascade' ? 'active' : ''}">
               Kaskádová (Minimální meta)
            </a>
        </div>
    `;

    const crossGroupTeams = [];
    const escapeHtmlAttribute = value => String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
    const getRecentTeamForm = (team) => (matches || [])
        .filter(match => {
            const result = match.result;
            if (result?.scoreHome === undefined || result.scoreHome === null || result.scoreHome === '' ||
                result.scoreAway === undefined || result.scoreAway === null || result.scoreAway === '') {
                return false;
            }
            const scoreHome = Number(result?.scoreHome);
            const scoreAway = Number(result?.scoreAway);
            return match.season === selectedSeason &&
                match.liga === selectedLiga &&
                !match.isPlayoff &&
                result &&
                Number.isFinite(scoreHome) &&
                Number.isFinite(scoreAway) &&
                Number.isFinite(new Date(match.datetime || match.date).getTime()) &&
                (Number(match.homeTeamId) === Number(team.id) || Number(match.awayTeamId) === Number(team.id));
        })
        .sort((a, b) => new Date(b.datetime || b.date) - new Date(a.datetime || a.date))
        .slice(0, 10)
        .map(match => {
            const isScheduledHome = Number(match.homeTeamId) === Number(team.id);
            const sideSwapped = match.result.sideSwap === true;
            const teamIsScoredAsHome = isScheduledHome !== sideSwapped;
            const scoreHome = Number(match.result.scoreHome);
            const scoreAway = Number(match.result.scoreAway);
            const teamScore = teamIsScoredAsHome ? scoreHome : scoreAway;
            const opponentScore = teamIsScoredAsHome ? scoreAway : scoreHome;
            const opponentId = Number(match.homeTeamId) === Number(team.id) ? match.awayTeamId : match.homeTeamId;
            const opponentName = teams.find(opponent => Number(opponent.id) === Number(opponentId))?.name || 'Soupeř';
            const won = teamScore > opponentScore;
            const overtime = Boolean(match.result.ot);
            const outcome = won ? (overtime ? 'overtime-win' : 'win') : (overtime ? 'overtime-loss' : 'loss');
            const resultTitle = won ? (overtime ? 'Výhra po prodloužení' : 'Výhra') : (overtime ? 'Prohra po prodloužení' : 'Prohra');

            return {
                outcome,
                label: overtime ? (won ? 'Vp' : 'Pp') : (won ? 'V' : 'P'),
                overtime,
                score: `${teamScore}:${opponentScore}`,
                title: `vs ${opponentName} · ${teamScore}:${opponentScore} · ${resultTitle}`
            };
        });

    // ==========================================
    // 1. ZÁKLADNÍ TABULKY (Skupiny)
    // ==========================================
    for (const group of sortedGroups) {
        const teamsInGroup = teamsByGroup[group];

        await evaluateRegularSeasonTable(selectedSeason, selectedLiga, group, true);

        if (leagueObj.crossGroupTable && leagueObj.crossGroupPosition > 0) {
            const targetIndex = leagueObj.crossGroupPosition - 1;
            if (teamsInGroup[targetIndex]) {
                crossGroupTeams.push({
                    ...teamsInGroup[targetIndex],
                    groupRank: targetIndex + 1
                });
            }
        }

        html += `
        <table class="points-table standings-table">
        <colgroup>
            <col style="width: 7%">
            <col style="width: 41%">
            <col style="width: 11%">
            <col style="width: 9%">
            <col style="width: 7%">
            <col style="width: 5%">
            <col style="width: 5%">
            <col style="width: 5%">
            <col style="width: 5%">
            <col style="width: 5%">
        </colgroup>
        <thead>
        <tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} ${selectedSeason} Základní část ${leagueObj?.isMultigroup ? `(Skupina ${group})` : ''}</h2></th></tr>
        <tr id="points-table-second-header"><th class="position">Místo</th><th style="text-align: left; padding-left: 25px">Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
        </thead>
        <tbody>`;

        const teamsWithStatuses = calculateClinchStatusesForGroup(
            teamsInGroup,
            leagueObj,
            selectedSeason,
            clinchMode,
            scores,
            matches,
            selectedLiga
        );

        teamsWithStatuses.forEach((team, index) => {
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0) + (stats.manualGames || 0);
            const {
                currentZone,
                locked,
                clinchedQF,
                clinchedPlayin,
                clinchedRelegation,
                clinchedNeutral
            } = team._clinchStatus;
            let rowClass = currentZone;

            if (locked) lockedTeamIds.add(Number(team.id));
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
            const teamLogoUrl = team.logo ? `/logoteamu/${team.logo}` : '';

            const recentForm = getRecentTeamForm(team);

            // Pravděpodobnosti zón - zobrazujeme Top 4 a Top 12 s ohledem na clinch
            const zoneProb = zoneProbabilities?.[group]?.[Number(team.id)];
            const clinchStatus = team._clinchStatus;
            const hasPlayin = leagueObj?.playin > leagueObj?.quarterfinal;
            const hasPlayoffZones = (leagueObj?.quarterfinal > 0) || (leagueObj?.playin > 0);
            const qfProb = zoneProb && hasPlayoffZones ? formatZoneProb(zoneProb.quarterfinal, clinchStatus?.clinchedQF, clinchStatus?.locked, isRegularSeasonFinished) : 0;
            const top12Prob = zoneProb && hasPlayin && hasPlayoffZones ? formatZoneProb(zoneProb.quarterfinal + zoneProb.playin, clinchStatus?.clinchedPlayin || clinchStatus?.clinchedQF, clinchStatus?.locked, isRegularSeasonFinished) : 0;
            let zoneProbHtml = '';
            let rowStyle = '';
            if (zoneProb && hasPlayoffZones && !isRegularSeasonFinished && (qfProb > 0 || top12Prob > 0)) {
                const probTitle = hasPlayin 
                    ? `Top 4: ${zoneProb.quarterfinal}% | Top 12: ${zoneProb.quarterfinal + zoneProb.playin}% | Neutral: ${zoneProb.neutral}% | Sestup: ${zoneProb.relegation}%\n\nVypočítáno pomocí Monte Carlo simulace (10 000 iterací). Pravděpodobnost, že tým skončí v dané zóně na základě zbývajících zápasů.`
                    : `Top 4: ${zoneProb.quarterfinal}% | Neutral: ${zoneProb.neutral}% | Sestup: ${zoneProb.relegation}%\n\nVypočítáno pomocí Monte Carlo simulace (10 000 iterací). Pravděpodobnost, že tým skončí v dané zóně na základě zbývajících zápasů.`;
                const pills = [];
                if (qfProb > 0) pills.push(`<span class="zone-prob-pill zone-prob-qf" data-tooltip="${escapeHtmlAttribute(probTitle)}" tabindex="0">${qfProb}%</span>`);
                if (hasPlayin && top12Prob > 0) pills.push(`<span class="zone-prob-pill zone-prob-top12" data-tooltip="${escapeHtmlAttribute(probTitle)}" tabindex="0">${top12Prob}%</span>`);
                zoneProbHtml = `<span class="zone-prob-badge">${pills.join('')}</span>`;
                // Dvojitý gradient: žlutá pro Top 4, zelená pro Top 12
                const isClinched = rowClass.includes('clinched-') || rowClass.includes('locked');
                const qfColor = isClinched ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 193, 7, 0.25)';
                const top12Color = isClinched ? 'rgba(255, 255, 255, 0.08)' : 'rgba(76, 175, 80, 0.15)';
                rowStyle = hasPlayin 
                    ? `style="background: linear-gradient(to right, ${qfColor} ${qfProb}%, ${top12Color} ${qfProb}%, ${top12Color} ${top12Prob}%, transparent ${top12Prob}%);"`
                    : `style="background: linear-gradient(to right, ${qfColor} ${qfProb}%, transparent ${qfProb}%);"`;
            }

            html += `<tr class="${rowClass} zone-prob-row" ${rowStyle}>
                <td class="rank-cell ${rankClass}"><span class="rank-badge">${index + 1}.</span></td>
                <td>
                    <div class="team-cell">
                        ${teamLogoUrl ? `<img src="${teamLogoUrl}" alt="" class="team-logo-small">` : ''}
                        <div class="team-cell-content">
                            <div class="team-cell-main"><span>${team.name}</span>${zoneProbHtml}</div>
                            ${recentForm.length ? `
                                <div class="team-recent-form" aria-label="Forma: posledních ${recentForm.length} zápasů">
                                    <div class="team-recent-form-results">
                                        <span class="team-recent-form-label">FORMA</span>
                                        ${recentForm.map(result => `<span class="team-form-result ${result.outcome}" data-tooltip="${escapeHtmlAttribute(result.title)}" tabindex="0">${result.label}</span>`).join('')}
                                    </div>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </td>
                <td class="points numbers"><span class="points-pill">${myPoints}</span></td>
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

        const rankedCrossGroupTeams = rankTeams(crossGroupTeams, {
            season: selectedSeason,
            matches,
            liga: selectedLiga,
            scores,
            criteria: getStandingsCriteria(leagueObj, 'crossGroup')
        });
        crossGroupTeams.splice(0, crossGroupTeams.length, ...rankedCrossGroupTeams);

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

        const crossGroupStatuses = calculateCrossGroupClinchStatuses(crossGroupTeams, {
            season: selectedSeason,
            leagueObj,
            matches,
            liga: selectedLiga,
            quarterfinal: cQfLimit,
            advancing: cTotalAdvancing,
            relegation: cRelLimit,
            clinchMode,
            isRegularSeasonFinished,
            estimateTeamCount: leagueObj.isMultigroup
                ? teamsInSelectedLiga.length / (leagueObj.groupCount || 1)
                : teamsInSelectedLiga.length,
            scores
        });

        crossGroupStatuses.forEach((team, index) => {
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0) + (stats.manualGames || 0);
            const teamStats = scores[team.id] || {gf:0, ga:0};
            const goalDiff = teamStats.gf - teamStats.ga;
            const {
                currentZone,
                locked: cLocked,
                clinchedQF: cSafeQF,
                clinchedPlayin: cSafePlayin,
                clinchedRelegation: cRelegated,
                clinchedNeutral: cNeutralLocked
            } = team._clinchStatus;

            let rowClass = currentZone;
            if (cRelegated) rowClass = 'clinched-relegation';
            else if (cNeutralLocked) rowClass = 'clinched-neutral';
            else if (cSafePlayin) rowClass = 'clinched-playin';
            else if (cSafeQF) rowClass = 'clinched-quarterfinal';
            if (cLocked) rowClass += ' locked';

            const teamLogoUrl = team.logo ? `/logoteamu/${team.logo}` : '';


            html += `<tr class="${rowClass}">
                <td class="rank-cell ${currentZone}"><span class="rank-badge">${index + 1}</span></td>
                <td>
                    <div class="team-cell">
                        ${teamLogoUrl ? `<img src="${teamLogoUrl}" alt="" class="team-logo-small">` : ''}
                        <span>${team.name}</span>
                    </div>
                </td>
                <td class="points numbers"><span class="points-pill">${myPoints}</span></td>
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
    // 3. PLAYOFF TABULKA (PAVOUK)
    // ==========================================
    const format = leagueObj?.playoffFormat || 'none';
    const allTemplates = await PlayoffTemplates.findAll();
    const currentTemplate = format !== 'none' ? (allTemplates?.[format] || null) : null;
    let zoneFaces = null;
    if (currentTemplate && currentTemplate.rules && Object.keys(currentTemplate.rules).length > 0) {
        try {
            const { collectZonePreview } = require('./playoffEditor');
            zoneFaces = collectZonePreview({
                season: selectedSeason,
                league: selectedLiga,
                template: currentTemplate,
                positionConfig: '',
                savedSlots: playoffData || {},
                teamsInLeague: teamsInSelectedLiga,
                teamsByGroup,
                lockedIds: lockedTeamIds,
                seasonTeams: teams,
                leagues: (seasonLeagues || []),
                templates: allTemplates,
                playoffData: playoffData || {},
                matches: bracketMatches || matches,
                calculateClinchStatusesForGroup,
                clinchMode
            });
        } catch (e) {
            console.error('Chyba při výpočtu zónového náhledu playoff pro uživatele:', e);
        }
    }

    html += renderPlayoffBracket({
        template: currentTemplate,
        savedSlots: playoffData || {},
        matches: bracketMatches || matches,
        teams,
        nameTeams: bracketNameTeams || [],
        scores,
        zoneFaces,
        ranks: globalRealRankMap || null,
        historical: isHistory,
        selectedSeason,
        selectedLiga,
        leagueObj,
        visible: tableMode === 'playoff'
    });

    // ==========================================
    // 4. PROGRESS BAR
    // ==========================================
    if (!isHistory) {
        let filledMatches = matches.filter(m => m.result && m.isPlayoff === false && m.liga === selectedLiga && m.season === selectedSeason).length;
        const totalManualGames = teamsInSelectedLiga.reduce((sum, t) => sum + (t.stats?.[selectedSeason]?.manualGames || 0), 0);
        filledMatches += Math.floor(totalManualGames / 2);
        const percentage = leagueObj.maxMatches > 0 ? Math.round((filledMatches / leagueObj.maxMatches) * 100) : 0;

        html += `
        <section class="progress-section">
            <div class="progress-header">
                <div class="progress-title">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
                    Odehráno zápasů v základní části
                </div>
                <div class="progress-stats-text">${filledMatches} / ${leagueObj.maxMatches || '?'} <span style="color: var(--accent-green); margin-left: 4px;">(${percentage}%)</span></div>
            </div>
            <div class="progress-container">
                <div class="progress-bar" style="width:${percentage}%;"></div>
            </div>
            <p id="progress-text" style="display:none;"></p>
        </section>
        `;
    }

    // ==========================================
    // 5. STATISTIKY UŽIVATELŮ
    // ==========================================
    html += await generateStatsHtml(username, currentUserStats, userStats);

    html += `
    </div> </section> `;

    return html;
}

async function logAdminAction(username, action, details, entity = 'admin', entityId = null, req = null, severity = 'info', success = true) {
    const AuditLog = require('../models/AuditLog');
    await AuditLog.log(username, action, entity, entityId, details, req, severity, 'admin', success);
}

async function logUserAction(username, action, details, entity = 'user', entityId = null, req = null, severity = 'info', success = true) {
    const AuditLog = require('../models/AuditLog');
    await AuditLog.log(username, action, entity, entityId, details, req, severity, 'user', success);
}

async function generateTimeWidget() {
    return `
    <span id="live-date" style="text-transform: uppercase; font-weight: 600; font-size: 11px; color: var(--text-dim); letter-spacing: 0.5px;"></span>
    <span style="opacity: 0.3; margin: 0 4px;">•</span>
    <span id="live-clock" style="font-weight: 700; color: #fff; font-family: 'JetBrains Mono', monospace; font-size: 12px;"></span>
    <script>
        function updateLiveTime() {
            const now = new Date();
            const dateStr = now.toLocaleDateString('cs-CZ', {
                timeZone: 'Europe/Prague',
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric'
            });
            const timeStr = now.toLocaleTimeString('cs-CZ', {
                timeZone: 'Europe/Prague',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            const dateEl = document.getElementById('live-date');
            const clockEl = document.getElementById('live-clock');
            if (dateEl) dateEl.textContent = dateStr.toUpperCase();
            if (clockEl) clockEl.textContent = timeStr;
        }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                updateLiveTime();
                setInterval(updateLiveTime, 1000);
            });
        } else {
            updateLiveTime();
            setInterval(updateLiveTime, 1000);
        }
    </script>
    `;
}

async function drawWatermark(ctx, width, height, settings = {}) {
    await brand.drawWatermark(ctx, width, height, settings);
}

async function createMatchImage(homeTeam, awayTeam, scoreHome = null, scoreAway = null, title = null, withWatermark = true, seriesData = null, customSettings = {}) {
    const { createCanvas } = require('canvas');
    const isResult = scoreHome !== null && scoreAway !== null;
    const width = isResult ? 1000 : 800;
    const height = isResult ? 600 : 500;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const theme = brand.resolveTheme(customSettings);

    await drawBrandedBackground(ctx, width, height, customSettings);

    if (!isResult) {
        await brand.drawMatchupLayout(ctx, width, height, homeTeam, awayTeam, theme, { kicker: title || 'ZÁPAS' });
    } else {
        const homeName = homeTeam?.name || 'Domácí';
        const awayName = awayTeam?.name || 'Hosté';
        const homeWon = Number(scoreHome) > Number(scoreAway);
        const awayWon = Number(scoreAway) > Number(scoreHome);
        const bottomLines = [{
            text: homeWon ? `VÍTĚZ  ·  ${homeName}` : awayWon ? `VÍTĚZ  ·  ${awayName}` : 'REMÍZA',
            color: homeWon ? theme.accentColor : awayWon ? theme.awayColor : theme.textColor
        }];
        if (seriesData) {
            bottomLines.push({ text: `STAV SÉRIE  ${seriesData.homeWins} : ${seriesData.awayWins}`, color: theme.gold, size: 15 });
        }
        await brand.drawMatchupLayout(ctx, width, height, homeTeam, awayTeam, theme, {
            kicker: title || 'KONEČNÝ VÝSLEDEK',
            center: { type: 'score', scoreHome, scoreAway, label: 'SKÓRE ZÁPASU' },
            bottomLines,
            highlight: homeWon ? 'home' : awayWon ? 'away' : null
        });
    }

    if (withWatermark) {
        await drawWatermark(ctx, width, height, customSettings);
    }

    return canvas.toBuffer('image/png');
}

async function createTransferImage(team1, team2, playerName = null, withWatermark = true, playerPhotoPath = null, customFromLogoBase64 = null, customToLogoBase64 = null, customSettings = {}) {
    const { createCanvas } = require('canvas');
    const width = 800;
    const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const theme = brand.resolveTheme(customSettings);
    const accentColor = theme.accentColor;

    await drawBrandedBackground(ctx, width, height, customSettings);
    brand.drawHeader(ctx, theme, { x: width / 2, y: 30, kicker: 'PŘESTUP', align: 'center', maxWidth: 300 });

    const cardW = 290;
    const cardH = 262;
    const cardY = 62;
    const sides = [
        { team: team1, cx: 36 + cardW / 2, label: 'ODCHOD', color: brand.withAlpha(theme.textColor, 0.55), logo: customFromLogoBase64 },
        { team: team2, cx: width - 36 - cardW / 2, label: 'PŘÍCHOD', color: accentColor, logo: customToLogoBase64 }
    ];

    brand.drawGlow(ctx, sides[1].cx, cardY + cardH / 2, 330, accentColor, 0.18);

    for (const side of sides) {
        brand.drawCard(ctx, side.cx - cardW / 2, cardY, cardW, cardH, { color: side.color });
        brand.drawText(ctx, side.label, side.cx, cardY + 24, { size: 11, color: theme.muted, align: 'center' });
        await brand.drawTeamLogo(ctx, side.team, side.cx, cardY + 112, 140, {
            color: accentColor,
            textColor: theme.textColor,
            customLogo: side.logo && side.logo.startsWith('data:image') ? side.logo : null
        });
        brand.drawText(ctx, (side.team?.name || '???').toLocaleUpperCase('cs-CZ'), side.cx, cardY + 208, { size: 18, minSize: 12, color: theme.textColor, align: 'center', maxWidth: cardW - 36 });
        if (side.team?.liga) {
            brand.drawText(ctx, side.team.liga.toLocaleUpperCase('cs-CZ'), side.cx, cardY + 234, { size: 12, color: accentColor, align: 'center', maxWidth: cardW - 36 });
        }
    }

    brand.drawBadge(ctx, width / 2, cardY + 112, 39, theme, '→');

    if (playerPhotoPath) {
        const playerImg = await brand.loadImageSource(playerPhotoPath);
        if (playerImg) {
            const photoSize = 76;
            const cx = width / 2;
            const cy = cardY + 210;
            ctx.save();
            ctx.beginPath();
            ctx.arc(cx, cy, photoSize / 2, 0, Math.PI * 2);
            ctx.closePath();
            ctx.clip();
            const ratio = Math.max(photoSize / playerImg.width, photoSize / playerImg.height);
            const nw = playerImg.width * ratio;
            const nh = playerImg.height * ratio;
            ctx.drawImage(playerImg, cx - nw / 2, cy - nh / 2, nw, nh);
            ctx.restore();
            ctx.strokeStyle = accentColor;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(cx, cy, photoSize / 2, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    if (playerName) {
        brand.drawText(ctx, playerName, width / 2, cardY + cardH + 30, { size: 20, minSize: 13, color: theme.textColor, align: 'center', maxWidth: 380 });
    }

    if (withWatermark) {
        await drawWatermark(ctx, width, height, customSettings);
    }

    return canvas.toBuffer('image/png');
}


async function createWinnerImage(winnerTeam, title, withWatermark = true, options = {}, customSettings = {}) {
    const { createCanvas } = require('canvas');
    const width = 800;
    const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const theme = brand.resolveTheme(customSettings);
    const { accentColor = theme.accentColor, showTrophy = true } = options;

    await drawBrandedBackground(ctx, width, height, customSettings);
    await brand.drawWinnerLayout(ctx, width, height, winnerTeam, theme, { title: title || 'VÍTĚZ', showTrophy, accentColor });

    if (withWatermark) {
        await drawWatermark(ctx, width, height, customSettings);
    }

    return canvas.toBuffer('image/png');
}

// Helper function to convert hex to rgba
async function createStandingsImage(teamsData, title, withWatermark = true, options = {}, customSettings = {}) {
    const { createCanvas } = require('canvas');
    const width = 950;
    
    // Custom nastavení barev
    const accentColor = customSettings.accentColor || '#ff4500';
    const textColor = customSettings.textColor || '#ffffff';
    
    // Options with defaults - MUST be first before using these values
    const {
        isPlayoff = false,
        quarterfinal = 0,
        playin = 0,
        relegation = 0,
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
    const headerHeight = 125;
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
    await drawBrandedBackground(ctx, width, height, customSettings);

    const theme = brand.resolveTheme(customSettings);
    brand.drawFrame(ctx, width, height, theme);
    const headerBottom = brand.drawHeader(ctx, theme, { x: 36, y: 34, kicker: isPlayoff ? 'TABULKA · PLAYOFF' : 'TABULKA', title: title || 'Tabulka', maxWidth: width - 100 });

    // Legend for zones
    let legendY = headerBottom + 20;
    if (!isPlayoff && (quarterfinal > 0 || playin > 0 || relegation > 0)) {
        let x = 36;
        const legendItem = (color, label) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.roundRect(x, legendY - 5, 10, 10, 3);
            ctx.fill();
            brand.drawText(ctx, label, x + 16, legendY, { size: 12, weight: 'normal', color: theme.soft });
            x += 16 + ctx.measureText(label).width + 24;
        };
        if (quarterfinal > 0) legendItem(theme.gold, 'Aktuálně čtvrtfinále');
        if (playin > 0 && playin > quarterfinal) legendItem(theme.cyan, 'Aktuálně předkolo');
        if (relegation > 0) legendItem(theme.danger, 'Aktuálně baráž');
        legendY += 20;
        brand.drawText(ctx, '„Jisté“ ve sloupci Stav = matematicky zajištěná pozice.', 36, legendY, { size: 11, weight: 'normal', color: theme.muted });
        legendY += 12;
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
            clinchedQF: false,
            clinchedPlayin: false,
            clinchedRelegation: false,
            clinchedNeutral: false
        };
    };

    // Render each group
    let currentY = legendY + 25;
    
    sortedGroups.forEach((group) => {
        const groupTeams = teamsByGroup[group];
        
        // Group header for multi-group leagues
        if (isMultiGroup) {
            brand.drawCard(ctx, 30, currentY - 5, width - 60, 30, { fill: theme.tableHeader, radius: 8, color: accentColor, stripe: 'left' });
            brand.drawText(ctx, `SKUPINA ${group}`.toLocaleUpperCase('cs-CZ'), width / 2, currentY + 10, { size: 14, color: accentColor, align: 'center' });
            currentY += 35;
        }
        
        // Header row
        const headerY = currentY;
        brand.drawTableHeaderRow(ctx, 30, headerY, width - 60, 36, theme);
        ctx.fillStyle = theme.soft;
        ctx.font = brand.font(11);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText('#', 40, headerY + 18);
        ctx.fillText('TÝM', 75, headerY + 18);
        ctx.textAlign = 'center';
        ctx.fillText('Z', 380, headerY + 18);
        ctx.fillText('V', 415, headerY + 18);
        ctx.fillText('VPP', 450, headerY + 18);
        ctx.fillText('PPP', 490, headerY + 18);
        ctx.fillText('P', 525, headerY + 18);
        ctx.fillText('SKÓRE', 590, headerY + 18);
        ctx.fillText('BODY', 660, headerY + 18);
        if (!isPlayoff && (quarterfinal > 0 || playin > 0 || relegation > 0)) {
            ctx.textAlign = 'right';
            ctx.fillText('POSTUP / BARÁŽ', 910, headerY + 18);
        }

        // Team rows
        let y = headerY + 50;
        groupTeams.forEach((team, index) => {
            // Get clinch status (per group)
            const status = !isPlayoff && (quarterfinal > 0 || playin > 0 || relegation > 0)
                ? calculateClinchStatus(team, index, groupTeams.length)
                : null;

            // Row tint reflects current position; the status text distinguishes it from a clinched outcome.
            let zoneColor = null;
            if (status) {
                if (status.currentZone === 'quarterfinal') zoneColor = theme.gold;
                else if (status.currentZone === 'playin') zoneColor = theme.cyan;
                else if (status.currentZone === 'relegation') zoneColor = theme.danger;
            }
            brand.drawTableRow(ctx, 30, y - 12, width - 60, 30, index, theme, zoneColor ? brand.withAlpha(zoneColor, 0.09) : null);
            if (zoneColor) {
                ctx.fillStyle = zoneColor;
                ctx.fillRect(30, y - 12, 3, 30);
            }

            // Position color coding (within group)
            const pos = index + 1;
            let posColor = textColor;
            if (status) {
                if (status.currentZone === 'quarterfinal') posColor = theme.gold;
                else if (status.currentZone === 'playin') posColor = theme.cyan;
                else if (status.currentZone === 'relegation') posColor = theme.danger;
                else posColor = textColor;
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
            brand.drawText(ctx, displayName, 75, y + 3, { size: 15, minSize: 12, color: textColor, maxWidth: 280 });

            // Zone probability badge
            if (team._zoneProb && team._zoneProb.quarterfinal > 0) {
                const probText = team._zoneProb.quarterfinal + '%';
                ctx.font = 'bold 11px Arial';
                ctx.fillStyle = theme.gold;
                ctx.textAlign = 'left';
                const nameWidth = ctx.measureText(displayName).width;
                ctx.fillText(probText, 75 + nameWidth + 8, y + 3);
            }

            // Stats
            ctx.textAlign = 'center';
            ctx.fillStyle = theme.soft;
            ctx.font = brand.font(14, 'normal');
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

            ctx.fillStyle = accentColor;
            ctx.font = 'bold 16px Arial';
            ctx.fillText(String(team.points || 0), 660, y + 3);
            
            // Status column
            if (status) {
                ctx.font = '12px Arial';
                let statusText;
                let statusColor = theme.muted;
                
                if (status.clinchedQF) {
                    statusText = 'Jisté: čtvrtfinále';
                    statusColor = theme.gold;
                } else if (status.clinchedPlayin) {
                    statusText = 'Jisté: předkolo';
                    statusColor = theme.cyan;
                } else if (status.clinchedRelegation) {
                    statusText = 'Jistá baráž';
                    statusColor = theme.danger;
                } else if (status.clinchedNeutral) {
                    statusText = 'Jisté: bez baráže';
                    statusColor = theme.success;
                } else if (status.currentZone === 'quarterfinal') {
                    statusText = 'Na pozici ČF';
                    statusColor = theme.gold;
                } else if (status.currentZone === 'playin') {
                    statusText = 'Na pozici předkola';
                    statusColor = theme.cyan;
                } else if (status.currentZone === 'relegation') {
                    statusText = 'Ohrožen baráží';
                    statusColor = theme.danger;
                } else if (status.locked) {
                    statusText = 'Pozice uzamčena';
                    statusColor = '#aeb7c6';
                } else {
                    statusText = quarterfinal > 0 || playin > 0
                        ? 'Mimo postupové zóny'
                        : relegation > 0 ? 'Mimo barážovou zónu' : 'Mimo zóny';
                }
                
                if (statusText) {
                    ctx.fillStyle = statusColor;
                    ctx.textAlign = 'right';
                    ctx.fillText(statusText, 910, y + 3, 190);
                }
            }

            y += 30;
        });
        
        currentY = y + (isMultiGroup ? 20 : 0);
    });

    if (withWatermark) {
        await drawWatermark(ctx, width, height, customSettings);
    }

    return canvas.toBuffer('image/png');
}

async function createStatisticsImage(usersStats, title, withWatermark = true, customSettings = {}) {
    const { createCanvas } = require('canvas');
    const width = 980;
    const headerY = 112;
    const headerHeight = 42;
    const rowHeight = 52;
    const tableBottom = headerY + headerHeight + usersStats.length * rowHeight;
    const height = Math.max(300, tableBottom + 76);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const theme = brand.resolveTheme(customSettings);
    const accentColor = theme.accentColor;
    const textColor = theme.textColor;

    await drawBrandedBackground(ctx, width, height, customSettings);
    brand.drawFrame(ctx, width, height, theme);
    brand.drawHeader(ctx, theme, {
        x: 36,
        y: 34,
        kicker: 'STATISTIKY',
        title: title || 'Statistiky tipujících',
        maxWidth: width - 260,
        meta: `${usersStats.length} ${usersStats.length === 1 ? 'tipující' : 'tipujících'}`,
        metaX: width - 40
    });

    brand.drawTableHeaderRow(ctx, 30, headerY, width - 60, headerHeight, theme);

    const columns = [
        { label: '#', x: 62, align: 'center' },
        { label: 'TIPUJÍCÍ', x: 96, align: 'left' },
        { label: 'ÚSPĚŠNOST', x: 438, align: 'center' },
        { label: 'BODY', x: 544, align: 'center' },
        { label: 'ZČ', x: 630, align: 'center' },
        { label: 'PO', x: 700, align: 'center' },
        { label: 'TREFENÉ POZICE', x: 804, align: 'center' },
        { label: 'ODCHYLKA', x: 916, align: 'center' }
    ];
    ctx.fillStyle = theme.soft;
    ctx.font = brand.font(11);
    ctx.textBaseline = 'middle';
    columns.forEach(column => {
        ctx.textAlign = column.align;
        ctx.fillText(column.label, column.x, headerY + headerHeight / 2);
    });

    usersStats.forEach((user, index) => {
        const rowY = headerY + headerHeight + index * rowHeight;
        const centerY = rowY + rowHeight / 2;
        const podiumColor = [theme.gold, theme.silver, theme.bronze][index] || null;
        brand.drawTableRow(ctx, 30, rowY, width - 60, rowHeight, index, theme, podiumColor ? brand.withAlpha(podiumColor, 0.06) : null);
        if (podiumColor) {
            ctx.fillStyle = podiumColor;
            ctx.fillRect(30, rowY, 3, rowHeight - 1);
        }

        brand.drawText(ctx, String(index + 1), 62, centerY, { size: 16, color: podiumColor || theme.muted, align: 'center' });
        brand.drawText(ctx, user.username || 'Neznámý uživatel', 96, centerY, { size: 15, minSize: 12, color: textColor, maxWidth: 300 });

        const successRate = user.total > 0 ? ((user.correct / user.total) * 100).toFixed(1) : '0.0';
        ctx.textAlign = 'center';
        ctx.fillStyle = theme.soft;
        ctx.font = brand.font(14, 'normal');
        ctx.fillText(successRate + '%', 438, centerY);
        ctx.fillStyle = accentColor;
        ctx.font = brand.font(16);
        ctx.fillText(String(user.correct || 0), 544, centerY);
        ctx.fillStyle = theme.soft;
        ctx.font = brand.font(14, 'normal');
        ctx.fillText(String(user.totalRegular || 0), 630, centerY);
        ctx.fillText(String(user.totalPlayoff || 0), 700, centerY);
        ctx.fillText(String(user.tableCorrect || 0), 804, centerY);
        ctx.fillText(String(user.tableDeviation || 0), 916, centerY);
    });

    brand.drawText(ctx, 'ZČ = základní část · PO = playoff · Odchylka = součet rozdílů v pořadí týmů', 36, tableBottom + 24, { size: 11, weight: 'normal', color: theme.muted, maxWidth: width - 140 });

    if (withWatermark) {
        await drawWatermark(ctx, width, height, customSettings);
    }

    return canvas.toBuffer('image/png');
}

async function createPlayoffBracketImage(data, withWatermark = true, customSettings = {}) {
    const { createCanvas } = require('canvas');
    const { playoffData, matches, teams, selectedLiga, title, standings } = data;
    
    // Custom nastavení barev
    const accentColor = customSettings.accentColor || '#ff4500';
    const textColor = customSettings.textColor || '#ffffff';
    
    const savedSlots = playoffData || {};
    
    // Canvas dimensions - larger overall
    let width = 1800;
    let height = 1000;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Background
    await drawBrandedBackground(ctx, width, height, customSettings);
    
    const theme = brand.resolveTheme(customSettings);
    brand.drawFrame(ctx, width, height, theme, 22);
    brand.drawHeader(ctx, theme, { x: 44, y: 40, kicker: 'PLAYOFF', title: title || `Playoff · ${selectedLiga}`, maxWidth: width - 140 });
    
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

                let scoreH = 0;
                let scoreA = 0;
                if (match.result) {
                    scoreH = match.result.scoreHome;
                    scoreA = match.result.scoreAway;
                } else if (match.playedMatches && match.playedMatches.length > 0) {
                    match.playedMatches.forEach(pm => {
                        if (pm.scoreHome > pm.scoreAway) scoreH++;
                        else if (pm.scoreAway > pm.scoreHome) scoreA++;
                    });
                }
                const winsNeeded = (Number(match.bo) || 1) > 1 ? Math.ceil((Number(match.bo) || 1) / 2) : 1;
                let homeWins = false;
                let awayWins = false;

                if (Number(match.bo) === 1) { // Speciální logika pro BO1 zápasy
                    if (scoreH > scoreA) {
                        homeWins = true;
                    } else if (scoreA > scoreH) {
                        awayWins = true;
                    }
                    // Pokud je skóre shodné (např. 0:0, 1:1), žádný tým není označen jako vítěz, protože to není konečný stav pro playoff BO1.
                } else { // Pro BO > 1 (série), použij standardní logiku počítání vyhraných map
                    homeWins = scoreH >= winsNeeded;
                    awayWins = scoreA >= winsNeeded;
                }

                const isFinished = homeWins || awayWins; // Pravda, pokud jeden tým vyhrál sérii
                const isOngoing = !isFinished && (scoreH > 0 || scoreA > 0); // Pravda, pokud zápas není dokončen, ale má nějaké skóre
                
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
                    isWaiting: false,
                    isFinished,
                    isOngoing,
                    home: homeTeam.name, away: awayTeam.name,
                    scoreH, scoreA,
                    homeWins, awayWins,
                    bo: Number(match.bo) || 1,
                    winsNeeded,
                    homeSeed, awaySeed
                };
            }
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
        const statusColor = seriesInfo && !seriesInfo.isWaiting ? accentColor : theme.faint;
        brand.drawCard(ctx, x, y, w, h, {
            fill: theme.cardStrong,
            radius: 12,
            color: statusColor,
            stripe: 'left',
            border: brand.withAlpha(statusColor, 0.45)
        });
        ctx.textBaseline = 'middle';
        
        if (seriesInfo) {
            const teamRowHeight = 22;
            const topPadding = 8;

            // Helper to draw team row with seed
            function drawTeamRow(teamName, seed, isWinner, rowY) {
                ctx.font = 'bold 14px Arial';
                ctx.textAlign = 'left';
                ctx.fillStyle = isWinner ? accentColor : textColor;
                
                // Seed indicator on the left
                if (seed) {
                    ctx.fillStyle = theme.muted;
                    ctx.font = 'bold 12px Arial';
                    ctx.fillText(`(${seed})`, x + 6, rowY);
                    ctx.fillStyle = isWinner ? accentColor : textColor;
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
            ctx.fillStyle = accentColor;
            ctx.font = 'bold 18px Arial';
            ctx.fillText(`${seriesInfo.scoreH} : ${seriesInfo.scoreA}`, x + w - 8, y + h/2 + 15);
            
            // Status text below score (small, clean)
            let statusColor = '#94a3b8';
            let statusText = '';
            if (seriesInfo.isFinished) {
                statusColor = accentColor;
                statusText = 'Konec';
            } else if (seriesInfo.isOngoing) {
                statusColor = accentColor;
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
                ctx.fillStyle = accentColor;
                ctx.font = 'bold 14px Arial';
                ctx.fillText('>>', x + w - 8, y + topPadding + 10);
            }
            if (seriesInfo.awayWins) {
                ctx.textAlign = 'right';
                ctx.fillStyle = accentColor;
                ctx.font = 'bold 14px Arial';
                ctx.fillText('>>', x + w - 8, y + topPadding + teamRowHeight + 10);
            }
            
            // Individual match scores (if available and enough space)
            if (seriesInfo.playedMatches && seriesInfo.playedMatches.length > 0 && w > 200) {
                ctx.font = '12px Arial';
                ctx.fillStyle = accentColor;
                ctx.textAlign = 'center';
                const matchScores = seriesInfo.playedMatches.map(pm => `${pm.scoreHome}:${pm.scoreAway}`).join(' | ');
                ctx.fillText(matchScores.substring(0, 30), x + w/2, y + h - 6);
            }
        } else {
            // Empty/waiting slot
            ctx.fillStyle = theme.faint;
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(label || 'Čeká na týmy', x + w/2, y + h/2 + 5);
        }
        
        // Round label above box
        if (label) {
            ctx.fillStyle = accentColor;
            ctx.font = 'bold 11px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(label, x + w/2, y - 8);
        }
    }
    
    // Draw connection lines with elbow/stepped style
    function drawConnection(x1, y1, x2, y2) {
        const midX = x1 + (x2 - x1) / 2;
        
        ctx.strokeStyle = brand.withAlpha(accentColor, 0.6);
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
        ctx.fillStyle = accentColor;
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
    const allowedRoundPrefixes = new Set(['playin', 'pk', 'pi', 'r16', 'qf', 'sf', 'f', 'fin', 'final', 'bronz']);
    const slotKeys = Object.keys(savedSlots).filter(k => {
        if (k.includes('_t1') || k.includes('_t2') || k === '_csrf') return false;
        const value = savedSlots[k];
        if (typeof value !== 'string' || !/^series-\d+$/.test(value)) return false;
        const match = k.match(/^([a-z]+)_?(\d*)$/i);
        return match ? allowedRoundPrefixes.has(match[1].toLowerCase()) : false;
    });
    
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
        ctx.fillStyle = accentColor;
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
            
                // Předkolo má vlastní série. Nezapojuje se znovu do čtvrtfinále.
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
        await drawWatermark(ctx, width, height, customSettings);
    }
    
    return canvas.toBuffer('image/png');
}

function getAvailableImages() {
    const fs = require('fs');
    const path = require('path');
    const imagesDir = path.join(process.cwd(), 'data', 'images');
    
    if (!fs.existsSync(imagesDir)) {
        return [];
    }
    
    return fs.readdirSync(imagesDir)
        .filter(f => f.match(/\.(jpg|jpeg|png|gif|webp)$/i))
        .map(f => {
            const stats = fs.statSync(path.join(imagesDir, f));
            return {
                filename: f,
                path: `/logoteamu/${f}`,
                size: (stats.size / 1024).toFixed(1)
            };
        })
        .sort((a, b) => a.filename.localeCompare(b.filename));
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
    getChosenSeason,
    generateLeftPanel,
    logAdminAction,
    logUserAction,
    getLeagueStatusData,
    getTableTipsData,
    checkAndApplyTableTipsLockers,
    checkAllTableTipsLockers,
    generateTimeWidget,
    createMatchImage,
    createTransferImage,
    createWinnerImage,
    calculateClinchStatusesForGroup,
    getAllowedLeagues,
    getMatches,
    getLeaguesData,
    loadTeams,
    getAvailableImages,
}
