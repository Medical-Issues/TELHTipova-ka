const fs = require("fs");
const express = require("express");
const router = express.Router();
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const notif = require('./notificationService');
const bcrypt = require("bcrypt");
const {
    requireAdmin,
    loadTeams,
    updateTeamsPoints,
    evaluateAndAssignPoints,
    generateSeasonRange,
    removeTipsForDeletedMatch,
    renameLeagueGlobal,
    evaluateRegularSeasonTable,
    renderErrorHtml,
    logAdminAction,
} = require("../utils/fileUtils");
router.post('/backup', async (req, res) => {
    try {
        await backupJsonFilesToGitHub();
        res.json({ success: true, message: '✅ Záloha provedena' });
        logAdminAction(req.session.user, "ZÁLOHA_DAT", `Spuštěna manuální záloha na GitHub`);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '❌ Chyba při záloze' });
    }
});
const storage = multer.diskStorage({
    'destination': function (req, file, cb) {
        const uploadPath = path.resolve(__dirname, '..', 'data', 'images');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    'filename': function (req, file, cb) {
        const safeName = Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');
        cb(null, safeName);
    }
});

const upload = multer({ storage: storage });
router.get('/', requireAdmin, (req, res) => {
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const teams = loadTeams();
    const transferLeagues = JSON.parse(fs.readFileSync('./data/transferLeagues.json', 'utf8'));
    const allowedLeagues = JSON.parse(fs.readFileSync('./data/allowedLeagues.json', 'utf-8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const selecteSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const leagues = (allSeasonData[selecteSeason] && allSeasonData[selecteSeason].leagues)
        ? allSeasonData[selecteSeason].leagues
        : [];
    const chosenSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));

    let clinchMode = 'strict';
    try {
        const settingsData = JSON.parse(fs.readFileSync('./data/settings.json', 'utf8'));
        if (settingsData.clinchMode) clinchMode = settingsData.clinchMode;
    } catch (e) {
        // Soubor neexistuje, použije se 'strict'
    }

    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromLeagues = [... new Set(leagues.map(t => t.name))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches, ...leaguesFromLeagues])];
    const currentYear = new Date().getFullYear();
    const seasonsFromTeams = teams.map(t => t.season).filter(Boolean);
    const seasonsFromMatches = matches.map(m => m.season).filter(Boolean);

    const knownSeasons = [...seasonsFromTeams, ...seasonsFromMatches];
    const futureSeasons = generateSeasonRange(currentYear, 10);

    const allSeasons = [...new Set([...futureSeasons, ...knownSeasons])];
    allSeasons.sort();

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

    const selectedSeason = req.query.season && allSeasons.includes(req.query.season)
        ? req.query.season
        : allSeasons[0] || 'Neurčeno';

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
        <a href="/admin/playoff" class="btn new-btn-admin">Playoff tabulky</a>
        <a href="/admin/playoff/templates" class="btn new-btn-admin">Templaty playoff tabulek</a>
        <a href="/admin/leagues/manage" class="btn new-btn-admin">Správa lig</a>
        <a href="/admin/teams/points" class="btn new-btn-admin">Manuální body</a>
        <a href="/admin/matches/import" class="btn new-btn-admin">Import zápasů</a>
        <a href="/admin/images/manage" class="btn new-btn-admin">Správce obrázků</a>
        <a href="/admin/transfers/manage" class="btn new-btn-admin">Správa přestupů</a>
        <a href="/admin/broadcast-ping" class="btn new-btn-admin">Test notifikace</a>
        <a href="/admin/users" class="btn new-btn-admin">Správa uživatelů</a>
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
        ${allSeasons.map(s => `<option value="${s}" ${s === selectedSeason ? 'selected' : ''}>${s}</option>`).join('')}
    </select>
  </form>
  <br>
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
        let result = '-';
        if (m.isPlayoff && m.bo > 1 && m.playedMatches && m.playedMatches.length > 0) {
            let sH = 0, sA = 0;
            m.playedMatches.forEach(pm => {
                if (pm.scoreHome > pm.scoreAway) sH++;
                else if (pm.scoreAway > pm.scoreHome) sA++;
            });
            result = `${sH} : ${sA} (série)`;
        }
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
           ${allSeasons.map(s => `<option value="${s}" ${s === chosenSeason ? 'selected' : ''}>${s}</option>`).join('')}
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
      <h2 style="margin-top: 20px;">Ligy s aktivními přestupy</h2>
    <form method="POST" action="/admin/leagues/transfers">
      <div class="leagues-allow">
`;

    for (const l of allLeagues) {
        const checked = transferLeagues.includes(l) ? 'checked' : '';
        html += `
        <label style="display: flex; align-items: center">
          <input type="checkbox" name="transferLeagues" value="${l}" ${checked}/>
          ${l}
        </label>
      `;
    }

    html += `
      </div>
      <button type="submit" class="action-btn edit-btn" style="margin-top: 10px;">Uložit přestupy</button>
    </form>
    <h2 style="margin-top: 20px;">Logika zamykání tabulky</h2>
    <form method="POST" action="/admin/settings/clinch">
      <div class="season-choose" style="margin-bottom: 10px;">
        <label>
          <input type="radio" name="mode" value="strict" ${clinchMode === 'strict' ? 'checked' : ''} />
          <strong>Striktní (Doporučeno)</strong>
          <span style="display:block; font-size: 0.8em; color: gray;">Tým se obarví až když je pevně uzamčen ve svém patře.</span>
        </label>
      </div>
      <div class="season-choose" style="margin-bottom: 10px;">
        <label>
          <input type="radio" name="mode" value="cascade" ${clinchMode === 'cascade' ? 'checked' : ''} />
          <strong>Kaskádové (Nejvyšší meta)</strong>
          <span style="display:block; font-size: 0.8em; color: gray;">Tým se obarví barvou nejvyššího patra, pod který už nemůže slézt.</span>
        </label>
      </div>
      <button type="submit" class="action-btn edit-btn" style="width: 100%;">Uložit logiku</button>
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
    if (!ligaName) return renderErrorHtml(res, "Název ligy je povinný.", 400);

    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];

    const exists = leagues.some(l => l.name.toLowerCase() === ligaName.toLowerCase());
    if (exists) return renderErrorHtml(res, `Liga ${ligaName} už existuje.`, 400);

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
    if (!team) return renderErrorHtml(res, "Tým s tímto ID nebyl nalezen.", 404);
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];

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
  <img height="50" src="${team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png'}" alt="Logo" />
  <form style="display: flex; flex-direction: row; gap: 10px; margin-bottom: 10px" action="/admin/teams/edit/${team.id}" method="POST" enctype="multipart/form-data">
    <label style="display: flex; flex-direction: column" for="name">Název týmu
      <input autocomplete="off" style="width: 220px" class="league-select" type="text" id="name" name="name" value="${team.name}" required />
    </label>
    <label style="display: flex; flex-direction: column" for="logo">Nahrát nové logo
      <input style="width: 220px" class="league-select" type="file" id="logo" name="logo" accept="image/*" />
      ${team.logo ? `<small style="color: gray;">Aktuální: ${team.logo}</small>` : ''}
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

router.post('/teams/edit/:id', requireAdmin, upload.single('logo'), async (req, res) => {
    const teamId = parseInt(req.params.id);
    const teams = loadTeams();

    const teamIndex = teams.findIndex(t => t.id === teamId);
    if (teamIndex === -1) return renderErrorHtml(res, "Tým s tímto ID nebyl nalezen.", 404);

    const {name, liga, active, group} = req.body;

    teams[teamIndex].name = name.trim();
    teams[teamIndex].liga = liga;
    teams[teamIndex].active = active === 'on';
    if (teams.isMultigroup) {
        teams[teamIndex].group = Number(group);
    }
    if (req.file) {
        teams[teamIndex].logo = req.file.filename;
    }

    fs.writeFileSync('./data/teams.json', JSON.stringify(teams, null, 2));
    logAdminAction(req.session.user, "ÚPRAVA_TÝMU", `Upraven tým ID: ${teamId} (Nový název: ${name})`);
    res.redirect('/admin');
});

router.get('/new/match', requireAdmin, (req, res) => {
    const teams = loadTeams(); // Předpokládám, že zde jsou všichni, včetně active: false, pokud je chceš filtrovat, přidej .filter(t => t.active)
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));

    const seasonsFromTeams = teams.map(t => t.season).filter(Boolean);
    const seasonsFromMatches = matches.map(m => m.season).filter(Boolean);

    const knownSeasons = [...seasonsFromTeams, ...seasonsFromMatches];
    const currentYear = new Date().getFullYear();
    const futureSeasons = generateSeasonRange(currentYear, 10);

    const allSeasons = [...new Set([...futureSeasons, ...knownSeasons])];
    allSeasons.sort();

    // 1. Získáme unikátní ligy pro filtr
    const uniqueLeagues = [...new Set(teams.map(t => t.liga))].sort();

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
            // 2. Předáme data týmů z backendu do JS proměnné
            const allTeams = ${JSON.stringify(teams)};

            function toggleBOOptions() {
                const checkbox = document.getElementById('isPlayoff');
                const boOptions = document.getElementById('boOptions');
                boOptions.style.display = checkbox.checked ? 'flex' : 'none';
            }

            // 3. Funkce pro filtrování
            function filterByLeague() {
                const selectedLeague = document.getElementById('leagueFilter').value;
                const homeSelect = document.getElementById('homeTeamId');
                const awaySelect = document.getElementById('awayTeamId');

                // Vyfiltrujeme týmy (nebo vezmeme všechny, pokud je vybráno "Všechny ligy")
                const filteredTeams = selectedLeague === 'all' 
                    ? allTeams 
                    : allTeams.filter(t => t.liga === selectedLeague);

                // Funkce pro přegenerování <option> v selectu
                const updateSelect = (selectElement) => {
                    selectElement.innerHTML = ''; // Vyčistit současné
                    filteredTeams.forEach(t => {
                        const option = document.createElement('option');
                        option.value = t.id;
                        option.text = t.liga + ' - ' + t.name;
                        selectElement.appendChild(option);
                    });
                };

                updateSelect(homeSelect);
                updateSelect(awaySelect);
            }
            
            function toggleBarazLiga() {
                const cb = document.getElementById('isBarazCb');
                const field = document.getElementById('barazLigaField');
                if (cb && field) {
                    field.style.display = cb.checked ? 'flex' : 'none';
                }
            }
        </script>
        </head>
        <body>
        <header class="header">
            <div class="logo_title"><img height="50" src="/images/logo.png" alt="Logo"><h1 id="title">Tipovačka</h1></div>
        </header>
        <main>
            <h1>Vytvořit nový zápas</h1>
            
            <div style="margin-bottom: 20px; padding: 10px; background-color: #333; display: inline-flex; align-items: center; gap: 10px;">
                <label for="leagueFilter" style="color: white; font-weight: bold;">Rychlý filtr ligy:</label>
                <select class="league-select" id="leagueFilter" onchange="filterByLeague()">
                    <option value="all">-- Všechny ligy --</option>
                    ${uniqueLeagues.map(l => `<option value="${l}">${l}</option>`).join('')}
                </select>
            </div>

            <form style="display: flex; flex-direction: row; gap: 10px; flex-wrap: wrap;" action="/admin/new/match" method="POST">
                <label style="display: flex; flex-direction: column" for="homeTeamId">Domácí tým
                    <select class="league-select" style="width: 220px" id="homeTeamId" name="homeTeamId" required>
                        ${teams.map(t => `<option value="${t.id}">${t.liga} - ${t.name}</option>`).join('')}
                    </select>
                </label>
                <label style="display: flex; flex-direction: column" for="awayTeamId">Hostující tým
                    <select class="league-select" style="width: 220px" id="awayTeamId" name="awayTeamId" required>
                        ${teams.map(t => `<option value="${t.id}">${t.liga} - ${t.name}</option>`).join('')}
                    </select>
                </label>
                <label style="display: flex; flex-direction: column" for="datetime">Datum a čas
                    <input class="league-select" style="width: 150px" type="datetime-local" id="datetime" name="datetime" required />
                </label>
                <div style="display: flex; align-items: center; gap: 10px; border-left: 2px solid orangered; padding-left: 10px; margin-left: 5px;">
                    <label style="display: flex; align-items: center; flex-direction: row; gap: 5px; font-weight: bold; color: orangered;">
                        Zápas je BARÁŽ
                        <input type="checkbox" name="isBaraz" id="isBarazCb" onchange="toggleBarazLiga()" />
                    </label>
                </div>

                <div id="barazLigaField" style="display: none; flex-direction: column; align-items: center; gap: 10px;">
                    <label>Liga (Kde se baráž zobrazí)
                        <select class="league-select" name="matchLiga">
                            ${uniqueLeagues.map(l => `<option value="${l}">${l}</option>`).join('')}
                        </select>
                    </label>
                </div>
                <label style="display: flex; flex-direction: column">Sezóna
                    <select class="league-select" name="season" id="seasonSelect" required>
                        ${allSeasons.map(s => `<option value="${s}">${s}</option>`).join('')}
                    </select>
                </label>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label style="display: flex; align-items: center; flex-direction: row; gap: 5px;">
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
                    <label style="display: flex; align-items: center; flex-direction: row; gap: 5px;">
                    Manuálně uzamčeno pro tipování
                    <input type="checkbox" name="locked" id="locked" />
                    </label>
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
    const { homeTeamId, awayTeamId, datetime, season, isPlayoff, bo, locked, matchLiga, isBaraz } = req.body;

    let matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const teams = loadTeams().filter(t => t.active);
    const homeTeam = teams.find(t => t.id === parseInt(homeTeamId));
    const awayTeam = teams.find(t => t.id === parseInt(awayTeamId));

    // Pokud to NENÍ baráž, automaticky zjistíme ligu podle týmů
    let defaultLiga = 'Přátelský zápas';
    if (homeTeam && awayTeam && homeTeam.liga === awayTeam.liga) {
        defaultLiga = homeTeam.liga;
    }

    // Pokud to JE baráž a admin vybral ligu, použijeme ji, jinak použijeme default
    const isBarazBool = isBaraz === 'on';
    const finalLiga = (isBarazBool && matchLiga) ? matchLiga : defaultLiga;

    const maxId = matches.reduce((max, m) => Math.max(max, m.id), 0);
    const newMatch = {
        id: maxId + 1,
        homeTeamId: parseInt(homeTeamId),
        awayTeamId: parseInt(awayTeamId),
        datetime,
        liga: finalLiga,
        season,
        isPlayoff: isPlayoff === 'on',
        isBaraz: isBarazBool,
        locked: locked === 'on'
    };
    // ... zbytek kódu zůstává stejný ...

    if (isPlayoff === 'on' && bo) {
        newMatch.bo = parseInt(bo);
    }

    matches.push(newMatch);
    notif.notifyNewMatches();
    fs.writeFileSync('./data/matches.json', JSON.stringify(matches, null, 2));
    logAdminAction(req.session.user, "NOVÝ_ZÁPAS", `Vytvořen nový zápas: ${homeTeam.name} vs ${awayTeam.name} (${finalLiga})`);
    res.redirect('/admin');
});


router.get('/new/team', requireAdmin, (req, res) => {
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];
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
    <form style="display: flex; flex-direction: row; gap: 10px" method="POST" action="/admin/new/team" enctype="multipart/form-data">
      <label style="display: flex; flex-direction: column;">Název týmu: <input style="width: 220px" class="league-select" autocomplete="off" type="text" name="name" required></label>
      <label style="display: flex; flex-direction: column;">Nahrát logo: 
        <input style="width: 220px" class="league-select" type="file" name="logo" accept="image/*">
      </label>
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
            option.value = String(i++);
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

router.post('/new/team', requireAdmin, upload.single('logo'), express.urlencoded({extended: true}), (req, res) => {
    const teams = loadTeams();
    let {name, liga, active} = req.body;
    active = active === 'on';

    const inputName = name.trim().toLowerCase();
    const inputLiga = liga.trim().toLowerCase();
    const logoFilename = req.file ? req.file.filename : '';

    const exists = teams.some(team =>
        team.name.trim().toLowerCase() === inputName &&
        team.liga.trim().toLowerCase() === inputLiga
    );

    if (exists) {
        return renderErrorHtml(res, `Tým <strong>${name}</strong> už v lize <strong>${liga}</strong> existuje.`, 400);
    }

    const newTeam = {
        id: teams.length > 0 ? Math.max(...teams.map(t => t.id)) + 1 : 1,
        name: name.trim(),
        liga: liga.trim(),
        active,
        group: parseInt(req.body.group),
        stats: {},
        logo: logoFilename // Uložíme název souboru do JSONu
    };

    teams.push(newTeam);

    fs.writeFileSync('./data/teams.json', JSON.stringify(teams, null, 2), 'utf-8');
    logAdminAction(req.session.user, "NOVÝ_TÝM", `Vytvořen nový tým: ${name} (${liga})`);
    res.redirect('/admin');
});

router.get('/edit/:id', requireAdmin, (req, res) => {
    const matchId = parseInt(req.params.id);
    let matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const teams = loadTeams().filter(t => t.active);

    const match = matches.find(m => m.id === matchId);
    if (!match) return renderErrorHtml(res, "Zápas nebyl nalezen.", 404);

    const seasonsFromTeams = teams.map(t => t.season).filter(Boolean);
    const seasonsFromMatches = matches.map(m => m.season).filter(Boolean);
    const allSeasons = [...new Set([...seasonsFromTeams, ...seasonsFromMatches])];
    const uniqueLeagues = [...new Set(teams.map(t => t.liga))].sort();
    allSeasons.sort();

    const resultHome = match.result?.scoreHome ?? '';
    const resultAway = match.result?.scoreAway ?? '';
    const selectedSeason = match.season ?? allSeasons[0] ?? '';

    const isSeries = match.isPlayoff && match.bo > 1;

    let matchInputs = `<fieldset id="series-score-fields" style="display: ${isSeries ? 'block' : 'none'}; margin-top: 1rem;"><legend>Jednotlivé zápasy série</legend>`;
    for (let i = 0; i < 9; i++) {
        const mResult = match.playedMatches && match.playedMatches[i] ? match.playedMatches[i] : {};
        const isMatchVisible = i < (match.bo || 1);
        matchInputs += `
            <div id="match_row_${i}" style="margin-bottom: 10px; border-bottom: 1px solid #444; padding-bottom: 10px; display: ${isMatchVisible ? 'block' : 'none'};">
                <strong>Zápas ${i + 1}</strong><br>
                <div style="display: flex; gap: 10px; align-items: center; margin-top: 5px;">
                    <label>Domácí: <input class="league-select" type="number" name="match_${i}_home" value="${mResult.scoreHome ?? ''}" style="width: 60px"></label>
                    <label>Hosté: <input class="league-select" type="number" name="match_${i}_away" value="${mResult.scoreAway ?? ''}" style="width: 60px"></label>
                    <label style="display: flex; align-items: center; gap: 5px;"><input type="checkbox" name="match_${i}_ot" ${mResult.ot ? 'checked' : ''}> Po prodloužení / nájezdech</label>
                </div>
            </div>
         `;
    }
    matchInputs += '</fieldset>';

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
        const boInput = document.getElementById('bo');
        
        const normalScore = document.getElementById('normal-score-fields');
        const seriesScore = document.getElementById('series-score-fields');
        const seriesInfo = document.getElementById('series-info');

        if (checkbox && boField) {
            const isPlayoff = checkbox.checked;
            boField.style.display = isPlayoff ? 'block' : 'none';
            
            const boValue = parseInt(boInput.value) || 1;
            if (isPlayoff && boValue > 1) {
                if (normalScore) normalScore.style.display = 'none';
                if (seriesInfo) seriesInfo.style.display = 'block';
                if (seriesScore) {
                    seriesScore.style.display = 'block';
                    for(let i = 0; i < 9; i++) {
                        const matchDiv = document.getElementById('match_row_' + i);
                        if (matchDiv) {
                            matchDiv.style.display = i < boValue ? 'block' : 'none';
                        }
                    }
                }
            } else {
                if (normalScore) normalScore.style.display = 'block';
                if (seriesInfo) seriesInfo.style.display = 'none';
                if (seriesScore) seriesScore.style.display = 'none';
            }
        }
    }
    window.addEventListener('DOMContentLoaded', () => {
        toggleBOInput();
        const boInput = document.getElementById('bo');
        if (boInput) boInput.addEventListener('input', toggleBOInput);
        const isPlayoffCb = document.getElementById('isPlayoff');
        if (isPlayoffCb) isPlayoffCb.addEventListener('change', toggleBOInput);
    });
    
    function toggleBarazLigaEdit() {
        const cb = document.getElementById('isBarazCbEdit');
        const field = document.getElementById('barazLigaFieldEdit');
        if (cb && field) {
            field.style.display = cb.checked ? 'flex' : 'none';
        }
    }
  </script>
</head>
<body>
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
    
    <label style="display: flex; flex-direction: row; align-items: center; margin-top: 1rem; color: orangered; font-weight: bold;">
      <input type="checkbox" id="isBarazCbEdit" name="isBaraz" ${match.isBaraz ? 'checked' : ''} onchange="toggleBarazLigaEdit()" />
      Tento zápas je BARÁŽ
    </label>

    <div id="barazLigaFieldEdit" style="display: ${match.isBaraz ? 'flex' : 'none'}; flex-direction: column; margin-top: 10px;">
        <label>Liga (Kde se baráž zobrazí)
          <select class="league-select" style="width: 200px;" name="matchLiga">
            ${uniqueLeagues.map(l => `<option value="${l}" ${l === match.liga ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </label>
    </div>

    <label style="display: flex; flex-direction: row; align-items: center" for="isPlayoff" style="margin-top: 1rem;">
      <input type="checkbox" id="isPlayoff" name="isPlayoff" ${match.isPlayoff ? 'checked' : ''} onchange="toggleBOInput()" />
      Tento zápas je součástí playoff
    </label>

    <div id="boField" style="display:none;">
      <label for="bo">Počet vítězných zápasů v sérii (bo):
        <input class="league-select" type="number" id="bo" name="bo" min="1" max="9" value="${match.bo ?? ''}" />
      </label>
    </div>

    <label style="display: flex; flex-direction: row; align-items: center; margin-top: 1rem; gap: 5px;" for="postponed">
      <input type="checkbox" id="postponed" name="postponed" ${match.postponed ? 'checked' : ''} />
      Zápas je odložen
    </label>

    <label style="display: flex; flex-direction: row; align-items: center; margin-top: 1rem; margin-bottom: 1rem; gap: 5px;" for="locked">
      <input type="checkbox" id="locked" name="locked" ${match.locked ? 'checked' : ''} />
      Zápas je manuálně uzamčen pro tipování
    </label>

    <fieldset class="edit-score">
      <legend>Výsledek (pokud je vyhodnocen)</legend>
      
      <div id="normal-score-fields" style="display: ${isSeries ? 'none' : 'block'};">
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
      </div>
      
      <div id="series-info" style="display: ${isSeries ? 'block' : 'none'}; color: gray;">
         Skóre série a celkový výsledek se vypočítá automaticky podle zapsaných zápasů níže.
      </div>
    </fieldset>
    
    ${matchInputs}
    
    <button class="action-btn edit-btn" type="submit" style="margin-top: 15px;">Uložit změny</button>
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
    if (matchIndex === -1) return renderErrorHtml(res, "Zápas nebyl nalezen.", 404);

    const match = matches[matchIndex];
    const liga = match.liga;

    // 1. Zjistíme staré hodnoty PŘED úpravou
    const oldDatetime = match.datetime;
    const oldPostponed = match.postponed === true;

    // 2. Aktualizace na nové hodnoty
    match.homeTeamId = parseInt(homeTeamId);
    match.awayTeamId = parseInt(awayTeamId);
    match.datetime = datetime;
    match.season = season;
    match.isBaraz = req.body.isBaraz === 'on';
    if (match.isBaraz && req.body.matchLiga) {
        match.liga = req.body.matchLiga;
    }
    match.isPlayoff = req.body.isPlayoff === 'on';
    match.postponed = req.body.postponed === 'on';
    match.locked = req.body.locked === 'on';

    if (match.locked) {
        removeTipsForDeletedMatch(matchId);
    }

    if (match.isPlayoff && req.body.bo && !isNaN(parseInt(req.body.bo))) {
        match.bo = parseInt(req.body.bo);
    } else {
        delete match.bo;
    }

    const isSeries = match.isPlayoff && match.bo > 1;

    // --- ULOŽÍME SI STARÝ POČET ODEHRANÝCH ZÁPASŮ ---
    const oldPlayedCount = (match.isPlayoff && match.playedMatches) ? match.playedMatches.length : 0;

    if (isSeries) {
        match.playedMatches = [];
        let seriesHomeWins = 0;
        let seriesAwayWins = 0;
        const requiredWins = Math.ceil(match.bo / 2);

        for (let i = 0; i < match.bo; i++) {
            const h = req.body[`match_${i}_home`];
            const a = req.body[`match_${i}_away`];
            const ot = req.body[`match_${i}_ot`] === 'on';

            if (h !== '' && a !== '' && h !== undefined && a !== undefined) {
                const sH = parseInt(h);
                const sA = parseInt(a);
                match.playedMatches.push({ scoreHome: sH, scoreAway: sA, ot });

                if (sH > sA) seriesHomeWins++;
                else if (sA > sH) seriesAwayWins++;
            }
        }

        // Vyhodnocení série pouze v případě dosažení potřebného počtu výher
        if (seriesHomeWins >= requiredWins || seriesAwayWins >= requiredWins) {
            match.result = {
                scoreHome: seriesHomeWins,
                scoreAway: seriesAwayWins,
                winner: seriesHomeWins > seriesAwayWins ? 'home' : 'away'
            };
        } else {
            delete match.result; // Série ještě neskončila

            // --- ODESLÁNÍ PRŮBĚŽNÉHO STAVU SÉRIE ---
            if (match.playedMatches.length > oldPlayedCount) {
                const lastM = match.playedMatches[match.playedMatches.length - 1];
                notif.notifySeriesProgress(matchId, match.playedMatches.length, lastM.scoreHome, lastM.scoreAway, lastM.ot, seriesHomeWins, seriesAwayWins);
            }
        }
    } else {
        delete match.result;
    }

    fs.writeFileSync('./data/matches.json', JSON.stringify(matches, null, 2));

    // 3. NOTIFIKAČNÍ DETEKTIV - Kontrola změn (Pokud NENÍ zadaný výsledek)
    if (!match.result) {
        let changes = [];

        // Kontrola změny času
        if (oldDatetime !== match.datetime) {
            const [datePart, timePart] = match.datetime.split('T');
            const [year, month, day] = datePart.split('-');
            const hezkyCas = `${day}. ${month}. ${year} v ${timePart}`;
            changes.push(`Nový čas: ${hezkyCas}`);
        }

        // Kontrola odložení
        if (!oldPostponed && match.postponed) {
            changes.push('Zápas byl odložen');
        } else if (oldPostponed && !match.postponed) {
            changes.push('Zápas již není odložen');
        }

        // Pokud se něco změnilo, odešleme naši novou notifikaci
        if (changes.length > 0) {
            notif.notifyMatchUpdate(match.id, changes.join(' | '));
        }
    }

    try {
        if (season && liga) {
            updateTeamsPoints(matches);
            evaluateAndAssignPoints(matches[matchIndex].liga, matches[matchIndex].season);
            evaluateRegularSeasonTable(season, liga);

            // 4. Odeslání výsledku (POUZE pokud má zápas výsledek, dřív to tu posílalo pořád)
            if (match.result) {
                notif.notifyResult(matchId, scoreHome, scoreAway);
            }
        }
    } catch (err) {
        console.error("Chyba při přepočtech, nebyla odeslána sezóna nebo liga", err);
    }
    logAdminAction(req.session.user, "ÚPRAVA_ZÁPASU", `Upraven zápas ID: ${matchId} (Liga: ${match.liga})`);
    res.redirect('/admin');
});

router.post('/teams/delete/:id', requireAdmin, (req, res) => {
    const teamsId = parseInt(req.params.id);
    let teams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf8'));

    teams = teams.filter(t => t.id !== teamsId);

    fs.writeFileSync('./data/teams.json', JSON.stringify(teams, null, 2));
    logAdminAction(req.session.user, "SMAZÁNÍ_TÝMU", `Smazán tým s ID: ${teamsId}`);
    res.redirect('/admin');
});

router.post('/delete/:id', requireAdmin, (req, res) => {
    const matchId = parseInt(req.params.id);
    let matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));

    // 1. NAJÍT ZÁPAS PŘEDTÍM, NEŽ HO SMAŽEME
    const matchToDelete = matches.find(m => m.id === matchId);

    // Pojistka: Pokud už zápas neexistuje (např. dvojklik), rovnou přesměruj
    if (!matchToDelete) {
        return res.redirect('/admin');
    }

    // 2. ULOŽIT SI LIGU A SEZÓNU (pro pozdější přepočet)
    const matchLiga = matchToDelete.liga;
    const matchSeason = matchToDelete.season;

    // 3. SMAZÁNÍ A ULOŽENÍ
    matches = matches.filter(m => m.id !== matchId);
    updateTeamsPoints(matches);
    fs.writeFileSync('./data/matches.json', JSON.stringify(matches, null, 2));

    removeTipsForDeletedMatch(matchId);

    evaluateAndAssignPoints(matchLiga, matchSeason);

    evaluateAndAssignPoints(matchLiga, matchSeason);
    logAdminAction(req.session.user, "SMAZÁNÍ_ZÁPASU", `Smazán zápas ID: ${matchId} (Liga: ${matchLiga})`);
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

router.get('/playoff', requireAdmin, (req, res) => {
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];
    const allLeagues = leagues.map(l => l.name);
    const selectedLeague = req.query.league || allLeagues[0] || "Neurčeno";

    // Zjistíme formát vybrané ligy
    const leagueObj = leagues.find(l => l.name === selectedLeague);
    const playoffFormat = leagueObj?.playoffFormat || 'none';

    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const teams = loadTeams();

    const playoffMatches = matches.filter(m => m.season === selectedSeason && m.liga === selectedLeague && m.isPlayoff);

    // Vytvoříme seznam sérií do roletky
    // (Toto už tam máš)
    const seriesOptionsHTML = playoffMatches.map(m => {
        const teamA = teams.find(t => t.id === m.homeTeamId)?.name || 'Neznámý';
        const teamB = teams.find(t => t.id === m.awayTeamId)?.name || 'Neznámý';
        return `<option value="series-${m.id}">${teamA} vs ${teamB} (Série ${m.id})</option>`;
    }).join('');

    // --- 1. PŘIDEJ TOTO (Seznam týmů pro čekající sloty) ---
    const teamsInLeague = teams.filter(t => t.liga === selectedLeague);
    const teamsOptionsHTML = teamsInLeague.map(t => `<option value="${t.name}">${t.name}</option>`).join('');

    // --- CHYBĚJÍCÍ BLOK: Načteme už uložené přiřazení slotů ---
    const filePath = path.join(__dirname, '../data/playoff.json');
    let savedSlots = {};
    try {
        const pd = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (pd[selectedSeason] && pd[selectedSeason][selectedLeague]) {
            savedSlots = pd[selectedSeason][selectedLeague];
        }
    } catch (e) {}

    // --- 2. NAHRAĎ PŮVODNÍ FUNKCI renderSlot TÍMTO ---
    const renderSlot = (slotId, label) => {
        const selectedVal = savedSlots[slotId] || '';
        const waitTeam1 = savedSlots[`${slotId}_t1`] || '';
        const waitTeam2 = savedSlots[`${slotId}_t2`] || '';

        return `
            <div style="margin-bottom: 10px; background: #222; padding: 10px; border: 1px solid #444; border-left: 3px solid orangered;">
                <label style="display:block; font-weight: bold; margin-bottom: 5px; color: lightgrey;">${label}</label>
                
                <select name="${slotId}" class="league-select" style="width: 100%; max-width: 400px; margin-bottom: 5px;">
                    <option value="">-- Prázdný slot (Čeká se na vytvoření série) --</option>
                    ${seriesOptionsHTML.replace(`value="${selectedVal}"`, `value="${selectedVal}" selected`)}
                </select>
                
                <div style="display: flex; gap: 10px; font-size: 0.9em; margin-top: 5px; max-width: 400px;">
                    <select name="${slotId}_t1" class="league-select" style="flex: 1; padding: 3px;">
                        <option value="">-- Čekající tým 1 --</option>
                        ${teamsOptionsHTML.replace(`value="${waitTeam1}"`, `value="${waitTeam1}" selected`)}
                    </select>
                    <span style="color: gray; align-self: center;">vs</span>
                    <select name="${slotId}_t2" class="league-select" style="flex: 1; padding: 3px;">
                        <option value="">-- Čekající tým 2 --</option>
                        ${teamsOptionsHTML.replace(`value="${waitTeam2}"`, `value="${waitTeam2}" selected`)}
                    </select>
                </div>
            </div>
        `;
    };

    let slotsHTML = '';
    // 1. Načtení šablon
    const tplPath = './data/playoffTemplates.json';
    const allTemplates = fs.existsSync(tplPath) ? JSON.parse(fs.readFileSync(tplPath, 'utf8')) : {};
    const currentTemplate = allTemplates[playoffFormat];
    if (!currentTemplate) {
        slotsHTML = '<p style="color: gray;">Tato liga nemá nastavený platný formát. <a href="/admin/playoff/templates" style="color:orangered">Vytvoř ho zde</a> a pak ho přiřaď lize v nastavení.</p>';
    } else {
        // Generujeme sekce podle šablony
        currentTemplate.columns.forEach(col => {
            slotsHTML += `<h3>${col.title}</h3>`;
            col.slots.forEach(slotId => {
                slotsHTML += renderSlot(slotId, slotId.toUpperCase());
            });
        });
    }

    const leagueOptions = allLeagues.map(liga => `<option value="${liga}" ${liga === selectedLeague ? 'selected' : ''}>${liga}</option>`).join('\n');

    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <title>Správa Playoff</title>
  <link rel="stylesheet" href="/css/styles.css" />
  <link rel="icon" href="/images/logo.png"/>
</head>
<body class="admin_site">
<header class="header">
  <div class="logo_title"><img class="image_logo" src="/images/logo.png" alt="Logo"><h1>Tipovačka</h1></div>
  <h1>Přiřazení sérií do pavouka (${selectedSeason})</h1>
  <form id="leagueForm" method="GET" action="/admin/playoff" style="padding: 10px;">
    <select name="league" class="league-select" onchange="this.form.submit()">
      ${leagueOptions}
    </select>
  </form>
</header>
<main style="padding: 20px; max-width: 800px; margin: 0 auto;">
    
    <div style="background: #1a1a1a; padding: 20px; border: 1px solid #333; margin-bottom: 20px;">
        <h2 style="color: orangered; margin-top: 0;">Přiřazení slotů</h2>
        <p style="color: gray; font-size: 0.9em;">
            Zde pouze vybereš, která série (zápas vytvořený v "Nový zápas") patří do kterého místa v pavouku. 
            O barvy, čáry a skóre se už postará systém na webu sám!
        </p>

        <form action="/admin/playoff/save" method="POST">
            <input type="hidden" name="season" value="${selectedSeason}">
            <input type="hidden" name="league" value="${selectedLeague}">
            
            ${slotsHTML}

            ${playoffFormat !== 'none' ? `<button type="submit" class="action-btn edit-btn" style="width: 100%; padding: 15px; font-size: 1.1em; margin-top: 20px;">Uložit pavouka</button>` : ''}
        </form>
        
        ${playoffFormat !== 'none' ? `
        <form action="/admin/playoff/delete" method="POST" onsubmit="return confirm('Opravdu vymazat celého pavouka pro tuto ligu? Všechny naklikané série ze slotů zmizí.');">
            <input type="hidden" name="season" value="${selectedSeason}">
            <input type="hidden" name="league" value="${selectedLeague}">
            <button type="submit" class="action-btn delete-btn" style="width: 100%; padding: 15px; font-size: 1.1em; margin-top: 10px;">Vyresetovat pavouka</button>
        </form>` : ''}
    </div>

    <a href="/admin" style="color: orangered;">Zpět na administraci</a>
</main>
</body>
</html>`;

    res.send(html);
});

router.post('/playoff/save', requireAdmin, (req, res) => {
    const { league, season, ...slots } = req.body; // Všechny sloty (qf1, sf1...) se nacpou do objektu slots

    if (!league || !season) return renderErrorHtml(res, "Chybí data k uložení.", 400);

    const filePath = path.join(__dirname, '../data/playoff.json');
    let playoffData = {};
    try { if (fs.existsSync(filePath)) playoffData = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) {}

    if (!playoffData[season]) playoffData[season] = {};

    // Uložíme jednoduše slovník: { "qf1": "series-468", "sf1": "series-500", ... }
    playoffData[season][league] = slots;

    fs.writeFileSync(filePath, JSON.stringify(playoffData, null, 2));
    logAdminAction(req.session.user, "PLAYOFF_ULOŽENÍ", `Aktualizovány sloty playoff pro ${league} (${season})`);
    res.redirect(`/admin/playoff?league=${encodeURIComponent(league)}`);
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

            if (Object.keys(playoffData[season]).length === 0) {
                delete playoffData[season];
            }
        }

        fs.writeFile(filePath, JSON.stringify(playoffData, null, 2), err => {
            if (err) {
                console.error('Chyba při zápisu do souboru:', err);
                return res.status(500).send('Nepodařilo se smazat data');
            }
            logAdminAction(req.session.user, "PLAYOFF_RESET", `KOMPLETNĚ SMAZÁNA playoff mřížka pro ${league} (${season})`);
            res.redirect('/admin/playoff');
        });
    });
});

router.get('/togglePostponed/:id', requireAdmin, (req, res) => {
    const matchId = parseInt(req.params.id);
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const match = matches.find(m => m.id === matchId);
    if (!match) return renderErrorHtml(res, "Zápas nebyl nalezen.", 404);

    match.postponed = !match.postponed;

    fs.writeFileSync('./data/matches.json', JSON.stringify(matches, null, 2));
    logAdminAction(req.session.user, "ODLOŽENÍ_ZÁPASU", `Zápas ID ${matchId} byl ${match.postponed ? 'ODLOŽEN' : 'VRÁCEN DO BĚŽNÉHO STAVU'}`);
    res.redirect('/admin');
});

router.get('/leagues/manage', requireAdmin, (req, res) => {
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));

    // 1. Načtení statusů
    let statusData = {};
    try {
        statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
    } catch (e) {
        statusData = {};
    }

    let allTemplates = {};
    try {
        const tplPath = './data/playoffTemplates.json';
        if (fs.existsSync(tplPath)) {
            allTemplates = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
        }
    } catch (e) {
        console.error("Chyba při načítání šablon:", e);
    }


    const seasonLeagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];

    const html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <title>Správa lig</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
        <style>
            /* Styl pro boxík s nastavením X-tých týmů */
            .cross-table-settings {
                flex-basis: 100%;
                background-color: #1a1a1a;
                border: 1px dashed #555;
                padding: 10px;
                margin-top: 10px;
                margin-bottom: 5px;
                display: flex;
                align-items: center;
                gap: 15px;
                flex-wrap: wrap;
                font-size: 0.9em;
            }
            .cross-table-settings h4 { color: #ffa500; font-size: 1em; margin: 0 10px 0 0;}
            .separator { border-left: 1px solid #444; height: 20px; margin: 0 5px; }
        </style>
    </head>
    <body>
        <h1>Správa lig (pro sezónu: ${selectedSeason})</h1>
        
        <h2>Přidat novou ligu</h2>
        <form method="POST" action="/admin/leagues/manage">
             <label>Nová liga: <input type="text" class="league-select" name="newLeague[ligaName]" required style="width: 200px;"></label>
             <label style="display: flex; align-items: center; gap: 10px;">Více skupin: <input type="checkbox" id="multiGroupCheckbox" name="newLeague[multigroup]" onchange="toggleGroupInput()"></label>
             <label id="groupCountLabel" style="display:none; gap: 10px;">Počet skupin: <input type="number" class="league-select" min="1" max="10" id="groupCount" name="newLeague[groupCount]"></label>
             <label>Max zápasů: <input type="number" min="1" class="league-select" name="newLeague[maxMatches]" required></label>
             <label>Čtvrtfinále: <input type="number" min="0" class="league-select" name="newLeague[quarterfinal]" value="4"></label>
             <label>Play-in: <input type="number" min="0" class="league-select" name="newLeague[playin]" value="12"></label>
             <label>Baráž: <input type="number" min="0" class="league-select" name="newLeague[relegation]" value="1"></label>
             <button class="action-btn edit-btn" type="submit">Přidat</button>
        </form>

        <h2>Seznam lig v sezóně ${selectedSeason}</h2>
        <ul>
            ${seasonLeagues.map(l => {
        // Načtení dat ligy
        let isFinished = false;
        let lockedStatus = false;
        if (statusData[selectedSeason] && statusData[selectedSeason][l.name]) {
            isFinished = statusData[selectedSeason][l.name].regularSeasonFinished;
            lockedStatus = statusData[selectedSeason][l.name].tableTipsLocked;
        }

        const isGloballyLocked = (lockedStatus === true);
        const statusStyle = isFinished ? "color: green; font-weight: bold;" : "color: orange;";
        const globalLockStyle = isGloballyLocked ? "color: red; font-weight: bold;" : "color: green;";

        // GENERUJEME HTML PRO SKUPINOVÉ ZÁMKY
        let groupLocksHTML = '';
        if (l.isMultigroup && l.groupCount > 0) {
            groupLocksHTML += '<div style="flex-basis: 100%; display: flex; gap: 15px; margin-left: 20px; margin-top: 5px; padding-top:5px; border-top:1px dotted #444;">';
            for (let i = 1; i <= l.groupCount; i++) {
                const gKey = String(i);
                const gLabel = `Skupina ${String.fromCharCode(64 + i)}`;
                let gLocked = false;
                if (statusData[selectedSeason] && statusData[selectedSeason][l.name]) {
                    gLocked = statusData[selectedSeason][l.name].tableTipsLocked;
                }
                const isThisGroupLocked = (gLocked === true) || (Array.isArray(gLocked) && gLocked.includes(gKey));
                const gStyle = isThisGroupLocked ? "color: red; font-weight: bold;" : "color: green;";

                groupLocksHTML += `
                    <form method="POST" action="/admin/toggle-table-tips-lock" style="display:inline-flex; align-items:center;">
                        <input type="hidden" name="season" value="${selectedSeason}">
                        <input type="hidden" name="liga" value="${l.name}">
                        <input type="hidden" name="group" value="${gKey}">
                        <input type="hidden" name="totalGroups" value="${l.groupCount}">
                        <label style="cursor: pointer; display: flex; align-items: center; gap: 3px; font-size: 0.9em; ${gStyle}">
                            <input type="checkbox" name="locked" value="true" ${isThisGroupLocked ? 'checked' : ''} onchange="this.form.submit()">
                            ${gLabel}
                        </label>
                    </form>
                `;
            }
            groupLocksHTML += '</div>';
        }

        return `
                <li style="margin-bottom: 10px; border-bottom: 1px solid #333; padding-bottom: 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px;">
                    
                    <form method="POST" action="/admin/leagues/update" style="display:flex; flex-wrap: wrap; align-items:center; gap:10px; width: 100%;">
                        <input type="hidden" name="originalLeagueName" value="${l.name}">
                        
                        <div style="display:inline-flex; align-items:center; gap:10px;">
                            <input type="text" name="leagueName" class="league-select" style="width: 150px" value="${l.name}">
                            <label>Max: <input type="number" name="maxMatches" value="${l.maxMatches || 0}" min="0" style="width:50px;"></label>
                            <label>ČF: <input type="number" name="quarterfinal" value="${l.quarterfinal || 0}" min="0" style="width:40px;"></label>
                            <label>P-in: <input type="number" name="playin" value="${l.playin || 0}" min="0" style="width:40px;"></label>
                            <label>Bar: <input type="number" name="relegation" value="${l.relegation || 0}" min="0" style="width:40px;"></label>
                            <label>Playoff formát: 
                                <select name="playoffFormat" style="width: 120px; padding: 2px;">
                                    <option value="none">Žádný</option>
                                    ${Object.keys(allTemplates).map(key => `
                                    <option value="${key}" ${l.playoffFormat === key ? 'selected' : ''}>${allTemplates[key].label}</option>
                                    `).join('')}
                                </select>
                            </label>
                        </div>

                        <div class="cross-table-settings">
                            <h4>Tabulka X-tých týmů:</h4>
                            
                            <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
                                <input type="checkbox" name="crossGroupEnabled" ${l.crossGroupTable ? 'checked' : ''}> Zapnout
                            </label>

                            <label title="Kterou pozici porovnávat? (např. 4 = čtvrté týmy)">
                                Pozice (X): <input type="number" name="crossGroupPosition" value="${l.crossGroupPosition || ''}" min="1" style="width: 40px;" placeholder="X">
                            </label>
                            
                            <div class="separator"></div>
                            
                            <span style="color:#aaa;">Postup/Sestup z této tabulky:</span>
                            <label title="Kolik týmů z této tabulky jde do ČF">
                                ČF: <input type="number" name="crossQuarterfinal" value="${l.crossGroupConfig?.quarterfinal || 0}" min="0" style="width: 40px;">
                            </label>
                            <label title="Kolik týmů z této tabulky jde do Předkola">
                                P-in: <input type="number" name="crossPlayin" value="${l.crossGroupConfig?.playin || 0}" min="0" style="width: 40px;">
                            </label>
                            <label title="Kolik týmů z této tabulky sestupuje">
                                Bar: <input type="number" name="crossRelegation" value="${l.crossGroupConfig?.relegation || 0}" min="0" style="width: 40px;">
                            </label>
                        </div>

                        <button class="action-btn edit-btn" type="submit" style="margin-left: auto;">Uložit změny</button>
                    </form>

                    <div style="display: flex; gap: 15px; width: 100%; align-items: center; justify-content: flex-end; margin-top: 5px;">
                        <form method="POST" action="/admin/toggle-table-tips-lock" style="display:inline-flex;">
                            <input type="hidden" name="season" value="${selectedSeason}">
                            <input type="hidden" name="liga" value="${l.name}">
                            <input type="hidden" name="totalGroups" value="${l.groupCount || 0}">
                            <label style="cursor: pointer; display: flex; align-items: center; gap: 5px; ${globalLockStyle}">
                                <input type="checkbox" name="locked" value="true" ${isGloballyLocked ? 'checked' : ''} onchange="this.form.submit()">
                                ${isGloballyLocked ? 'Tabulky ZAMČENY (Vše)' : 'Zamknout Vše'}
                            </label>
                        </form>

                        <form method="POST" action="/admin/toggle-regular-season" style="display:inline-flex;">
                            <input type="hidden" name="season" value="${selectedSeason}">
                            <input type="hidden" name="liga" value="${l.name}">
                            <label style="cursor: pointer; display: flex; align-items: center; gap: 5px; ${statusStyle}">
                                <input type="checkbox" name="finished" value="true" ${isFinished ? 'checked' : ''} onchange="this.form.submit()">
                                ${isFinished ? 'Body Aktivní' : 'Body Neaktivní'}
                            </label>
                        </form>

                        <form method="POST" action="/admin/leagues/delete" style="display:inline;">
                            <input type="hidden" name="league" value="${l.name}">
                            <button class="action-btn delete-btn" type="submit" onclick="return confirm('Smazat ligu?')">Smazat</button>
                        </form>
                    </div>

                    ${groupLocksHTML}

                </li>`;
    }).join('')}
        </ul>

        <a href="/admin">← Zpět na hlavní stránku</a>

        <script>
            function toggleGroupInput() {
                const checkbox = document.getElementById('multiGroupCheckbox');
                const label = document.getElementById('groupCountLabel');
                label.style.display = checkbox.checked ? 'flex' : 'none';
            }
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

router.post('/leagues/manage', requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
    const { ligaName, multigroup, groupCount, maxMatches, quarterfinal, playin, relegation } = req.body.newLeague;
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));

    if (!allSeasonData[selectedSeason]) {
        allSeasonData[selectedSeason] = { leagues: [] };
    }
    if (!allSeasonData[selectedSeason].leagues) {
        allSeasonData[selectedSeason].leagues = [];
    }

    const leagueExists = allSeasonData[selectedSeason].leagues.some(l => l.name === ligaName);

    if (!leagueExists) {
        allSeasonData[selectedSeason].leagues.push({
            name: ligaName,
            isMultigroup: multigroup === 'on' || false,
            groupCount: Number(groupCount) || 1,
            maxMatches: Number(maxMatches) || 0,
            quarterfinal: Number(quarterfinal) || 0,
            playin: Number(playin) || 0,
            relegation: Number(relegation) || 0
        });
        fs.writeFileSync('./data/leagues.json', JSON.stringify(allSeasonData, null, 2));
    }
    res.redirect('/admin/leagues/manage');
});

router.post('/leagues/update', requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
    const {
        originalLeagueName, leagueName, maxMatches, quarterfinal, playin, relegation,
        // Nová pole z formuláře
        crossGroupEnabled, crossGroupPosition, crossQuarterfinal, crossPlayin, crossRelegation, playoffFormat
    } = req.body;

    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));

    if (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) {
        const index = allSeasonData[selectedSeason].leagues.findIndex(l => l.name === originalLeagueName);

        if (index !== -1) {
            // 1. Změna názvu
            if (originalLeagueName !== leagueName) {
                console.log(`Změna názvu ligy z ${originalLeagueName} na ${leagueName}`);
                renameLeagueGlobal(originalLeagueName, leagueName);
                allSeasonData[selectedSeason].leagues[index].name = leagueName;
            }

            // 2. Základní nastavení
            allSeasonData[selectedSeason].leagues[index].maxMatches = Number(maxMatches) || 0;
            allSeasonData[selectedSeason].leagues[index].quarterfinal = Number(quarterfinal) || 0;
            allSeasonData[selectedSeason].leagues[index].playin = Number(playin) || 0;
            allSeasonData[selectedSeason].leagues[index].relegation = Number(relegation) || 0;
            allSeasonData[selectedSeason].leagues[index].playoffFormat = playoffFormat || 'none';

            // 3. Nastavení X-tých týmů
            allSeasonData[selectedSeason].leagues[index].crossGroupTable = (crossGroupEnabled === 'on');
            allSeasonData[selectedSeason].leagues[index].crossGroupPosition = Number(crossGroupPosition) || 0;

            // Uložíme konfiguraci pro tuto speciální tabulku
            allSeasonData[selectedSeason].leagues[index].crossGroupConfig = {
                quarterfinal: Number(crossQuarterfinal) || 0,
                playin: Number(crossPlayin) || 0,
                relegation: Number(crossRelegation) || 0
            };

            fs.writeFileSync('./data/leagues.json', JSON.stringify(allSeasonData, null, 2));
        }
    }
    logAdminAction(req.session.user, "ÚPRAVA_LIGY", `Upraveno nastavení ligy: ${leagueName}`);
    res.redirect('/admin/leagues/manage');
});

router.post('/leagues/delete', requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
    const { league } = req.body;
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));

    if (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) {

        allSeasonData[selectedSeason].leagues = allSeasonData[selectedSeason].leagues.filter(l => l.name !== league);

        fs.writeFileSync('./data/leagues.json', JSON.stringify(allSeasonData, null, 2));
    }
    logAdminAction(req.session.user, "SMAZÁNÍ_LIGY", `Kompletně smazána liga: ${league}`);
    res.redirect('/admin/leagues/manage');
});
router.post("/toggle-regular-season", requireAdmin, (req, res) => {
    if (req.session.role !== "admin") return renderErrorHtml(res, "Nemáte oprávnění k této akci.", 403);

    const { season, liga } = req.body;
    const isFinishedNow = req.body.finished === 'true'; // Pokud je checkbox zaškrtnutý

    let statusData = {};
    try {
        statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
    } catch(e) {}

    if (!statusData[season]) statusData[season] = {};

    // Získáme předchozí stav, abychom věděli, jestli se něco změnilo
    const wasFinishedBefore = statusData[season][liga]?.regularSeasonFinished === true;

    // Uložíme nový stav
    statusData[season][liga] = {
        ...statusData[season][liga], // Zachováme ostatní klíče (např. zámky)
        regularSeasonFinished: isFinishedNow
    };

    fs.writeFileSync('./data/leagueStatus.json', JSON.stringify(statusData, null, 2));

    // Přepočet tabulky
    evaluateRegularSeasonTable(season, liga);

    // NOTIFIKACE: Pokud byla liga právě teď označena jako dokončená (a předtím nebyla)
    if (isFinishedNow && !wasFinishedBefore) {
        console.log(`Posílám notifikaci o ukončení ligy: ${liga}`);
        notif.notifyLeagueEnd(liga);
    }
    logAdminAction(req.session.user, "ZÁKLADNÍ_ČÁST", `Změněn stav základní části pro ${liga} (${season}) na: ${req.body.isFinished === 'on' ? 'DOKONČENO' : 'PROBÍHÁ'}`);
    res.redirect('/admin');
});

router.post("/toggle-table-tips-lock", requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
    const { season, liga, locked, group, totalGroups } = req.body;
    const shouldLock = (locked === 'true');

    let statusData = {};
    try { statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8')); } catch(e) {}
    if (!statusData[season]) statusData[season] = {};
    if (!statusData[season][liga]) statusData[season][liga] = {};
    let currentStatus = statusData[season][liga].tableTipsLocked;

    if (!group) {
        // Globální zámek
        statusData[season][liga].tableTipsLocked = shouldLock;
    }
    else {
        // Zámek konkrétní skupiny
        let lockedGroups = [];

        if (Array.isArray(currentStatus)) {
            lockedGroups = [...currentStatus];
        } else if (currentStatus === true) {
            // Pokud bylo zamčeno vše, vygenerujeme pole ČÍSEL ["1", "2", ...]
            const count = parseInt(totalGroups) || 1;
            for (let i = 1; i <= count; i++) {
                lockedGroups.push(String(i)); // "1", "2"...
            }
        } else {
            lockedGroups = [];
        }

        const groupStr = String(group); // "1"

        if (shouldLock) {
            if (!lockedGroups.includes(groupStr)) lockedGroups.push(groupStr);
        } else {
            lockedGroups = lockedGroups.filter(g => g !== groupStr);
        }

        // Optimalizace
        const total = parseInt(totalGroups) || 0;
        if (lockedGroups.length === 0) statusData[season][liga].tableTipsLocked = false;
        else if (lockedGroups.length === total && total > 0) statusData[season][liga].tableTipsLocked = true;
        else statusData[season][liga].tableTipsLocked = lockedGroups;
    }

    fs.writeFileSync('./data/leagueStatus.json', JSON.stringify(statusData, null, 2));
    logAdminAction(req.session.user, "ZÁMEK_TABULKY", `Změněn zámek tipů na tabulku pro ${liga} (Skupina: ${group || 'GLOBÁLNÍ'}) na: ${shouldLock ? 'ZAMČENO' : 'ODEMČENO'}`);
    res.redirect('/admin/leagues/manage');
});

router.get('/teams/points', requireAdmin, (req, res) => {
    const fs = require('fs');
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    const teams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf8'));

    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const realScores = {};

    const seasonLeagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];

    const selectedLiga = req.query.liga || (seasonLeagues.length > 0 ? seasonLeagues[0].name : null);

    teams.forEach(t => realScores[t.id] = { points: 0, gf: 0, ga: 0 });

    matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga).forEach(m => {
        if (m.result) {
            const sH = parseInt(m.result.scoreHome);
            const sA = parseInt(m.result.scoreAway);
            if (realScores[m.homeTeamId]) { realScores[m.homeTeamId].gf += sH; realScores[m.homeTeamId].ga += sA; }
            if (realScores[m.awayTeamId]) { realScores[m.awayTeamId].gf += sA; realScores[m.awayTeamId].ga += sH; }
            if (m.result.ot) {
                if (sH > sA) { if (realScores[m.homeTeamId]) realScores[m.homeTeamId].points += 2; if (realScores[m.awayTeamId]) realScores[m.awayTeamId].points += 1; }
                else { if (realScores[m.awayTeamId]) realScores[m.awayTeamId].points += 2; if (realScores[m.homeTeamId]) realScores[m.homeTeamId].points += 1; }
            } else {
                if (sH > sA) { if (realScores[m.homeTeamId]) realScores[m.homeTeamId].points += 3; }
                else if (sA > sH) { if (realScores[m.awayTeamId]) realScores[m.awayTeamId].points += 3; }
                else { if (realScores[m.homeTeamId]) realScores[m.homeTeamId].points += 1; if (realScores[m.awayTeamId]) realScores[m.awayTeamId].points += 1; }
            }
        }
    });

    // Načteme existující bonusy
    let bonusData = {};
    try { bonusData = JSON.parse(fs.readFileSync('./data/teamBonuses.json', 'utf8')); } catch (e) { bonusData = {}; }

    // Filtrujeme týmy
    const leagueTeams = teams.filter(t => t.liga === selectedLiga && t.active);

    // PŘIDÁNO: Ultimátní seřazení (Body -> Rozdíl skóre -> Vstřelené góly)
    leagueTeams.sort((a, b) => {
        const getData = (team) => {
            const raw = bonusData[selectedSeason]?.[selectedLiga]?.[String(team.id)];
            if (typeof raw === 'number') return { points: raw, gf: 0, ga: 0, tiebreaker: 0 };
            return raw || { points: 0, gf: 0, ga: 0, tiebreaker: 0 };
        };

        const dataA = getData(a);
        const dataB = getData(b);

        const totalPtsA = (realScores[a.id]?.points || 0) + (dataA.points || 0);
        const totalPtsB = (realScores[b.id]?.points || 0) + (dataB.points || 0);

        // 1. Kritérium: CELKOVÉ BODY
        if (totalPtsB !== totalPtsA) return totalPtsB - totalPtsA;

        // 1.5 Kritérium: TIEBREAKER (Pořadí: 1 = vítěz minitabulky, 2 = druhý...)
        const tieA = dataA.tiebreaker || 0;
        const tieB = dataB.tiebreaker || 0;
        if (tieA !== tieB) {
            // Pokud jeden z nich nemá zadané pořadí (má 0), automaticky prohrává
            if (tieA === 0) return 1;  // A padá dolů
            if (tieB === 0) return -1; // B padá dolů

            // Pokud mají oba vyplněno (> 0), menší číslo vyhrává (1 porazí 2)
            return tieA - tieB;
        }

        // 2. Kritérium: CELKOVÝ ROZDÍL SKÓRE (GF - GA)
        const diffA = ((realScores[a.id]?.gf || 0) + (dataA.gf || 0)) - ((realScores[a.id]?.ga || 0) + (dataA.ga || 0));
        const diffB = ((realScores[b.id]?.gf || 0) + (dataB.gf || 0)) - ((realScores[b.id]?.ga || 0) + (dataB.ga || 0));
        if (diffB !== diffA) return diffB - diffA;

        // 3. Kritérium: CELKOVÉ VSTŘELENÉ GÓLY (GF)
        const gfA = (realScores[a.id]?.gf || 0) + (dataA.gf || 0);
        const gfB = (realScores[b.id]?.gf || 0) + (dataB.gf || 0);
        return gfB - gfA;
    });

    const pointsCount = {};
    leagueTeams.forEach(t => {
        const raw = bonusData[selectedSeason]?.[selectedLiga]?.[String(t.id)];
        const manualPts = (typeof raw === 'number' ? raw : raw?.points) || 0;
        const totalPts = (realScores[t.id]?.points || 0) + manualPts;
        pointsCount[totalPts] = (pointsCount[totalPts] || 0) + 1;
    });
    // === NOVÉ: Zjištění unikátních shod pro barevné odlišení ===
    const tiedScores = Object.keys(pointsCount)
        .filter(pts => pointsCount[pts] > 1)
        .sort((a, b) => Number(b) - Number(a)); // Seřadíme od nejvyšších bodů dolů

    // Paleta tmavých barev pro pozadí skupin se shodou (rotují, kdyby bylo shod hodně)
    const tieColors = ['#4a2500', '#00294d', '#00401a', '#4d0026', '#33004a'];
    const html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <title>Body a Zápasy týmů</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
    </head>
    <body style="background-color: #222; color: white; margin: 20px">
        <h1>Manuální úprava týmů (${selectedSeason})</h1>
        <form method="GET" action="/admin/teams/points" style="margin-bottom: 20px;">
            <label>Liga: <select name="liga" class="league-select" onchange="this.form.submit()">
                ${seasonLeagues.map(l => `<option value="${l.name}" ${l.name === selectedLiga ? 'selected' : ''}>${l.name}</option>`).join('')}
            </select></label>
        </form>

        <form method="POST" action="/admin/teams/points">
            <input type="hidden" name="season" value="${selectedSeason}">
            <input type="hidden" name="liga" value="${selectedLiga}">
            <table class="points-table" style="width: 100%; max-width: 800px; text-align: center;">
                <thead>
                    <tr>
                        <th style="text-align: left;">Tým (ID)</th>
                        <th>Extra body (+/-)</th>
                        <th>Zápasy navíc (+/-)</th>
                        <th>Vstřelené góly (GF)</th>
                        <th>Obdržené góly (GA)</th>
                        <th>Tiebreak (při shodě)</th>
                    </tr>
                </thead>
                <tbody>
                    ${leagueTeams.map(t => {
        const tId = String(t.id);

        // Načtení uložených dat a přidání GF a GA
        let savedData = { points: 0, games: 0, gf: 0, ga: 0, tiebreaker: 0 }; // Ujisti se, že tu je tiebreaker
        if (bonusData[selectedSeason] &&
            bonusData[selectedSeason][selectedLiga] &&
            bonusData[selectedSeason][selectedLiga][tId]) {

            let raw = bonusData[selectedSeason][selectedLiga][tId];
            if (typeof raw === 'number') {
                savedData.points = raw;
            } else {
                savedData = { ...savedData, ...raw };
            }
        }

        const myTotalPts = (realScores[t.id]?.points || 0) + (savedData.points || 0);
        const isTied = pointsCount[myTotalPts] > 1;
        let rowBgStyle = "";
        if (isTied) {
            const groupIndex = tiedScores.indexOf(String(myTotalPts));
            const bgColor = tieColors[groupIndex % tieColors.length];
            rowBgStyle = `style="background-color: ${bgColor};"`;
        }
        return `
                        <tr ${rowBgStyle}>
                            <td style="text-align: left;">
                                <b>${t.name}</b><br>
                                <small style="color: grey;">ID: ${tId}</small>
                            </td>
                            <td>
                                <input type="number" name="points_${tId}" value="${savedData.points || 0}" style="width: 70px; text-align: center; background-color: #111; color: white; border: 1px solid orangered;">
                            </td>
                            <td>
                                <input type="number" name="games_${tId}" value="${savedData.games || 0}" style="width: 70px; text-align: center; background-color: #111; color: white; border: 1px solid orangered;">
                            </td>
                            <td>
                                <input type="number" name="gf_${tId}" value="${savedData.gf || 0}" style="width: 70px; text-align: center; border: 1px solid #00ff00; background-color: #111; color: white;">
                            </td>
                            <td>
                                <input type="number" name="ga_${tId}" value="${savedData.ga || 0}" style="width: 70px; text-align: center; border: 1px solid #ff0000; background-color: #111; color: white;">
                            </td>
                            <td>
                                ${isTied
            ? `<input type="number" name="tie_${tId}" value="${savedData.tiebreaker || 0}" style="width: 70px; text-align: center; border: 1px solid orangered; background-color: #111; color: white;" title="Pořadí v minitabulce (1 = nejlepší)">`
            : `<input type="hidden" name="tie_${tId}" value="0"><span style="color: gray;">—</span>`
        }
                            </td>
                        </tr>`;
    }).join('')}
                </tbody>
            </table>
            <br>
            <button class="action-btn edit-btn" type="submit" style="padding: 10px 20px; font-size: 1.1em;">Uložit změny</button>
        </form>
        <br>
        <a href="/admin" style="color: orangered;">Zpět do admina</a>
    </body>
    </html>`;
    res.send(html);
});

router.post('/teams/points', requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
    const { season, liga } = req.body;

    let bonusData = {};
    try { bonusData = JSON.parse(fs.readFileSync('./data/teamBonuses.json', 'utf8')); } catch (e) { bonusData = {}; }

    if (!bonusData[season]) bonusData[season] = {};
    if (!bonusData[season][liga]) bonusData[season][liga] = {};

    // Projdeme všechny položky formuláře
    // Hledáme klíče, které začínají na "points_"
    Object.keys(req.body).forEach(key => {
        if (key.startsWith('points_')) {
            // Získám ID týmu odříznutím "points_" (prvních 7 znaků)
            const teamId = key.substring(7);

            const pointsVal = Number(req.body[`points_${teamId}`]) || 0;
            const gamesVal  = Number(req.body[`games_${teamId}`]) || 0;

            // PŘIDÁNO: Načtení gólů z formuláře
            const gfVal     = Number(req.body[`gf_${teamId}`]) || 0;
            const gaVal     = Number(req.body[`ga_${teamId}`]) || 0;
            const tieVal    = Number(req.body[`tie_${teamId}`]) || 0;

            // Uložíme pod správné ID (nyní i s góly)
            bonusData[season][liga][teamId] = {
                points: pointsVal,
                games: gamesVal,
                gf: gfVal,
                ga: gaVal,
                tiebreaker: tieVal
            };
        }
    });

    fs.writeFileSync('./data/teamBonuses.json', JSON.stringify(bonusData, null, 2));
    logAdminAction(req.session.user, "MANUÁLNÍ_BODY", `Upraveny extra body v lize: ${liga}, Sezóna: ${season}`);
    res.redirect(`/admin/teams/points?liga=${encodeURIComponent(liga)}`);
});

router.post('/settings/clinch', requireAdmin, (req, res) => {
    // 1. Zkontrolujeme, co přesně přišlo z formuláře
    console.log("--- UKLÁDÁNÍ NASTAVENÍ ---");
    console.log("Přijatá data v req.body:", req.body);

    const mode = req.body.mode;
    let settings = {};

    // 2. Bezpečné načtení existujícího souboru
    try {
        if (fs.existsSync('./data/settings.json')) {
            const rawData = fs.readFileSync('./data/settings.json', 'utf8');
            if (rawData.trim() !== "") {
                settings = JSON.parse(rawData);
            }
        }
    } catch (e) {
        console.error("Chyba při čtení settings.json:", e);
    }

    console.log("Aktuální stav před změnou:", settings);

    // 3. Nastavení nové hodnoty
    settings.clinchMode = (mode === 'cascade') ? 'cascade' : 'strict';

    console.log("Nový stav k uložení:", settings);

    // 4. Uložení
    try {
        fs.writeFileSync('./data/settings.json', JSON.stringify(settings, null, 2));
        console.log("Úspěšně uloženo do ./data/settings.json");
    } catch (err) {
        console.error("Kritická chyba při zápisu do souboru:", err);
    }
    logAdminAction(req.session.user, "NASTAVENÍ_TABULKY", `Režim obarvování tabulky (clinch mode) změněn na: ${settings.clinchMode}`);
    // Návrat na předchozí stránku (odkud se formulář odeslal)
    res.redirect('/admin');
});

router.get('/matches/import', requireAdmin, (req, res) => {
    // 1. Načtení dat
    const currentSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));

    // Načítáme ligy z leagues.json (nikoliv allowedLeagues.json)
    let leaguesData = {};
    try {
        leaguesData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8'));
    } catch (e) {
        console.error("Chyba leagues.json", e);
    }

    // Získáme unikátní seznam lig napříč všemi sezónami
    const uniqueLeagues = new Set();
    Object.values(leaguesData).forEach(seasonObj => {
        if (seasonObj.leagues && Array.isArray(seasonObj.leagues)) {
            seasonObj.leagues.forEach(l => uniqueLeagues.add(l.name));
        }
    });
    // Seřadíme abecedně
    const leaguesList = Array.from(uniqueLeagues).sort();

    // Pokud je seznam prázdný, dáme tam aspoň default
    if (leaguesList.length === 0) leaguesList.push("TELH");

    // 2. Datumy (Dnes -> +14 dní)
    const today = new Date().toISOString().split('T')[0];
    const nextWeekDate = new Date();
    nextWeekDate.setDate(nextWeekDate.getDate() + 14);
    const nextWeek = nextWeekDate.toISOString().split('T')[0];

    // 3. Generování sezón (5 let zpět, 10 dopředu)
    const currentYearShort = parseInt(currentSeason.split('/')[0]);
    const currentYearFull = 2000 + currentYearShort;

    const seasonOptions = [];
    for (let i = -5; i <= 10; i++) {
        const y = currentYearFull + i;
        const nextY = y + 1;
        const label = `${String(y).slice(-2)}/${String(nextY).slice(-2)}`;
        seasonOptions.push(label);
    }

    // 4. HTML s tvým stylingem
    const html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <title>Import z Hokej.cz</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
    </head>
    <body class="admin_site">
        
        <header class="header">
            <div class="logo_title">
                <img alt="Logo" class="image_logo" src="/images/logo.png">
                <h1 id="title">Import zápasů</h1>
            </div>
            <div style="display:flex; gap:10px;">
                <a href="/admin" style="color: orangered">Zpět do menu</a>
            </div>
        </header>

        <main class="main_page" style="flex-direction: column; align-items: center;">
            
            <div class="stats-container" style="width: 100%; max-width: 800px; text-align: left;">
                <h2 style="color: orangered; text-align: center;">Hokej.cz Scraper</h2>
                <p style="text-align: center; color: lightgrey;">
                    Vyber parametry a vlož odkaz na sekci <strong>ZÁPASY</strong> z webu hokej.cz.
                </p>

                <form method="POST" action="/admin/matches/import-run" style="display: flex; flex-direction: column; gap: 15px; width: 100%;">
                    
                    <label style="display: flex; flex-direction: column; color: orangered;">
                        URL adresa (https://www.hokej.cz/tipsport-extraliga/zapasy?matchList-view-displayAll=1&matchList-filter-season=2025&matchList-filter-competition=7397):
                        <input type="text" name="url" placeholder="https://www.hokej.cz/tipsport-extraliga/zapasy?season=..." required 
                               style="padding: 10px; background-color: #222; border: 1px solid orangered; color: white;">
                    </label>

                    <div style="display:flex; gap: 20px; flex-wrap: wrap;">
                        <label style="flex: 1; display: flex; flex-direction: column; color: orangered;">
                            Od data:
                            <input type="date" name="dateFrom" value="${today}" 
                                   style="padding: 10px; background-color: #222; border: 1px solid orangered; color: white;">
                        </label>
                        <label style="flex: 1; display: flex; flex-direction: column; color: orangered;">
                            Do data:
                            <input type="date" name="dateTo" value="${nextWeek}" 
                                   style="padding: 10px; background-color: #222; border: 1px solid orangered; color: white;">
                        </label>
                    </div>

                    <div style="display:flex; gap: 20px; flex-wrap: wrap;">
                        <label style="flex: 1; display: flex; flex-direction: column; color: orangered;">
                            Liga (dle leagues.json):
                            <select name="liga" style="padding: 10px; background-color: #222; border: 1px solid orangered; color: white;">
                                ${leaguesList.map(l => `<option value="${l}" ${l === 'TELH' ? 'selected' : ''}>${l}</option>`).join('')}
                            </select>
                        </label>

                        <label style="flex: 1; display: flex; flex-direction: column; color: orangered;">
                            Sezóna (pro výpočet roku):
                            <select name="season" style="padding: 10px; background-color: #222; border: 1px solid orangered; color: white;">
                                ${seasonOptions.map(s => `<option value="${s}" ${s === currentSeason ? 'selected' : ''}>${s}</option>`).join('')}
                            </select>
                        </label>
                    </div>
                    
                    <div style="display:flex; margin-top: 10px; padding: 10px; background: rgba(255, 69, 0, 0.1); border: 1px dashed orangered;">
                        <label style="display: flex; align-items: center; gap: 10px; color: white; cursor: pointer;">
                            <input type="checkbox" name="lockImported" style="transform: scale(1.3);">
                            <strong>Zamknout všechny importované zápasy pro tipování (Lze později odemknout)</strong>
                        </label>
                    </div>
                    
                    <button type="submit" class="login_button" style="width: 100%; margin-top: 10px;">Stáhnout data</button>
                </form>
            </div>
        </main>
    </body>
    </html>
    `;
    res.send(html);
});

router.post('/matches/import-run', requireAdmin, async (req, res) => {
    const { url, liga, season, dateFrom, dateTo, lockImported } = req.body;

    const shouldLock = lockImported === 'on';

    try {
        console.log(`🔍 DEBUG: Začínám import pro ligu '${liga}'...`);

        // 1. Stahování
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
            }
        });

        const html = response.data;
        const $ = cheerio.load(html);
        const pageTitle = $('title').text().trim();

        const allTeams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf8'));
        const myTeams = allTeams.filter(t => t.liga === liga);

        // --- ID MATCHING (Zjištění posledního ID) ---
        const matchesDB = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));

        // Najdeme nejvyšší ID (číslo)
        let maxId = matchesDB.reduce((max, m) => {
            const numId = Number(m.id); // Převedeme na číslo
            return !isNaN(numId) && numId > max ? numId : max;
        }, 0);

        console.log(`ℹ️ Start ID: ${maxId + 1}`);

        let newMatchesCount = 0;
        let skippedCount = 0;
        let outOfRangeCount = 0;
        let notFoundTeams = new Set();

        // --- POMOCNÉ FUNKCE ---
        const cleanTeamName = (rawName) => {
            if (!rawName) return "";
            let clean = rawName.trim();
            clean = clean.replace(/^([A-Z]{1,2})\s+/, "");
            clean = clean.split(/\s{2,}|\n/)[0];
            clean = clean.replace("Č.", "České").replace("K.", "Karlovy");
            return clean.trim();
        };

        const findTeamId = (scrapedName) => {
            if (!scrapedName) return null;
            let clean = cleanTeamName(scrapedName);
            let found = myTeams.find(t => t.name.toLowerCase() === clean.toLowerCase());
            if (!found) found = myTeams.find(t => t.name.toLowerCase().includes(clean.toLowerCase()));
            if (!found) found = myTeams.find(t => clean.toLowerCase().includes(t.name.toLowerCase()));
            if (!found && clean.includes(" B")) {
                const baseName = clean.replace(" B", "").trim();
                found = myTeams.find(t => t.name.includes(baseName) && t.name.includes(" B"));
            }
            if (!found) notFoundTeams.add(`${clean} (orig: ${scrapedName})`);

            // Důležité: Vracíme ID jako ČÍSLO (pokud je v teams.json string, převedeme ho)
            return found ? Number(found.id) : null;
        };

        const rows = $('table.preview tr');
        console.log(`ℹ️ Nalezeno řádků: ${rows.length}`);

        rows.each((i, el) => {
            // Jména týmů
            const getDirectText = (selector) => $(el).find(selector).contents().filter(function() { return this.type === 'text'; }).text().trim();
            let homeName = getDirectText('.preview__name:first') || $(el).find('.preview__name').first().text().trim();
            let awayName = getDirectText('.preview__name:last') || $(el).find('.preview__name').last().text().trim();

            if (!homeName || !awayName) return;

            // --- DATA A ČAS ---
            let dateRaw = null;
            let timeRaw = "17:00";

            const dateBoxCols = $(el).find('.preview__center .box-snow .col-1_3');
            if (dateBoxCols.length >= 2) {
                dateBoxCols.each((idx, col) => {
                    const txt = $(col).text().trim();
                    if (txt.match(/^\d{1,2}\.\s*\d{1,2}\.$/)) dateRaw = txt;
                    if (txt.match(/^\d{1,2}:\d{2}$/)) timeRaw = txt;
                });
            }

            // Fallbacky
            if (!dateRaw) dateRaw = $(el).closest('table').prevAll('h2, h3, .date-header').first().text().trim();
            if (!dateRaw) {
                const centerText = $(el).find('.preview__center').text().trim();
                const dateMatch = centerText.match(/(\d{1,2})\.\s*(\d{1,2})\./);
                if (dateMatch) dateRaw = `${dateMatch[1]}. ${dateMatch[2]}.`;
            }

            const homeId = findTeamId(homeName);
            const awayId = findTeamId(awayName);

            if (homeId && awayId) {
                const parseMatch = dateRaw ? dateRaw.match(/(\d{1,2})\.\s*(\d{1,2})\./) : null;

                if (parseMatch) {
                    const day = parseMatch[1].padStart(2, '0');
                    const month = parseMatch[2].padStart(2, '0');

                    // Výpočet roku
                    const seasonYears = season.split('/');
                    const startYear = "20" + seasonYears[0];
                    const endYear = "20" + seasonYears[1];
                    const year = (parseInt(month) >= 8) ? startYear : endYear;

                    const fullDate = `${year}-${month}-${day}`;

                    // Vytvoření datetime stringu (YYYY-MM-DDTHH:MM)
                    const isoDateTime = `${fullDate}T${timeRaw}`;

                    // Kontrola rozsahu (porovnáváme jen datumovou část)
                    if (dateFrom && fullDate < dateFrom) { outOfRangeCount++; return; }
                    if (dateTo && fullDate > dateTo) { outOfRangeCount++; return; }

                    // Kontrola existence - musíme parsovat existující datetime v DB
                    const exists = matchesDB.some(m => {
                        // Pokud v DB datetime chybí, nemůžeme porovnat
                        if (!m.datetime) return false;
                        // Porovnáváme začátek stringu (datum) + ID týmů
                        return m.datetime.startsWith(fullDate) && m.homeTeamId === homeId && m.awayTeamId === awayId;
                    });

                    if (!exists) {
                        maxId++;

                        // PUSHUJEME PŘESNĚ TVŮJ FORMÁT
                        matchesDB.push({
                            id: maxId,              // Číslo (16)
                            homeTeamId: homeId,     // Číslo (10)
                            awayTeamId: awayId,     // Číslo (8)
                            datetime: isoDateTime,  // "2025-09-14T16:00"
                            liga: liga,             // "TELH"
                            season: season,         // "25/26"
                            isPlayoff: false,       // false
                            postponed: false,       // Výchozí stav (neodloženo)
                            locked: shouldLock,     // Výchozí stav (odemčeno)
                            result: null            // null (výsledek zatím není)
                        });
                        newMatchesCount++;
                    } else {
                        skippedCount++;
                    }
                }
            }
        });

        if (newMatchesCount > 0) fs.writeFileSync('./data/matches.json', JSON.stringify(matchesDB, null, 2));

        const notFoundArray = Array.from(notFoundTeams);

        const htmlRes = `
        <!DOCTYPE html>
        <html lang="cs">
        <head>
            <meta charset="UTF-8">
            <title>Výsledek importu</title>
            <link rel="stylesheet" href="/css/styles.css">
            <link rel="icon" href="/images/logo.png">
        </head>
        <body class="admin_site">
            <header class="header">
                <div class="logo_title">
                    <img alt="Logo" class="image_logo" src="/images/logo.png">
                    <h1 id="title">Výsledek importu</h1>
                </div>
            </header>

            <main class="main_page" style="flex-direction: column; align-items: center;">
                <div class="stats-container" style="width: 100%; max-width: 700px;">
                    <h2 style="color: ${newMatchesCount > 0 ? '#00ff00' : 'orangered'};">
                        ${newMatchesCount > 0 ? 'Úspěch!' : 'Dokončeno'}
                    </h2>
                    
                    <p style="color:gray; font-size:12px;">Titulek stránky: ${pageTitle}</p>

                    <table class="points-table" style="font-size: 14px; margin-top: 20px;">
                        <tr><td style="text-align: left;">Vybraná liga:</td><td>${liga}</td></tr>
                        <tr><td style="text-align: left;">Prohledáno řádků:</td><td>${rows.length}</td></tr>
                        <tr><td style="text-align: left;">Nové zápasy:</td><td style="color: #00ff00; font-weight: bold;">${newMatchesCount}</td></tr>
                        <tr><td style="text-align: left;">Již existující:</td><td style="color: yellow;">${skippedCount}</td></tr>
                        <tr><td style="text-align: left;">Mimo datum:</td><td style="color: gray;">${outOfRangeCount}</td></tr>
                    </table>

                    ${notFoundArray.length > 0 ? `
                    <div style="margin-top: 20px; border: 1px solid red; padding: 10px; background: #330000;">
                        <h3 style="color: red; margin: 0 0 10px 0;">⚠️ Nespárované týmy</h3>
                        <ul style="color: white; text-align: left; columns: 1;">
                            ${notFoundArray.map(t => `<li>${t}</li>`).join('')}
                        </ul>
                    </div>
                    ` : ''}

                    <div style="margin-top: 20px; display: flex; gap: 10px; justify-content: center;">
                        <a href="/admin/matches/import" class="action-btn" style="background-color: #333; border: 1px solid orangered;">Zkusit znovu</a>
                        <a href="/admin" class="action-btn edit-btn">Správa zápasů</a>
                    </div>
                </div>
            </main>
        </body>
        </html>
        `;
        logAdminAction(req.session.user, "IMPORT_ZÁPASŮ", `Hromadně importováno ${newMatchesCount} zápasů pro ligu ${liga} (${season})`);
        res.send(htmlRes);

    } catch (error) {
        console.error(error);
        res.status(500).send(`Chyba: ${error.message}`);
    }
});
router.post('/leagues/transfers', requireAdmin, express.urlencoded({ extended: true }), (req, res) => {
    let { transferLeagues } = req.body;

    // Ošetření, aby to bylo vždycky pole
    let savedTransferLeagues = [];
    if (Array.isArray(transferLeagues)) {
        savedTransferLeagues = transferLeagues;
    } else if (typeof transferLeagues === 'string') {
        savedTransferLeagues = [transferLeagues];
    }

    // Uložení do JSONu
    fs.writeFileSync('./data/transferLeagues.json', JSON.stringify(savedTransferLeagues, null, 2));

    res.redirect('/admin');
});

router.get('/images/manage', requireAdmin, (req, res) => {
    const imagesDir = path.join(__dirname, '..', 'data', 'images');
    const teams = loadTeams();
    const usedLogos = new Set(teams.map(t => t.logo).filter(Boolean));

    // Pojistka, kdyby složka neexistovala
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }

    // Načteme všechny soubory, které jsou obrázky
    const files = fs.readdirSync(imagesDir).filter(f => f.match(/\.(jpg|jpeg|png|gif|webp)$/i));

    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <title>Správce log</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
    </head>
    <body class="usersite">
        <main class="admin_site">
            <h1>Správce nahraných log (${files.length} souborů)</h1>
            <p><a href="/admin" style="color: orangered;">← Zpět do adminu</a></p>
            
            <div class="image-grid">
                ${files.map(file => {
        const isActive = usedLogos.has(file);
        return `
                    <div class="image-card ${isActive ? 'active' : ''}">
                        <span class="status-badge ${isActive ? 'status-active' : 'status-unused'}">
                            ${isActive ? 'POUŽÍVÁ SE' : 'NEVYUŽITO'}
                        </span>
                        <img src="/logoteamu/${file}" alt="${file}">
                        <span class="image-name">${file}</span>
                        
                        ${isActive
            ? `<span class="delete-link disabled" title="Nelze smazat logo, které je přiřazeno týmu">SMAZAT</span>`
            : `<a href="/admin/images/delete/${file}" class="delete-link" onclick="return confirm('Opravdu smazat nepoužívané logo?')">SMAZAT</a>`
        }
                    </div>
                `;}).join('')}
            </div>
            
            ${files.length === 0 ? '<p style="text-align:center; color: gray;">Žádné obrázky nenalezeny.</p>' : ''}
        </main>
    </body>
    </html>`;
    res.send(html);
});
router.get('/images/delete/:filename', requireAdmin, async (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, '..', 'data', 'images', filename);

    // 1. Lokální smazání ze serveru
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Lokální soubor ${filename} byl smazán.`);
        }
    } catch (err) {
        console.error("Chyba při lokálním mazání souboru:", err);
    }

    // 2. Permanentní smazání z GitHub zálohy (aby se po restartu nevrátil)
    try {
        const { Octokit } = require("@octokit/rest");
        const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

        // Nastavení tvého repozitáře (stejné jako v githubBackup.js)
        const REPO_OWNER = 'Medical-Issues';
        const REPO_NAME = 'TELHTipovackaZaloha';
        const BRANCH = 'main';
        const remotePath = `data/images/${filename}`;

        // GitHub vyžaduje pro smazání souboru jeho unikátní "sha" kód
        const { data } = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: remotePath,
            ref: BRANCH
        });

        // Odeslání požadavku na smazání
        await octokit.repos.deleteFile({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: remotePath,
            message: `🗑️ Auto-delete: Permanentně odstraněn obrázek ${filename}`,
            sha: data.sha,
            branch: BRANCH
        });

        console.log(`✅ Soubor ${filename} byl permanentně smazán i z GitHubu.`);
    } catch (err) {
        // Pokud vrátí 404, znamená to, že na GitHubu už soubor nebyl (což je v pořádku)
        if (err.status !== 404) {
            console.error(`⚠️ Chyba při mazání ${filename} z GitHubu:`, err.message);
        }
    }
    logAdminAction(req.session.user, "SMAZÁNÍ_OBRÁZKU", `Permanentně smazán obrázek z webu i zálohy: ${filename}`);
    res.redirect('/admin/images/manage');
});

router.get('/transfers/manage', requireAdmin, (req, res) => {
    const teams = loadTeams();
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const allowedLeagues = JSON.parse(fs.readFileSync('./data/allowedLeagues.json', 'utf-8'));

    const selectedLiga = req.query.liga || allowedLeagues[0];

    let transfersData = {};
    try {
        if (fs.existsSync('./data/transfers.json')) {
            transfersData = JSON.parse(fs.readFileSync('./data/transfers.json', 'utf8'));
        }
    } catch (e) { transfersData = {}; }

    const currentTransfers = transfersData[selectedSeason]?.[selectedLiga] || {};
    const teamsInLiga = teams.filter(t => t.liga === selectedLiga && t.active);

    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <title>Admin - Přestupy</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
    </head>
    <body class="usersite">
        <main class="admin_site">
            <h1>Správa přestupů: ${selectedLiga} (${selectedSeason})</h1>
            
            <div class="legend-box">
                <h3 style="margin: 0; color: white;">🎨 Jak formátovat jména (Legenda)</h3>
                <p style="margin: 5px 0 0 0; color: gray; font-size: 0.9em;">Za jméno hráče připiš tyto značky a po uložení se na webu obarví:</p>
                
                <div class="legend-grid">
                    <div class="legend-item">
                        <span class="code-tag">(!)</span> = <span style="color: gold; font-weight: bold;">🔥 Bomba / Hotovo</span>
                    </div>
                    <div class="legend-item">
                        <span class="code-tag">(X)</span> = <span style="color: #ff6666; text-decoration: line-through;">❌ Padlo / Odchod</span>
                    </div>
                    <div class="legend-item">
                        <span class="code-tag">(?)</span> = <span style="color: #00d4ff; font-style: italic;">❓ Spekulace</span>
                    </div>
                    <div class="legend-item">
                        <span class="code-tag">(K)</span> = <span style="color: orange; font-weight: bold;">📄 Konec smlouvy</span>
                    </div>
                     <div class="legend-item">
                        <span class="code-tag">#00ff00</span> = <span style="color: #00ff00;">Vlastní HEX barva</span>
                    </div>
                </div>
            </div>

            <form method="GET" style="margin-bottom: 20px;">
                Změnit ligu: 
                <select id="league-select" name="liga" onchange="this.form.submit()" style="padding: 5px;">
                    ${allowedLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </form>

            <form method="POST" action="/admin/transfers/save">
                <input type="hidden" name="liga" value="${selectedLiga}">
                <input type="hidden" name="season" value="${selectedSeason}">
                
                ${teamsInLiga.map(team => {
        const tId = String(team.id);
        const data = currentTransfers[tId] || { specIn: [], specOut: [], confIn: [], confOut: [] };
        const logoUrl = team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

        return `
                    <div class="team-block">
                        <div class="team-background-logo" style="background-image: url('${logoUrl}');"></div>
                        <div class="team-content">
                            <h2>${team.name} <span style="font-size:0.6em; color:gray; font-weight:normal;">(ID: ${team.id})</span></h2>
                            <div class="t-grid">
                                <div><span class="t-label">SPEKULACE IN <span style="color:cyan">(?)</span></span><textarea name="t[id_${team.id}][specIn]">${(data.specIn || []).join('\n')}</textarea></div>
                                <div><span class="t-label">SPEKULACE OUT <span style="color:cyan">(?)</span></span><textarea name="t[id_${team.id}][specOut]">${(data.specOut || []).join('\n')}</textarea></div>
                                <div><span class="t-label" style="color: lime;">PŘÍCHODY <span style="color:gold">(!)</span></span><textarea name="t[id_${team.id}][confIn]">${(data.confIn || []).join('\n')}</textarea></div>
                                <div><span class="t-label" style="color: red;">ODCHODY <span style="color:#ff6666">(X)</span></span><textarea name="t[id_${team.id}][confOut]">${(data.confOut || []).join('\n')}</textarea></div>
                            </div>
                        </div>
                    </div>`;
    }).join('')}

                <div class="save-bar">
                    <button type="submit" class="btn new-btn-admin" style="width: 300px; padding: 10px;">ULOŽIT VŠECHNY PŘESTUPY</button>
                    <p><a href="/admin" style="color: #aaa;">Zrušit a zpět</a></p>
                </div>
            </form>
        </main>
    </body>
    </html>`;
    res.send(html);
});

router.post('/transfers/save', requireAdmin, express.urlencoded({ extended: true }), async (req, res) => {
    const fs = require('fs');
    const path = require('path');
    const notif = require('./notificationService');

    const { liga, season, t } = req.body;

    // --- DEBUG 1: Co přišlo z formuláře? ---
    console.log(`PŘIJATÝ POST: Liga: ${liga}, Sezóna: ${season}`);
    if (!t) {
        console.error("CHYBA: Objekt 't' s daty týmů chybí v req.body!");
        return res.redirect('back');
    }

    const teamsPath = path.join(__dirname, '../data/teams.json');
    const transfersPath = path.join(__dirname, '../data/transfers.json');

    let teams = [];
    try {
        teams = JSON.parse(fs.readFileSync(teamsPath, 'utf8'));
    } catch (e) { console.error("Chyba načítání teams.json", e); }

    let transfersData = {};
    try {
        if (fs.existsSync(transfersPath)) {
            transfersData = JSON.parse(fs.readFileSync(transfersPath, 'utf8'));
        }
    } catch (e) { transfersData = {}; }

    if (!transfersData[season]) transfersData[season] = {};
    if (!transfersData[season][liga]) transfersData[season][liga] = {};

    let newTransfersNotification = [];

    // Iterujeme přes týmy
    for (const rawKey in t) {
        const teamId = rawKey.replace('id_', '');
        const teamObj = t[rawKey];

        const cleanList = (text) => text ? text.split('\n').map(name => name.trim()).filter(name => name !== "") : [];

        // 1. Načtení nových seznamů z formuláře
        const newConfIn = cleanList(teamObj.confIn);
        const newConfOut = cleanList(teamObj.confOut);
        const newSpecIn = cleanList(teamObj.specIn);
        const newSpecOut = cleanList(teamObj.specOut);

        // 2. Načtení starých dat pro porovnání
        const oldData = transfersData[season][liga][teamId] || {};
        const oldConfIn = Array.isArray(oldData.confIn) ? oldData.confIn.map(p => p.trim()) : [];
        const oldConfOut = Array.isArray(oldData.confOut) ? oldData.confOut.map(p => p.trim()) : [];
        const oldSpecIn = Array.isArray(oldData.specIn) ? oldData.specIn.map(p => p.trim()) : [];
        const oldSpecOut = Array.isArray(oldData.specOut) ? oldData.specOut.map(p => p.trim()) : [];

        // Najdeme jméno týmu
        const teamName = teams.find(tm => Number(tm.id) === Number(teamId))?.name || `Tým ${teamId}`;

        // Pomocná funkce pro nalezení skutečně nových jmen
        const getAdded = (newArr, oldArr) => newArr.filter(p => p !== "" && !oldArr.includes(p));

        // 3. DETEKCE ZMĚN

        // Potvrzené příchody
        getAdded(newConfIn, oldConfIn).forEach(p => newTransfersNotification.push(`✅ ${p} -> ${teamName}`));

        // Potvrzené odchody
        getAdded(newConfOut, oldConfOut).forEach(p => newTransfersNotification.push(`❌ ${p} opouští ${teamName}`));

        // Spekulace příchody
        getAdded(newSpecIn, oldSpecIn).forEach(p => newTransfersNotification.push(`❓ ${p} (spekulace) -> ${teamName}`));

        // Spekulace odchody
        getAdded(newSpecOut, oldSpecOut).forEach(p => newTransfersNotification.push(`⚠️ ${p} (možný odchod) -> ${teamName}`));

        // 4. AKTUALIZACE DAT V PAMĚTI
        transfersData[season][liga][teamId] = {
            specIn: newSpecIn,
            specOut: newSpecOut,
            confIn: newConfIn,
            confOut: newConfOut
        };
    }

    // --- ZÁPIS DO SOUBORU ---
    try {
        fs.writeFileSync(transfersPath, JSON.stringify(transfersData, null, 2));
        console.log("Data úspěšně uložena do transfers.json");
    } catch (err) {
        console.error("Chyba při zápisu do souboru:", err);
    }

    // --- ODESLÁNÍ NOTIFIKACE ---
    if (newTransfersNotification.length > 0) {
        let message;
        // Pokud je změn málo, vypíšeme je. Pokud hodně, pošleme souhrnnou zprávu.
        if (newTransfersNotification.length <= 4) {
            message = `Změny v kádrech: ${newTransfersNotification.join(', ')}`;
        } else {
            const firstFew = newTransfersNotification.slice(0, 3).join(', ');
            message = `Nové pohyby v lize (${newTransfersNotification.length}): ${firstFew} a další...`;
        }

        console.log("ODESÍLÁM NOTIFIKACI:", message);

        try {
            notif.notifyTransfer(message);
        } catch (err) {
            console.error("Selhalo volání notif.notifyTransfer:", err);
        }
    } else {
        console.log("Žádné nové pohyby k oznámení.");
    }
    logAdminAction(req.session.user, "PŘESTUPY", `Uloženy přestupy pro ligu ${liga} (Nové pohyby: ${newTransfersNotification.length})`);
    res.redirect(`/admin/transfers/manage?liga=${encodeURIComponent(liga)}`);
});

router.get('/broadcast-ping', requireAdmin, async (req, res) => {
    try {
        // 1. Čteme soubor VŽDY uvnitř routy, aby tam byli i noví lidé
        const usersPath = path.join(__dirname, '../data/users.json');
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));

        // 2. OPRAVENÝ FILTR: Musíme vzít starý i nový formát
        const subscribers = users.filter(u =>
            u.subscription || (u.subscriptions && u.subscriptions.length > 0)
        );

        if (subscribers.length === 0) {
            return res.send("<h2>Nikdo nemá zapnuté notifikace 😢</h2>");
        }

        // 3. Příprava dat
        const payload = {
            title: "📢 Testovací PING",
            body: "Pokud tohle čteš, hromadné notifikace fungují na všech tvých zařízeních! 🚀",
            icon: "/images/logo.png"
        };

        let successCount = 0;
        let failCount = 0;

        // 4. Odesílání přes sendToUserDevices, která zvládne všechna zařízení uživatele
        subscribers.forEach(u => {
            try {
                // Tato funkce v notificationService už má v sobě .catch pro chyby 410
                notif.sendToUserDevices(u, payload);
                successCount++;
            } catch (err) {
                failCount++;
                console.error(`Kritická chyba u odesílání pro ${u.username}:`, err);
            }
        });

        // 5. Výsledek pro admina
        res.send(`
            <h1>Výsledek Broadcastu</h1>
            <p>✅ Příkaz k odeslání vydán pro: <strong>${successCount}</strong> uživatelů.</p>
            <p>ℹ️ <em>Poznámka: Pokud má uživatel více zařízení (PC i mobil), dostane zprávu na obě.</em></p>
            <br>
            <a href="/admin">Zpět do adminu</a>
        `);

    } catch (e) {
        console.error("Chyba v broadcast-ping:", e);
        res.send(`Chyba serveru: ${e.message}`);
    }
});
router.get('/users', requireAdmin, (req, res) => {
    const usersPath = path.join(__dirname, '../data/users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));

    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
        <title>Správa uživatelů</title>
    </head>
    <body class="usersite">
        <main class="admin_site">
            <h1>Správa uživatelů</h1>
            <table class="admin-table" style="width:100%; border-collapse: collapse; margin-top: 20px; color: white;">
                <thead>
                    <tr style="background: #fb6a18; color: black;">
                        <th style="padding: 12px; text-align: left;">Uživatel</th>
                        <th style="padding: 12px; text-align: center;">Role</th>
                        <th style="padding: 12px; text-align: center;">Notifikace</th>
                        <th style="padding: 12px; text-align: right;">Akce</th>
                    </tr>
                </thead>
                <tbody>
                    ${users.map(user => `
                        <tr style="border-bottom: 1px solid #444;">
                            <td style="padding: 12px;"><strong>${user.username}</strong></td>
                            <td style="padding: 12px; text-align: center;">
                                <span style="color: ${user.role === 'admin' ? 'red' : 'lightgreen'}; font-weight: bold;">
                                    ${user.role === 'admin' ? 'Administrátor' : 'Uživatel'}
                                </span>
                            </td>
                            <td style="padding: 12px; text-align: center;">${(user.subscriptions?.length > 0 || user.subscription) ? '🔔' : '❌'}</td>
                            <td style="padding: 12px; text-align: right;">
                                <a href="/admin/users/edit/${encodeURIComponent(user.username)}" class="btn-edit" style="background: orange; color: black; padding: 5px 10px; text-decoration: none; font-weight: bold;">Upravit</a>
                                
                                <form method="POST" action="/admin/users/delete" style="display:inline;" onsubmit="return confirm('OPRAVDU SMAZAT? Tato akce provede HLOUBKOVÉ smazání všech tipů uživatele ${user.username}!');">
                                    <input type="hidden" name="usernameToDelete" value="${user.username}">
                                    <button type="submit" style="background: red; color: white; border: none; padding: 5px 10px; cursor: pointer; font-weight: bold;">Smazat</button>
                                </form>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            <br>
            <a href="/admin" style="color: #fb6a18; font-weight: bold;">← Zpět do hlavního Adminu</a>
        </main>
    </body></html>`;
    res.send(html);
});

router.post('/users/delete', requireAdmin, (req, res) => {
    const { usernameToDelete } = req.body;

    if (usernameToDelete === req.session.user) {
        return res.status(400).send("Chyba: Nemůžete smazat svůj vlastní účet.");
    }

    try {
        // 1. Smazání z users.json (Přihlášení a odběry)
        const usersPath = path.join(__dirname, '../data/users.json');
        let users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        users = users.filter(u => u.username !== usernameToDelete);
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

        // 2. Smazání z tips.json (Tipy na zápasy)
        const tipsPath = path.join(__dirname, '../data/tips.json');
        if (fs.existsSync(tipsPath)) {
            let tips = JSON.parse(fs.readFileSync(tipsPath, 'utf8'));
            if (tips[usernameToDelete]) {
                delete tips[usernameToDelete];
                fs.writeFileSync(tipsPath, JSON.stringify(tips, null, 2));
            }
        }

        // 3. Smazání z tableTips.json (Tipy na tabulky)
        const tableTipsPath = path.join(__dirname, '../data/tableTips.json');
        if (fs.existsSync(tableTipsPath)) {
            let tableTips = JSON.parse(fs.readFileSync(tableTipsPath, 'utf8'));
            if (tableTips[usernameToDelete]) {
                delete tableTips[usernameToDelete];
                fs.writeFileSync(tableTipsPath, JSON.stringify(tableTips, null, 2));
            }
        }

        console.log(`🧹 Uživatel ${usernameToDelete} byl kompletně vymazán ze všech souborů.`);
        logAdminAction(req.session.user, "SMAZÁNÍ_UŽIVATELE", `Smazán účet: ${usernameToDelete}`);
        res.redirect('/admin/users');
    } catch (error) {
        console.error("Kritická chyba při mazání:", error);
        logAdminAction(req.session.user, "POKUS_SMAZÁNÍ_UŽIVATELE", `Účet: ${usernameToDelete}`);
        res.status(500).send("Chyba při hloubkovém mazání uživatele.");
    }
});

// Formulář úpravy
router.get('/users/edit/:username', requireAdmin, (req, res) => {
    const usernameToEdit = req.params.username;
    const usersPath = path.join(__dirname, '../data/users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    const user = users.find(u => u.username === usernameToEdit);

    if (!user) return res.send("Uživatel nenalezen.");

    res.send(`
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/public/images/logo.png">
        <title>Upravit uživatele - ${user.username}</title>
        <style>
            .edit-card {
                background: #1a1a1a;
                border: 1px solid #333;
                padding: 30px;
                max-width: 500px;
                margin: 20px auto;
                box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            }
            .edit-card h1 {
                color: #fb6a18;
                margin-top: 0;
                border-bottom: 1px solid #fb6a18;
                padding-bottom: 10px;
            }
            .form-group {
                margin-bottom: 20px;
            }
            .form-group label {
                display: block;
                color: #ccc;
                margin-bottom: 8px;
                font-weight: bold;
            }
            .form-group input, .form-group select {
                width: 100%;
                padding: 12px;
                background: #000;
                border: 1px solid #444;
                color: #fff;
                box-sizing: border-box;
            }
            .form-group input:focus {
                border-color: #fb6a18;
                outline: none;
            }
            .btn-save {
                width: 100%;
                padding: 15px;
                background: #fb6a18;
                color: #000;
                border: none;
                font-weight: bold;
                cursor: pointer;
                transition: 0.3s;
            }
            .btn-save:hover {
                background: #ff8c4a;
            }
            .back-link {
                display: block;
                text-align: center;
                margin-top: 20px;
                color: #888;
                text-decoration: none;
            }
            .back-link:hover {
                color: #fb6a18;
            }
        </style>
    </head>
    <body class="usersite">
        <main class="admin_site">
            <div class="edit-card">
                <h1>Upravit účet</h1>
                <form action="/admin/users/update" method="POST">
                    <input type="hidden" name="oldUsername" value="${user.username}">
                    
                    <div class="form-group">
                        <label>Uživatelské jméno</label>
                        <input type="text" name="newUsername" value="${user.username}" required>
                    </div>


                    <div class="form-group">
                        <label>Nové heslo</label>
                        <input type="password" name="newPassword" placeholder="Ponechte prázdné pro beze změny">
                    </div>

                    <div class="form-group">
                        <label>Role</label>
                        <select name="newRole">
                            <option value="user" ${user.role !== 'admin' ? 'selected' : ''}>Běžný uživatel</option>
                            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrátor</option>
                        </select>
                    </div>

                    ${user.username === req.session.user ? `<p style="color: red; font-size: 12px;">⚠️ Upravuješ svůj vlastní účet. Systém tě nenechá odebrat si roli Administrátora.</p>` : ''}

                    <button type="submit" class="btn-save">ULOŽIT ZMĚNY</button>
                    <a href="/admin/users" class="back-link">← Zpět na seznam</a>
                </form>
            </div>
        </main>
    </body>
    </html>`);
});

// Uložení úpravy
// Uložení úpravy (Přidáno slovo 'async')
router.post('/users/update', requireAdmin, async (req, res) => {
    const { oldUsername, newUsername, newPassword, newRole } = req.body;
    const usersPath = path.join(__dirname, '../data/users.json');
    let users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));

    const idx = users.findIndex(u => u.username === oldUsername);
    if (idx === -1) return res.send("Uživatel nenalezen.");

    // Aktualizace v users.json
    users[idx].username = newUsername;

    // PŘIDÁNO: Skutečné zašifrování hesla pomocí bcryptu
    if (newPassword && newPassword.trim() !== "") {
        users[idx].password = await bcrypt.hash(newPassword, 10);
    }

    if (oldUsername === req.session.user && newRole !== 'admin') {
        // Pokud se snažíš odebrat práva sám sobě, systém to ignoruje a nechá ti admina
        users[idx].role = 'admin';
    } else if (newRole) {
        users[idx].role = newRole;
    }

    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

    // Pokud se změnilo jméno, přepíšeme ho v tipech (Hloubková synchronizace)
    if (oldUsername !== newUsername) {
        ['../data/tips.json', '../data/tableTips.json'].forEach(file => {
            const filePath = path.join(__dirname, file);
            if (fs.existsSync(filePath)) {
                let data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (data[oldUsername]) {
                    data[newUsername] = data[oldUsername];
                    delete data[oldUsername];
                    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
                }
            }
        });
    }
    logAdminAction(req.session.user, "ÚPRAVA_UŽIVATELE", `Úprava účtu: ${oldUsername} -> ${newUsername}, Nová role: ${newRole || 'beze změny'}`);
    res.redirect('/admin/users');
});

router.get('/toggleLocked/:id', requireAdmin, (req, res) => {
    const matchId = parseInt(req.params.id);
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const match = matches.find(m => m.id === matchId);
    if (!match) return renderErrorHtml(res, "Zápas nebyl nalezen.", 404);

    // Provede změnu stavu zámku (true na false a naopak)
    match.locked = !match.locked;

    if (match.locked) {
        removeTipsForDeletedMatch(matchId);
    }

    fs.writeFileSync('./data/matches.json', JSON.stringify(matches, null, 2));
    logAdminAction(req.session.user, "ZÁMEK_ZÁPASU", `Zápas ID ${matchId} byl manuálně ${match.locked ? 'UZAMČEN' : 'ODEMČEN'}`);
    res.redirect('/admin');
});

router.get('/playoff/templates', requireAdmin, (req, res) => {
    const tplPath = './data/playoffTemplates.json';
    const templates = fs.existsSync(tplPath) ? JSON.parse(fs.readFileSync(tplPath, 'utf8')) : {};

    res.send(`
        <!DOCTYPE html>
        <html lang="cs">
        <head><meta charset="UTF-8">
        <title>Editor formátů</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png"/>
        </head>
        <body class="admin_site">
            <h1>Editor formátů playoff</h1>
            <div style="background: #1a1a1a; padding: 20px; border: 1px solid #333;">
                <form action="/admin/playoff/templates/save" method="POST">
                    <label>Kód formátu (bez mezer, např. spengler_6): <input type="text" name="key" required class="league-select"></label><br><br>
                    <label>Název (pro lidi): <input type="text" name="label" required class="league-select"></label><br><br>
                    <label>JSON struktura sloupců (viz manuál):<br>
                        <textarea name="structure" style="width:100%; height:200px; background:#000; color:lime; font-family:monospace;">[
  { "title": "Čtvrtfinále", "slots": ["qf1", "qf2"], "gap": "60px" },
  { "title": "Semifinále", "slots": ["sf1", "sf2"], "gap": "30px" },
  { "title": "Finále", "slots": ["fin"], "gap": "30px" }
]</textarea>
                    </label><br>
                    <button type="submit" class="action-btn edit-btn">Uložit nový formát</button>
                </form>
            </div>
            <a href="/admin/playoff">← Zpět na Playoff</a>
            <h3>Stávající formáty:</h3>
            <pre style="color: gray;">${JSON.stringify(templates, null, 2)}</pre>
        </body></html>
    `);
});

router.post('/playoff/templates/save', requireAdmin, (req, res) => {
    const { key, label, structure } = req.body;
    const tplPath = './data/playoffTemplates.json';
    let templates = fs.existsSync(tplPath) ? JSON.parse(fs.readFileSync(tplPath, 'utf8')) : {};

    try {
        templates[key] = { label, columns: JSON.parse(structure) };
        fs.writeFileSync(tplPath, JSON.stringify(templates, null, 2));
        res.redirect('/admin/playoff/templates');
    } catch (e) {
        res.status(400).send("Chyba v JSON struktuře!");
    }
});

module.exports = router;