const fs = require("fs");
const express = require("express");
const router = express.Router();
const path = require('path');
const {loadTeams, requireLogin, calculateTeamScores} = require("../utils/fileUtils");

router.post("/tip", requireLogin, (req, res) => {
    const username = req.session.user;
    const matchId = parseInt(req.body.matchId);
    const winner = req.body.winner;
    const loserWins = parseInt(req.body.loserWins);

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
        const data = fs.readFileSync('./data/users.json', 'utf8');
        users = JSON.parse(data);
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
        if (typeof winner !== 'undefined') {
            existing.winner = winner;
        }
        if (!isNaN(loserWins)) {
            existing.loserWins = loserWins;
        }
    } else {
        user.tips[season][league].push({
            matchId,
            ...(typeof winner !== 'undefined' ? { winner } : {}),
            loserWins: isNaN(loserWins) ? 0 : loserWins
        });
    }

    fs.writeFileSync('./data/users.json', JSON.stringify(users, null, 2));
    req.session.save(err => {
        if (err) {
            console.error("Chyba při ukládání session:", err);
            return res.status(500).send("Chyba session.");
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
        userStats = allUsers
            .filter(u => u.stats && u.stats[selectedSeason] && u.stats[selectedSeason][selectedLiga] &&
                (u.stats[selectedSeason][selectedLiga].totalRegular > 0 || u.stats[selectedSeason][selectedLiga].totalPlayoff > 0))
            .map(u => ({
                username: u.username,
                correct: u.stats?.[selectedSeason]?.[selectedLiga]?.correct || 0,
                total: u.stats?.[selectedSeason]?.[selectedLiga]?.totalRegular + u.stats?.[selectedSeason]?.[selectedLiga]?.totalPlayoff * 3 || 0,
                totalRegular: u.stats?.[selectedSeason]?.[selectedLiga]?.totalRegular,
                totalPlayoff: u.stats?.[selectedSeason]?.[selectedLiga]?.totalPlayoff,
            }));
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
            <table class="points-table">
                <thead>
                    <tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní Část</h2></th></tr>
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
                    <tr>
                         `;
    teamsInSelectedLiga.sort((a, b) => {
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


    teamsInSelectedLiga.forEach((team, index) => {
        const teamStats = scores[team.id] || {gf: 0, ga: 0};
        const goalDiff = teamStats.gf - teamStats.ga;

        const numberMatches = team.stats?.[selectedSeason]?.wins + team.stats?.[selectedSeason]?.otWins + team.stats?.[selectedSeason]?.otLosses + team.stats?.[selectedSeason]?.losses
        html += `
    <tr>
        <td>${index + 1}.</td>
        <td>${team.name}</td>
        <td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td>
        <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
        <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
        <td class="numbers">${numberMatches || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td>
    </tr>`;
    });
    html += `
                </tbody>
            </table>
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
            const percent = (currentUserStats.correct / currentUserStats.total * 100).toFixed(2);
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
                return b.total - a.total;
            })
            .forEach((user, index) => {
                const correct = user.correct || 0;
                const total = user.total || 0;
                const successRate = total > 0 ? ((correct / total) * 100).toFixed(2) : '0.00';
                html += `
        <tr>
            <td>${index + 1}.</td>
            <td>${user.username}</td>
            <td>${successRate}%</td>
            <td>${user.correct}</td>
            <td>${user.totalRegular}</td>
            <td>${user.totalPlayoff}</td>
        </tr>`;
            });
        html += `
        </tbody>
    </table>
    <br>
    <table class="points-table">
        <tr>
            <td colspan="3">Za správný tip zápasu v základní části</td>
            <td colspan="3">1 bod</td>
        </tr>
        <tr>
            <td colspan="3">Za správný tip vítěze dané série v playoff</td>
            <td colspan="3">1 bod</td>
        </tr>
        <tr>
            <td colspan="3">Za správný tip vítěze dané série v playoff + počet vyhraných zápasů týmů který prohrál</td>
            <td colspan="3">3 body</td>
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
            groupedMatches["Odložené zápasy"] = postponedMatches;
        }

        normalMatches.forEach(match => {
            const dateTime = match.datetime || match.date || "Neznámý čas";
            if (!groupedMatches[dateTime]) groupedMatches[dateTime] = [];
            groupedMatches[dateTime].push(match);
        });

        for (const [dateTime, matchesAtSameTime] of Object.entries(groupedMatches)) {
            let formattedDateTime;

            if (matchesAtSameTime.some(m => m.postponed)) {
                formattedDateTime = "Odložené zápasy";
            } else {
                formattedDateTime = new Date(dateTime).toLocaleString('cs-CZ', {
                    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
                });
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
                function parseCETDate(datetimeString) {
                    if (datetimeString != null) {
                    const [datePart, timePart] = datetimeString.split("T");
                    const [year, month, day] = datePart.split("-").map(Number);
                    const [hour, minute] = timePart.split(":").map(Number);

                    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
                    date.setHours(date.getHours()-2);
                    return date;
                } else {
                        return null;
                    }
                }

                const matchTime = parseCETDate(match.datetime);
                const now = new Date();
                const matchStarted = match.postponed ? true : matchTime <= now;

                const isPlayoff = match.isPlayoff;
                const bo = match.bo || 5;
                Math.ceil(bo / 2);
                if (match.postponed) {
                    html += `
<tr class="match-row postponed">
    <td colspan="3"><strong>${homeTeam} vs ${awayTeam}</strong></td>
</tr>
`;
                } else if (!isPlayoff) {
                    html += `
<tr class="match-row">
    <td>
        <form action="/tip" method="POST" style="display:inline">
            <input type="hidden" name="matchId" value="${match.id}">
            <input type="hidden" name="winner" value="home">
            <button type="submit" class="team-link ${selectedWinner === "home" ? "selected" : ""}" ${matchStarted ? 'disabled' : ''}>${homeTeam}</button>
        </form>
    </td>
    <td class="vs">vs</td>
    <td>
        <form action="/tip" method="POST" style="display:inline">
            <input type="hidden" name="matchId" value="${match.id}">
            <input type="hidden" name="winner" value="away">
            <button type="submit" class="team-link ${selectedWinner === "away" ? "selected" : ""}" ${matchStarted ? 'disabled' : ''}>${awayTeam}</button>
        </form>
    </td>
</tr>
`;
                } else {
                    html += `
<tr class="match-row">
    <form action="/tip" method="POST">
        <input type="hidden" name="matchId" value="${match.id}">
        <td>
            <button type="submit" name="winner" value="home"
                class="team-link ${selectedWinner === "home" ? "selected" : ""}"
                ${matchStarted ? 'disabled' : ''}>
                ${homeTeam}
            </button>
        </td>
        <td class="vs">vs</td>
        <td>
            <button type="submit" name="winner" value="away"
                class="team-link ${selectedWinner === "away" ? "selected" : ""}"
                ${matchStarted ? 'disabled' : ''}>
                ${awayTeam}
            </button>
        </td>
    </form>
</tr>
`;
                }
            }

            html += `
        </tbody>
    </table>
    `;
        }

        html += `</section></main></body><script>
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('select[name="loserWins"]').forEach(sel => {
      sel.addEventListener('change', () => sel.form.submit());
    });
  });
    document.addEventListener("DOMContentLoaded", () => {
    const allForms = document.querySelectorAll("form");

    allForms.forEach(form => {
      form.addEventListener("submit", () => {
        localStorage.setItem("scrollTop", window.scrollY);
      });
    });

    const savedScroll = localStorage.getItem("scrollTop");
    if (savedScroll !== null) {
      window.scrollTo(0, parseInt(savedScroll));
      localStorage.removeItem("scrollTop");
    }
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
    const selectedSeason = req.query.sezona;
    const teams = loadTeams().filter(t => t.stats[selectedSeason]).filter(t => t.stats[selectedSeason].wins + t.stats[selectedSeason].otWins + t.stats[selectedSeason].otLosses + t.stats[selectedSeason].losses > 0);
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf-8'));

    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];
    const uniqueLeagues = allLeagues.filter(l => {
        return matches.some(m => m.liga === l && m.season === selectedSeason);
    });

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga) ? req.query.liga : uniqueLeagues[0];
    const teamsInSelectedLiga = teams.filter(t => t.liga === selectedLiga);

    const scores = calculateTeamScores(matches, selectedSeason, selectedLiga);

    let userStats = [];
    try {
        const usersData = fs.readFileSync('./data/users.json', 'utf-8');
        const allUsers = JSON.parse(usersData);
        userStats = allUsers
            .filter(u => u.stats && u.stats[selectedSeason] && u.stats[selectedSeason][selectedLiga] &&
                (u.stats[selectedSeason][selectedLiga].totalRegular > 0 || u.stats[selectedSeason][selectedLiga].totalPlayoff > 0))
            .map(u => ({
                username: u.username,
                correct: (u.stats[selectedSeason][selectedLiga]?.correct) || 0,
                total: (u.stats[selectedSeason][selectedLiga]?.totalRegular+u.stats[selectedSeason][selectedLiga]?.totalPlayoff*3) || 0,
                totalRegular: u.stats[selectedSeason][selectedLiga].totalRegular,
                totalPlayoff: u.stats[selectedSeason][selectedLiga].totalPlayoff,
            }));
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
            <table class="points-table">
                <thead>
                    <tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} - ZČ</h2></th></tr>
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
                    <tr>
                         `;
    teamsInSelectedLiga.sort((a, b) => {
        const aStats = a.stats?.[selectedSeason] || {};
        const bStats = b.stats?.[selectedSeason] || {};

        const aPoints = aStats.points || 0;
        const bPoints = bStats.points || 0;

        const aScore = scores[a.id] || { gf: 0, ga: 0 };
        const bScore = scores[b.id] || { gf: 0, ga: 0 };

        const aDiff = aScore.gf - aScore.ga;
        const bDiff = bScore.gf - bScore.ga;

        const aMatches = (aStats.wins || 0) + (aStats.otWins || 0) + (aStats.otLosses || 0) + (aStats.losses || 0);
        const bMatches = (bStats.wins || 0) + (bStats.otWins || 0) + (bStats.otLosses || 0) + (bStats.losses || 0);

        if (bPoints !== aPoints) return bPoints - aPoints;

        if (bDiff !== aDiff) return bDiff - aDiff;

        return aMatches - bMatches;
    });

    teamsInSelectedLiga.forEach((team, index) => {
        const teamStats = scores[team.id] || { gf: 0, ga: 0 };
        const goalDiff = teamStats.gf - teamStats.ga;

        const numberMatches = team.stats?.[selectedSeason]?.wins + team.stats?.[selectedSeason]?.otWins + team.stats?.[selectedSeason]?.otLosses + team.stats?.[selectedSeason]?.losses
        html += `
    <tr>
        <td>${index + 1}.</td>
        <td>${team.name}</td>
        <td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td>
        <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
        <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
        <td class="numbers">${numberMatches || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td>
        <td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td>
    </tr>`;
    });
    html += `
                </tbody>
            </table>
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
            const percent = (currentUserStats.correct / currentUserStats.total * 100).toFixed(2);
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
                return b.total - a.total;
            })
            .forEach((user, index) => {
                const correct = user.correct || 0;
                const total = user.total || 0;
                const successRate = total > 0 ? ((correct / total) * 100).toFixed(2) : '0.00';
                html += `
        <tr>
            <td>${index + 1}.</td>
            <td>${user.username}</td>
            <td>${successRate}%</td>
            <td>${user.correct}</td>
            <td>${user.totalRegular}</td>
            <td>${user.totalPlayoff}</td>
        </tr>`;
            });
        html += `
        </tbody>
    </table>
    <br>
    <table class="points-table">
        <tr>
            <td colspan="3">Za správný tip zápasu v základní části</td>
            <td colspan="3">1 bod</td>
        </tr>
        <tr>
            <td colspan="3">Za správný tip vítěze dané série v playoff</td>
            <td colspan="3">1 bod</td>
        </tr>
        <tr>
            <td colspan="3">Za správný tip vítěze dané série v playoff + počet vyhraných zápasů týmů který prohrál</td>
            <td colspan="3">3 body</td>
        </tr>
    </table>
</section>
</section>
<section class="matches-container">
    <h2>Historie tipů</h2>
    <table class="points-table">
        `
        const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8')).filter(m => m.liga === selectedLiga && m.result).filter(m => m.season === selectedSeason).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
        const users = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));
        const currentUser = users.find(u => u.username === username);
        const userTips = currentUser?.tips?.[selectedSeason]?.[selectedLiga] || [];
        const groupedMatches = matches.reduce((groups, match) => {
            const dateTime = match.datetime || match.date || "Neznámý čas";
            if (!groups[dateTime]) groups[dateTime] = [];
            groups[dateTime].push(match);
            return groups;
        }, {});
        const teams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf8'));

        for (const [dateTime, matchesAtSameTime] of Object.entries(groupedMatches)) {
            const formattedDateTime = new Date(dateTime).toLocaleString('cs-CZ', {
                day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            html += `<h3>${formattedDateTime}</h3>`;
            html += `<table class="matches-table">`;
            html += `<thead class="matches-table-header"><tr><th colSpan="6">Zápasy</th></tr></thead>`;
            html += `<tbody>`;
            for (const match of matchesAtSameTime) {
                const homeTeam = teams.find(t => t.id === match.homeTeamId)?.name || '???';
                const awayTeam = teams.find(t => t.id === match.awayTeamId)?.name || '???';
                const existingTip = userTips.find(t => t.matchId === match.id);
                const selectedWinner = existingTip?.winner;
                const selectedLoserWins = existingTip?.loserWins || 0;

                const isPlayoff = match.isPlayoff;
                const bo = match.bo || 5;

                if (!isPlayoff) {
                    html += `
<tr class="match-row">
    <td class="match-row">
        <form action="/tip" method="POST" style="display:inline">
            <input type="hidden" name="matchId" value="${match.id}">
            <input type="hidden" name="winner" value="home">
            <div class="team-link-history ${selectedWinner === "home" ? match.result.winner === "home" ? "right-selected" : "wrong-selected" : ""}">${homeTeam}</div>
        </form>
    </td>
    <td class="vs">${match.result.scoreHome}</td>
    <td class="vs">${match.result.ot === true ? "pp/sn": ":"}</td>
    <td class="vs">${match.result.scoreAway}</td>
    <td class="match-row">
        <form action="/tip" method="POST" style="display:inline">
            <input type="hidden" name="matchId" value="${match.id}">
            <input type="hidden" name="winner" value="away">
            <div class="team-link-history ${selectedWinner === "away" ? match.result.winner === "away" ? "right-selected" : "wrong-selected" : ""}">${awayTeam}</div>
        </form>
    </td>
</tr>`;
                } else {
                    html += `
           <tr class="match-row">
    <form action="/tip" method="POST">
        <input type="hidden" name="matchId" value="${match.id}">
        <input type="hidden" name="winner" value="home">
        <td>
            <div class="team-link-history ${selectedWinner === "home" ? match.result.winner === "home" ? "right-selected" : "wrong-selected" : ""}" >${homeTeam}</div>
        </td>
    </form>
        <td class="vs">${match.result.scoreHome}</td>
        <td class="vs">vs</td>
        <td class="vs">${match.result.scoreAway}</td>
    <form action="/tip" method="POST">
        <td>
            <input type="hidden" name="matchId" value="${match.id}">
            <input type="hidden" name="winner" value="away">
            <div class="team-link-history ${selectedWinner === "away" ? match.result.winner === "away" ? "right-selected" : "wrong-selected" : ""}">${awayTeam}</div>
        </td>
    </form>
</tr>

<tr>
  <form action="/tip" method="POST">
    <input type="hidden" name="matchId" value="${match.id}">
    <td colspan="3">
      <div>
        Série - BO${bo}<br>
          <div class="team-link-history ${
                        typeof selectedLoserWins !== "undefined" && match.result
                            ? (
                                selectedLoserWins === (
                                    match.result.winner === "home"
                                        ? match.result.scoreAway
                                        : match.result.scoreHome
                                )
                                    ? "right-selected"
                                    : "wrong-selected"
                            )
                            : ""
                    }">
            ${selectedLoserWins ?? '-'}
          </div>
      </div>
    </td>
  </form>
</tr> `;
                }
            }
            html += `
        </tbody>
    </table>
    `;
        }
        html += `</section></main></body></html>`
        res.send(html);
    }
});

module.exports = router;