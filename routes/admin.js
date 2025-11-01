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
router.post('/backup', async (req, res) => {
    try {
        await backupJsonFilesToGitHub();
        res.json({ success: true, message: '✅ Záloha provedena' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '❌ Chyba při záloze' });
    }
});

router.get('/', requireAdmin, (req, res) => {
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const teams = loadTeams();
    const allowedLeagues = JSON.parse(fs.readFileSync('./data/allowedLeagues.json', 'utf-8'));
    const leagues = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    const chosenSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));

    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromLeagues = [... new Set(leagues.map(t => t.name))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches, ...leaguesFromLeagues])];

    const uniqueLeagues = allLeagues.filter(l => leaguesFromLeagues.includes(l));

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga)
        ? req.query.liga
        : uniqueLeagues[0] || allLeagues[0];
    const teamsByLeague = {};
    teams.forEach(team => {
        if (!teamsByLeague[team.liga]) teamsByLeague[team.liga] = [];
        teamsByLeague[team.liga].push(team);
    });
    const teamsByGroup = {};
    teams.forEach(team => {
        if (team.liga === selectedLiga) {
            if (!teamsByGroup[team.group]) teamsByGroup[team.group] = [];
            teamsByGroup[team.group].push(team);
        }
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

    const pendingMatches = filteredMatches
        .filter(m => !m.result)
        .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

    const finishedMatches = filteredMatches
        .filter(m => m.result)
        .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

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
        <a href="/admin/leagues/manage" class="btn new-btn-admin">Správa lig</a>
        <a id="backupBtn" class="btn new-btn-admin">Uložit data uživatelům (pouze pro administrativní účely)</a>
    </div>
  </div>
  <form class="league-dropdown" method="GET" action="/admin/">
    Liga:
    <select id="league-select" name="liga" required onchange="this.form.submit()">
        ${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    Sezóna:
    <select class="league-select" name="season" onchange="this.form.submit()">
        ${seasons.map(s => `<option value="${s}" ${s === selectedSeason ? 'selected' : ''}>${s}</option>`).join('')}
    </select>
  </form>
  <section class="all-match-table-and-leagues">
  <div style="display: flex; flex-direction: column; border: 1px solid orangered; padding: 10px; flex: 5;">
  <table>
    <thead>
    <h2>Nevyhodnocené zápasy (${pendingMatches.length})</h2>
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

    for (const m of pendingMatches) {
        const homeTeam = teams.find(t => t.id === m.homeTeamId)?.name || '???';
        const awayTeam = teams.find(t => t.id === m.awayTeamId)?.name || '???';
        const result = '-';
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
            <button type="submit" style="font-family: Segoe UI,serif" class="action-btn delete-btn">Smazat</button>
          </form>
            <a href="/admin/togglePostponed/${m.id}" 
                class="action-btn ${m.postponed ? 'postponed' : 'delete-btn'}">
                ${m.postponed ? 'Odložený' : 'Odložit'}
            </a>
        </td>
      </tr>
    `;
    }

    html += `
    </table>
    <details style="margin-top:20px;">
      <summary><h2 style="display: inline">Vyhodnocené zápasy (${finishedMatches.length})</h2></summary>
      <table style="margin-top:10px; width: 100%">
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

    for (const m of finishedMatches) {
        const homeTeam = teams.find(t => t.id === m.homeTeamId)?.name || '???';
        const awayTeam = teams.find(t => t.id === m.awayTeamId)?.name || '???';
        const result = `${m.result.scoreHome} : ${m.result.scoreAway} ${m.result.ot === true ? "pp/sn" : ""}`;
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
    </details>
    </div>
  <div class="select-leagues">
    <h2>Vybraná sezóna</h2>
    <form method="POST" action="/admin/season">
      <label for="season-select">Sezóna:</label>
      <div class="season-choose">
        <select id="season-select" class="league-select" style="width: 100%" name="season">
          ${seasons.map(s => `<option value="${s}" ${s === chosenSeason ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button type="submit" class="action-btn edit-btn" style="margin-top: 10px;">Vybrat sezónu</button>
      </div>
    </form>
    <h2>Veřejné ligy</h2>
    <form method="POST" action="/admin/leagues/visibility">
      <div class="leagues-allow">
`;

    for (const l of allLeagues) {
        const checked = allowedLeagues.includes(l) ? 'checked' : '';
        html += `
        <label style="display: flex; align-items: center">
          <input type="checkbox" name="allowedLeagues" value="${l}" ${checked}/>
          ${l}
        </label>
      `;
    }

    html += `
      </div>
      <button type="submit" class="action-btn edit-btn" style="margin-top: 10px;">Uložit viditelnost lig</button>
    </form>
  </div>
  </section>
  <section class="all-match-table-and-leagues">
  <div class="select-teams">
    <h2>Veřejné ligy</h2>
    <div class="teams-allow">
`;

    leaguesFromLeagues.forEach(liga => {
        const leagueTeams = teamsByLeague[liga] || [];
        const activeTeams = leagueTeams.filter(team => team.active);
        const inactiveTeams = leagueTeams.filter(team => !team.active);
        const leagueObj = leagues.find(l => l.name === liga);

        const sortTeams = arr => arr.sort((a, b) => {
            if (a.group !== b.group) return a.group - b.group;
            return a.name.localeCompare(b.name, 'cs', { sensitivity: 'base' });
        });

        sortTeams(activeTeams);
        sortTeams(inactiveTeams);

        html += `<div class="league-column"><h3>${liga}</h3>`;
        if (activeTeams.length > 0) {
            html += `<strong>Aktivní</strong>`;
            activeTeams.forEach(team => {
                if (leagueObj?.isMultigroup === true){
                    html += `<a href="/admin/teams/edit/${team.id}">${String.fromCharCode(team.group+64)} - ${team.name}</a>`;
                } else {
                    html += `<a href="/admin/teams/edit/${team.id}">${team.name}</a>`;
                }
            });
            html += `<br>`;
        }
        if (inactiveTeams.length > 0) {
            html += `<strong>Neaktivní</strong>`;
            inactiveTeams.forEach(team => {
                if (leagueObj?.isMultigroup === true){
                    html += `<a href="/admin/teams/edit/${team.id}" class="inactive">${String.fromCharCode(team.group+64)} - ${team.name}</a>`;
                } else {
                    html += `<a href="/admin/teams/edit/${team.id}" class="inactive">${team.name}</a>`;
                }
            });
        }

        html += `</div>`;
    })

    html += `
    </div>
  </div>
  </section>
  <p><a href="/" style="margin-top: 20px; display: inline-block;">Zpět na hlavní stránku</a></p>
</main>
</body>
<script>
document.getElementById('backupBtn').addEventListener('click', async () => {
  const res = await fetch('/admin/backup', { method: 'POST' });
  const data = await res.json();
  alert(data.message);
});
</script>
</html>
`;

    res.send(html);
});
router.post('/leagues', express.urlencoded({ extended: true }), requireAdmin, (req, res) => {
    const ligaName = req.body.name?.trim();
    if (!ligaName) return res.send('<p style="color:red;">Název ligy je povinný. <a href="/admin/leagues/manage">Zpět</a></p>');

    const leagues = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const exists = leagues.some(l => l.name.toLowerCase() === ligaName.toLowerCase());
    if (exists) return res.send(`<p style="color:red;">Liga <strong>${ligaName}</strong> už existuje. <a href="/admin/leagues/manage">Zpět</a></p>`);

    const multiGroup = req.body.multiGroup === 'on';
    const groupCount = multiGroup ? parseInt(req.body.groupCount) || 1 : 1;

    const newLeague = {
        name: ligaName,
        isMultigroup: multiGroup,
        groupCount: groupCount
    };

    leagues.push(newLeague);
    fs.writeFileSync('./data/leagues.json', JSON.stringify(leagues, null, 2), 'utf-8');
});

router.post('/leagues/visibility', requireAdmin, (req, res) => {
    let ligaNames = req.body.allowedLeagues || [];
    if (!Array.isArray(ligaNames)) ligaNames = [ligaNames];

    const allowedLeagues = JSON.parse(fs.readFileSync('./data/allowedLeagues.json', 'utf-8'));
    allowedLeagues.push(ligaNames);
    fs.writeFileSync('./data/allowedLeagues.json', JSON.stringify([...new Set(ligaNames)], null, 2), 'utf-8');

    res.redirect('/admin');
})

router.get('/teams/edit/:id', requireAdmin, (req, res) => {
    const teamId = parseInt(req.params.id);
    const teams = loadTeams();

    const team = teams.find(t => t.id === teamId);
    if (!team) return res.status(404).send("Tým nenalezen");
    const leagues = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leaguesFromLeagues = [... new Set(leagues.map(t => t.name))];

    const teamLeagueObj = leagues.find(l => l.name === team.liga);
    const groupCount = teamLeagueObj?.isMultigroup ? teamLeagueObj.groupCount : 1;

    const groupOptions = [...Array(groupCount).keys()]
        .map(i => `<option value="${i+1}" ${team.group === i+1 ? 'selected' : ''}>Skupina ${String.fromCharCode(65+i)}</option>`)
        .join('');

    const html = `
<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upravit tým ID ${team.id} ${team.name}</title>
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
  <h1>Upravit tým ${team.name} ID ${team.id}</h1>
  <form style="display: flex; flex-direction: row; gap: 10px; margin-bottom: 10px" action="/admin/teams/edit/${team.id}" method="POST">
    <label style="display: flex; flex-direction: column" for="name">Název týmu
      <input autocomplete="off" style="width: 220px" class="league-select" type="text" id="name" name="name" value="${team.name}" required />
    </label>
    <label style="display: flex; flex-direction: column" for="liga">Liga
      <select class="league-select" id="liga" name="liga" required>
        ${leaguesFromLeagues.map(l => `<option value="${l}" ${l === team.liga ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </label>
    ${teamLeagueObj?.isMultigroup ? `
    <label style="display: flex; flex-direction: column" for="group">Skupina
      <select class="league-select" id="group" name="group" required>
        ${groupOptions}
      </select>
    </label>` : ''}
    <label style="display: flex; flex-direction: row; align-items: center" for="active">
        Aktivní tým
      <input type="checkbox" id="active" name="active" ${team.active ? 'checked' : ''} />
    </label>
    <button class="action-btn edit-btn" type="submit">Uložit změny</button>
  </form>
  <form action="/admin/teams/delete/${team.id}" method="POST" style="display:inline;" onsubmit="return confirm('Opravdu smazat tým?');">
            <button type="submit" class="action-btn delete-btn">Smazat tým</button>
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
                boOptions.style.display = checkbox.checked ? 'flex' : 'none';
            }
        </script>
        </head>
        <body>
        <header class="header">
            <div class="logo_title"><img height="50" src="/images/logo.png" alt="Logo"><h1 id="title">Tipovačka</h1></div>
        </header>
        <main>
            <h1>Vytvořit nový zápas</h1>
            <form style="display: flex; flex-direction: row; gap: 10px" action="/admin/new/match" method="POST">
                <label style="display: flex; flex-direction: column" for="homeTeamId">Domácí tým
                    <select class="league-select" style="width: 220px" id="homeTeamId" name="homeTeamId" required>
                        ${teams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                    </select>
                </label>
                <label style="display: flex; flex-direction: column" for="awayTeamId">Hostující tým
                    <select class="league-select" style="width: 220px" id="awayTeamId" name="awayTeamId" required>
                        ${teams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                    </select>
                </label>
                <label style="display: flex; flex-direction: column" for="datetime">Datum a čas
                    <input class="league-select" style="width: 150px" type="datetime-local" id="datetime" name="datetime" required />
                </label>
                <label style="display: flex; flex-direction: column">Sezóna
                    <select class="league-select" name="season" id="seasonSelect" required>
                        ${allSeasons.map(s => `<option value="${s}">${s}</option>`).join('')}
                    </select>
                </label>
                <label style="display: flex; align-items: center; flex-direction: row">
                    Playoff série
                    <input type="checkbox" name="isPlayoff" id="isPlayoff" onchange="toggleBOOptions()" />
                </label>
                <div style="display: none; flex-direction: column; align-items: center" id="boOptions">
                        Typ série (BO)
                        <select class="league-select" name="bo" id="bo">
                            <option value="1">BO1</option>
                            <option value="3">BO3</option>
                            <option value="5">BO5</option>
                            <option value="7">BO7</option>
                            <option value="9">BO9</option>
                        </select>
                </div>
                <button class="action-btn btn" type="submit">Vytvořit zápas</button>

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
    const leagues = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    const leagueOptions = leagues.map(l => `<option value="${l.name}">${l.name}</option>`).join('');

    const groupOptions = '';

    res.send(`
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Vytvořit nový tým</title>
        <link rel="stylesheet" href="/css/styles.css" />
        <link rel="icon" href="/images/logo.png">
    </head>
    <body>
    <header class="header">
        <div class="logo_title"><img class="image_logo" src="/images/logo.png" alt="Logo"><h1 id="title">Tipovačka</h1></div>
    </header>
    <main>
    <h1>Vytvořit nový tým</h1>
    <form style="display: flex; flex-direction: row; gap: 10px" method="POST" action="">
      <label style="display: flex; flex-direction: column;">Název týmu: <input style="width: 220px" class="league-select" autocomplete="off" type="text" name="name" required></label>
      <label style="display: flex; flex-direction: column;">Liga:
        <select class="league-select" style="width: 220px" name="liga" id="ligaSelect" required>
            ${leagueOptions}
        </select>
     </label>
     <label style="display: flex; flex-direction: column;">Skupina:
        <select class="league-select" style="width: 220px" name="group" id="groupSelect">
            ${groupOptions}
        </select>
    </label>
    <label style="display: flex; flex-direction: row; align-items: center">Aktivní tým <input type="checkbox" name="active" checked></label>
    <button class="action-btn btn" type="submit">Vytvořit tým</button>
    </form>
    <a href="/admin" class="back-link">← Zpět na správu zápasů</a>
    </main>
    </body>
    <script>
    const leagues = ${JSON.stringify(leagues)};
    const ligaSelect = document.getElementById('ligaSelect');
    const groupSelect = document.getElementById('groupSelect');

    function updateGroups() {
        const selectedName = ligaSelect.value;
        const selectedLeague = leagues.find(l => l.name === selectedName);
        const count = selectedLeague?.groupCount || 1;

        groupSelect.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const option = document.createElement('option');
            option.value = i+1;
            option.textContent = 'Skupina ' + String.fromCharCode(65+i);
            groupSelect.appendChild(option);
        }
    }
    updateGroups();
    ligaSelect.addEventListener('change', updateGroups);
    </script>
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
        group: parseInt(req.body.group),
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
  <h1>Upravit zápas ID ${match.id}</h1>
  <form class="login_form" action="/admin/edit/${match.id}" method="POST">
    <label for="homeTeamId">Domácí tým
      <select class="league-select" style="width: 220px" id="homeTeamId" name="homeTeamId" required>
        ${teams.map(t => `<option value="${t.id}" ${t.id === match.homeTeamId ? 'selected' : ''}>${t.name}</option>`).join('')}
      </select>
    </label>
    
    <label for="awayTeamId">Hostující tým
      <select class="league-select" style="width: 220px" id="awayTeamId" name="awayTeamId" required>
        ${teams.map(t => `<option value="${t.id}" ${t.id === match.awayTeamId ? 'selected' : ''}>${t.name}</option>`).join('')}
      </select>
    </label>
    
    <label for="datetime">Datum a čas
      <input class="league-select" style="width: 200px" type="datetime-local" id="datetime" name="datetime" value="${match.datetime.slice(0, 16)}" required />
    </label>
    
    <label for="season">Sezóna
      <select class="league-select" id="season" name="season" required>
        ${allSeasons.map(sez => `<option value="${sez}" ${sez === selectedSeason ? 'selected' : ''}>${sez}</option>`).join('')}
      </select>
    </label>

    <label style="display: flex; flex-direction: row; align-items: center" for="isPlayoff" style="margin-top: 1rem;">
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
      <label for="scoreHome">Skóre domácích
        <input class="league-select" type="number" id="scoreHome" name="scoreHome" value="${resultHome}" min="0" />
      </label>
      <label for="scoreAway">Skóre hostů:
        <input class="league-select" type="number" id="scoreAway" name="scoreAway" value="${resultAway}" min="0" />
      </label>
      <label style="display: flex; flex-direction: row; align-items: center" for="overtime">
        <input type="checkbox" id="overtime" name="overtime" ${match.result?.ot ? 'checked' : ''} />
        Rozhodnuto v prodloužení?
      </label>
    </fieldset>

    <button class="action-btn edit-btn" type="submit">Uložit změny</button>
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
    match.postponed = req.body.postponed === 'on';

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
    evaluateAndAssignPoints(matches[matchIndex].liga, matches[matchIndex].season);
    res.redirect('/admin');
});

const {getAllSeasons} = require('../utils/fileUtils');
const {backupJsonFilesToGitHub} = require("../utils/githubBackup");

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
const leagues = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
const leaguesFromLeagues = [... new Set(leagues.map(t => t.name))];
const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches, ...leaguesFromLeagues])];
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
    <select name="league" class="league-select" onchange="this.form.submit()">
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
                const style = `style="background-color:${cell.bgColor || '#333'};color:${cell.textColor || 'lightgrey'}"`;
                const content = cell.text || '';
                html += `<td contenteditable="true" data-placeholder="…" ${style}>${content}</td>`;
            }
            html += '</tr>';
        }

        html += `
  </table>
  <div style="display: flex; align-items: center;">
  <button type="submit" class="action-btn edit-btn" style="margin-top:10px; margin-bottom: 10px; padding:5px 10px;">Uložit</button>
</form>
  <form action="/admin/playoff/delete" method="POST" onsubmit="return confirm('Opravdu chceš smazat celou playoff tabulku? Tohle nelze vrátit zpět!');">
  <input type="hidden" name="season" value="${SEASON}">
  <input type="hidden" name="league" value="${selectedLeague}">
  <button type="submit" class="action-btn delete-btn" style="margin-left: 20px; padding:5px 10px;">Smazat celou tabulku</button>
  </form>
  <label for="colorPicker" style="margin-left: 20px; color: orangered; font-weight: 600;">Vyber barvu:</label>
  <input type="color" id="colorPicker" value="#FF0000" style="vertical-align: middle; margin-left: 5px;">
  <label for="textColorPicker" style="margin-left: 20px; color: orangered; font-weight: 600;">Barva textu:</label>
  <input type="color" id="textColorPicker" value="#FFFFFF" style="vertical-align: middle; margin-left: 5px;">
  </div>
  <div style="margin-left: 10px">
  <div>Pravé tlačítko myši = Aplikování barvy z výběru do buňky</div>
  <div>CTRL + Pravé tlačítko myši = Zrušení obarvení pole</div>
  <div>SHIFT + Pravé tlačítko myši = Aplikování barvy z výběru do textu</div>
  <div>CTRL + SHIFT + Pravé tlačítko myši = Zrušení obarvení textu</div>
  <p><a href="/admin">Zpět na hlavní stránku</a></p>
  </div>

<script>

  let selectedBgColor = colorPicker.value;
let selectedTextColor = textColorPicker.value;

colorPicker.addEventListener('input', e => selectedBgColor = e.target.value);
textColorPicker.addEventListener('input', e => selectedTextColor = e.target.value);

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
    if (e.shiftKey) {
      // SHIFT + Pravý klik → mění barvu textu
      if (e.ctrlKey || e.metaKey) {
        cell.style.color = 'lightgrey'; // reset textu
      } else {
        cell.style.color = selectedTextColor;
      }
    } else {
      // normální pravý klik → mění pozadí
      if (e.ctrlKey || e.metaKey) {
        cell.style.backgroundColor = '#333';
      } else {
        cell.style.backgroundColor = selectedBgColor;
      }
    }
  });
});


  document.getElementById('saveForm').addEventListener('submit', () => {
    const table = document.getElementById('playoffTable');
    const data = [];
    for (let row of table.rows) {
    const rowData = [];
    for (let cell of row.cells) {
    rowData.push({
        text: cell.innerText.trim(),
        bgColor: cell.style.backgroundColor || '',
        textColor: cell.style.color || ''
        });
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

router.get('/togglePostponed/:id', requireAdmin, (req, res) => {
    const matchId = parseInt(req.params.id);
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const match = matches.find(m => m.id === matchId);
    if (!match) return res.status(404).send("Zápas nenalezen");

    match.postponed = !match.postponed;

    fs.writeFileSync('./data/matches.json', JSON.stringify(matches, null, 2));
    res.redirect('/admin');
});

router.get('/leagues/manage', requireAdmin, (req, res) => {
    const leagues = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));

    const html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <title>Správa lig</title>
        <link rel="stylesheet" href="/css/styles.css">
    </head>
    <body>
        <h1>Správa lig</h1>
        <form method="POST" action="/admin/leagues/manage">
            <label>Nová liga:
                <input type="text" class="league-select" name="newLeague[ligaName]" required>
            </label>
            <label style="display: flex; align-items: center; gap: 10px;">
                Více skupin/tabulek:
                <input type="checkbox" id="multiGroupCheckbox" name="newLeague[multigroup]" onchange="toggleGroupInput()">
            </label>
            <label id="groupCountLabel" style="display:none; gap: 10px; flex-direction: row;">
                Počet skupin:
            <input type="number" class="league-select" min="1" max="10" id="groupCount" name="newLeague[groupCount]" value="2">
            </label>

            <button class="action-btn edit-btn" type="submit">Přidat</button>
        </form>
        <h2>Seznam lig</h2>
        <ul>
            ${leagues.map(l => `
                <li>
                    ${l.name} 
                    <form method="POST" action="/admin/leagues/delete" style="display:inline;">
                        <input type="hidden" name="league" value="${l.name}">
                        <button class="action-btn delete-btn" type="submit">Smazat</button>
                    </form>
                </li>`).join('')}
        </ul>
        <a href="/admin">← Zpět na hlavní stránku</a>
    </body>
    <script>
        function toggleGroupInput() {
            const checkbox = document.getElementById('multiGroupCheckbox');
            const label = document.getElementById('groupCountLabel');
            label.style.display = checkbox.checked ? 'flex' : 'none';
        }
    </script>
    </html>
    `;
    res.send(html);
});

router.post('/leagues/manage', requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
    const {ligaName, multigroup, groupCount} = req.body.newLeague;
    let leagues = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    if (!leagues.some(l => l.name === ligaName)) {
        leagues.push({ name: ligaName, isMultigroup: multigroup === 'on' || false, groupCount: Number(groupCount) || 1});
        fs.writeFileSync('./data/leagues.json', JSON.stringify(leagues, null, 2));
    }
    res.redirect('/admin/leagues/manage');
});


router.post('/leagues/delete', requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
    const leagueToDelete = req.body.league?.name || req.body.league;
    let leagues = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    leagues = leagues.filter(l => l.name !== leagueToDelete);
    fs.writeFileSync('./data/leagues.json', JSON.stringify(leagues, null, 2));

    const playoffPath = './data/playoff.json';
    let playoffData = JSON.parse(fs.readFileSync(playoffPath, 'utf8'));
    if (playoffData[SEASON] && playoffData[SEASON][leagueToDelete]) {
        delete playoffData[SEASON][leagueToDelete];
        fs.writeFileSync(playoffPath, JSON.stringify(playoffData, null, 2));
    }

    res.redirect('/admin/leagues/manage');
});

module.exports = router;