const fs = require("fs");
const express = require("express");
const router = express.Router();
const path = require('path');
const {loadTeams, requireLogin, calculateTeamScores, getLeagueZones, getTeamZone, isLockedPosition} = require("../utils/fileUtils");
router.post("/tip", requireLogin, (req, res) => {
    const username = req.session.user;
    if (username === "Admin") {
        return res.status(403).send("Administrátor se nemůže účastnit tipování.");
    }
    const matchId = parseInt(req.body.matchId);
    const winner = req.body.winner;
    const loserWins = parseInt(req.body.loserWins);
    const scoreHome = req.body.scoreHome ? parseInt(req.body.scoreHome) : null;
    const scoreAway = req.body.scoreAway ? parseInt(req.body.scoreAway) : null;

    let matches;
    try {
        matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    } catch (err) {
        console.error("Chyba při čtení matches.json:", err);
        return res.status(500).send("Nastala chyba při čtení dat zápasů.");
    }

    const match = matches.find(m => m.id === matchId);
    if (!match) return res.status(400).send("Neplatný zápas.");

    if (new Date(match.datetime) <= new Date()) {
        return res.status(403).send("Tipování na tento zápas již není možné, zápas už začal.");
    }

    const league = match.liga;
    const season = match.season;

    if (!season || !league) {
        return res.status(400).send("Zápas nemá vyplněnou sezónu nebo ligu.");
    }

    let users;
    try {
        users = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));
    } catch (err) {
        console.error("Chyba při čtení users.json:", err);
        return res.status(500).send("Nastala chyba při čtení dat uživatelů.");
    }

    const user = users.find(u => u.username === username);
    if (!user) return res.status(400).send("Uživatel nenalezen");

    if (!user.tips) user.tips = {};
    if (!user.tips[season]) user.tips[season] = {};
    if (!user.tips[season][league]) user.tips[season][league] = [];

    const existing = user.tips[season][league].find(t => t.matchId === matchId);

    if (existing) {
        if (typeof winner !== 'undefined') existing.winner = winner;

        if (match.bo === 1) {
            if (scoreHome !== null && scoreAway !== null) {
                existing.scoreHome = scoreHome;
                existing.scoreAway = scoreAway;
            }
            delete existing.loserWins;
        } else {
            if (!isNaN(loserWins)) existing.loserWins = loserWins;
            delete existing.scoreHome;
            delete existing.scoreAway;
        }
    } else {
        const newTip = { matchId };
        if (typeof winner !== 'undefined') newTip.winner = winner;

        if (match.bo === 1) {
            newTip.scoreHome = scoreHome ?? null;
            newTip.scoreAway = scoreAway ?? null;
        } else {
            newTip.loserWins = isNaN(loserWins) ? 0 : loserWins;
        }

        user.tips[season][league].push(newTip);
    }

    fs.writeFileSync('./data/users.json', JSON.stringify(users, null, 2));

    req.session.save(err => {
        if (err) {
            console.error("Chyba při ukládání session:", err);
            return res.status(500).send("Chyba session.");
        }

        if (req.headers['x-requested-with'] === 'fetch') {
            return res.status(200).send("Tip uložen");
        }
        res.redirect(`/?liga=${encodeURIComponent(league)}&sezona=${encodeURIComponent(season)}`);
    });
});

router.get('/', requireLogin, (req, res) => {
    const username = req.session.user;
    const teams = loadTeams().filter(t => t.active);
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf-8'));
    const allowedLeagues = JSON.parse(fs.readFileSync('./data/allowedLeagues.json', 'utf-8'));
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];

    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];
    const uniqueLeagues = allLeagues.filter(l => allowedLeagues.includes(l));

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga) ? req.query.liga : uniqueLeagues[0];
    const teamsInSelectedLiga = teams.filter(t => t.liga === selectedLiga);

    const scores = calculateTeamScores(matches, selectedSeason, selectedLiga);

    let userStats = [];
    try {
        const usersData = fs.readFileSync('./data/users.json', 'utf-8');
        const allUsers = JSON.parse(usersData);
        const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);

        userStats = allUsers
            .filter(u => {
                const tips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
                return tips.length > 0;
            })
            .map(u => {
                const stats = u.stats?.[selectedSeason]?.[selectedLiga] || {};
                const userTips = u.tips?.[selectedSeason]?.[selectedLiga] || [];

                const maxFromTips = userTips.reduce((sum, tip) => {
                    const match = matchesInLiga.find(m => Number(m.id) === Number(tip.matchId));
                    if (!match || !match.result) return sum;
                    if (!match.isPlayoff) return sum + 1;
                    if (match.bo === 1) return sum + 5;
                    return sum + 3;
                }, 0);

                const totalPoints = matchesInLiga.reduce((sum, match) => {
                    if (!match.result) return sum;
                    if (!match.isPlayoff) return sum + 1;
                    if (match.bo === 1) return sum + 5;
                    return sum + 3;
                }, 0);

                return {
                    username: u.username,
                    correct: stats.correct || 0,
                    total: totalPoints,
                    maxFromTips: maxFromTips,
                    totalRegular: stats.totalRegular || 0,
                    totalPlayoff: stats.totalPlayoff || 0
                };
            });
    } catch (err) {
        console.error("Chyba při načítání statistik uživatelů:", err);
    }

    const currentUserStats = userStats.find(u => u.username === username);

    const playoffPath = path.join(__dirname, '../data/playoff.json');
    let playoffData = [];
    try {
        const raw = fs.readFileSync(playoffPath, 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) {
            playoffData = allPlayoffs[selectedSeason][selectedLiga];
        } else {
            console.warn('Playoff data pro danou sezónu a ligu nebyla nalezena.');
        }

    } catch (e) {
        console.error("Chyba při načítání playoff dat:", e);
    }

    const teamsByGroup = {};
    teamsInSelectedLiga.forEach(team => {
        const group = team.group ? String.fromCharCode(team.group + 64) : 'X';
        if (!teamsByGroup[group]) teamsByGroup[group] = [];
        teamsByGroup[group].push(team);
    });

    const leagueObj = leagues.find(l => l.name === selectedLiga) || {
        name: selectedLiga || "Neznámá liga",
        maxMatches: 0,
        quarterfinal: 0,
        playin: 0,
        relegation: 0,
        isMultigroup: false
    };

    if (leagueObj.maxMatches === 0 && selectedLiga) {
        console.warn(`[VAROVÁNÍ] Pro ligu '${selectedLiga}' (sezóna ${selectedSeason}) nebyla nalezena konfigurační data v leagues.json. Tabulka se nemusí zobrazit správně.`);
    }
    const sortedGroups = Object.keys(teamsByGroup).sort();

    let html = `
    <!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tipovačka</title>
    <link rel="stylesheet" href="./css/styles.css" />
    <link rel="icon" href="./images/logo.png">
</head>
<body class="usersite">
<header class="header">
    <div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
    <form class="league-dropdown" method="GET" action="/">
    <label class="league-select-name">
        Liga:
        <select id="league-select" name="liga" required onchange="this.form.submit()">
        ${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
    </label>
        <a class="history-btn" href="/history">Historie</a>
    </form>
    <p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
<main class="main_page">
    <section class="stats-container">
        <div class="left-panel">
        <div style="display: flex; flex-direction: row; justify-content: space-around; margin:20px 0; text-align:center;">
            <button style="cursor: pointer; border: none; color: orangered; background-color: black" class="history-btn" onclick="showTable('regular')">Základní část</button>
            <button style="cursor: pointer; border: none; color: orangered; background-color: black" class="history-btn" onclick="showTable('playoff')">Playoff</button>
        </div>
        <div id="regularTable">
        `
    for (const group of sortedGroups) {
        const teamsInGroup = teamsByGroup[group];
        const zoneConfig = getLeagueZones(leagueObj);

        html += `
    <table class="points-table">
        <thead>
            <tr>
                <th scope="col" id="points-table-header" colspan="10">
                    <h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část ${leagueObj?.isMultigroup ? `(Skupina ${group})` : ''}</h2>
                </th>
            </tr>
            <tr>
                <th class="position" scope="col">Místo</th>
                <th scope="col">Tým</th>
                <th class="points" scope="col">Body</th>
                <th scope="col">Skóre</th>
                <th scope="col">Rozdíl</th>
                <th scope="col">Z</th>
                <th scope="col">V</th>
                <th scope="col">Vpp</th>
                <th scope="col">Ppp</th>
                <th scope="col">P</th>
            </tr>
        </thead>
        <tbody>
    `;

        teamsInGroup.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const aPoints = aStats.points || 0;
            const bPoints = bStats.points || 0;
            const aScore = scores[a.id] || {gf:0, ga:0};
            const bScore = scores[b.id] || {gf:0, ga:0};
            const aDiff = aScore.gf - aScore.ga;
            const bDiff = bScore.gf - bScore.ga;
            const aMatches = (aStats.wins||0)+(aStats.otWins||0)+(aStats.otLosses||0)+(aStats.losses||0);
            const bMatches = (bStats.wins||0)+(bStats.otWins||0)+(bStats.otLosses||0)+(bStats.losses||0);

            if (bPoints !== aPoints) return bPoints - aPoints;
            if (bDiff !== aDiff) return bDiff - aDiff;
            return aMatches - bMatches;
        });

        const sorted = teamsInGroup;

        teamsInGroup.forEach((team, index) => {
            const zone = getTeamZone(index, teamsInGroup.length, zoneConfig);
            const matchesPerTeam = (leagueObj.maxMatches * 2) / teamsInGroup.length;
            const allTeamsFinished = sorted.every(team => {
                const stats = team.stats?.[selectedSeason] || {};
                const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0);
                return played >= matchesPerTeam;
            });
            const locked = isLockedPosition(index, teamsInGroup.length, sorted, zoneConfig, selectedSeason, matchesPerTeam, allTeamsFinished);
            team.zone = zone;
            team.locked = locked;

            const rowClass = locked ? `${zone} locked` : '';
            const rankClass = zone;

            const teamStats = scores[team.id] || {gf:0, ga:0};
            const goalDiff = teamStats.gf - teamStats.ga;
            const numberMatches = (team.stats?.[selectedSeason]?.wins||0)
                + (team.stats?.[selectedSeason]?.otWins||0)
                + (team.stats?.[selectedSeason]?.otLosses||0)
                + (team.stats?.[selectedSeason]?.losses||0);

            html += `
        <tr class="${rowClass}">
            <td class="rank-cell ${rankClass}">${index + 1}.</td>
            <td>${team.name}</td>
            <td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td>
            <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
            <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
            <td class="numbers">${numberMatches || 0}</td>
            <td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td>
            <td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td>
            <td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td>
            <td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td>
        </tr>
        `;
        });
        html += `
        </tbody>
    </table>
    `;
    }

    html += `
            </div>
            <div id="playoffTablePreview" style="display:none; overflow:auto; max-width:100%;">
      <table class="points-table"><tr><th scope="col" id="points-table-header" colspan="20"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Playoff</h2></th></tr>`;
    playoffData.forEach((row) => {
        html += '<tr>';
        row.forEach(cell => {
            const bgColor = cell.bgColor || '';
            const textColor = cell.textColor || '';
            const styleParts = [];
            if (bgColor) styleParts.push(`background-color:${bgColor}`);
            if (textColor) styleParts.push(`color:${textColor}`);
            const styleAttr = styleParts.length ? ` style="${styleParts.join(';')}"` : '';

            const txt = cell.text || '';
            html += `<td${styleAttr}>${txt}</td>`;
        });
        html += '</tr>';
    });
    const totalMatches = leagueObj.maxMatches
    const filledMatches = matches.filter(m => m.result && m.liga === selectedLiga && m.season === selectedSeason && m.isPlayoff !== true).length;
    const percentage = totalMatches > 0 ? Math.round((filledMatches / totalMatches) * 100) : 0;

    html += `
      </table>
    </div>
    <section class="progress-section">
        <h3>Odehráno zápasů v základní části</h3>
        <div class="progress-container">
            <div class="progress-bar" style="width:${percentage}%;">${percentage}%</div>
        </div>
        <p id="progress-text"></p>
    </section>

    <script>
    function showTable(which) {
        document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none';
        const p = document.getElementById('playoffTablePreview');
        p.style.display = which === 'playoff' ? 'block' : 'none';
    }
    const bar = document.getElementById("progress-bar");
    const text = document.getElementById("progress-text");
    </script>
        </div>
`;

    if (username) {
        html += `
<section class="user_stats">
    <h2>Tvoje statistiky</h2>
    ${currentUserStats ? `
        <p>Správně tipnuto z maximálního počtu všech vyhodnocených zápasů: 
            <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.total}</strong> 
            (${(currentUserStats.correct / currentUserStats.total * 100).toFixed(2)} %)
        </p>
        ${currentUserStats.total !== currentUserStats.maxFromTips ? `
        <p>Správně tipnuto z tipovaných zápasů: 
            <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.maxFromTips}</strong> 
            (${(currentUserStats.correct / currentUserStats.maxFromTips * 100).toFixed(2)} %)
        </p>` : ''}
    ` : `<p>Nemáš ještě žádné tipy nebo není vyhodnoceno.</p>`}
</section>

<section class="global_stats">
    <table class="points-table">
        <thead>
            <tr><th scope="col" id="points-table-header" colspan="6"><h2>Statistiky všech</h2></th></tr>
            <tr>
                <th class="position">Místo</th>
                <th>Uživatel</th>
                <th>Úspěšnost</th>
                <th>Počet bodů</th>
                <th>Celkem tipů v ZČ</th>
                <th>Celkem tipů v Playoff</th>
            </tr>
        </thead>
        <tbody>`;
        userStats
            .sort((a, b) => {
                if (b.correct !== a.correct) {
                    return b.correct - a.correct;
                }
                return b.total - a.total;
            })
            .forEach((user, index) => {
                const successRate = user.total > 0 ? ((user.correct / user.total) * 100).toFixed(2) : '0.00';
                const successRateOverall = user.maxFromTips > 0 ? ((user.correct / user.maxFromTips) * 100).toFixed(2) : '0.00';

                html += `
        <tr>
            <td>${index + 1}.</td>
            <td>${user.username}</td>
            <td>${successRateOverall}%${user.total !== user.maxFromTips ? ` (${successRate}%)` : ''}</td>
            <td>${user.correct}</td>
            <td>${user.totalRegular}</td>
            <td>${user.totalPlayoff}</td>
        </tr>`;
            });
        html += `
        </tbody>
    </table>
    <br>
    <table style="color: black" class="points-table">
        <tr style="background-color: #00FF00">
            <td colspan="3">Za správný tip zápasu v základní části</td>
            <td colspan="3">1 bod</td>
        </tr>
        <tr style="background-color: #FF0000">
            <td colspan="3">Za správný tip vítěze dané série v playoff ale špatný tip počtu vyhraných zápasů týmu který prohrál</td>
            <td colspan="3">1 bod</td>
        </tr>
        <tr style="background-color: #00FF00">
            <td colspan="3">Za správný tip vítěze dané série v playoff + počet vyhraných zápasů týmů který prohrál</td>
            <td colspan="3">3 body</td>
        </tr>
        <tr style="background-color: #00FF00">
            <td colspan="3">Za správný tip vítěze daného zápasu v playoff + správné skóre</td>
            <td colspan="3">5 bodů</td>
        </tr>
        <tr style="background-color: #FFFF00">
            <td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 1 gól</td>
            <td colspan="3">4 body</td>
        </tr>
        <tr style="background-color: #FF6600">
            <td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 2 góly</td>
            <td colspan="3">3 body</td>
        </tr>
        <tr style="background-color: #FF0000">
            <td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 3+ gólů</td>
            <td colspan="3">1 bod</td>
        </tr>
    </table>
</section>
</section>
<section class="matches-container">
    <h2>Aktuální zápasy k tipování</h2>
    <table class="points-table">
        `
        const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'))
            .filter(m => m.liga === selectedLiga && !m.result)
            .filter(m => m.season === selectedSeason)
            .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

        const users = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));
        const currentUser = users.find(u => u.username === username);
        const userTips = currentUser?.tips?.[selectedSeason]?.[selectedLiga] || [];

        const postponedMatches = matches.filter(m => m.postponed);
        const normalMatches = matches.filter(m => !m.postponed)
            .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

        const groupedMatches = {};

        if (postponedMatches.length) {
            const POSTPONED_LABEL = "Odložené zápasy";
            groupedMatches[POSTPONED_LABEL] = postponedMatches;

        }

        normalMatches.forEach(match => {
            const dateTime = match.datetime || match.date || "Neznámý čas";
            if (!groupedMatches[dateTime]) groupedMatches[dateTime] = [];
            groupedMatches[dateTime].push(match);
        });

        const getPragueISO = () => {
            return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Prague' }).replace(' ', 'T');
        };
        const currentPragueTimeISO = getPragueISO();

        for (const [dateTime, matchesAtSameTime] of Object.entries(groupedMatches)) {
            let formattedDateTime;

            if (matchesAtSameTime.some(m => m.postponed) || dateTime === "Neznámý čas") {
                formattedDateTime = "Odložené zápasy";
            } else {
                const [dPart, tPart] = dateTime.split('T');
                const [year, month, day] = dPart.split('-');
                formattedDateTime = `${day}. ${month}. ${year} ${tPart}`;
            }

            html += `
    <h3>${formattedDateTime}</h3>
    <table class="matches-table">
        <thead class="matches-table-header">
            <tr><th colspan="3">Zápasy</th></tr>
        </thead>
        <tbody>
    `;

            for (const match of matchesAtSameTime) {
                const homeTeam = teams.find(t => t.id === match.homeTeamId)?.name || '???';
                const awayTeam = teams.find(t => t.id === match.awayTeamId)?.name || '???';
                const existingTip = userTips.find(t => t.matchId === match.id);
                const selectedWinner = existingTip?.winner;

                const matchStarted = match.postponed ? true : (match.datetime <= currentPragueTimeISO);
                const isPlayoff = match.isPlayoff;

                if (match.postponed) {
                    html += `
                    <tr class="match-row postponed">
                        <td colspan="3"><strong>${homeTeam} vs ${awayTeam}</strong></td>
                    </tr>`;
                }
                // --- VARIANTA 1: NORMÁLNÍ ZÁPAS (Bez formuláře, ID je v řádku) ---
                else if (!isPlayoff) {
                    html += `
                    <tr class="match-row simple-match-row" data-match-id="${match.id}">
                        <td>
                            <button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" 
                                    data-winner="home" ${matchStarted ? 'disabled' : ''}>${homeTeam}</button>
                        </td>
                        <td class="vs">vs</td>
                        <td>
                            <button type="button" class="team-link away-btn ${selectedWinner === "away" ? "selected" : ""}" 
                                    data-winner="away" ${matchStarted ? 'disabled' : ''}>${awayTeam}</button>
                        </td>
                    </tr>`;
                }
                // --- VARIANTA 2: PLAYOFF ZÁPAS ---
                else {
                    const existingLoserWins = existingTip?.loserWins || 0;
                    const bo = match.bo || 7;
                    const maxLoserWins = Math.floor(bo / 2);

                    html += `
                    <tr class="match-row playoff-parent-row" data-match-id="${match.id}">
                        <td>
                          <button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" 
                                  data-winner="home" ${matchStarted ? 'disabled' : ''}>
                            ${homeTeam}
                          </button>
                        </td>
                        <td class="vs">vs</td>
                        <td>
                          <button type="button" class="team-link away-btn ${selectedWinner === "away" ? "selected" : ""}" 
                                  data-winner="away" ${matchStarted ? 'disabled' : ''}>
                            ${awayTeam}
                          </button>
                        </td>
                    </tr>

                    <tr class="match-row loser-row" style="display:${existingTip ? 'table-row' : 'none'}">
                      <td colspan="3">
                        <form class="loserwins-form" onsubmit="return false;" data-bo="${match.bo}">
                          <input type="hidden" name="matchId" value="${match.id}">
                          <input type="hidden" name="winner" value="${existingTip?.winner ?? ''}">
                          
                          ${match.bo === 1
                        ? `Skóre: 
                              <input type="number" name="scoreHome" value="${existingTip?.scoreHome ?? ''}" min="0" style="width:50px"> :
                              <input type="number" name="scoreAway" value="${existingTip?.scoreAway ?? ''}" min="0" style="width:50px">`
                        : `Kolik zápasů vyhrál poražený:
                              <select name="loserWins">
                                ${Array.from({length: maxLoserWins+1}, (_, i) => `<option value="${i}" ${i===existingLoserWins?'selected':''}>${i}</option>`).join('')}
                              </select>`
                    }
                        </form>
                      </td>
                    </tr>`;
                }
            }

            html += `
        </tbody>
    </table>
    `;
        }

        html += `</section></main></body>

<script>
document.addEventListener('DOMContentLoaded', () => {

    // Hlavní funkce pro odeslání dat
    function sendTip(formData, homeBtn, awayBtn, loserRow) {
        const winner = formData.get('winner');

        fetch('/tip', {
            method: 'POST',
            headers: { 'x-requested-with': 'fetch' },
            body: formData
        })
        .then(res => {
            if (res.ok) {
                console.log('Tip uložen');
                
                // VIZUÁLNÍ UPDATE (Až po potvrzení serverem, nebo hned - jak chceš)
                if (homeBtn) {
                    homeBtn.classList.toggle('selected', winner === 'home');
                    // Pokud kliknu na Home, musím zajistit, že Away už není selected
                    if (winner === 'home' && awayBtn) awayBtn.classList.remove('selected');
                }
                if (awayBtn) {
                    awayBtn.classList.toggle('selected', winner === 'away');
                    if (winner === 'away' && homeBtn) homeBtn.classList.remove('selected');
                }

                if (loserRow) loserRow.style.display = 'table-row';
            } else {
                alert('Chyba při ukládání (Server Error).');
            }
        })
        .catch(err => {
            console.error(err);
            alert('Chyba připojení.');
        });
    }

    // --- 1. OBSLUHA KLIKNUTÍ NA TÝMY (Pro Playoff i Normální) ---
    // Hledáme všechna tlačítka, která mají data-winner
    document.querySelectorAll('button[data-winner]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            
            // Najdeme řádek tabulky
            const row = btn.closest('tr');
            const matchId = row.dataset.matchId;
            const winner = btn.dataset.winner;

            const homeBtn = row.querySelector('.home-btn');
            const awayBtn = row.querySelector('.away-btn');
            
            // Zjistíme, jestli je to playoff (jestli následuje loser-row)
            const nextRow = row.nextElementSibling;
            let loserRow = null;
            let loserForm = null;

            if (nextRow && nextRow.classList.contains('loser-row')) {
                loserRow = nextRow;
                loserForm = loserRow.querySelector('form');
            }

            // Pokud existuje formulář pro skóre, musíme v něm aktualizovat hidden input 'winner'
            // To je DŮLEŽITÉ pro změnu tipu, aby se při zadání skóre poslal správný vítěz
            if (loserForm) {
                const wInput = loserForm.querySelector('input[name="winner"]');
                if (wInput) wInput.value = winner;
            }

            const formData = new URLSearchParams();
            formData.append('matchId', matchId);
            formData.append('winner', winner);

            sendTip(formData, homeBtn, awayBtn, loserRow);
        });
    });

    // --- 2. OBSLUHA SKÓRE A SELECTU (Playoff) ---
    document.querySelectorAll('.loserwins-form').forEach(form => {
        const matchId = form.querySelector('input[name="matchId"]').value;
        const winnerInput = form.querySelector('input[name="winner"]'); // Tento input aktualizujeme výše

        // ENTER (Skóre)
        form.querySelectorAll('input[type="number"]').forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (!winnerInput.value) { alert('Vyber nejdřív vítěze!'); return; }

                    const scoreHome = form.querySelector('input[name="scoreHome"]').value;
                    const scoreAway = form.querySelector('input[name="scoreAway"]').value;

                    const formData = new URLSearchParams();
                    formData.append('matchId', matchId);
                    formData.append('winner', winnerInput.value);
                    formData.append('scoreHome', scoreHome);
                    formData.append('scoreAway', scoreAway);

                    // Tlačítka nepotřebujeme měnit, už svítí
                    sendTip(formData, null, null, null);
                }
            });
        });

        // SELECT (Loser wins)
        const select = form.querySelector('select');
        if (select) {
            select.addEventListener('change', () => {
                if (!winnerInput.value) { alert('Vyber nejdřív vítěze!'); return; }

                const formData = new URLSearchParams();
                formData.append('matchId', matchId);
                formData.append('winner', winnerInput.value);
                formData.append('loserWins', select.value);

                sendTip(formData, null, null, null);
            });
        }
    });
});
</script>
</html>`
        res.send(html);
    }
})

router.get('/history', requireLogin, (req, res) => {
    let matches;
    try {
        matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    } catch (err) {
        console.error("Chyba při čtení matches.json:", err);
        return res.status(500).send("Nastala chyba při čtení dat zápasů.");
    }

    const history = [];

    for (const match of matches) {
        if (match.liga && match.season) {
            const key = `${match.season}_${match.liga}`;
            if (!history.some(entry => entry.key === key)) {
                history.push({key, season: match.season, liga: match.liga});
            }
        }
    }

    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <title>Historie lig a sezón</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
    </head>
    <body class="usersite">
        <header class="header">
            <div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1>Historie sezón a lig</h1></div>
            <a href="/">Zpět na hlavní stránku</a>
        </header>
        <main class="main_page">
            <table class="points-table">
                <thead class="points-table-history">
                    <tr>
                        <th>Sezóna</th>
                        <th>Liga</th>
                        <th>Odkaz</th>
                    </tr>
                </thead>
                <tbody>
    `;

    history.sort((a, b) => b.season.localeCompare(a.season));

    for (const entry of history) {
        html += `
            <tr class="history-table-choose">
                <td>${entry.season}</td>
                <td>${entry.liga}</td>
                <td><a href="/history/a/?liga=${encodeURIComponent(entry.liga)}&sezona=${encodeURIComponent(entry.season)}">Zobrazit</a></td>
            </tr>
        `;
    }

    html += `
                </tbody>
            </table>
        </main>
    </body>
    </html>
    `;

    res.send(html);
});

router.get('/history/a', requireLogin, (req, res) => {
    const username = req.session.user;
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const teams = loadTeams().filter(t => t.stats[selectedSeason]).filter(t => t.stats[selectedSeason].wins + t.stats[selectedSeason].otWins + t.stats[selectedSeason].otLosses + t.stats[selectedSeason].losses > 0);
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf-8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];
    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];
    const uniqueLeagues = allLeagues.filter(l => {
        return matches.some(m => m.liga === l && m.season === selectedSeason);
    });

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga) ? req.query.liga : uniqueLeagues[0];
    const teamsInSelectedLiga = teams.filter(t => t.liga === selectedLiga);

    const scores = calculateTeamScores(matches, selectedSeason, selectedLiga);
    const leagueObj = leagues.find(l => l.name === selectedLiga);

    let userStats = [];
    try {
        const usersData = fs.readFileSync('./data/users.json', 'utf-8');
        const allUsers = JSON.parse(usersData);

        const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);

        userStats = allUsers
            .filter(u => {
                const stats = u.stats?.[selectedSeason]?.[selectedLiga];
                const tips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
                return (stats && (stats.totalRegular > 0 || stats.totalPlayoff > 0)) || tips.length > 0;
            })
            .map(u => {
                const stats = u.stats?.[selectedSeason]?.[selectedLiga] || {};
                const userTips = u.tips?.[selectedSeason]?.[selectedLiga] || [];

                const maxFromTips = userTips.reduce((sum, tip) => {
                    const match = matchesInLiga.find(m => Number(m.id) === Number(tip.matchId));
                    if (!match || !match.result) return sum;
                    if (!match.isPlayoff) return sum + 1;
                    if (match.bo === 1) return sum + 5;
                    return sum + 3;
                }, 0);

                const totalPoints = matchesInLiga.reduce((sum, match) => {
                    if (!match.result) return sum;
                    if (!match.isPlayoff) return sum + 1;
                    if (match.bo === 1) return sum + 5;
                    return sum + 3;
                }, 0);

                return {
                    username: u.username,
                    correct: stats.correct || 0,
                    total: totalPoints,
                    maxFromTips: maxFromTips,
                    totalRegular: stats.totalRegular || 0,
                    totalPlayoff: stats.totalPlayoff || 0
                };
            });
    } catch (err) {
        console.error("Chyba při načítání statistik uživatelů:", err);
    }

    const currentUserStats = userStats.find(u => u.username === username);

    const playoffPath = path.join(__dirname, '../data/playoff.json');
    let playoffData = [];
    try {
        const raw = fs.readFileSync(playoffPath, 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) {
            playoffData = allPlayoffs[selectedSeason][selectedLiga];
        } else {
            console.warn('Playoff data v tabulce pro danou sezónu a ligu nebyla nalezena.');
        }

    } catch (e) {
        console.error("Chyba při načítání playoff dat:", e);
    }

    const isMultigroup = leagueObj?.isMultigroup || false;

    const teamsByGroup = {};
    teamsInSelectedLiga.forEach(team => {
        const groupLetter = String.fromCharCode(64 + team.group);
        if (!teamsByGroup[groupLetter]) teamsByGroup[groupLetter] = [];
        teamsByGroup[groupLetter].push(team);
    });

    const sortedGroups = Object.keys(teamsByGroup).sort();

    let html = `
    <!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Tipovačka</title>
    <link rel="stylesheet" href="../../css/styles.css" />
    <link rel="icon" href="/images/logo.png">
</head>
<body class="usersite">
<header class="header">
    <div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
    <a class="history-btn" href="/">Aktuální</a>
    <a class="history-btn" href="/history">Historie</a>
    <p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
<main class="main_page">
    <section class="stats-container">
        <div class="left-panel">
        <div style="display: flex; flex-direction: row; justify-content: space-around; margin:20px 0; text-align:center;">
            <button style="cursor: pointer; border: none; color: orangered; background-color: black" class="history-btn" onclick="showTable('regular')">Základní část</button>
            <button style="cursor: pointer; border: none; color: orangered; background-color: black" class="history-btn" onclick="showTable('playoff')">Playoff</button>
        </div>
        <div id="regularTable">
        `;
    for (const groupLetter of sortedGroups) {
        const teamsInGroup = teamsByGroup[groupLetter];
        const sorted = teamsInGroup;
        const zoneConfig = leagueObj ? {
            quarterfinal: leagueObj.quarterfinal,
            playin: leagueObj.playin,
            relegation: leagueObj.relegation
        } : { quarterfinal: 0, playin: 0, relegation: 0 };

        const matchesPerTeam = leagueObj ? (leagueObj.maxMatches * 2) / teamsInGroup.length : 0;
        const allTeamsFinished = sorted.every(team => {
            const stats = team.stats?.[selectedSeason] || {};
            const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0);
            return played >= matchesPerTeam;
        });

        html += `
  <table class="points-table">
    <thead>
      <tr>
        <th scope="col" id="points-table-header" colspan="10">
          <h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část
          ${isMultigroup ? ` - Skupina ${groupLetter}` : ''}</h2>
        </th>
      </tr>
      <tr>
        <th class="position">Místo</th>
        <th>Tým</th>
        <th class="points">Body</th>
        <th>Skóre</th>
        <th>Rozdíl</th>
        <th>Z</th>
        <th>V</th>
        <th>Vpp</th>
        <th>Ppp</th>
        <th>P</th>
      </tr>
    </thead>
    <tbody>`;

        teamsInGroup.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const aPoints = aStats.points || 0;
            const bPoints = bStats.points || 0;
            const aScore = scores[a.id] || {gf: 0, ga: 0};
            const bScore = scores[b.id] || {gf: 0, ga: 0};
            const aDiff = aScore.gf - aScore.ga;
            const bDiff = bScore.gf - bScore.ga;
            const aMatches = (aStats.wins || 0) + (aStats.otWins || 0) + (aStats.otLosses || 0) + (aStats.losses || 0);
            const bMatches = (bStats.wins || 0) + (bStats.otWins || 0) + (bStats.otLosses || 0) + (bStats.losses || 0);

            if (bPoints !== aPoints) return bPoints - aPoints;
            if (bDiff !== aDiff) return bDiff - aDiff;
            return aMatches - bMatches;
        });

        teamsInGroup.forEach((team, index) => {
            const teamStats = scores[team.id] || {gf: 0, ga: 0};
            const goalDiff = teamStats.gf - teamStats.ga;
            const numberMatches = (team.stats?.[selectedSeason]?.wins || 0)
                + (team.stats?.[selectedSeason]?.otWins || 0)
                + (team.stats?.[selectedSeason]?.otLosses || 0)
                + (team.stats?.[selectedSeason]?.losses || 0);
            const zone = getTeamZone(index, teamsInGroup.length, zoneConfig);
            const locked = isLockedPosition(index, teamsInGroup.length, sorted, zoneConfig, selectedSeason, matchesPerTeam, allTeamsFinished);

            const rowClass = locked ? `${zone} locked` : zone;
            html += `
      <tr class="${rowClass}"> <td class="rank-cell ${zone}">${index + 1}.</td> <td>${team.name}</td>
        <td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td>
        <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
        <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
        <td class="numbers">${numberMatches}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td>
      </tr>`;
        });

        html += `
    </tbody>
  </table><br>`;
    }
    html += `
        </div>
        <div id="playoffTablePreview" style="display:none; overflow:auto; max-width:100%;">
      <table class="points-table"><tr><th scope="col" id="points-table-header" colspan="20"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Playoff</h2></th></tr>`;

    playoffData.forEach((row) => {
        html += '<tr>';
        row.forEach(cell => {
            const bg = cell.bgColor ? ` style="background-color:${cell.bgColor}"` : '';
            const txt = cell.text || '';
            html += `<td${bg}>${txt}</td>`;
        });
        html += '</tr>';
    });

    html += `
      </table>
    </div>

    <script>
      function showTable(which) {
        document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none';
        const p = document.getElementById('playoffTablePreview');
        p.style.display = which === 'playoff' ? 'block' : 'none';
      }
    </script>
        </div>
`;

    if (username) {
        html += `
            <section class="user_stats">
                <h2>Tvoje statistiky</h2>
             `;

        if (currentUserStats) {
            const percent = currentUserStats.total > 0 ? (currentUserStats.correct / currentUserStats.total * 100).toFixed(2) : "0.00";
            html += `
            <p>Správně tipnuto z maximálního počtu všech možných bodů: <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.total}</strong> (${percent} %)</p>
        `;
        } else {
            html += `<p>Nemáš ještě žádné tipy nebo není vyhodnoceno.</p>`;
        }

        html += `
        </section>

<section class="global_stats">
    <table class="points-table">
        <thead>
            <tr><th scope="col" id="points-table-header" colspan="6"><h2>Statistiky všech</h2></th></tr>
            <tr>
                <th class="position">Místo</th>
                <th>Uživatel</th>
                <th>Úspěšnost</th>
                <th>Počet bodů</th>
                <th>Celkem tipů v ZČ</th>
                <th>Celkem tipů v Playoff</th>
            </tr>
        </thead>
        <tbody>`;
        userStats
            .sort((a, b) => {
                if (b.correct !== a.correct) {
                    return b.correct - a.correct;
                }
                return a.maxFromTips - b.maxFromTips;
            })
            .forEach((user, index) => {
                const successRateOverall = user.maxFromTips > 0 ? ((user.correct / user.maxFromTips) * 100).toFixed(2) : '0.00';
                const successRate = user.total > 0 ? ((user.correct / user.total) * 100).toFixed(2) : '0.00';

                html += `
        <tr>
            <td>${index + 1}.</td>
            <td>${user.username}</td>
            
            <td>${successRateOverall}%${user.total !== user.maxFromTips ? ` (${successRate}%)` : ''}</td>
            
            <td>${user.correct}</td>
            <td>${user.totalRegular}</td>
            <td>${user.totalPlayoff}</td>
        </tr>`;
            });
        html += `
        </tbody>
    </table>
    <br>
    <table style="color: black" class="points-table">
        <tr style="background-color: #00FF00">
            <td colspan="3">Za správný tip zápasu v základní části</td>
            <td colspan="3">1 bod</td>
        </tr>
        <tr style="background-color: #FF0000">
            <td colspan="3">Za správný tip vítěze dané série v playoff ale špatný tip počtu vyhraných zápasů týmu který prohrál</td>
            <td colspan="3">1 bod</td>
        </tr>
        <tr style="background-color: #00FF00">
            <td colspan="3">Za správný tip vítěze dané série v playoff + počet vyhraných zápasů týmů který prohrál</td>
            <td colspan="3">3 body</td>
        </tr>
        <tr style="background-color: #00FF00">
            <td colspan="3">Za správný tip vítěze daného zápasu v playoff + správné skóre</td>
            <td colspan="3">5 bodů</td>
        </tr>
        <tr style="background-color: #FFFF00">
            <td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 1 gól</td>
            <td colspan="3">4 body</td>
        </tr>
        <tr style="background-color: #FF6600">
            <td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 2 góly</td>
            <td colspan="3">3 body</td>
        </tr>
        <tr style="background-color: #FF0000">
            <td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 3+ gólů</td>
            <td colspan="3">1 bod</td>
        </tr>
    </table>
</section>
</section>
<section class="matches-container">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
        <h2 style="margin: 0;">Historie tipů</h2>
        
        <div style="display: flex; align-items: center; gap: 10px;">
            <label for="historyUserSelect" style="color: lightgrey;">Zobrazit:</label>
            `;

        const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'))
            .filter(m => m.liga === selectedLiga && m.result)
            .filter(m => m.season === selectedSeason)
            .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

        const users = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));

        // 1. Uživatelé pro Select (jen ti, co mají tipy)
        const usersWithTips = users.filter(u => {
            const tips = u.tips?.[selectedSeason]?.[selectedLiga];
            return tips && tips.length > 0;
        }).sort((a, b) => a.username.localeCompare(b.username));

        // Defaultně zobrazíme přihlášeného uživatele (nebo prvního v seznamu)
        const initialUser = usersWithTips.find(u => u.username === username) ? username : (usersWithTips[0]?.username || "");

        // 2. HTML PRO SELECT (Žádné URL, jen volání JS funkce)
        html += `
            <select id="historyUserSelect" 
                    onchange="showUserHistory(this.value)"
                    style="background-color: black; color: orangered; border: 1px solid orangered; padding: 5px; border-radius: 5px;">
        `;

        if (usersWithTips.length === 0) {
            html += `<option disabled selected>Žádná data</option>`;
        } else {
            usersWithTips.forEach(u => {
                const isSelected = u.username === initialUser ? 'selected' : '';
                html += `<option value="${u.username}" ${isSelected}>${u.username}</option>`;
            });
        }

        html += `   </select>
        </div>
    </div>

    <table class="points-table">
        `;

        const groupedMatches = matches.reduce((groups, match) => {
            const dateTime = match.datetime || match.date || "Neznámý čas";
            if (!groups[dateTime]) groups[dateTime] = [];
            groups[dateTime].push(match);
            return groups;
        }, {});
        const teams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf8'));

        // --- POMOCNÁ FUNKCE PRO GENEROVÁNÍ HTML BUŇKY PRO JEDNOHO USERA ---
        // Abychom nemuseli kopírovat logiku 10x, uděláme si funkci uvnitř
        const renderUserTip = (u, match, type) => {
            const userTip = u.tips?.[selectedSeason]?.[selectedLiga]?.find(t => t.matchId === match.id);
            const selectedWinner = userTip?.winner;
            const bo = match.bo || 5;

            // CSS třída pro identifikaci uživatele (např. "user-Pepa")
            // Pokud to není aktuálně vybraný uživatel, rovnou ho skryjeme (display: none)
            const visibilityStyle = u.username === initialUser ? '' : 'display:none;';
            const userClass = `history-item user-${u.username.replace(/[^a-zA-Z0-9]/g, '_')}`; // Ošetření speciálních znaků

            if (type === 'home' || type === 'away') {
                const teamName = type === 'home'
                    ? (teams.find(t => t.id === match.homeTeamId)?.name || '???')
                    : (teams.find(t => t.id === match.awayTeamId)?.name || '???');

                // Logika pro barvu
                let cssClass = "";
                if (selectedWinner === type) {
                    cssClass = match.result.winner === type ? "right-selected" : "wrong-selected";
                }

                return `<div class="${userClass} team-link-history ${cssClass}" style="${visibilityStyle}">${teamName}</div>`;
            }

            if (type === 'score') {
                if (selectedWinner === "home" || selectedWinner === "away") {
                    if (bo === 1) {
                        const tH = userTip?.scoreHome ?? 0;
                        const tA = userTip?.scoreAway ?? 0;
                        const aH = match.result.scoreHome;
                        const aA = match.result.scoreAway;
                        const diff = Math.abs(tH - aH) + Math.abs(tA - aA);

                        let sc = 'diff-3plus';
                        if (diff === 0) sc = 'exact-score';
                        else if (diff === 1) sc = 'diff-1';
                        else if (diff === 2) sc = 'diff-2';

                        return `<div class="${userClass} team-link-history ${sc}" style="${visibilityStyle}">${tH} : ${tA}</div>`;
                    } else {
                        const correct = userTip?.loserWins !== undefined && userTip.loserWins ===
                            (match.result.winner === "home" ? match.result.scoreAway : match.result.scoreHome);
                        const sc = correct ? "right-selected" : "wrong-selected";
                        return `<div class="${userClass} team-link-history ${sc}" style="${visibilityStyle}">${userTip?.loserWins ?? '-'}</div>`;
                    }
                }
                return `<div class="${userClass}" style="${visibilityStyle}">-</div>`;
            }
            return '';
        };

        // --- HLAVNÍ SMYČKA ---
        for (const [dateTime, matchesAtSameTime] of Object.entries(groupedMatches)) {
            const formattedDateTime = new Date(dateTime).toLocaleString('cs-CZ', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            html += `<h3>${formattedDateTime}</h3>`;
            html += `<table class="matches-table">`;
            html += `<thead class="matches-table-header"><tr><th colSpan="6">Zápasy</th></tr></thead>`;
            html += `<tbody>`;

            for (const match of matchesAtSameTime) {
                // Generujeme obsah buněk pro VŠECHNY uživatele najednou
                let homeCellHTML = "";
                let awayCellHTML = "";
                let scoreCellHTML = ""; // Pro Playoff střed

                usersWithTips.forEach(u => {
                    homeCellHTML += renderUserTip(u, match, 'home');
                    awayCellHTML += renderUserTip(u, match, 'away');
                    if (match.isPlayoff) {
                        scoreCellHTML += renderUserTip(u, match, 'score');
                    }
                });

                if (!match.isPlayoff) {
                    html += `
                    <tr class="match-row">
                        <td class="match-row">${homeCellHTML}</td>
                        <td class="vs">${match.result.scoreHome}</td>
                        <td class="vs">${match.result.ot === true ? "pp/sn": ":"}</td>
                        <td class="vs">${match.result.scoreAway}</td>
                        <td class="match-row">${awayCellHTML}</td>
                    </tr>`;
                } else {
                    html += `
                    <tr class="match-row">
                        <td>${homeCellHTML}</td>
                        <td class="vs">${match.result.scoreHome}</td>
                        <td class="vs">vs</td>
                        <td class="vs">${match.result.scoreAway}</td>
                        <td>${awayCellHTML}</td>
                    </tr>
                    <tr class="match-row">
                      <td style="color: black" colspan="5">${scoreCellHTML}</td>
                    </tr>`;
                }
            }
            html += `</tbody></table>`;
        }

        html += `
    </section>
    </main>

    <script>
        // TATO FUNKCE PŘEPÍNÁ VIDITELNOST BEZ RELOADU
        function showUserHistory(username) {
            // 1. Schováme všechny
            document.querySelectorAll('.history-item').forEach(el => {
                el.style.display = 'none';
            });

            // 2. Ošetříme speciální znaky ve jméně (stejně jako na serveru)
            const safeName = username.replace(/[^a-zA-Z0-9]/g, '_');

            // 3. Ukážeme ty, co patří vybranému
            document.querySelectorAll('.user-' + safeName).forEach(el => {
                el.style.display = 'flex'; // Nebo 'flex'/'table-cell' podle potřeby, block obvykle stačí pro div
            });
        }
    </script>
    </body></html>`;

        res.send(html);
    }
})

module.exports = router;