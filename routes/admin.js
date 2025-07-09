const fs = require("fs");
const express = require("express");
const router = express.Router();
const path = require('path');
const {
    requireAdmin,
    loadTeams,
    updateTeamsPoints,
    evaluateAndAssignPoints,
    generateSeasonRange,
    removeTipsForDeletedMatch,
} = require("../utils/fileUtils");

router.get('/', requireAdmin, (req, res) => {
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'))
    const teams = loadTeams()
    const allowedLeagues = JSON.parse(fs.readFileSync('./data/allowedLeagues.json', 'utf-8'));
    const chosenSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];
    const uniqueLeagues = allLeagues.filter(l => allowedLeagues.includes(l));
    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga) ? req.query.liga : uniqueLeagues[0];

    const teamsByLeague = {};
    teams.forEach(team => {
        if (!teamsByLeague[team.liga]) {
            teamsByLeague[team.liga] = [];
        }
        teamsByLeague[team.liga].push(team);
    });

    const seasons = [...new Set(
        matches
            .filter(m => m.liga === selectedLiga)
            .map(m => m.season || 'Neurčeno')
    )];

    const selectedSeason = req.query.season && seasons.includes(req.query.season)
        ? req.query.season
        : seasons[0] || 'Neurčeno';

    const filteredMatches = matches.filter(m =>
        m.liga === selectedLiga && (m.season || 'Neurčeno') === selectedSeason
    );
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin - Správa zápasů</title>
  <link rel="stylesheet" href="/css/styles.css" />
  <link rel="icon" href="/images/logo.png">
</head>
<header class="header">
  <div class="logo_title"><img class="image_logo" src="/images/logo.png" alt="Logo"><h1 id="title">Tipovačka</h1></div>
</header>
<body class="usersite">
<main class="admin_site">
  <div class="admin-header">
    <h1>Admin: Správa zápasů</h1>
    <div>
        <a href="/admin/new/match" class="btn new-btn-admin">Vytvořit nový zápas</a>
        <a href="/admin/new/team" class="btn new-btn-admin">Vytvořit nový tým</a>
        <a href="/admin/playoff" class="btn new-btn-admin">Playoff Tabulky</a>
    </div>
  </div>
  <form class="league-dropdown" method="GET" action="/admin/">
    Liga:
    <select id="league-select" name="liga" required onchange="this.form.submit()">
        ${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    Sezóna:
    <select name="season" onchange="this.form.submit()">
        ${seasons.map(s => `<option value="${s}" ${s === selectedSeason ? 'selected' : ''}>${s}</option>`).join('')}
    </select>
  </form>
  <section class="all-match-table-and-leagues">
  <table>
    <thead>
      <tr>
        <th>ID</th>
        <th>Domácí</th>
        <th>Hosté</th>
        <th>Datum a čas</th>
        <th>Výsledek</th>
        <th>Akce</th>
      </tr>
    </thead>
    <tbody>
`;

    for (const m of filteredMatches) {
        const homeTeam = teams.find(t => t.id === m.homeTeamId)?.name || '???';
        const awayTeam = teams.find(t => t.id === m.awayTeamId)?.name || '???';
        const result = m.result ? `${m.result.scoreHome} : ${m.result.scoreAway}` : '-';
        const dateObj = new Date(m.datetime);
        const formattedDate = dateObj.toLocaleString('cs-CZ', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });

        html += `
      <tr class="${m.isPlayoff ? 'playoff-row' : ''}">
        <td>${m.id}</td>
        <td>${homeTeam}</td>
        <td>${awayTeam}</td>
        <td>${formattedDate}</td>
        <td>${result}</td>
        <td>
          <a href="/admin/edit/${m.id}" class="action-btn edit-btn">Upravit</a>
          <form action="/admin/delete/${m.id}" method="POST" style="display:inline;" onsubmit="return confirm('Opravdu smazat zápas?');">
            <button type="submit" class="action-btn delete-btn">Smazat</button>
          </form>
        </td>
      </tr>
    `;
    }

    html += `
    </tbody>
  </table>
  <div class="select-leagues">
    <h2>Vybraná sezóna</h2>
    <form method="POST" action="/admin/season">
      <label for="season-select">Sezóna:</label>
      <div class="season-choose">
        <select id="season-select" name="season">
          ${seasons.map(s => `<option value="${s}" ${s === chosenSeason ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button type="submit" style="margin-top: 10px;">Vybrat sezónu</button>
      </div>
    </form>
  </div>
  <div class="select-leagues">
    <h2>Veřejné ligy</h2>
    <form method="POST" action="/admin/leagues">
      <div class="leagues-allow">
`;

    for (const l of allLeagues) {
        const checked = allowedLeagues.includes(l) ? 'checked' : '';
        html += `
        <label>
          <input type="checkbox" name="leagues" value="${l}" ${checked}/>
          ${l}
        </label>
      `;
    }

    html += `
      </div>
      <button type="submit" style="margin-top: 10px;">Uložit viditelnost lig</button>
    </form>
  </div>
  </section>
  <section class="all-match-table-and-leagues">
  <div class="select-teams">
    <h2>Veřejné ligy</h2>
    <div class="teams-allow">
`;

    for (const liga in teamsByLeague) {
        const activeTeams = teamsByLeague[liga].filter(team => team.active);
        const inactiveTeams = teamsByLeague[liga].filter(team => !team.active);

        html += `<div class="league-column"><h3>${liga}</h3>`;
        if (activeTeams.length > 0) {
            html += `<strong>Aktivní</strong>`;
            activeTeams.forEach(team => {
                html += `<a href="/admin/teams/edit/${team.id}">${team.name}</a>`;
            });
            html += `<br>`;
        }
        if (inactiveTeams.length > 0) {
            html += `<strong>Neaktivní</strong>`;
            inactiveTeams.forEach(team => {
                html += `<a href="/admin/teams/edit/${team.id}" class="inactive">${team.name}</a>`;
            });
        }

        html += `</div>`;
    }

    html += `
    </div>
  </div>
  </section>
  <p><a href="/" style="margin-top: 20px; display: inline-block;">Zpět na hlavní stránku</a></p>
</main>
</body>
</html>
`;

    res.send(html);
});


router.get('/teams/edit/:id', requireAdmin, (req, res) => {
    const teamId = parseInt(req.params.id);
    const teams = loadTeams();

    const team = teams.find(t => t.id === teamId);
    if (!team) return res.status(404).send("Tým nenalezen");
    const allLeagues = [...new Set(teams.map(t => t.liga))].sort();

    const html = `
<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upravit tým #${team.id}</title>
  <link rel="stylesheet" href="/css/styles.css" />
  <link rel="icon" href="/images/logo.png" />
</head>
<body>
<header class="header">
  <div class="logo_title">
    <img height="50" src="/images/logo.png" alt="Logo" />
    <h1 id="title">Tipovačka</h1>
  </div>
</header>
<main>
  <h1>Upravit tým #${team.id}</h1>
  <form action="/admin/teams/edit/${team.id}" method="POST">
    <label for="name">Název týmu:
      <input autocomplete="off" type="text" id="name" name="name" value="${team.name}" required />
    </label>
    <label for="liga">Liga:
      <select id="liga" name="liga" required>
        ${allLeagues.map(l => `<option value="${l}" ${l === team.liga ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>
    <label for="active">
      <input type="checkbox" id="active" name="active" ${team.active ? 'checked' : ''} />
      Aktivní tým
    </label>
    <button type="submit">Uložit změny</button>
  </form>
  <form action="/admin/teams/delete/${team.id}" method="POST" style="display:inline;" onsubmit="return confirm('Opravdu smazat tým?');">
            <button type="submit" class="action-btn delete-btn">Smazat</button>
          </form>
  <a href="/admin" class="back-link">← Zpět na seznam týmů</a>
</main>
</body>
</html>
    `;

    res.send(html);
});

router.post('/teams/edit/:id', requireAdmin, (req, res) => {
    const teamId = parseInt(req.params.id);
    const teams = loadTeams();

    const teamIndex = teams.findIndex(t => t.id === teamId);
    if (teamIndex === -1) return res.status(404).send("Tým nenalezen");

    const {name, liga, active} = req.body;

    teams[teamIndex].name = name.trim();
    teams[teamIndex].liga = liga;
    teams[teamIndex].active = active === 'on';

    fs.writeFileSync('./data/teams.json', JSON.stringify(teams, null, 2));

    res.redirect('/admin');
});

router.get('/new/match', requireAdmin, (req, res) => {
    const teams = loadTeams();
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));

    const seasonsFromTeams = teams.map(t => t.season).filter(Boolean);
    const seasonsFromMatches = matches.map(m => m.season).filter(Boolean);

    const knownSeasons = [...seasonsFromTeams, ...seasonsFromMatches];
    const currentYear = new Date().getFullYear();
    const futureSeasons = generateSeasonRange(currentYear, 10);

    const allSeasons = [...new Set([...futureSeasons, ...knownSeasons])];
    allSeasons.sort();

    const html = `
        <!DOCTYPE html>
    <html lang="cs">
        <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Vytvořit nový zápas</title>
        <link rel="stylesheet" href="/css/styles.css" />
        <link rel="icon" href="/images/logo.png">
        <script>
            function toggleBOOptions() {
                const checkbox = document.getElementById('isPlayoff');
                const boOptions = document.getElementById('boOptions');
                boOptions.style.display = checkbox.checked ? 'block' : 'none';
            }
        </script>
        </head>
        <body>
        <header class="header">
            <div class="logo_title"><img height="50" src="/images/logo.png" alt="Logo"><h1 id="title">Tipovačka</h1></div>
        </header>
        <main>
            <h1>Vytvořit nový zápas</h1>
            <form action="/admin/new/match" method="POST">
                <label for="homeTeamId">Domácí tým
                    <select id="homeTeamId" name="homeTeamId" required>
                        ${teams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                    </select>
                </label>
                <label for="awayTeamId">Hostující tým
                    <select id="awayTeamId" name="awayTeamId" required>
                        ${teams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                    </select>
                </label>
                <label for="datetime">Datum a čas
                    <input type="datetime-local" id="datetime" name="datetime" required />
                </label>Sezóna
                    <select name="season" id="seasonSelect" required>
                        ${allSeasons.map(s => `<option value="${s}">${s}</option>`).join('')}
                    </select>

                <label>
                    <input type="checkbox" name="isPlayoff" id="isPlayoff" onchange="toggleBOOptions()" />
                    Playoff série
                </label>
                <button type="submit">Vytvořit zápas</button>
                <div id="boOptions" style="display:none;">
                    <label for="bo">Typ série (BO)
                        <select name="bo" id="bo">
                            <option value="1">BO1</option>
                            <option value="3">BO3</option>
                            <option value="5">BO5</option>
                            <option value="7">BO7</option>
                            <option value="9">BO9</option>
                        </select>
                    </label>
                </div>

            </form>
            <a href="/admin" class="back-link">← Zpět na správu zápasů</a>
        </main>
    </body>
</html>
    `;

    res.send(html);
});

router.post('/new/match', requireAdmin, (req, res) => {
    const { homeTeamId, awayTeamId, datetime, season, isPlayoff, bo } = req.body;

    let matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const teams = loadTeams().filter(t => t.active);
    const homeTeam = teams.find(t => t.id === parseInt(homeTeamId));
    const awayTeam = teams.find(t => t.id === parseInt(awayTeamId));

    let liga = 'Přátelský zápas';
    if (homeTeam && awayTeam && homeTeam.liga === awayTeam.liga) {
        liga = homeTeam.liga;
    }

    const maxId = matches.reduce((max, m) => Math.max(max, m.id), 0);
    const newMatch = {
        id: maxId + 1,
        homeTeamId: parseInt(homeTeamId),
        awayTeamId: parseInt(awayTeamId),
        datetime,
        liga,
        season,
        isPlayoff: isPlayoff === 'on'
    };

    if (isPlayoff === 'on' && bo) {
        newMatch.bo = parseInt(bo);
    }

    matches.push(newMatch);

    fs.writeFileSync('./data/matches.json', JSON.stringify(matches, null, 2));
    res.redirect('/admin');
});


router.get('/new/team', requireAdmin, (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="cs">
        <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Vytvořit nový zápas</title>
    <link rel="stylesheet" href="/css/styles.css" />
    <link rel="icon" href="/images/logo.png">
    </head>
    <header class="header">
        <div class="logo_title"><img class="image_logo" src="/images/logo.png" alt="Logo"><h1 id="title">Tipovačka</h1></div>
    </header>
    <body>
    <main>
    <h1>Vytvořit nový tým</h1>
    <form method="POST" action="">
      <label>Název týmu: <input autocomplete="off" type="text" name="name" required></label>
      <label>Liga: <input type="text" name="liga" required></label>
      <label>Aktivní: <input type="checkbox" name="active" checked></label>
      <button type="submit">Vytvořit</button>
      <a href="/admin" class="back-link">← Zpět na správu zápasů</a>
    </form>
    </main>
    </body>
</html>
  `);
});

router.post('/new/team', requireAdmin, express.urlencoded({extended: true}), (req, res) => {
    const teams = loadTeams();
    let {name, liga, active} = req.body;
    active = active === 'on';

    const inputName = name.trim().toLowerCase();
    const inputLiga = liga.trim().toLowerCase();

    const exists = teams.some(team =>
        team.name.trim().toLowerCase() === inputName &&
        team.liga.trim().toLowerCase() === inputLiga
    );

    if (exists) {
        return res.send(`<p style="color:red;">Tým <strong>${name}</strong> už v lize <strong>${liga}</strong> existuje. <a href="">Zpět</a></p>`);
    }

    const newTeam = {
        id: teams.length > 0 ? Math.max(...teams.map(t => t.id)) + 1 : 1,
        name: name.trim(),
        liga: liga.trim(),
        active,
        stats: {}
    };

    teams.push(newTeam);

    fs.writeFileSync('./data/teams.json', JSON.stringify(teams, null, 2), 'utf-8');

    res.redirect('/admin');
});

router.get('/edit/:id', requireAdmin, (req, res) => {
    const matchId = parseInt(req.params.id);
    let matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const teams = loadTeams().filter(t => t.active);

    const match = matches.find(m => m.id === matchId);
    if (!match) return res.status(404).send("Zápas nenalezen");

    const seasonsFromTeams = teams.map(t => t.season).filter(Boolean);
    const seasonsFromMatches = matches.map(m => m.season).filter(Boolean);
    const allSeasons = [...new Set([...seasonsFromTeams, ...seasonsFromMatches])];
    allSeasons.sort();

    const resultHome = match.result?.scoreHome ?? '';
    const resultAway = match.result?.scoreAway ?? '';
    const selectedSeason = match.season ?? allSeasons[0] ?? '';

    const html = `
<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upravit zápas #${match.id}</title>
  <link rel="stylesheet" href="/css/styles.css" />
  <link rel="icon" href="/images/logo.png">
  <script>
    function toggleBOInput() {
      const checkbox = document.getElementById('isPlayoff');
      const boField = document.getElementById('boField');
      boField.style.display = checkbox.checked ? 'block' : 'none';
    }
  </script>
</head>
<body onload="toggleBOInput()">
<header class="header">
  <div class="logo_title"><img height="50" src="/images/logo.png" alt="Logo"><h1 id="title">Tipovačka</h1></div>
</header>
<main>
  <h1>Upravit zápas #${match.id}</h1>
  <form class="login_form" action="/admin/edit/${match.id}" method="POST">
    <label for="homeTeamId">Domácí tým:
      <select id="homeTeamId" name="homeTeamId" required>
        ${teams.map(t => `<option value="${t.id}" ${t.id === match.homeTeamId ? 'selected' : ''}>${t.name}</option>`).join('')}
      </select>
    </label>
    <label for="awayTeamId">Hostující tým:
      <select id="awayTeamId" name="awayTeamId" required>
        ${teams.map(t => `<option value="${t.id}" ${t.id === match.awayTeamId ? 'selected' : ''}>${t.name}</option>`).join('')}
      </select>
    </label>
    <label for="datetime">Datum a čas:
      <input type="datetime-local" id="datetime" name="datetime" value="${match.datetime.slice(0, 16)}" required />
    </label>
    <label for="season">Sezóna:
      <select id="season" name="season" required>
        ${allSeasons.map(sez => `<option value="${sez}" ${sez === selectedSeason ? 'selected' : ''}>${sez}</option>`).join('')}
      </select>
    </label>

    <label for="isPlayoff" style="margin-top: 1rem;">
      <input type="checkbox" id="isPlayoff" name="isPlayoff" ${match.isPlayoff ? 'checked' : ''} onchange="toggleBOInput()" />
      Tento zápas je součástí playoff
    </label>

    <div id="boField" style="display:none;">
      <label for="bo">Počet vítězných zápasů v sérii (bo):
        <input type="number" id="bo" name="bo" min="1" max="9" value="${match.bo ?? ''}" />
      </label>
    </div>

    <fieldset class="edit-score">
      <legend>Výsledek (pokud je vyhodnocen)</legend>
      <label for="scoreHome">Skóre domácích:
        <input type="number" id="scoreHome" name="scoreHome" value="${resultHome}" min="0" />
      </label>
      <label for="scoreAway">Skóre hostů:
        <input type="number" id="scoreAway" name="scoreAway" value="${resultAway}" min="0" />
      </label>
      <label for="overtime">
        <input type="checkbox" id="overtime" name="overtime" ${match.result?.ot ? 'checked' : ''} />
        Rozhodnuto v prodloužení?
      </label>
    </fieldset>

    <button class="edit-btn" type="submit">Uložit změny</button>
  </form>
  <a href="/admin" class="back-link">← Zpět na správu zápasů</a>
</main>
</body>
</html>
    `;
    res.send(html);
});

router.post('/edit/:id', requireAdmin, (req, res) => {
    const matchId = parseInt(req.params.id);
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));

    const {homeTeamId, awayTeamId, datetime, season, scoreHome, scoreAway} = req.body;

    const matchIndex = matches.findIndex(m => m.id === matchId);
    if (matchIndex === -1) return res.status(404).send("Zápas nenalezen");

    const match = matches[matchIndex];
    match.homeTeamId = parseInt(homeTeamId);
    match.awayTeamId = parseInt(awayTeamId);
    match.datetime = datetime;
    match.season = season;
    match.isPlayoff = req.body.isPlayoff === 'on';

    if (match.isPlayoff && req.body.bo && !isNaN(parseInt(req.body.bo))) {
        match.bo = parseInt(req.body.bo);
    } else {
        delete match.bo;
    }

    const parsedHome = scoreHome === '' ? null : parseInt(scoreHome);
    const parsedAway = scoreAway === '' ? null : parseInt(scoreAway);

    if (parsedHome !== null && parsedAway !== null) {
        if (parsedHome > parsedAway) winner = "home";
        else if (parsedHome < parsedAway) winner = 'away';
        else winner = null;

        match.result = {
            scoreHome: parsedHome,
            scoreAway: parsedAway,
            ot: req.body.overtime === 'on',
            winner: winner,
        };
    } else {
        delete match.result;
    }
    fs.writeFileSync('./data/matches.json', JSON.stringify(matches, null, 2));
    updateTeamsPoints(matches);
    evaluateAndAssignPoints(matches[matchIndex].liga, matches[matchIndex].season);
    res.redirect('/admin');
});

router.post('/teams/delete/:id', requireAdmin, (req, res) => {
    const teamsId = parseInt(req.params.id);
    let teams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf8'));

    teams = teams.filter(t => t.id !== teamsId);

    fs.writeFileSync('./data/teams.json', JSON.stringify(teams, null, 2));
    res.redirect('/admin');
});

router.post('/delete/:id', requireAdmin, (req, res) => {
    const matchId = parseInt(req.params.id);
    let matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));

    matches = matches.filter(m => m.id !== matchId);
    updateTeamsPoints(matches)

    fs.writeFileSync('./data/matches.json', JSON.stringify(matches, null, 2));
    removeTipsForDeletedMatch(matchId);
    res.redirect('/admin');
});

const {getAllSeasons} = require('../utils/fileUtils');

router.get('/api/seasons', requireAdmin, (req, res) => {
    const seasons = getAllSeasons();
    res.json(seasons);
});

router.post('/season', express.urlencoded({ extended: true }), requireAdmin, (req, res) => {
    const selectedSeason = req.body.season || 'Neurčeno';
    fs.writeFileSync('./data/chosenSeason.json', JSON.stringify(selectedSeason, null, 2), 'utf-8');
    res.redirect('/admin');
});

const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
const teams = loadTeams();
const SEASON = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];

router.get('/playoff',requireAdmin ,(req, res) => {
    const selectedLeague = req.query.league || allLeagues[0];

    const filePath = path.join(__dirname, '../data/playoff.json');
    fs.readFile(filePath, 'utf-8', (err, jsonData) => {
        let playoffData = {};

        if (!err && jsonData) {
            try {
                playoffData = JSON.parse(jsonData);
            } catch {
                playoffData = {};
            }
        }

        if (!playoffData[SEASON]) playoffData[SEASON] = {};
        if (!playoffData[SEASON][selectedLeague]) {
            playoffData[SEASON][selectedLeague] = Array.from({ length: 20 }, () =>
                Array.from({ length: 20 }, () => ({ text: '', bgColor: '' }))
            );
        }

        const tableData = playoffData[SEASON][selectedLeague];

        const leagueOptions = allLeagues
            .map(liga => `<option value="${liga}" ${liga === selectedLeague ? 'selected' : ''}>${liga}</option>`)
            .join('\n');

        let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Admin - Správa playoff tabulky</title>
  <link rel="stylesheet" href="/css/styles.css" />
  <link rel="icon" href="/images/logo.png">
<style>
  body { background: #222;}
  form { padding: 10px; }
  label { color: orangered; }
  select { margin-left: 10px; }
  table { border-collapse: collapse; width: 100%; margin-top: 20px; user-select: none; }
  td { border: 1px solid orangered; width: 60px; height: 20px; text-align: center; padding: 5px; cursor: pointer; background-color: #333; color: lightgrey; font-weight: 600; transition: background-color 0.3s ease, color 0.3s ease; }
  td:focus { outline: 2px solid orangered; background-color: orangered; color: black; }
  td[contenteditable="true"]:empty::before { content: attr(data-placeholder); color: #666; }
</style>
</head>
<body>

<header>
  <div class="logo_title"><img class="image_logo" src="/images/logo.png" alt="Logo"><h1 id="title">Tipovačka</h1></div>
  <h1>Playoff tabulka - sezóna: ${SEASON}</h1>
  <form id="leagueForm" method="GET" action="/admin/playoff">
    <label for="leagueSelect">Vyber ligu:</label>
    <select name="league" id="leagueSelect" onchange="this.form.submit()">
      ${leagueOptions}
    </select>
  </form>
</header>

<form id="saveForm" action="/admin/playoff/save" method="POST">
  <input type="hidden" name="season" value="${SEASON}">
  <input type="hidden" name="league" value="${selectedLeague}">
  <input type="hidden" name="tableData" id="tableData" />
  <table id="playoffTable">
`;

        for (let i = 0; i < 20; i++) {
            html += '<tr>';
            for (let j = 0; j < 20; j++) {
                const cell = tableData[i][j] || { text: '', bgColor: '' };
                const style = cell.bgColor ? `style="background-color:${cell.bgColor}"` : '';
                const content = cell.text || '';
                html += `<td contenteditable="true" data-placeholder="…" ${style}>${content}</td>`;
            }
            html += '</tr>';
        }

        html += `
  </table>
  <div style="display: flex; align-items: center;">
  <button type="submit" style="margin-top:10px; margin-bottom: 10px; padding:5px 10px;">Uložit</button>
</form>
  <form action="/admin/playoff/delete" method="POST" onsubmit="return confirm('Opravdu chceš smazat celou playoff tabulku? Tohle nelze vrátit zpět!');">
  <input type="hidden" name="season" value="${SEASON}">
  <input type="hidden" name="league" value="${selectedLeague}">
  <button type="submit" style="margin-left: 20px; padding:5px 10px;">Smazat celou tabulku</button>
  </form>
  <label for="colorPicker" style="margin-left: 20px; color: orangered; font-weight: 600;">Vyber barvu:</label>
  <input type="color" id="colorPicker" value="#FF0000" style="vertical-align: middle; margin-left: 5px;">
  </div>
  <div style="margin-left: 10px">
  <div>Pravé tlačítko myši = Aplikování barvy z výběru do buňky</div>
  <div>CTRL + Pravé tlačítko myši = Zrušení obarvení pole</div>
  <p><a href="/admin">Zpět na hlavní stránku</a></p>
  </div>

<script>

  let selectedColor = colorPicker.value;
  colorPicker.addEventListener('input', e => selectedColor = e.target.value);

  document.querySelectorAll('td').forEach(cell => {
    cell.addEventListener('keydown', e => {
      if ((e.key === 'Backspace' || e.key === 'Delete') && cell.innerText.trim() === '') {
        e.preventDefault();
        cell.innerText = '';
      }
      if (e.key === 'Enter') e.preventDefault();
    });
    cell.addEventListener('paste', e => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      document.execCommand('insertText', false, text);
    });
    cell.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        cell.style.backgroundColor = '#333';
      } else {
        cell.style.backgroundColor = selectedColor;
      }
    });
  });

  document.getElementById('saveForm').addEventListener('submit', () => {
    const table = document.getElementById('playoffTable');
    const data = [];
    for (let row of table.rows) {
      const rowData = [];
      for (let cell of row.cells) {
        rowData.push({ text: cell.innerText.trim(), bgColor: cell.style.backgroundColor || '' });
      }
      data.push(rowData);
    }
    document.getElementById('tableData').value = JSON.stringify(data);
  });
  
   document.getElementById('clearButton').addEventListener('click', () => {
    if (confirm('Opravdu chceš smazat celou tabulku? Tohle je nevratné!')) {
      const table = document.getElementById('playoffTable');
      for (let row of table.rows) {
        for (let cell of row.cells) {
          cell.innerText = '';
          cell.style.backgroundColor = '#333';
        }
      }
    }
  });
  
</script>

</body>
</html>`;

        res.send(html);
    });
});

router.post('/playoff/save', (req, res) => {
    const { tableData, league, season } = req.body;

    if (!tableData || !league || !season) {
        return res.status(400).send('Chybí data k uložení');
    }

    const filePath = path.join(__dirname, '../data/playoff.json');
    fs.readFile(filePath, 'utf8', (err, jsonData) => {
        let playoffData = {};
        if (!err && jsonData) {
            try {
                playoffData = JSON.parse(jsonData);
            } catch {
                playoffData = {};
            }
        }

        if (!playoffData[season]) playoffData[season] = {};
        try {
            playoffData[season][league] = JSON.parse(tableData);
        } catch(e) {
            return res.status(400).send('Špatný formát tableData');
        }

        fs.writeFile(filePath, JSON.stringify(playoffData, null, 2), err => {
            if (err) {
                console.error('Chyba při zápisu do souboru:', err);
                return res.status(500).send('Nepodařilo se uložit data');
            }
            res.redirect(`/admin/playoff?league=${encodeURIComponent(league)}`);
        });
    });
});

router.post('/playoff/delete', requireAdmin, (req, res) => {
    const { season, league } = req.body;

    if (!season || !league) {
        return res.status(400).send('Chybí sezóna nebo liga k vymazání.');
    }

    const filePath = path.join(__dirname, '../data/playoff.json');
    fs.readFile(filePath, 'utf8', (err, jsonData) => {
        let playoffData = {};

        if (!err && jsonData) {
            try {
                playoffData = JSON.parse(jsonData);
            } catch {
                playoffData = {};
            }
        }

        if (playoffData[season] && playoffData[season][league]) {
            delete playoffData[season][league];

            // Pokud tím pádem sezóna bude prázdná, smaž ji taky
            if (Object.keys(playoffData[season]).length === 0) {
                delete playoffData[season];
            }
        }

        fs.writeFile(filePath, JSON.stringify(playoffData, null, 2), err => {
            if (err) {
                console.error('Chyba při zápisu do souboru:', err);
                return res.status(500).send('Nepodařilo se smazat data');
            }

            res.redirect('/admin/playoff');
        });
    });
});


module.exports = router;