const fs = require("fs");
const { Users, Matches, Teams, Leagues, AllowedLeagues, ChosenSeason, Settings, TeamBonuses, LeagueStatus, TableTips, Playoff, PlayoffTemplates, TransferLeagues, Transfers, Tips } = require('../utils/mongoDataAccess');
const express = require("express");
const router = express.Router();
const path = require('path');
require('axios');
require('cheerio');
const multer = require('multer');
const notif = require('./notificationService');
const bcrypt = require("bcrypt");
const {
    requireAdmin,
    updateTeamsPoints,
    evaluateAndAssignPoints,
    generateSeasonRange,
    removeTipsForDeletedMatch,
    renameLeagueGlobal,
    evaluateRegularSeasonTable,
    renderErrorHtml,
    logAdminAction,
    getAvailableImages,
} = require("../utils/fileUtils");
const { fetchMatchesFromLivesport } = require('../utils/livesportService');
const { 
    scanImageHashes, 
    findDuplicates, 
    checkNewFileDuplicate,
    syncImageHashesToDatabase 
} = require('../utils/imageUtils');
router.post('/backup', async (req, res) => {
    try {
        await backupJsonFilesToGitHub();
        res.json({ success: true, message: '✅ Záloha provedena' });
        await logAdminAction(req.session.user, "ZÁLOHA_DAT", `Spuštěna manuální záloha na GitHub`);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '❌ Chyba při záloze' });
    }
});
const storage = multer.diskStorage({
    'destination': function (req, file, cb) {
        const uploadPath = path.resolve(__dirname, '..', 'data', 'images');
        const fs = require('fs');
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
router.get('/', requireAdmin, async (req, res) => {
    // Načtení všech dat z MongoDB
    const [matches, teams, transferLeagues, allowedLeagues, allSeasonData, chosenSeason, settingsData] = await Promise.all([
        Matches.findAll(),
        Teams.findAll(),
        TransferLeagues.findAll(),
        AllowedLeagues.findAll(),
        Leagues.findAll(),
        ChosenSeason.findAll(),
        Settings.findAll()
    ]);
    
    const selectedSeason = chosenSeason;
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];
    
    const chosenSeasonValue = chosenSeason;

    let clinchMode = 'strict';
    if (settingsData && settingsData.clinchMode) clinchMode = settingsData.clinchMode;

    // Filter teams and matches by chosenSeason - admin sees all teams from current season (active and inactive)
    const teamsFromCurrentSeason = teams.filter(t => t.season === chosenSeason);
    const matchesFromCurrentSeason = matches.filter(m => m.season === chosenSeason);

    const leaguesFromMatches = [...new Set(matchesFromCurrentSeason.map(m => m.liga))];
    const leaguesFromTeams = [...new Set(teamsFromCurrentSeason.map(t => t.liga))];
    const leaguesFromLeagues = [... new Set(leagues.map(t => t.name))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches, ...leaguesFromLeagues])];
    const currentYear = new Date().getFullYear();
    const seasonsFromTeams = teams.map(t => t.season).filter(Boolean);
    const seasonsFromMatches = matches.map(m => m.season).filter(Boolean);

    const knownSeasons = [...seasonsFromTeams, ...seasonsFromMatches];
    const futureSeasons = await generateSeasonRange(currentYear, 10);

    const allSeasons = [...new Set([...futureSeasons, ...knownSeasons])];
    allSeasons.sort();

    const uniqueLeagues = allLeagues.filter(l => leaguesFromLeagues.includes(l));

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga)
        ? req.query.liga
        : uniqueLeagues[0] || allLeagues[0];
    const teamsByLeague = {};
    teamsFromCurrentSeason.forEach(team => {
        if (!teamsByLeague[team.liga]) teamsByLeague[team.liga] = [];
        teamsByLeague[team.liga].push(team);
    });
    const teamsByGroup = {};
    teamsFromCurrentSeason.forEach(team => {
        if (team.liga === selectedLiga) {
            if (!teamsByGroup[team.group]) teamsByGroup[team.group] = [];
            teamsByGroup[team.group].push(team);
        }
    });

    const selectedSeasonQuery = req.query.season && allSeasons.includes(req.query.season)
        ? req.query.season
        : chosenSeason || 'Neurčeno';

    const filteredMatches = matchesFromCurrentSeason.filter(m =>
        m.liga === selectedLiga && (m.season || 'Neurčeno') === selectedSeasonQuery
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Admin - Správa zápasů</title>
  <link rel="stylesheet" href="/css/styles.css" />
  <link rel="icon" href="/images/logo.png">
</head>
<header class="header">
  <div class="logo_title"><img class="image_logo" src="/images/logo.png" alt="Logo"><h1 id="title">Tipovačka</h1></div>
  <a href="/">← Zpět na hlavní stránku</a>
</header>
<body class="usersite">
<main class="admin_site">
  <div class="admin-header">
    <div class="admin-title">
      <h1>🛠️ Admin Panel</h1>
      <p class="admin-subtitle">Správa aplikace TELH Tipovačka</p>
    </div>
    
    <!-- Nastavení aplikace - integrované všechny funkce v grid layoutu -->
    <div class="settings-card">
      <div class="card-header">
        <h3>⚙️ Nastavení aplikace</h3>
      </div>
      <div class="card-body">
        <div class="settings-grid">
          <!-- Registrace -->
          <div class="setting-item">
            <div class="setting-info">
              <label id="registrationLabel" class="setting-label">Registrace nových uživatelů</label>
              <span id="registrationStatus" class="setting-description">
                ${settingsData && settingsData.registrationsBlocked ? 'Noví uživatelé se nemohou registrovat' : 'Noví uživatelé se mohou registrovat'}
              </span>
            </div>
            <button id="toggleRegistrations" class="btn ${settingsData && settingsData.registrationsBlocked ? 'btn-danger' : 'btn-success'} btn-lg">
              ${settingsData && settingsData.registrationsBlocked ? '🔒 BLOKOVÁNY' : '🔓 POVOLENY'}
            </button>
          </div>
          
          <!-- Vybraná sezóna -->
          <div class="setting-item">
            <div class="setting-info">
              <label id="seasonLabel" class="setting-label">📅 Vybraná sezóna</label>
              <span class="setting-description">Aktuální sezóna pro celou aplikaci</span>
            </div>
            <form method="POST" action="/admin/season" style="display: flex; align-items: center; gap: 10px;">
              <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
              <select id="season-select" class="modern-select" name="season" style="width: 150px;">
                ${allSeasons.map(s => `<option value="${s}" ${s === chosenSeasonValue ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
              <button type="submit" class="btn btn-primary">💾 Uložit</button>
            </form>
          </div>
          
          <!-- Veřejné ligy -->
          <div class="setting-item">
            <div class="setting-info">
              <label id="publicLeaguesLabel" class="setting-label">🏆 Veřejné ligy</label>
              <span class="setting-description">Ligy viditelné pro uživatele</span>
            </div>
            <form method="POST" action="/admin/leagues/visibility" style="display: flex; flex-direction: column; gap: 10px;">
              <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
              <div class="leagues-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px;">
                ${allLeagues.map(l => `
                  <label style="display: flex; align-items: center; gap: 6px; font-size: 0.9em;">
                    <input type="checkbox" name="allowedLeagues" value="${l}" ${allowedLeagues.includes(l) ? 'checked' : ''}/>
                    <span>${l}</span>
                  </label>
                `).join('')}
              </div>
              <button type="submit" class="btn btn-primary">🔓 Uložit viditelnost</button>
            </form>
          </div>
          
          <!-- Ligy s přestupy -->
          <div class="setting-item">
            <div class="setting-info">
              <label id="transfersLeaguesLabel" class="setting-label">💰 Ligy s přestupy</label>
              <span class="setting-description">Ligy s aktivním přestupovým oknem</span>
            </div>
            <form method="POST" action="/admin/leagues/transfers" style="display: flex; flex-direction: column; gap: 10px;">
              <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
              <div class="leagues-grid" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px;">
                ${allLeagues.map(l => `
                  <label style="display: flex; align-items: center; gap: 6px; font-size: 0.9em;">
                    <input type="checkbox" name="transferLeagues" value="${l}" ${transferLeagues.includes(l) ? 'checked' : ''}/>
                    <span>${l}</span>
                  </label>
                `).join('')}
              </div>
              <button type="submit" class="btn btn-primary">💸 Uložit přestupy</button>
            </form>
          </div>
          
          <!-- Logika zamykání tabulky -->
          <div class="setting-item">
            <div class="setting-info">
              <label id="clinchLogicLabel" class="setting-label">🔒 Logika zamykání tabulky</label>
              <span class="setting-description">Jak se týmy obarvují při zamykání pozic</span>
            </div>
            <form method="POST" action="/admin/settings/clinch" style="display: flex; flex-direction: column; gap: 10px;">
              <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
              <div style="display: flex; flex-direction: column; gap: 8px;">
                <label style="display: flex; align-items: center; gap: 8px;">
                  <input type="radio" name="mode" value="strict" ${clinchMode === 'strict' ? 'checked' : ''} />
                  <div>
                    <strong>Striktní (Doporučeno)</strong>
                    <span style="display:block; font-size: 0.8em; color: gray;">Tým se obarví až když je pevně uzamčen ve svém patře.</span>
                  </div>
                </label>
                <label style="display: flex; align-items: center; gap: 8px;">
                  <input type="radio" name="mode" value="cascade" ${clinchMode === 'cascade' ? 'checked' : ''} />
                  <div>
                    <strong>Kaskádové (Nejvyšší meta)</strong>
                    <span style="display:block; font-size: 0.8em; color: gray;">Tým se obarví barvou nejvyššího patra, pod který už nemůže slézt.</span>
                  </div>
                </label>
              </div>
              <button type="submit" class="btn btn-primary">🔐 Uložit logiku</button>
            </form>
          </div>
        </div>
      </div>
    </div>
    
    <!-- Navigační karty - nové pořadí -->
    <div class="admin-nav">
      <div class="nav-section">
        <h3>⚽ Zápasy a týmy</h3>
        <div class="nav-buttons">
          <a href="/admin/new/match" class="btn btn-primary">🆕 Nový zápas</a>
          <a href="/admin/new/team" class="btn btn-primary">👥 Nový tým</a>
          <a href="/admin/matches/import" class="btn btn-secondary">📥 Import zápasů</a>
          <a href="/admin/teams/points" class="btn btn-secondary">📊 Manuální body</a>
        </div>
      </div>
      
      <div class="nav-section">
        <h3>🏆 Playoff a ligy</h3>
        <div class="nav-buttons">
          <a href="/admin/playoff" class="btn btn-primary">🏆 Playoff tabulky</a>
          <a href="/admin/playoff/templates" class="btn btn-secondary">📋 Playoff Templaty</a>
          <a href="/admin/leagues/manage" class="btn btn-secondary">⚙️ Správa lig</a>
        </div>
      </div>
      
      <div class="nav-section">
        <h3>👤 Uživatelé a obsah</h3>
        <div class="nav-buttons">
          <a href="/admin/users" class="btn btn-primary">👥 Správa uživatelů</a>
          <a href="/admin/images/manage" class="btn btn-secondary">🖼️ Správce obrázků</a>
          <a href="/admin/transfers/manage" class="btn btn-secondary">💰 Správa přestupů</a>
        </div>
      </div>
      
      <div class="nav-section">
        <h3>🔔 Systém a notifikace</h3>
        <div class="nav-buttons">
          <a href="/admin/broadcast-ping" class="btn btn-secondary">📢 Test notifikace</a>
          <a href="/api/versions/manage" class="btn btn-secondary">📋 Správa verzí</a>
          <a href="/admin/transfer-data" class="btn btn-warning">🔄 Převod dat z minulého roku</a>
          <a href="/admin/fix-team-seasons" class="btn btn-info">🔧 Opravit sezóny týmů</a>
          <a id="backupBtn" class="btn btn-warning">💾 Záloha dat do JSONů</a>
          <a id="verifyStatsBtn" class="btn btn-danger">🔍 Kontrola statistik</a>
        </div>
      </div>
    </div>
  </div>
  
  <form class="league-dropdown-modern" method="GET" action="/admin/">
    <div class="filter-group">
      <label class="filter-label">Liga:</label>
      <select class="league-select" name="liga" required onchange="this.form.submit()">
        ${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="filter-group">
      <label class="filter-label">Sezóna:</label>
      <select class="league-select" name="season" onchange="this.form.submit()">
        ${allSeasons.map(s => `<option value="${s}" ${s === selectedSeason ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="filter-group" style="margin-left: 20px; border-left: 2px solid orangered; padding-left: 15px;">
      <label class="filter-label">⚙️ Hromadné akce:</label>
      <a href="/admin/matches/bulk-lock" class="btn btn-secondary">
        🔒 Lock/Unlock zápasů
      </a>
      <a href="/admin/matches/bulk-lock" class="btn btn-danger" style="background: #8B0000; border-color: #ff0000; margin-left: 5px;">
        🗑️ Smazat nevyhodnocené
      </a>
    </div>
  </form>
  
  <section class="matches-section">
    <div class="section-card">
      <div class="section-header">
        <h2>⚽ Nevyhodnocené zápasy <span class="badge">${pendingMatches.length}</span></h2>
      </div>
      <div class="table-container">
        <table class="modern-table">
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
        <td><span class="id-badge">${m.id}</span></td>
         <td><span class="team-name">${homeTeam}</span></td>
         <td><span class="team-name">${awayTeam}</span></td>
         <td><span class="date-time">${formattedDate}</span></td>
         <td><span class="result finished">${result}</span></td>
        <td>
          <div class="action-buttons">
            <a href="/admin/edit/${m.id}" class="btn btn-sm btn-primary">✏️</a>
            <form action="/admin/delete/${m.id}" method="POST" style="display:inline;" onsubmit="return confirm('Opravdu smazat zápas?');">
              <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
              <button type="submit" class="btn btn-sm btn-danger">🗑️</button>
            </form>
            <a href="/admin/togglePostponed/${m.id}" 
                class="btn btn-sm ${m.postponed ? 'btn-warning' : 'btn-secondary'}">
                ${m.postponed ? '⏰' : '⏸️'}
            </a>
          </div>
        </td>
      </tr>
    `;
    }

    html += `
          </tbody>
        </table>
      </div>
    </div>
    
    <!-- Hotové zápasy -->
    <div class="section-card"">
      <div class="section-header">
        <h2>✅ Vyhodnocené zápasy <span class="badge">${finishedMatches.length}</span></h2>
        <button type="button" class="btn btn-sm btn-secondary toggle-details" onclick="this.closest('.section-card').classList.toggle('expanded')">
          📊 Zobrazit/Skrýt
        </button>
      </div>
      <div class="table-container" style="display: none;">
        <table class="modern-table">
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
          <td><span class="id-badge">${m.id}</span></td>
          <td><span class="team-name">${homeTeam}</span></td>
          <td><span class="team-name">${awayTeam}</span></td>
          <td><span class="date-time">${formattedDate}</span></td>
          <td><span class="result finished">${result}</span></td>
          <td>
            <div class="action-buttons">
              <a href="/admin/edit/${m.id}" class="btn btn-sm btn-primary">✏️</a>
              <form action="/admin/delete/${m.id}" method="POST" style="display:inline;" onsubmit="return confirm('Opravdu smazat zápas?');">
                <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                <button type="submit" class="btn btn-sm btn-danger">🗑️</button>
              </form>
            </div>
          </td>
        </tr>
      `;
    }

    html += `
        </tbody>
      </table>
    </details>
    </div>
  </div>
    <div class="section-card">
      <div class="card-header">
        <h3>👥 Správa týmů</h3>
      </div>
      <div class="card-body-teams">
        <div class="teams-grid">
          ${leaguesFromLeagues.map(liga => {
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

            return `
                <div class="league-column">
                    <h4>${liga}</h4>
                    <div class="teams-list">
                        ${activeTeams.length > 0 ? `
                            <strong style="color: #28a745;">Aktivní</strong>
                            ${activeTeams.map(team => `
                                <a href="/admin/teams/edit/${team.id}" class="team-link">
                                    ${leagueObj?.isMultigroup === true ? `${String.fromCharCode(team.group+64)} - ${team.name}` : team.name}
                                </a>
                            `).join('')}
                        ` : ''}
                        ${inactiveTeams.length > 0 ? `
                            <strong style="color: #dc3545;">Neaktivní</strong>
                            ${inactiveTeams.map(team => `
                                <a href="/admin/teams/edit/${team.id}" class="team-link inactive">
                                    ${leagueObj?.isMultigroup === true ? `${String.fromCharCode(team.group+64)} - ${team.name}` : team.name}
                                </a>
                            `).join('')}
                        ` : ''}
                    </div>
                </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  </div>
  
  <p><a href="/" style="margin-top: 20px; display: inline-block;" class="btn btn-secondary">← Zpět na hlavní stránku</a></p>
</main>
</body>
<script>
document.getElementById('backupBtn').addEventListener('click', async () => {
  const res = await fetch('/admin/backup', { method: 'POST' });
  const data = await res.json();
  alert(data.message);
});

// Funkce pro přepínání registrací
async function toggleRegistrations() {
    const btn = document.getElementById('toggleRegistrations');
    const status = document.getElementById('registrationStatus');
    
    btn.disabled = true;
    btn.textContent = 'Pracuji...';
    
    try {
        const csrfToken = document.querySelector('input[name="_csrf"]')?.value || '';
        const response = await fetch('/admin/toggle-registrations', { 
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: '_csrf=' + encodeURIComponent(csrfToken)
        });
        const result = await response.json();
        
        if (result.success) {
            if (result.blocked) {
                btn.className = 'btn btn-danger btn-lg';
                btn.textContent = '🔒 BLOKOVÁNY';
                status.textContent = 'Noví uživatelé se nemohou registrovat';
            } else {
                btn.className = 'btn btn-success btn-lg';
                btn.textContent = '🔓 POVOLENY';
                status.textContent = 'Noví uživatelé se mohou registrovat';
            }
            alert(result.message);
        } else {
            alert('Chyba: ' + result.message);
        }
    } catch (error) {
        alert('Chyba při komunikaci se serverem: ' + error.message);
    }
    
    btn.disabled = false;
}

// Funkce pro kontrolu a opravu statistik
async function verifyStats() {
    const btn = document.getElementById('verifyStatsBtn');
    const selectedLiga = document.querySelector('select[name="liga"]').value;
    const selectedSeason = document.querySelector('select[name="season"]').value;
    
    if (!selectedLiga || !selectedSeason) {
        alert('Prosím vyberte ligu a sezónu pro kontrolu statistik.');
        return;
    }
    
    if (!confirm(\`Opravdu chcete spustit kontrolu a opravu statistik pro \${selectedLiga} - \${selectedSeason}?\\n\\nTato akce přepočítá všechny statistiky uživatelů pro vybranou ligu a sezónu.\`)) {
        return;
    }
    
    btn.disabled = true;
    btn.textContent = '🔄 Kontroluji...';
    
    try {
        const response = await fetch('/admin/verify-stats', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: \`season=\${encodeURIComponent(selectedSeason)}&liga=\${encodeURIComponent(selectedLiga)}\`
        });
        
        const result = await response.json();
        
        if (result.success) {
            btn.className = 'btn btn-success';
            btn.textContent = '✅ Hotovo';
            alert(result.message);
            
            // Obnovit stránku po 2 sekundách
            setTimeout(() => {
                window.location.reload();
            }, 2000);
        } else {
            btn.className = 'btn btn-danger';
            btn.textContent = '❌ Chyba';
            alert('Chyba: ' + result.message);
        }
    } catch (error) {
        btn.className = 'btn btn-danger';
        btn.textContent = '❌ Chyba';
        alert('Chyba při komunikaci se serverem: ' + error.message);
    }
    
    // Obnovit původní stav tlačítka po 5 sekundách
    setTimeout(() => {
        btn.disabled = false;
        btn.className = 'btn btn-danger';
        btn.textContent = '🔍 Kontrola statistik';
    }, 5000);
}

// Přidání event listeneru
document.addEventListener('DOMContentLoaded', () => {
    const toggleBtn = document.getElementById('toggleRegistrations');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', toggleRegistrations);
    }
    
    // Přidání event listeneru pro kontrolu statistik
    const verifyStatsBtn = document.getElementById('verifyStatsBtn');
    if (verifyStatsBtn) {
        verifyStatsBtn.addEventListener('click', verifyStats);
    }
    
    // Přidání animací pro tlačítka
    document.querySelectorAll('.btn').forEach(btn => {
        btn.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-2px)';
        });
        btn.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0)';
        });
    });
});

// Funkce pro hromadný unlock/lock tabulky
async function toggleBulkLock() {
    const btn = document.getElementById('bulkLockBtn');
    const selectedLiga = document.querySelector('select[name="liga"]').value;
    const selectedSeason = document.querySelector('select[name="season"]').value;
    
    if (!selectedLiga || !selectedSeason) {
        alert('Prosím vyberte ligu a sezónu.');
        return;
    }
    
    const confirmMsg = 'Opravdu chcete změnit stav zamčení tabulky pro ' + selectedLiga + ' - ' + selectedSeason + '?\\n\\nToto zamkne nebo odemkne tipování tabulky pro všechny skupiny v této lize.';
    if (!confirm(confirmMsg)) {
        return;
    }
    
    btn.disabled = true;
    btn.textContent = '🔄 Pracuji...';
    
    try {
        const csrfToken = document.querySelector('input[name="_csrf"]').value;
        const bodyParams = 'season=' + encodeURIComponent(selectedSeason) + '&liga=' + encodeURIComponent(selectedLiga) + '&_csrf=' + encodeURIComponent(csrfToken);
        const response = await fetch('/admin/toggle-bulk-lock', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: bodyParams
        });
        
        const result = await response.json();
        
        if (result.success) {
            btn.textContent = '✅ Hotovo';
            alert(result.message);
            setTimeout(function() {
                window.location.reload();
            }, 1000);
        } else {
            btn.className = 'btn btn-danger';
            btn.textContent = '❌ Chyba';
            alert('Chyba: ' + result.message);
            btn.disabled = false;
            btn.className = 'btn btn-warning';
            btn.textContent = '🔄 Hromadně zamknout/odemknout';
        }
    } catch (error) {
        btn.className = 'btn btn-danger';
        btn.textContent = '❌ Chyba';
        alert('Chyba při komunikaci se serverem: ' + error.message);
        btn.disabled = false;
        btn.className = 'btn btn-warning';
        btn.textContent = '🔄 Hromadně zamknout/odemknout';
    }
}
</script>
</html>
`;

    res.send(html);
});

// Endpoint pro přepínání registrací
router.post('/toggle-registrations', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    try {
        // CSRF kontrola
        if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
            return res.status(403).json({ 
                success: false, 
                message: 'Neplatný CSRF token' 
            });
        }
        
        // Načtení aktuálních nastavení
        let settings = await Settings.findAll();
        
        // Ošetření případu kdy settings neexistuje nebo je null
        if (!settings) {
            settings = {};
        }
        
        // Přepnutí stavu - pokud registrationsBlocked není definováno, použijeme false (povoleno)
        const currentBlockedState = settings.registrationsBlocked === true;
        const newBlockedState = !currentBlockedState;
        
        // Aktualizace v MongoDB
        await Settings.updateOne({}, { registrationsBlocked: newBlockedState }, { upsert: true });
        
        // Logování akce
        await logAdminAction(req.session.user, "TOGGLE_REGISTRATIONS",
            `Registrace ${newBlockedState ? 'BLOKOVÁNY' : 'POVOLENY'}`);
        
        res.json({ 
            success: true, 
            blocked: newBlockedState,
            message: `Registrace byly úspěšně ${newBlockedState ? 'blokovány' : 'povoleny'}!`
        });
    } catch (error) {
        console.error('Chyba při přepínání registrací:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Chyba serveru při změně nastavení: ' + (error.message || 'Neznámá chyba')
        });
    }
});

// Endpoint pro hromadný lock/unlock tabulky
router.post('/toggle-bulk-lock', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    try {
        // CSRF kontrola
        if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
            return res.status(403).json({ 
                success: false, 
                message: 'Neplatný CSRF token' 
            });
        }
        
        const { season, liga } = req.body;
        
        if (!season || !liga) {
            return res.status(400).json({
                success: false,
                message: 'Chybí sezóna nebo liga.'
            });
        }
        
        // Načtení aktuálního stavu
        const statusData = await LeagueStatus.findAll();
        const currentSeasonData = statusData?.[season] || {};
        const currentLigaData = currentSeasonData?.[liga] || {};
        const currentLockStatus = currentLigaData?.tableTipsLocked || false;
        
        // Přepnutí stavu - true (zamčeno) ↔ false (odemčeno)
        const newLockStatus = currentLockStatus !== true;
        
        // Aktualizace v MongoDB
        const updateObj = {};
        updateObj[`${season}.${liga}.tableTipsLocked`] = newLockStatus;
        
        const { getDatabase } = require('../config/database');
        const db = await getDatabase();
        const collection = db.collection('leagueStatus');
        
        await collection.updateOne(
            {},
            { $set: updateObj },
            { upsert: true }
        );
        
        // Logování akce
        await logAdminAction(req.session.user, "BULK_LOCK_TOGGLE",
            `Tabulka ${liga} - ${season}: ${newLockStatus ? 'ZAMČENO' : 'ODEMČENO'}`);
        
        res.json({
            success: true,
            locked: newLockStatus,
            message: `Tipování tabulky pro ${liga} - ${season} bylo ${newLockStatus ? 'ZAMČENO' : 'ODEMČENO'}.`
        });
        
    } catch (error) {
        console.error('Chyba při hromadném zamykání:', error);
        res.status(500).json({
            success: false,
            message: 'Chyba serveru: ' + (error.message || 'Neznámá chyba')
        });
    }
});

router.post('/leagues', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const ligaName = req.body.name?.trim();
    if (!ligaName) return renderErrorHtml(res, "Název ligy je povinný.", 400);

    // Načtení z MongoDB
    const [chosenSeason, allSeasonData] = await Promise.all([
        ChosenSeason.findAll(),
        Leagues.findAll()
    ]);
    
    const selectedSeason = chosenSeason;
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
    
    // Uložení do MongoDB
    allSeasonData[selectedSeason].leagues = leagues;
    await Leagues.replaceAll(allSeasonData);
    
    res.redirect('/admin/leagues/manage');
});

router.post('/leagues/visibility', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    let ligaNames = req.body.allowedLeagues || [];
    if (!Array.isArray(ligaNames)) ligaNames = [ligaNames];

    // Uložení POUZE zaškrtnutých lig (ne přidávání ke stávajícím)
    await AllowedLeagues.replaceAll(ligaNames);

    res.redirect('/admin');
})

router.get('/teams/edit/:id', requireAdmin, async (req, res) => {
    const teamId = parseInt(req.params.id);
    const teams = await Teams.findAll();

    const team = teams.find(t => t.id === teamId);
    if (!team) return renderErrorHtml(res, "Tým s tímto ID nebyl nalezen.", 404);
    
    const [chosenSeason, allSeasonData] = await Promise.all([
        ChosenSeason.findAll(),
        Leagues.findAll()
    ]);
    
    const selectedSeason = chosenSeason;
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
  <form style="display: flex; flex-direction: row; gap: 10px; margin-bottom: 10px" action="/admin/teams/edit/${team.id}?_csrf=${req.session.csrfToken || ''}" method="POST" enctype="multipart/form-data">
    <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
    <label style="display: flex; flex-direction: column" for="name">Název týmu
      <input autocomplete="off" style="width: 220px" class="league-select" type="text" id="name" name="name" value="${team.name}" required />
    </label>
    <label style="display: flex; flex-direction: column" for="logo">Logo týmu
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <input style="width: 220px" class="league-select" type="file" id="logo" name="logo" accept="image/*" />
        <input type="hidden" name="selectedLogo" id="selectedLogo" value="">
        <button type="button" class="btn btn-secondary" style="padding: 5px 10px; font-size: 0.85em;" onclick="openImageSelector('selectedLogo', 'logoPreview')">🖼️ Vybrat z galerie</button>
      </div>
      ${team.logo ? `<small style="color: gray;">Aktuální: ${team.logo}</small>` : ''}
      <img id="logoPreview" src="${team.logo ? `/logoteamu/${team.logo}` : ''}" style="width: 60px; height: 60px; object-fit: contain; margin-top: 5px; ${team.logo ? '' : 'display: none;'}"  alt=""/>
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
    <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
            <button type="submit" class="action-btn delete-btn">Smazat tým</button>
  </form>
  <a href="/admin" class="back-link">← Zpět na seznam týmů</a>
</main>
<script>
// Otevře popup pro výběr obrázku
function openImageSelector(hiddenInputId, previewId) {
    const popup = window.open(
        '/admin/images/selector?callback=' + hiddenInputId + '&preview=' + previewId,
        'imageSelector',
        'width=900,height=700,scrollbars=yes,resizable=yes,top=100,left=100'
    );
    
    if (!popup || popup.closed || typeof popup.closed === 'undefined') {
        alert('Popup byl zablokován. Povolte popup okna pro tento web.');
    }
}

// Posluchač pro zprávu z popup okna
window.addEventListener('message', function(event) {
    if (event.data && event.data.type === 'imageSelected') {
        const { filename, path, callbackField, previewId } = event.data;
        
        // Nastavit hidden input
        const hiddenInput = document.getElementById(callbackField);
        if (hiddenInput) {
            hiddenInput.value = filename;
        }
        
        // Zobrazit náhled
        const preview = document.getElementById(previewId);
        if (preview) {
            preview.src = path;
            preview.style.display = 'block';
        }
        
        // Vyčistit file input (pokud je vybrán existující, nový soubor se nepoužije)
        const fileInput = document.querySelector('input[type="file"][name="logo"]');
        if (fileInput) {
            fileInput.value = '';
        }
    }
});
</script>
</body>
</html>
    `;

    res.send(html);
});

router.post('/edit/:id', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const matchId = parseInt(req.params.id);
    const matches = await Matches.findAll();

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
        await removeTipsForDeletedMatch(matchId);
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
            const swap = req.body[`match_${i}_swap`] === 'true';

            if (h !== '' && a !== '' && h !== undefined && a !== undefined) {
                const sH = parseInt(h);
                const sA = parseInt(a);
                match.playedMatches.push({ scoreHome: sH, scoreAway: sA, ot, sideSwap: swap });

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
                await notif.notifySeriesProgress(match, match.playedMatches.length, lastM.scoreHome, lastM.scoreAway, lastM.ot, seriesHomeWins, seriesAwayWins, match.playedMatches);
            }
        }
    } else {
        // --- OPRAVA: ZDE CHYBĚLO ULOŽENÍ VÝSLEDKU BĚŽNÉHO ZÁPASU ---
        if (scoreHome !== '' && scoreAway !== '' && scoreHome !== undefined && scoreAway !== undefined) {
            match.result = {
                scoreHome: parseInt(scoreHome),
                scoreAway: parseInt(scoreAway),
                ot: req.body.ot === 'on'
            };
        } else {
            delete match.result;
        }
    }

    // Uložení do MongoDB
    await Matches.replaceAll(matches);

    // 3. NOTIFIKAČNÍ DETEKTIV - Kontrola změn (Pokud NENÍ zadaný výsledek)
    if (!match.result) {
        let changes = [];

        if (oldDatetime !== match.datetime) {
            const [datePart, timePart] = match.datetime.split('T');
            const [year, month, day] = datePart.split('-');
            const hezkyCas = `${day}. ${month}. ${year} v ${timePart}`;
            changes.push(`Nový čas: ${hezkyCas}`);
        }

        if (!oldPostponed && match.postponed) {
            changes.push('Zápas byl odložen');
        } else if (oldPostponed && !match.postponed) {
            changes.push('Zápas již není odložen');
        }

        if (changes.length > 0) {
            await notif.notifyMatchUpdate(match.id, changes.join(' | '));
        }
    }

    try {
        if (season && liga) {
            await updateTeamsPoints(matches);
            await evaluateAndAssignPoints(liga, matches[matchIndex].season);
            await evaluateRegularSeasonTable(season, liga);

            // 4. Odeslání výsledku (POUZE pokud má zápas výsledek)
            if (match.result) {
                // --- OPRAVA: POSÍLÁME ULOŽENÝ VÝSLEDEK, NIKOLIV SUROVÁ DATA Z FORMULÁŘE ---
                await notif.notifyResult(matchId, match.result.scoreHome, match.result.scoreAway);
            }
        }
    } catch (err) {
        console.error("Chyba při přepočtech, nebyla odeslána sezóna nebo liga", err);
    }

    await logAdminAction(req.session.user, "ÚPRAVA_ZÁPASU", `Upraven zápas ID: ${matchId} (Liga: ${match.liga})`);
    res.redirect('/admin');
});

router.get('/new/match', requireAdmin, async (req, res) => {
    const chosenSeason = await ChosenSeason.findAll();
    const teams = (await Teams.findAll()).filter(t => t.active === true && t.season === chosenSeason);
    const matches = await Matches.findAll();

    const seasonsFromTeams = teams.map(t => t.season).filter(Boolean);
    const seasonsFromMatches = matches.map(m => m.season).filter(Boolean);

    const knownSeasons = [...seasonsFromTeams, ...seasonsFromMatches];
    const currentYear = new Date().getFullYear();
    const futureSeasons = await generateSeasonRange(currentYear, 10);

    const allSeasons = [...new Set([...futureSeasons, ...knownSeasons])];
    allSeasons.sort();

    // 1. Získáme unikátní ligy pro filtr
    const uniqueLeagues = [...new Set(teams.map(t => t.liga))].sort();

    const html = `
        <!DOCTYPE html>
    <html lang="cs">
        <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
                <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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

router.post('/new/match', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { homeTeamId, awayTeamId, datetime, season, isPlayoff, bo, locked, matchLiga, isBaraz } = req.body;

    let matches = await Matches.findAll();
    const teams = (await Teams.findAll()).filter(t => t.active === true && t.season === season);
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
    await notif.notifyNewMatches();
    
    // Uložení do MongoDB
    await Matches.replaceAll(matches);
    
    await logAdminAction(req.session.user, "NOVÝ_ZÁPAS", `Vytvořen nový zápas: ${homeTeam.name} vs ${awayTeam.name} (${finalLiga})`);
    res.redirect('/admin');
});


router.get('/new/team', requireAdmin, async (req, res) => {
    const selectedSeason = await ChosenSeason.findAll();
    const allSeasonData = await Leagues.findAll();
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
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
    <form style="display: flex; flex-direction: row; gap: 10px" method="POST" action="/admin/new/team?_csrf=${req.session.csrfToken || ''}" enctype="multipart/form-data">
      <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
      <label style="display: flex; flex-direction: column;">Název týmu: <input style="width: 220px" class="league-select" autocomplete="off" type="text" name="name" required></label>
      <label style="display: flex; flex-direction: column;">Logo týmu:
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <input style="width: 220px" class="league-select" type="file" name="logo" accept="image/*" id="logoFile">
          <input type="hidden" name="selectedLogo" id="selectedLogoNew" value="">
          <button type="button" class="btn" style="background: #666; padding: 5px 10px; font-size: 0.85em; width: 220px;" onclick="openImageSelector('selectedLogoNew', 'logoPreviewNew')">🖼️ Vybrat z galerie</button>
        </div>
        <img id="logoPreviewNew" src="" style="width: 60px; height: 60px; object-fit: contain; margin-top: 5px; display: none;"  alt=""/>
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
    
    // Otevře popup pro výběr obrázku
    function openImageSelector(hiddenInputId, previewId) {
        const popup = window.open(
            '/admin/images/selector?callback=' + hiddenInputId + '&preview=' + previewId,
            'imageSelector',
            'width=900,height=700,scrollbars=yes,resizable=yes,top=100,left=100'
        );
        
        if (!popup || popup.closed || typeof popup.closed === 'undefined') {
            alert('Popup byl zablokován. Povolte popup okna pro tento web.');
        }
    }
    
    // Posluchač pro zprávu z popup okna
    window.addEventListener('message', function(event) {
        if (event.data && event.data.type === 'imageSelected') {
            const { filename, path, callbackField, previewId } = event.data;
            
            // Nastavit hidden input
            const hiddenInput = document.getElementById(callbackField);
            if (hiddenInput) {
                hiddenInput.value = filename;
            }
            
            // Zobrazit náhled
            const preview = document.getElementById(previewId);
            if (preview) {
                preview.src = path;
                preview.style.display = 'block';
            }
            
            // Vyčistit file input (pokud je vybrán existující, nový soubor se nepoužije)
            const fileInput = document.getElementById('logoFile');
            if (fileInput) {
                fileInput.value = '';
            }
        }
    });
    </script>
    </html>
  `);
});

router.post('/new/team', express.urlencoded({ extended: true }), requireAdmin, upload.single('logo'), async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const teams = await Teams.findAll();
    let {name, liga, active} = req.body;
    active = active === 'on';

    const inputName = name.trim().toLowerCase();
    const inputLiga = liga.trim().toLowerCase();
    const logoFilename = req.file ? req.file.filename : (req.body.selectedLogo || '');

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

    // Uložení do MongoDB
    await Teams.replaceAll(teams);
    
    await logAdminAction(req.session.user, "NOVÝ_TÝM", `Vytvořen nový tým: ${name} (${liga})`);
    res.redirect('/admin');
});

router.get('/edit/:id', requireAdmin, async (req, res) => {
    const matchId = parseInt(req.params.id);
    let matches = await Matches.findAll();
    const chosenSeason = await ChosenSeason.findAll();
    const teams = (await Teams.findAll()).filter(t => t.active === true && t.season === chosenSeason);

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

    // Úprava v admin.js (router.get('/edit/:id'))
    let matchInputs = `<fieldset id="series-score-fields" style="display: ${isSeries ? 'block' : 'none'}; margin-top: 1rem;"><legend>Jednotlivé zápasy série</legend>`;
    for (let i = 0; i < 9; i++) {
        const mResult = match.playedMatches && match.playedMatches[i] ? match.playedMatches[i] : {};
        const isMatchVisible = i < (match.bo || 1);
        const isSwapped = mResult.sideSwap === true; // Načtení stavu z DB

        matchInputs += `
            <script>
            function swapSides(idx) {
        const swapInput = document.getElementById('match_' + idx + '_swap');
        const labelHome = document.getElementById('label_home_' + idx);
        const labelAway = document.getElementById('label_away_' + idx);

        const isSwapped = swapInput.value === 'true';
        if (isSwapped) {
            swapInput.value = 'false';
            labelHome.innerText = 'Domácí (doma):'; labelHome.style.color = '#00ff00';
            labelAway.innerText = 'Hosté (venku):'; labelAway.style.color = '#888';
        } else {
            swapInput.value = 'true';
            labelHome.innerText = 'Hosté (venku):'; labelHome.style.color = '#888';
            labelAway.innerText = 'Domácí (doma):'; labelAway.style.color = '#00ff00';
        }
    }
            </script>
            <div id="match_row_${i}" style="margin-bottom: 15px; border: 1px solid #444; padding: 10px; background: #1a1a1a; display: ${isMatchVisible ? 'block' : 'none'};">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <strong style="color: orangered;">Zápas ${i + 1}</strong>
                    <button type="button" class="edit-btn" style="font-size: 0.7em; padding: 2px 8px;" onclick="swapSides(${i})">🔄 Prohodit strany (Kdo je doma)</button>
                    <input type="hidden" name="match_${i}_swap" id="match_${i}_swap" value="${isSwapped}">
                </div>
                <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
                    <label style="display: flex; flex-direction: column;">
                        <span id="label_home_${i}" style="font-size: 0.75em; color: ${isSwapped ? '#888' : '#00ff00'}">${isSwapped ? 'Hosté (venku)' : 'Domácí (doma)'}:</span>
                        <input class="league-select" type="number" name="match_${i}_home" value="${mResult.scoreHome ?? ''}" style="width: 65px">
                    </label>
                    <span style="margin-top: 15px;">:</span>
                    <label style="display: flex; flex-direction: column;">
                        <span id="label_away_${i}" style="font-size: 0.75em; color: ${isSwapped ? '#00ff00' : '#888'}">${isSwapped ? 'Domácí (doma)' : 'Hosté (venku)'}:</span>
                        <input class="league-select" type="number" name="match_${i}_away" value="${mResult.scoreAway ?? ''}" style="width: 65px">
                    </label>
                    <label style="display: flex; align-items: center; gap: 5px; margin-top: 15px; margin-left: 10px; font-size: 0.85em;">
                        <input type="checkbox" name="match_${i}_ot" ${mResult.ot ? 'checked' : ''}> pp/sn
                    </label>
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
    // Hledej v admin.js funkci toggleBarazLigaEdit() a pod ni vlož toto:
    function swapSides(idx) {
        const swapInput = document.getElementById('match_' + idx + '_swap');
        const labelHome = document.getElementById('label_home_' + idx);
        const labelAway = document.getElementById('label_away_' + idx);

        const isSwapped = swapInput.value === 'true';
        if (isSwapped) {
            swapInput.value = 'false';
            labelHome.innerText = 'Domácí (doma):'; labelHome.style.color = '#00ff00';
            labelAway.innerText = 'Hosté (venku):'; labelAway.style.color = '#888';
        } else {
            swapInput.value = 'true';
            labelHome.innerText = 'Hosté (venku):'; labelHome.style.color = '#888';
            labelAway.innerText = 'Domácí (doma):'; labelAway.style.color = '#00ff00';
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
    <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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

router.post('/edit/:id', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const matchId = parseInt(req.params.id);
    const matches = await Matches.findAll();

    const {homeTeamId, awayTeamId, datetime, season} = req.body;

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
        await removeTipsForDeletedMatch(matchId);
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
            const swap = req.body[`match_${i}_swap`] === 'true'; // PŘIDÁNO: Načtení stavu swapu

            if (h !== '' && a !== '' && h !== undefined && a !== undefined) {
                const sH = parseInt(h);
                const sA = parseInt(a);
                // PŘIDÁNO: Uložení sideSwap do objektu
                match.playedMatches.push({ scoreHome: sH, scoreAway: sA, ot, sideSwap: swap });

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
                await notif.notifySeriesProgress(match, match.playedMatches.length, lastM.scoreHome, lastM.scoreAway, lastM.ot, seriesHomeWins, seriesAwayWins, match.playedMatches);
            }
        }
    } else {
        delete match.result;
    }

    try {
        await Matches.replaceAll(matches);
        console.log(`✅ Zápas ID ${matchId} upraven.`);
    } catch (err) {
        console.error("Chyba při zápisu do MongoDB:", err);
        return renderErrorHtml(res, "Chyba při ukládání.", 500);
    }

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
            await notif.notifyMatchUpdate(match.id, changes.join(' | '));
        }
    }

    try {
        if (season && liga) {
            await updateTeamsPoints(matches);
            await evaluateAndAssignPoints(liga, matches[matchIndex].season);
            await evaluateRegularSeasonTable(season, liga);

            // 4. Odeslání výsledku (POUZE pokud má zápas výsledek, dřív to tu posílalo pořád)
            if (match.result) {
                await notif.notifyResult(matchId, match.result.scoreHome, match.result.scoreAway);
            }
        }
    } catch (err) {
        console.error("Chyba při přepočtech, nebyla odeslána sezóna nebo liga", err);
    }
    await logAdminAction(req.session.user, "ÚPRAVA_ZÁPASU", `Upraven zápas ID: ${matchId} (Liga: ${match.liga})`);
    res.redirect('/admin');
});

router.post('/teams/edit/:id', express.urlencoded({ extended: true }), requireAdmin, upload.single('logo'), async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const teamId = parseInt(req.params.id);
    const teams = await Teams.findAll();
    
    const teamIndex = teams.findIndex(t => t.id === teamId);
    if (teamIndex === -1) return renderErrorHtml(res, "Tým s tímto ID nebyl nalezen.", 404);
    
    const team = teams[teamIndex];
    const { name, liga, active } = req.body;
    
    // Aktualizace dat týmu
    team.name = name.trim();
    team.liga = liga.trim();
    team.active = active === 'on';
    team.group = parseInt(req.body.group);
    
    // Pokud bylo nahráno nové logo nebo vybrán existující, aktualizujeme ho
    if (req.file) {
        team.logo = req.file.filename;
    } else if (req.body.selectedLogo) {
        team.logo = req.body.selectedLogo;
    }
    
    // Uložení do MongoDB
    await Teams.replaceAll(teams);
    
    await logAdminAction(req.session.user, "ÚPRAVA_TÝMU", `Upraven tým: ${team.name} (${team.liga})`);
    res.redirect('/admin');
});

router.post('/teams/delete/:id', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const teamsId = parseInt(req.params.id);
    let teams = await Teams.findAll();

    teams = teams.filter(t => t.id !== teamsId);

    // Uložení do MongoDB
    await Teams.replaceAll(teams);
    
    await logAdminAction(req.session.user, "SMAZÁNÍ_TÝMU", `Smazán tým s ID: ${teamsId}`);
    res.redirect('/admin');
});

router.post('/delete/:id', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const matchId = parseInt(req.params.id);
    let matches = await Matches.findAll();

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
    await updateTeamsPoints(matches);
    
    // Uložení do MongoDB
    await Matches.replaceAll(matches);

    await removeTipsForDeletedMatch(matchId);

    await evaluateAndAssignPoints(matchLiga, matchSeason);

    await evaluateAndAssignPoints(matchLiga, matchSeason);
    await logAdminAction(req.session.user, "SMAZÁNÍ_ZÁPASU", `Smazán zápas ID: ${matchId} (Liga: ${matchLiga})`);
    res.redirect('/admin');
});

const {getAllSeasons} = require('../utils/fileUtils');
const {backupJsonFilesToGitHub} = require("../utils/githubBackup");

router.get('/api/seasons', requireAdmin, (req, res) => {
    const seasons = getAllSeasons();
    res.json(seasons);
});

router.post('/season', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const selectedSeason = req.body.season || 'Neurčeno';
    const previousSeason = await ChosenSeason.findAll();
    
    // Uložení nové sezóny do MongoDB
    await ChosenSeason.replaceAll(selectedSeason);
    
    // ŽÁDNÉ MAZÁNÍ DAT - pouze změna aktivní sezóny
    await logAdminAction(req.session.user, "ZMENA_SEZONY", 
        `Změna sezóny z "${previousSeason}" na "${selectedSeason}" (data zachována)`);
    
    res.redirect('/admin');
});

router.get('/playoff', requireAdmin, async (req, res) => {
    const selectedSeason = await ChosenSeason.findAll();
    const allSeasonData = await Leagues.findAll();
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];
    const allLeagues = leagues.map(l => l.name);
    // Admin vidí VŠECHNY ligy - žádné filtrování
    const selectedLeague = req.query.league || allLeagues[0] || "Neurčeno";

    // Zjistíme formát vybrané ligy
    const leagueObj = leagues.find(l => l.name === selectedLeague);
    const playoffFormat = leagueObj?.playoffFormat || 'none';

    const [matches, teams] = await Promise.all([
        Matches.findAll(),
        Teams.findAll()
    ]);

    // Filter teams by selectedSeason - admin should only see active teams from current season
    const teamsFromCurrentSeason = teams.filter(t => t.active === true && t.season === selectedSeason);

    const playoffMatches = matches.filter(m => m.season === selectedSeason && m.liga === selectedLeague && m.isPlayoff);

    // Vytvoříme seznam sérií do roletky
    // (Toto už tam máš)
    const seriesOptionsHTML = playoffMatches.map(m => {
        const teamA = teamsFromCurrentSeason.find(t => t.id === m.homeTeamId)?.name || 'Neznámý';
        const teamB = teamsFromCurrentSeason.find(t => t.id === m.awayTeamId)?.name || 'Neznámý';
        return `<option value="series-${m.id}">${teamA} vs ${teamB} (Série ${m.id})</option>`;
    }).join('');

    // --- 1. PŘIDEJ TOTO (Seznam týmů pro čekající sloty) ---
    const teamsInLeague = teamsFromCurrentSeason.filter(t => t.liga === selectedLeague);
    const teamsOptionsHTML = teamsInLeague.map(t => `<option value="${t.name}">${t.name}</option>`).join('');

    // --- CHYBĚJÍCÍ BLOK: Načteme už uložené přiřazení slotů ---
    const playoffData = await Playoff.findAll();
    let savedSlots = {};
    try {
        if (playoffData[selectedSeason] && playoffData[selectedSeason][selectedLeague]) {
            savedSlots = playoffData[selectedSeason][selectedLeague];
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
    // 1. Načtení šablon z MongoDB
    const allTemplates = await PlayoffTemplates.findAll() || {};
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
            <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
            <input type="hidden" name="season" value="${selectedSeason}">
            <input type="hidden" name="league" value="${selectedLeague}">
            
            ${slotsHTML}

            ${playoffFormat !== 'none' ? `<button type="submit" class="action-btn edit-btn" style="width: 100%; padding: 15px; font-size: 1.1em; margin-top: 20px;">Uložit pavouka</button>` : ''}
        </form>
        
        ${playoffFormat !== 'none' ? `
        <form action="/admin/playoff/delete" method="POST" onsubmit="return confirm('Opravdu vymazat celého pavouka pro tuto ligu? Všechny naklikané série ze slotů zmizí.');">
            <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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

router.post('/playoff/save', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { league, season, ...slots } = req.body;

    if (!league || !season) return renderErrorHtml(res, "Chybí data k uložení.", 400);

    // Načtení z MongoDB
    let playoffData = await Playoff.findAll();
    if (!playoffData || Object.keys(playoffData).length === 0) playoffData = {};

    if (!playoffData[season]) playoffData[season] = {};

    // Uložíme jednoduše slovník: { "qf1": "series-468", "sf1": "series-500", ... }
    playoffData[season][league] = slots;

    // Uložení do MongoDB
    await Playoff.replaceAll(playoffData);
    
    await logAdminAction(req.session.user, "PLAYOFF_ULOŽENÍ", `Aktualizovány sloty playoff pro ${league} (${season})`);
    res.redirect(`/admin/playoff?league=${encodeURIComponent(league)}`);
});

router.post('/playoff/delete', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { season, league } = req.body;

    if (!season || !league) {
        return res.status(400).send('Chybí sezóna nebo liga k vymazání.');
    }

    try {
        let playoffData = await Playoff.findAll() || {};
        
        if (playoffData[season] && playoffData[season][league]) {
            delete playoffData[season][league];

            if (Object.keys(playoffData[season]).length === 0) {
                delete playoffData[season];
            }

            await Playoff.replaceAll(playoffData);
        }
        
        await logAdminAction(req.session.user, "PLAYOFF_RESET", `KOMPLETNĚ SMAZÁNA playoff mřížka pro ${league} (${season})`);
        res.redirect('/admin/playoff');
    } catch (error) {
        console.error('Chyba při mazání playoff:', error);
        return res.status(500).send('Nepodařilo se smazat data');
    }
});

router.get('/togglePostponed/:id', requireAdmin, async (req, res) => {
    const matchId = parseInt(req.params.id);
    const matches = await Matches.findAll();
    const match = matches.find(m => m.id === matchId);
    if (!match) return renderErrorHtml(res, "Zápas nebyl nalezen.", 404);

    match.postponed = !match.postponed;

    // Uložení do MongoDB
    await Matches.replaceAll(matches);
    
    await logAdminAction(req.session.user, "ODLOŽENÍ_ZÁPASU", `Zápas ID ${matchId} byl ${match.postponed ? 'ODLOŽEN' : 'VRÁCEN DO BĚŽNÉHO STAVU'}`);
    res.redirect('/admin');
});

router.get('/leagues/manage', requireAdmin, async (req, res) => {
    const allSeasonData = await Leagues.findAll();
    const selectedSeason = await ChosenSeason.findAll();

    // 1. Načtení statusů z MongoDB
    let statusData = await LeagueStatus.findAll();
    if (!statusData || Object.keys(statusData).length === 0) statusData = {};

    let allTemplates = await PlayoffTemplates.findAll();
    if (!allTemplates || Object.keys(allTemplates).length === 0) allTemplates = {};


    const seasonLeagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];

    const html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Správa lig</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
    </head>
    <body>
        <h1>Správa lig (pro sezónu: ${selectedSeason})</h1>
        
        <h2>Přidat novou ligu</h2>
        <form method="POST" action="/admin/leagues/manage">
             <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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
                        <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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
                        <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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
                            <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                            <input type="hidden" name="season" value="${selectedSeason}">
                            <input type="hidden" name="liga" value="${l.name}">
                            <input type="hidden" name="totalGroups" value="${l.groupCount || 0}">
                            <label style="cursor: pointer; display: flex; align-items: center; gap: 5px; ${globalLockStyle}">
                                <input type="checkbox" name="locked" value="true" ${isGloballyLocked ? 'checked' : ''} onchange="this.form.submit()">
                                ${isGloballyLocked ? 'Tabulky ZAMČENY (Vše)' : 'Zamknout Vše'}
                            </label>
                        </form>

                        <form method="POST" action="/admin/toggle-regular-season" style="display:inline-flex;">
                            <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                            <input type="hidden" name="season" value="${selectedSeason}">
                            <input type="hidden" name="liga" value="${l.name}">
                            <label style="cursor: pointer; display: flex; align-items: center; gap: 5px; ${statusStyle}">
                                <input type="checkbox" name="finished" value="true" ${isFinished ? 'checked' : ''} onchange="this.form.submit()">
                                ${isFinished ? 'Body Aktivní' : 'Body Neaktivní'}
                            </label>
                        </form>

                        <form method="POST" action="/admin/leagues/delete" style="display:inline;">
                            <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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

router.post('/leagues/manage', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { ligaName, multigroup, groupCount, maxMatches, quarterfinal, playin, relegation } = req.body.newLeague;
    const allSeasonData = await Leagues.findAll();
    const selectedSeason = await ChosenSeason.findAll();

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
        await Leagues.replaceAll(allSeasonData);
    }
    res.redirect('/admin/leagues/manage');
});

router.post('/leagues/update', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const {
        originalLeagueName, leagueName, maxMatches, quarterfinal, playin, relegation,
        // Nová pole z formuláře
        crossGroupEnabled, crossGroupPosition, crossQuarterfinal, crossPlayin, crossRelegation, playoffFormat
    } = req.body;

    const allSeasonData = await Leagues.findAll();
    const selectedSeason = await ChosenSeason.findAll();

    if (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) {
        const index = allSeasonData[selectedSeason].leagues.findIndex(l => l.name === originalLeagueName);

        if (index !== -1) {
            // 1. Změna názvu
            if (originalLeagueName !== leagueName) {
                console.log(`Změna názvu ligy z ${originalLeagueName} na ${leagueName}`);
                await renameLeagueGlobal(originalLeagueName, leagueName);
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

            await Leagues.replaceAll(allSeasonData);
        }
    }
    await logAdminAction(req.session.user, "ÚPRAVA_LIGY", `Upraveno nastavení ligy: ${leagueName}`);
    res.redirect('/admin/leagues/manage');
});

router.post('/leagues/delete', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { league } = req.body;
    const allSeasonData = await Leagues.findAll();
    const selectedSeason = await ChosenSeason.findAll();

    if (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) {

        allSeasonData[selectedSeason].leagues = allSeasonData[selectedSeason].leagues.filter(l => l.name !== league);

        await Leagues.replaceAll(allSeasonData);
    }
    await logAdminAction(req.session.user, "SMAZÁNÍ_LIGY", `Kompletně smazána liga: ${league}`);
    res.redirect('/admin/leagues/manage');
});
router.post("/toggle-regular-season", express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    if (req.session.role !== "admin") return renderErrorHtml(res, "Nemáte oprávnění k této akci.", 403);

    const { season, liga } = req.body;
    const isFinishedNow = req.body.finished === 'true'; // Pokud je checkbox zaškrtnutý

    // Načtení z MongoDB
    let statusData = await LeagueStatus.findAll();
    if (!statusData || Object.keys(statusData).length === 0) statusData = {};

    if (!statusData[season]) statusData[season] = {};

    // Získáme předchozí stav, abychom věděli, jestli se něco změnilo
    const wasFinishedBefore = statusData[season][liga]?.regularSeasonFinished === true;

    // Uložíme nový stav
    statusData[season][liga] = {
        ...statusData[season][liga], // Zachováme ostatní klíče (např. zámky)
        regularSeasonFinished: isFinishedNow
    };

    // Uložení do MongoDB
    await LeagueStatus.replaceAll(statusData);

    // Přepočet tabulky
    await evaluateRegularSeasonTable(season, liga);

    // NOTIFIKACE: Pokud byla liga právě teď označena jako dokončená (a předtím nebyla)
    if (isFinishedNow && !wasFinishedBefore) {
        console.log(`Posílám notifikaci o ukončení ligy: ${liga}`);
        
        // Získání vítězného týmu z tabulky
        let winnerTeam = null;
        try {
            const tableTips = await TableTips.findAll();
            const tableTipsArray = Object.values(tableTips || {});
            const leagueTips = tableTipsArray.filter(t => t.season === season && t.liga === liga);
            if (leagueTips.length > 0) {
                // Seřazení podle bodů (nejvyšší první)
                const sortedTips = leagueTips.sort((a, b) => (b.points || 0) - (a.points || 0));
                const winnerTip = sortedTips[0];
                if (winnerTip) {
                    const teams = await Teams.findAll();
                    winnerTeam = teams.find(t => t.id === winnerTip.teamId);
                }
            }
        } catch (err) {
            console.error("Chyba při získávání vítěze:", err);
        }
        
        await notif.notifyLeagueEnd(liga, winnerTeam);
    }
    await logAdminAction(req.session.user, "ZÁKLADNÍ_ČÁST", `Změněn stav základní části pro ${liga} (${season}) na: ${req.body.isFinished === 'on' ? 'DOKONČENO' : 'PROBÍHÁ'}`);
    res.redirect('/admin');
});

router.post("/toggle-table-tips-lock", express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { season, liga, locked, group, totalGroups } = req.body;
    const shouldLock = (locked === 'true');

    let statusData = await LeagueStatus.findAll();
    if (!statusData || Object.keys(statusData).length === 0) statusData = {};
    
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

    // Uložení do MongoDB
    await LeagueStatus.replaceAll(statusData);
    
    await logAdminAction(req.session.user, "ZÁMEK_TABULKY", `Změněn zámek tipů na tabulku pro ${liga} (Skupina: ${group || 'GLOBÁLNÍ'}) na: ${shouldLock ? 'ZAMČENO' : 'ODEMČENO'}`);
    
    // OKAMŽITÉ VYHODNOCENÍ PO ZAMČENÍ/ODEMČENÍ
    const { evaluateRegularSeasonTable } = require('../utils/fileUtils');
    await evaluateRegularSeasonTable(season, liga);
    
    res.redirect('/admin/leagues/manage');
});

router.get('/teams/points', requireAdmin, async (req, res) => {
    const selectedSeason = await ChosenSeason.findAll();
    const allSeasonData = await Leagues.findAll();
    const teams = await Teams.findAll();

    const matches = await Matches.findAll();
    const realScores = {};

    const seasonLeagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues)
        ? allSeasonData[selectedSeason].leagues
        : [];

    const selectedLiga = req.query.liga || (seasonLeagues.length > 0 ? seasonLeagues[0].name : null);

    // Filter teams by selectedSeason - admin should only see active teams from current season
    const teamsFromCurrentSeason = teams.filter(t => t.active === true && t.season === selectedSeason);

    teamsFromCurrentSeason.forEach(t => realScores[t.id] = { points: 0, gf: 0, ga: 0 });

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

    // Načteme existující bonusy z MongoDB
    let bonusData = await TeamBonuses.findAll();
    if (!bonusData || Object.keys(bonusData).length === 0) bonusData = {};

    // Filtrujeme týmy
    const leagueTeams = teamsFromCurrentSeason.filter(t => t.liga === selectedLiga && t.active);

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
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
            <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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

router.post('/teams/points', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { season, liga } = req.body;

    // Načtení z MongoDB
    let bonusData = await TeamBonuses.findAll();
    if (!bonusData || Object.keys(bonusData).length === 0) bonusData = {};

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

    // Uložení do MongoDB
    await TeamBonuses.replaceAll(bonusData);
    
    await logAdminAction(req.session.user, "MANUÁLNÍ_BODY", `Upraveny extra body v lize: ${liga}, Sezóna: ${season}`);
    res.redirect(`/admin/teams/points?liga=${encodeURIComponent(liga)}`);
});

router.post('/settings/clinch', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    // 1. Zkontrolujeme, co přesně přišlo z formuláře
    console.log("--- UKLÁDÁNÍ NASTAVENÍ ---");
    console.log("Přijatá data v req.body:", req.body);

    const mode = req.body.mode;
    
    // Načtení z MongoDB
    let settings = await Settings.findAll();
    if (!settings || Object.keys(settings).length === 0) settings = {};

    console.log("Aktuální stav před změnou:", settings);

    // 3. Nastavení nové hodnoty
    settings.clinchMode = (mode === 'cascade') ? 'cascade' : 'strict';

    console.log("Nový stav k uložení:", settings);

    // 4. Uložení do MongoDB
    try {
        await Settings.replaceAll(settings);
        console.log("Úspěšně uloženo do MongoDB (settings)");
    } catch (err) {
        console.error("Kritická chyba při zápisu do MongoDB:", err);
    }
    await logAdminAction(req.session.user, "NASTAVENÍ_TABULKY", `Režim obarvování tabulky (clinch mode) změněn na: ${settings.clinchMode}`);
    // Návrat na předchozí stránku (odkud se formulář odeslal)
    res.redirect('/admin');
});

router.get('/matches/import', requireAdmin, async (req, res) => {
    // 1. Načtení dat z MongoDB
    const currentSeason = await ChosenSeason.findAll();

    // Načítáme ligy z MongoDB
    let leaguesData = await Leagues.findAll();
    if (!leaguesData || Object.keys(leaguesData).length === 0) leaguesData = {};

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
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Import z Livesport.cz</title>
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
                <h2 style="color: orangered; text-align: center;">Livesport.cz Import</h2>
                <p style="text-align: center; color: lightgrey;">
                    Vyber parametry a vlož odkaz na sekci <strong>ZÁPASY</strong> z webu livesport.cz.<br>
                    <small>Podporuje <strong>jakoukoliv</strong> ligu - stačí mít vytvořené týmy v databázi</small>
                </p>

                <div style="background: rgba(255, 69, 0, 0.1); border: 1px dashed orangered; padding: 15px; margin-bottom: 15px; border-radius: 5px;">
                    <p style="margin: 0; color: white; font-size: 14px;">
                        <strong>Příklady URL (záložka "Zápasy"):</strong><br>
                        <code style="color: #00ff00;">https://www.livesport.cz/zapasy/2025-2026/telh-UCEL8Q9b/</code><br>
                        <code style="color: #00ff00;">https://www.livesport.cz/hokej/svet/mistrovstvi-sveta/zapasy/</code><br>
                        <code style="color: #00ff00;">https://www.livesport.cz/hokej/cesko/tipsport-extraliga/zapasy/</code>
                    </p>
                </div>

                <form method="POST" action="/admin/matches/import-run" style="display: flex; flex-direction: column; gap: 15px; width: 100%;">
                    <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                    
                    <label style="display: flex; flex-direction: column; color: orangered;">
                        URL adresa z livesport.cz:
                        <input type="text" name="url" placeholder="https://www.livesport.cz/zapasy/2025-2026/telh-UCEL8Q9b/" required 
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

router.post('/matches/import-run', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { url, liga, season, dateFrom, dateTo, lockImported } = req.body;
    const shouldLock = lockImported === 'on';

    try {
        // 1. Načtení týmů z DB
        const allTeams = await Teams.findAll();

        // 2. Načtení existujících zápasů pro kontrolu duplicit
        const matchesDB = await Matches.findAll();
        let maxId = matchesDB.reduce((max, m) => {
            const numId = Number(m.id);
            return !isNaN(numId) && numId > max ? numId : max;
        }, 0);

        console.log(`ℹ️ Start ID: ${maxId + 1}`);
        console.log(`📥 Importuji z Livesport: ${liga} - ${season}`);

        // 3. Stažení zápasů z Livesportu
        const importResult = await fetchMatchesFromLivesport({
            url,
            liga,
            season,
            dateFrom,
            dateTo,
            dbTeams: allTeams
        });

        if (!importResult.success) {
            console.error('❌ Chyba při importu z Livesport:', importResult.error);
            return res.status(500).send(`
            <!DOCTYPE html>
            <html lang="cs">
            <head>
                <meta charset="UTF-8">
                <title>Chyba importu</title>
                <link rel="stylesheet" href="/css/styles.css">
            </head>
            <body class="admin_site">
                <main class="main_page" style="flex-direction: column; align-items: center; padding: 40px;">
                    <div class="stats-container" style="border: 2px solid red; background: #330000;">
                        <h2 style="color: red;">❌ Chyba při importu</h2>
                        <p style="color: white;">${importResult.error || 'Nepodařilo se stáhnout data z Livesportu'}</p>
                        <div style="margin-top: 20px;">
                            <a href="/admin/matches/import" class="action-btn" style="background-color: #333; border: 1px solid orangered;">← Zpět na import</a>
                        </div>
                    </div>
                </main>
            </body>
            </html>
            `);
        }

        // 4. Zpracování stažených zápasů
        let newMatchesCount = 0;
        let skippedCount = 0;
        let outOfRangeCount = importResult.stats?.outOfRange || 0;

        for (const match of importResult.matches) {
            // Kontrola existence - porovnáváme datum + ID týmů
            const exists = matchesDB.some(m => {
                if (!m.datetime) return false;
                return m.datetime.startsWith(match.date) &&
                       m.homeTeamId === match.homeTeamId &&
                       m.awayTeamId === match.awayTeamId;
            });

            if (!exists) {
                maxId++;
                matchesDB.push({
                    id: maxId,
                    homeTeamId: match.homeTeamId,
                    awayTeamId: match.awayTeamId,
                    datetime: match.datetime,
                    liga: liga,
                    season: season,
                    isPlayoff: false,
                    postponed: false,
                    locked: shouldLock,
                    result: null
                });
                newMatchesCount++;
            } else {
                skippedCount++;
            }
        }

        // 5. Uložení do MongoDB
        if (newMatchesCount > 0) {
            await Matches.replaceAll(matchesDB);
            console.log(`✅ Uloženo ${newMatchesCount} nových zápasů`);
        }

        // 6. Výsledková stránka
        const htmlRes = `
        <!DOCTYPE html>
        <html lang="cs">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>Výsledek importu z Livesport</title>
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

                    <p style="color:gray; font-size:12px;">Zdroj: Livesport.cz | Liga: ${liga} | Sezóna: ${season}</p>

                    <table class="points-table" style="font-size: 14px; margin-top: 20px;">
                        <tr><td style="text-align: left;">Vybraná liga:</td><td>${liga}</td></tr>
                        <tr><td style="text-align: left;">Nalezeno na Livesportu:</td><td>${importResult.stats?.totalFound || 0}</td></tr>
                        <tr><td style="text-align: left;">Úspěšně spárováno:</td><td>${importResult.matches.length}</td></tr>
                        <tr><td style="text-align: left;">Nové zápasy:</td><td style="color: #00ff00; font-weight: bold;">${newMatchesCount}</td></tr>
                        <tr><td style="text-align: left;">Již existující:</td><td style="color: yellow;">${skippedCount}</td></tr>
                        <tr><td style="text-align: left;">Mimo datum. rozsah:</td><td style="color: gray;">${outOfRangeCount}</td></tr>
                    </table>

                    ${importResult.notFoundTeams.length > 0 ? `
                    <div style="margin-top: 20px; border: 1px solid red; padding: 10px; background: #330000;">
                        <h3 style="color: red; margin: 0 0 10px 0;">⚠️ Nespárované týmy (${importResult.notFoundTeams.length})</h3>
                        <p style="color: #ff9999; font-size: 12px; margin-bottom: 10px;">
                            Tyto týmy se nepodařilo najít v databázi. Zkontrolujte, zda máte vytvořené všechny týmy pro ligu ${liga}.
                        </p>
                        <ul style="color: white; text-align: left; columns: 1; max-height: 200px; overflow-y: auto;">
                            ${importResult.notFoundTeams.map(t => `<li>${t}</li>`).join('')}
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

        await logAdminAction(req.session.user, "IMPORT_ZÁPASŮ_LIVESPORT", `Importováno ${newMatchesCount} zápasů z Livesportu pro ${liga} (${season})`);
        res.send(htmlRes);

    } catch (error) {
        console.error('❌ Chyba při importu z Livesport:', error);
        res.status(500).send(`
        <!DOCTYPE html>
        <html lang="cs">
        <head>
            <meta charset="UTF-8">
            <title>Chyba importu</title>
            <link rel="stylesheet" href="/css/styles.css">
        </head>
        <body class="admin_site">
            <main class="main_page" style="flex-direction: column; align-items: center; padding: 40px;">
                <div class="stats-container" style="border: 2px solid red; background: #330000;">
                    <h2 style="color: red;">❌ Chyba při importu</h2>
                    <p style="color: white;">${error.message}</p>
                    <pre style="color: #ff9999; background: #220000; padding: 10px; border-radius: 5px; overflow-x: auto;">${error.stack}</pre>
                    <div style="margin-top: 20px;">
                        <a href="/admin/matches/import" class="action-btn" style="background-color: #333; border: 1px solid orangered;">← Zpět na import</a>
                    </div>
                </div>
            </main>
        </body>
        </html>
        `);
    }
});
router.post('/leagues/transfers', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    let { transferLeagues } = req.body;

    // Ošetření, aby to bylo vždycky pole
    let savedTransferLeagues = [];
    if (Array.isArray(transferLeagues)) {
        savedTransferLeagues = transferLeagues;
    } else if (typeof transferLeagues === 'string') {
        savedTransferLeagues = [transferLeagues];
    }

    // Uložení do MongoDB
    await TransferLeagues.replaceAll(savedTransferLeagues);

    res.redirect('/admin');
});

router.get('/images/manage', requireAdmin, async (req, res) => {
    const imagesDir = path.join(__dirname, '..', 'data', 'images');
    const teams = await Teams.findAll();
    const selectedSeason = await ChosenSeason.findAll();
    
    // Filter teams by selectedSeason - admin should only see logos from current season
    const teamsFromCurrentSeason = teams.filter(t => t.season === selectedSeason);
    const usedLogos = new Set(teamsFromCurrentSeason.map(t => t.logo).filter(Boolean));

    // Pojistka, kdyby složka neexistovala
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }

    // Načteme všechny soubory, které jsou obrázky
    const files = fs.readdirSync(imagesDir).filter(f => f.match(/\.(jpg|jpeg|png|gif|webp)$/i));

    // Získáme hashe pro detekci duplicit (načteme z MongoDB pokud existují)
    let imageHashes = [];
    let duplicates = { exact: [], similar: [], filenameConflicts: [] };
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const hashCollection = db.collection('image_hashes');
        imageHashes = await hashCollection.find({}).toArray();
        
        // Pokud nemáme hashe v DB, naskenujeme je
        if (imageHashes.length === 0) {
            imageHashes = await scanImageHashes(imagesDir);
            await syncImageHashesToDatabase(db, imagesDir);
        }
        
        // Najdeme duplicity - pouze identické soubory (MD5), žádná vizuální podobnost vůbec
        duplicates = findDuplicates(imageHashes, { similarThreshold: -1 });
    } catch (err) {
        console.log('ℹ️ Hash index není dostupný, pokračuji bez detekce duplicit');
    }

    // Seskuptíme obrázky podle duplicit
    const duplicateGroups = {};
    [...duplicates.exact, ...duplicates.similar].forEach(dup => {
        const key = dup.type === 'exact' ? dup.original : dup.image1;
        if (!duplicateGroups[key]) duplicateGroups[key] = [];
        duplicateGroups[key].push(dup);
    });

    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Galerie obrázků - Správa log</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
        <style>
            .gallery-container { padding: 20px; }
            .gallery-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; margin-bottom: 20px; }
            .gallery-stats { display: flex; gap: 20px; flex-wrap: wrap; }
            .stat-box { background: #1a1a2e; padding: 10px 20px; border-radius: 8px; border: 1px solid #333; }
            .stat-box .number { font-size: 1.5em; font-weight: bold; color: #00d4ff; }
            .stat-box .label { font-size: 0.85em; color: #888; }
            .upload-section { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border: 2px dashed #00d4ff; padding: 30px; margin-bottom: 30px; border-radius: 12px; text-align: center; }
            .upload-section.dragover { background: rgba(0, 212, 255, 0.1); border-color: #00ff00; }
            .file-input-wrapper { position: relative; display: inline-block; margin: 10px; }
            .file-input-wrapper input[type="file"] { display: none; }
            .file-input-label { background: #00d4ff; color: #000; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-weight: bold; display: inline-flex; align-items: center; gap: 8px; }
            .file-input-label:hover { background: #00b4d8; }
            .duplicate-warning { background: #ff4444; color: white; padding: 15px; border-radius: 8px; margin: 10px 0; display: none; }
            .duplicate-warning.visible { display: block; }
            .duplicate-group { background: rgba(255, 68, 68, 0.1); border: 1px solid #ff4444; padding: 10px; margin: 5px 0; border-radius: 6px; }
            .batch-upload-preview { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 15px; margin-top: 20px; }
            .preview-item { position: relative; background: #1a1a2e; padding: 10px; border-radius: 8px; text-align: center; }
            .preview-item img { max-width: 100%; height: 100px; object-fit: cover; border-radius: 4px; }
            .preview-item .filename { font-size: 0.75em; color: #888; margin-top: 5px; word-break: break-all; }
            .preview-item .duplicate-badge { position: absolute; top: 5px; right: 5px; background: #ff4444; color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.75em; }
            .preview-item .similar-badge { position: absolute; top: 5px; right: 5px; background: #ffaa00; color: #000; padding: 2px 8px; border-radius: 12px; font-size: 0.75em; }
            .filter-tabs { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
            .filter-tab { background: #1a1a2e; border: 1px solid #444; padding: 10px 20px; border-radius: 8px; cursor: pointer; color: #888; }
            .filter-tab.active { background: #00d4ff; color: #000; border-color: #00d4ff; }
            .filter-tab:hover:not(.active) { border-color: #00d4ff; color: #00d4ff; }
            .gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 20px; }
            .gallery-item { position: relative; background: #1a1a2e; border-radius: 12px; overflow: hidden; border: 2px solid transparent; transition: all 0.3s ease; }
            .gallery-item:hover { border-color: #00d4ff; transform: translateY(-2px); }
            .gallery-item.selected { border-color: #00ff00; box-shadow: 0 0 20px rgba(0, 255, 0, 0.3); }
            .gallery-item.duplicate { border-color: #ff4444; }
            .gallery-item.similar { border-color: #ffaa00; }
            .gallery-item img { width: 100%; height: 150px; object-fit: cover; cursor: pointer; }
            .gallery-item .info { padding: 12px; }
            .gallery-item .name { font-size: 0.85em; color: #fff; word-break: break-all; }
            .gallery-item .meta { font-size: 0.75em; color: #666; margin-top: 5px; }
            .gallery-item .checkbox { position: absolute; top: 10px; left: 10px; width: 24px; height: 24px; cursor: pointer; }
            .gallery-item .status-badge { position: absolute; top: 10px; right: 10px; padding: 4px 10px; border-radius: 12px; font-size: 0.7em; font-weight: bold; }
            .gallery-item .status-badge.active { background: #00ff00; color: #000; }
            .gallery-item .status-badge.unused { background: #666; color: #fff; }
            .gallery-item .duplicate-badge { position: absolute; bottom: 60px; left: 10px; right: 10px; background: rgba(255, 68, 68, 0.9); color: white; padding: 5px; border-radius: 6px; font-size: 0.75em; text-align: center; }
            .gallery-item .similar-badge { position: absolute; bottom: 60px; left: 10px; right: 10px; background: rgba(255, 170, 0, 0.9); color: #000; padding: 5px; border-radius: 6px; font-size: 0.75em; text-align: center; }
            .gallery-item .actions { display: flex; gap: 5px; padding: 10px; }
            .gallery-item .actions a, .gallery-item .actions button { flex: 1; text-align: center; padding: 8px; border-radius: 6px; font-size: 0.8em; text-decoration: none; border: none; cursor: pointer; }
            .gallery-item .actions .delete { background: #ff4444; color: white; }
            .gallery-item .actions .delete:disabled { background: #444; cursor: not-allowed; }
            .bulk-actions { display: none; position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1a1a2e; border: 2px solid #00d4ff; padding: 15px 30px; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); z-index: 100; }
            .bulk-actions.visible { display: flex; gap: 10px; align-items: center; }
            .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; justify-content: center; align-items: center; }
            .modal-overlay.visible { display: flex; }
            .modal-content { background: #1a1a2e; padding: 30px; border-radius: 16px; max-width: 90vw; max-height: 90vh; overflow: auto; border: 2px solid #00d4ff; }
            .modal-content img { max-width: 100%; max-height: 70vh; }
            .duplicates-section { background: rgba(255, 68, 68, 0.1); border: 1px solid #ff4444; padding: 20px; margin-bottom: 30px; border-radius: 12px; }
            .duplicates-section h3 { color: #ff4444; margin-top: 0; }
            .duplicate-comparison { display: flex; gap: 20px; flex-wrap: wrap; margin: 15px 0; padding: 15px; background: rgba(0,0,0,0.3); border-radius: 8px; }
            .duplicate-comparison img { width: 150px; height: 150px; object-fit: cover; border-radius: 8px; }
            .duplicate-info { flex: 1; min-width: 200px; }
        </style>
    </head>
    <body class="usersite">
        <main class="admin_site gallery-container">
            <div class="gallery-header">
                <div>
                    <h1>🖼️ Galerie obrázků</h1>
                    <p><a href="/admin" style="color: orangered;">← Zpět do adminu</a></p>
                </div>
                <div class="gallery-stats">
                    <div class="stat-box">
                        <div class="number">${files.length}</div>
                        <div class="label">Celkem obrázků</div>
                    </div>
                    <div class="stat-box">
                        <div class="number" style="color: #00ff00;">${[...usedLogos].filter(l => files.includes(l)).length}</div>
                        <div class="label">Používá se</div>
                    </div>
                    <div class="stat-box">
                        <div class="number" style="color: ${[...usedLogos].filter(l => !files.includes(l)).length > 0 ? '#ff4444' : '#666'};">${[...usedLogos].filter(l => !files.includes(l)).length}</div>
                        <div class="label">Chybějící loga</div>
                    </div>
                    <div class="stat-box">
                        <div class="number" style="color: ${duplicates.exact.length + duplicates.similar.length > 0 ? '#ff4444' : '#00ff00'};">${duplicates.exact.length + duplicates.similar.length}</div>
                        <div class="label">Duplicity</div>
                    </div>
                </div>
            </div>

            <!-- Upload sekce -->
            <div class="upload-section" id="dropZone">
                <h3>📤 Nahrát obrázky</h3>
                <p style="color: #888; margin: 10px 0;">Přetáhni soubory sem nebo vyber z počítače (podporováno více souborů najednou)</p>
                <div class="file-input-wrapper">
                    <input type="file" id="fileInput" accept="image/*" multiple onchange="handleFiles(this.files)">
                    <label for="fileInput" class="file-input-label">
                        📁 Vybrat obrázky
                    </label>
                </div>
                <div class="file-input-wrapper">
                    <input type="file" id="folderInput" webkitdirectory directory onchange="handleFiles(this.files)">
                    <label for="folderInput" class="file-input-label" style="background: #666;">
                        📂 Vybrat složku
                    </label>
                </div>
                <p style="color: #666; font-size: 0.85em; margin-top: 15px;">
                    <a href="/admin/images/reset-hashes" style="color: #ffaa00;" onclick="return confirm('Přepočítat všechny hashe obrázků? Toto může chvíli trvat.')">🔄 Přepočítat hashe obrázků</a>
                </p>
                <div id="duplicateWarning" class="duplicate-warning"></div>
                <div id="uploadPreview" class="batch-upload-preview"></div>
                <button id="uploadBtn" class="btn new-btn-admin" style="display: none; margin-top: 20px;" onclick="uploadFiles()">
                    🚀 Nahrát vybrané soubory
                </button>
            </div>

            <!-- Sekce duplicit -->
            ${(duplicates.exact.length > 0 || duplicates.similar.length > 0) ? `
            <div class="duplicates-section">
                <h3>⚠️ Nalezeny duplicity (${duplicates.exact.length} identických, ${duplicates.similar.length} podobných)</h3>
                <p style="color: #888; margin-bottom: 15px;">Následující obrázky jsou duplicitní. Zvaž jejich smazání pro úsporu místa.</p>
                ${duplicates.exact.map(dup => `
                    <div class="duplicate-comparison">
                        <div>
                            <img src="/logoteamu/${dup.original}" alt="">
                            <p style="font-size: 0.8em; color: #888; margin-top: 5px;">${dup.original}</p>
                        </div>
                        <div style="display: flex; align-items: center; color: #ff4444; font-size: 1.5em;">=</div>
                        <div>
                            <img src="/logoteamu/${dup.duplicate}" alt="">
                            <p style="font-size: 0.8em; color: #888; margin-top: 5px;">${dup.duplicate}</p>
                            <a href="/admin/images/delete/${dup.duplicate}" class="btn" style="background: #ff4444; color: white; padding: 5px 15px; font-size: 0.8em; margin-top: 5px;">Smazat duplicitu</a>
                        </div>
                    </div>
                `).join('')}
                ${duplicates.similar.slice(0, 5).map(dup => `
                    <div class="duplicate-comparison">
                        <div>
                            <img src="/logoteamu/${dup.image1}" alt="">
                            <p style="font-size: 0.8em; color: #888; margin-top: 5px;">${dup.image1}</p>
                        </div>
                        <div style="display: flex; align-items: center; color: #ffaa00; font-size: 1.2em;">~${dup.similarity}%</div>
                        <div>
                            <img src="/logoteamu/${dup.image2}" alt="">
                            <p style="font-size: 0.8em; color: #888; margin-top: 5px;">${dup.image2}</p>
                        </div>
                    </div>
                `).join('')}
                ${duplicates.similar.length > 5 ? `<p style="color: #888;">... a dalších ${duplicates.similar.length - 5} podobných párů</p>` : ''}
            </div>
            ` : ''}

            <!-- Filtry -->
            <div class="filter-tabs">
                <div class="filter-tab active" onclick="filterImages('all')">Všechny</div>
                <div class="filter-tab" onclick="filterImages('active')">Používané</div>
                <div class="filter-tab" onclick="filterImages('unused')">Nepoužité</div>
                <div class="filter-tab" onclick="filterImages('duplicates')">Duplicity</div>
            </div>

            <!-- Galerie -->
            <div class="gallery-grid" id="gallery">
                ${files.map(file => {
        const isActive = usedLogos.has(file);
        const isDuplicate = duplicateGroups[file] || duplicates.exact.some(d => d.duplicate === file);
        const isSimilar = duplicates.similar.some(d => d.image1 === file || d.image2 === file);
        const fileData = imageHashes.find(h => h.filename === file);
        const size = fileData ? (fileData.size / 1024).toFixed(1) : '?';

        return `
                    <div class="gallery-item ${isActive ? '' : 'unused'} ${isDuplicate ? 'duplicate' : ''} ${isSimilar ? 'similar' : ''}" 
                         data-filename="${file}" 
                         data-status="${isActive ? 'active' : 'unused'}"
                         data-duplicate="${isDuplicate || isSimilar}">
                        <input type="checkbox" class="checkbox" onchange="toggleSelection('${file}')">
                        <span class="status-badge ${isActive ? 'active' : 'unused'}">
                            ${isActive ? 'POUŽÍVÁ SE' : 'NEVYUŽITO'}
                        </span>
                        ${isDuplicate ? `<div class="duplicate-badge">⚠️ Duplicitní</div>` : ''}
                        ${isSimilar && !isDuplicate ? `<div class="similar-badge">~ Podobný</div>` : ''}
                        <img src="/logoteamu/${file}" alt="${file}" onclick="openModal('/logoteamu/${file}')">
                        <div class="info">
                            <div class="name">${file}</div>
                            <div class="meta">${size} KB</div>
                        </div>
                        <div class="actions">
                            ${!isActive
            ? `<a href="/admin/images/delete/${file}" class="delete" onclick="return confirm('Opravdu smazat tento obrázek?')">Smazat</a>`
            : `<button class="delete" disabled title="Nelze smazat používané logo">Smazat</button>`
        }
                        </div>
                    </div>
                    `;
    }).join('')}
            </div>
            
            ${files.length === 0 ? '<p style="text-align:center; color: gray; padding: 40px;">Žádné obrázky nenalezeny.</p>' : ''}

            <!-- Bulk actions -->
            <div class="bulk-actions" id="bulkActions">
                <span id="selectedCount">0 vybráno</span>
                <button class="btn" onclick="deleteSelected()" style="background: #ff4444; color: white;">Smazat vybrané</button>
                <button class="btn" onclick="clearSelection()" style="background: #666;">Zrušit výběr</button>
            </div>

            <!-- Modal -->
            <div class="modal-overlay" id="modal" onclick="closeModal()">
                <div class="modal-content" onclick="event.stopPropagation()">
                    <img id="modalImage" src="" alt="">
                    <div style="display: flex; justify-content: center; gap: 10px; margin-top: 20px;">
                        <a id="modalDelete" class="btn" style="background: #ff4444; color: white;" href="#">Smazat</a>
                        <button class="btn" onclick="closeModal()" style="background: #666;">Zavřít</button>
                    </div>
                </div>
            </div>
        </main>

        <script>
            let selectedFiles = new Set();
            let filesToUpload = [];

            // Drag and drop
            const dropZone = document.getElementById('dropZone');
            
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                dropZone.addEventListener(eventName, preventDefaults, false);
            });
            
            function preventDefaults(e) {
                e.preventDefault();
                e.stopPropagation();
            }
            
            ['dragenter', 'dragover'].forEach(eventName => {
                dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
            });
            
            ['dragleave', 'drop'].forEach(eventName => {
                dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
            });
            
            dropZone.addEventListener('drop', (e) => handleFiles(e.dataTransfer.files), false);

            async function handleFiles(files) {
                filesToUpload = Array.from(files).filter(f => f.type.startsWith('image/'));
                if (filesToUpload.length === 0) return;

                const preview = document.getElementById('uploadPreview');
                const warning = document.getElementById('duplicateWarning');
                const uploadBtn = document.getElementById('uploadBtn');
                preview.innerHTML = '';
                warning.innerHTML = '';
                warning.classList.remove('visible');

                // Kontrola duplicit na serveru
for (const file of filesToUpload) {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const div = document.createElement('div');
                        div.className = 'preview-item';
                        div.innerHTML = \`
                            <img src="\${e.target.result}" alt="">
                            <div class="filename">\${file.name}</div>
                        \`;
                        preview.appendChild(div);
                    };
                    reader.readAsDataURL(file);
                }

                uploadBtn.style.display = 'inline-block';
                
                // Kontrola duplicit přes API
                try {
                    const formData = new FormData();
                    filesToUpload.forEach(f => formData.append('files', f));
                    
                    const response = await fetch('/admin/images/check-duplicates', {
                        method: 'POST',
                        body: formData
                    });
                    
                    if (response.ok) {
                        const result = await response.json();
                        if (result.conflicts && result.conflicts.length > 0) {
                            warning.innerHTML = \`⚠️ Nalezeny potenciální duplicity: \${result.conflicts.length} souborů (\${result.conflicts.map(c => c.conflicts.map(cc => cc.type).join(', ')).flat().filter((v,i,a) => a.indexOf(v)===i).join(', ')})\`;
                            warning.classList.add('visible');
                            
                            // Označení duplicit v preview
                            result.conflicts.forEach((conflict, idx) => {
                                if (conflict.conflicts.length > 0) {
                                    const badge = document.createElement('div');
                                    badge.className = conflict.conflicts.some(c => c.type === 'exact') ? 'duplicate-badge' : 'similar-badge';
                                    badge.textContent = conflict.conflicts.some(c => c.type === 'exact') ? 'Duplicitní' : 'Podobný';
                                    preview.children[idx]?.appendChild(badge);
                                }
                            });
                        }
                    }
                } catch (err) {
                    console.error('Chyba při kontrole duplicit:', err);
                }
            }

            async function uploadFiles() {
                if (filesToUpload.length === 0) return;
                
                const uploadBtn = document.getElementById('uploadBtn');
                uploadBtn.disabled = true;
                uploadBtn.textContent = '⏳ Nahrávám...';

                try {
                    const formData = new FormData();
                    filesToUpload.forEach(f => formData.append('images', f));
                    formData.append('_csrf', '${req.session.csrfToken || ''}');

                    const response = await fetch('/admin/images/batch-upload', {
                        method: 'POST',
                        body: formData
                    });

                    if (response.ok) {
                        const result = await response.json();
                        alert(\`✅ Nahráno \${result.uploaded} souborů\${result.skipped > 0 ? ', přeskočeno ' + result.skipped + ' duplicit' : ''}\`);
                        window.location.reload();
                    } else {
                        alert('❌ Chyba při nahrávání');
                    }
                } catch (err) {
                    alert('❌ Chyba: ' + err.message);
                } finally {
                    uploadBtn.disabled = false;
                    uploadBtn.textContent = '🚀 Nahrát vybrané soubory';
                }
            }

            function toggleSelection(filename) {
                if (selectedFiles.has(filename)) {
                    selectedFiles.delete(filename);
                } else {
                    selectedFiles.add(filename);
                }
                updateBulkActions();
            }

            function updateBulkActions() {
                const bulkActions = document.getElementById('bulkActions');
                const count = document.getElementById('selectedCount');
                
                count.textContent = selectedFiles.size + ' vybráno';
                
                if (selectedFiles.size > 0) {
                    bulkActions.classList.add('visible');
                } else {
                    bulkActions.classList.remove('visible');
                }

                // Update visual selection
                document.querySelectorAll('.gallery-item').forEach(item => {
                    if (selectedFiles.has(item.dataset.filename)) {
                        item.classList.add('selected');
                    } else {
                        item.classList.remove('selected');
                    }
                });
            }

            function clearSelection() {
                selectedFiles.clear();
                document.querySelectorAll('.gallery-item .checkbox').forEach(cb => cb.checked = false);
                updateBulkActions();
            }

            async function deleteSelected() {
                if (selectedFiles.size === 0) return;
                
                if (!confirm(\`Opravdu smazat \${selectedFiles.size} vybraných obrázků?\`)) return;
                
                let deleted = 0;
                for (const filename of selectedFiles) {
                    try {
                        const response = await fetch(\`/admin/images/delete/\${filename}\`);
                        if (response.ok || response.redirected) deleted++;
                    } catch (err) {
                        console.error('Chyba při mazání:', filename);
                    }
                }
                
                alert(\`Smazáno \${deleted} obrázků\`);
                window.location.reload();
            }

            function filterImages(type) {
                document.querySelectorAll('.filter-tab').forEach(tab => tab.classList.remove('active'));
                event.target.classList.add('active');

                const items = document.querySelectorAll('.gallery-item');
                items.forEach(item => {
                    const isActive = item.dataset.status === 'active';
                    const isDuplicate = item.dataset.duplicate === 'true';
                    
                    switch(type) {
                        case 'active':
                            item.style.display = isActive ? '' : 'none';
                            break;
                        case 'unused':
                            item.style.display = !isActive ? '' : 'none';
                            break;
                        case 'duplicates':
                            item.style.display = isDuplicate ? '' : 'none';
                            break;
                        default:
                            item.style.display = '';
                    }
                });
            }

            function openModal(src) {
                document.getElementById('modalImage').src = src;
                document.getElementById('modalDelete').href = src.replace('/logoteamu/', '/admin/images/delete/');
                document.getElementById('modal').classList.add('visible');
            }

            function closeModal() {
                document.getElementById('modal').classList.remove('visible');
            }

            // Keyboard shortcuts
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeModal();
            });
        </script>
    </body>
    </html>`;
    res.send(html);
});

// Endpoint pro kontrolu duplicit před uploadem
router.post('/images/check-duplicates', requireAdmin, upload.any(), async (req, res) => {
    try {
        const imagesDir = path.join(__dirname, '..', 'data', 'images');
        const existingImages = await scanImageHashes(imagesDir);
        
        const conflicts = [];
        
        for (const file of req.files || []) {
            const result = await checkNewFileDuplicate(file.path, existingImages, {
                similarThreshold: 0,  // POUZE IDENTICKÉ SOUBORY, žádná vizuální podobnost
                checkFilename: true
            });
            conflicts.push({
                filename: file.originalname,
                conflicts: result.conflicts
            });
            // Vyčistíme temp file
            try { fs.unlinkSync(file.path); } catch (e) {}
        }
        
        res.json({ conflicts });
    } catch (err) {
        console.error('Chyba při kontrole duplicit:', err);
        res.status(500).json({ error: 'Chyba při kontrole duplicit' });
    }
});

// Endpoint pro batch upload
router.post('/images/batch-upload', requireAdmin, upload.any(), async (req, res) => {
    try {
        const imagesDir = path.join(__dirname, '..', 'data', 'images');
        const existingImages = await scanImageHashes(imagesDir);
        
        let uploaded = 0;
        let skipped = 0;
        const uploadedFiles = [];
        
        for (const file of req.files || []) {
            // Kontrola duplicit - pouze identické soubory, žádná vizuální podobnost
            const check = await checkNewFileDuplicate(file.path, existingImages, {
                similarThreshold: 0,
                checkFilename: true
            });
            
            if (check.isDuplicate && check.conflicts.some(c => c.type === 'exact' || c.type === 'filename')) {
                // Přeskočíme identické duplicity a konflikty názvů
                skipped++;
                try { fs.unlinkSync(file.path); } catch (e) {}
                continue;
            }
            
            // Soubor je unikátní, ponecháme ho
            uploaded++;
            uploadedFiles.push(file.filename);
            
            // Přidáme hash do existujících pro další kontrolu
            existingImages.push({
                filename: file.filename,
                fileHash: check.fileHash,
                perceptualHash: check.perceptualHash
            });
        }
        
        // Synchronizace hashi do MongoDB
        try {
            const { connectToDatabase } = require('../config/database');
            const db = await connectToDatabase();
            await syncImageHashesToDatabase(db, imagesDir);
        } catch (err) {
            console.error('Chyba při synchronizaci hashi:', err);
        }
        
        await logAdminAction(req.session.user, "BATCH_UPLOAD", `Nahráno ${uploaded} obrázků (přeskočeno ${skipped} duplicit)`);
        
        res.json({ success: true, uploaded, skipped, files: uploadedFiles });
    } catch (err) {
        console.error('Chyba při batch uploadu:', err);
        res.status(500).json({ error: 'Chyba při nahrávání souborů' });
    }
});
router.get('/images/reset-hashes', requireAdmin, async (req, res) => {
    try {
        path.join(__dirname, '..', 'data', 'images');
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        
        // Smažeme kolekci hashů
        await db.collection('image_hashes').deleteMany({});
        console.log('[Reset Hashes] Kolekce image_hashes smazána');
        
        // Přesměrujeme zpět do galerie
        res.redirect('/admin/images/manage');
    } catch (err) {
        console.error('Chyba při resetu hashů:', err);
        res.status(500).send('Chyba při resetu hashů: ' + err.message);
    }
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
    await logAdminAction(req.session.user, "SMAZÁNÍ_OBRÁZKU", `Permanentně smazán obrázek z webu i zálohy: ${filename}`);
    
    // 3. Záznam do MongoDB o smazaném obrázku (aby se nepři restore znovu nestáhl)
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const deletedImagesCollection = db.collection('deleted_images');
        await deletedImagesCollection.insertOne({
            filename: filename,
            deletedAt: new Date(),
            deletedBy: req.session.user
        });
        console.log(`📝 Záznam o smazaném obrázku ${filename} uložen do MongoDB`);
    } catch (err) {
        console.error(`⚠️ Chyba při záznamu smazaného obrázku:`, err.message);
    }

    // 4. Smazání hash z image_hashes kolekce
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        await db.collection('image_hashes').deleteOne({ filename: filename });
    } catch (err) {
        console.error(`⚠️ Chyba při mazání hashe:`, err.message);
    }
    
    res.redirect('/admin/images/manage');
});

// Endpoint pro modal výběru obrázku (použitelný z formulářů)
router.get('/images/selector', requireAdmin, async (req, res) => {
    const availableImages = getAvailableImages();
    const callbackField = req.query.callback || 'selectedLogo';
    const previewId = req.query.preview || 'logoPreview';
    
    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Výběr obrázku</title>
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body { 
                font-family: Arial, sans-serif; 
                background: #0d1117; 
                color: #fff;
                padding: 20px;
            }
            h2 { margin-bottom: 15px; color: #00d4ff; }
            .gallery { 
                display: grid; 
                grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); 
                gap: 12px; 
                max-height: 70vh;
                overflow-y: auto;
                padding: 10px;
            }
            .gallery-item { 
                position: relative; 
                cursor: pointer; 
                border: 3px solid transparent; 
                border-radius: 8px; 
                overflow: hidden;
                transition: all 0.2s;
                background: #1a1a2e;
            }
            .gallery-item:hover { 
                border-color: #00d4ff; 
                transform: scale(1.05);
                box-shadow: 0 4px 15px rgba(0,212,255,0.3);
            }
            .gallery-item.selected { 
                border-color: #00ff00; 
                box-shadow: 0 0 15px rgba(0,255,0,0.4);
            }
            .gallery-item img { 
                width: 100%; 
                height: 80px; 
                object-fit: cover;
                display: block;
            }
            .gallery-item .info {
                padding: 5px;
                font-size: 0.7em;
                color: #888;
                text-align: center;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .actions { 
                display: flex; 
                gap: 10px; 
                margin-top: 20px;
                justify-content: flex-end;
            }
            .btn { 
                padding: 10px 20px; 
                border: none; 
                border-radius: 6px; 
                cursor: pointer;
                font-weight: bold;
            }
            .btn-primary { background: #00d4ff; color: #000; }
            .btn-secondary { background: #666; color: #fff; }
            .btn:hover { opacity: 0.9; }
            .search-box {
                width: 100%;
                padding: 10px;
                margin-bottom: 15px;
                background: #1a1a2e;
                border: 1px solid #444;
                border-radius: 6px;
                color: #fff;
            }
            .empty-state {
                text-align: center;
                padding: 40px;
                color: #888;
            }
            .stats {
                margin-bottom: 10px;
                color: #888;
                font-size: 0.9em;
            }
        </style>
    </head>
    <body>
        <h2>🖼️ Vyberte obrázek</h2>
        <div class="stats">Celkem dostupných: ${availableImages.length} obrázků</div>
        <input type="text" class="search-box" id="searchBox" placeholder="🔍 Hledat obrázek..." onkeyup="filterImages()">
        
        ${availableImages.length === 0 ? 
            `<div class="empty-state">
                <p>Žádné obrázky nejsou k dispozici.</p>
                <p style="font-size: 0.85em; margin-top: 10px;">Nejprve nahrajte obrázky do galerie.</p>
            </div>` :
            `<div class="gallery" id="gallery">
                ${availableImages.map(img => `
                    <div class="gallery-item" data-filename="${img.filename}" data-path="${img.path}" onclick="selectImage('${img.filename}', '${img.path}')">
                        <img src="${img.path}" alt="${img.filename}">
                        <div class="info">${img.filename}<br>${img.size} KB</div>
                    </div>
                `).join('')}
            </div>`
        }
        
        <div class="actions">
            <button class="btn btn-secondary" onclick="closeSelector()">Zrušit</button>
            <button class="btn btn-primary" onclick="confirmSelection()" id="confirmBtn" style="display: none;">Vybrat</button>
        </div>
        
        <script>
            let selectedFilename = null;
            let selectedPath = null;
            const callbackField = '${callbackField}';
            const previewId = '${previewId}';
            
            function selectImage(filename, path) {
                document.querySelectorAll('.gallery-item').forEach(item => item.classList.remove('selected'));
                document.querySelector('[data-filename="' + filename + '"]').classList.add('selected');
                selectedFilename = filename;
                selectedPath = path;
                document.getElementById('confirmBtn').style.display = 'block';
            }
            
            function confirmSelection() {
                if (!selectedFilename) return;
                
                // Odeslat zprávu rodičovskému oknu
                if (window.opener && !window.opener.closed) {
                    window.opener.postMessage({
                        type: 'imageSelected',
                        filename: selectedFilename,
                        path: selectedPath,
                        callbackField: callbackField,
                        previewId: previewId
                    }, '*');
                }
                
                // Zavřít okno
                window.close();
            }
            
            function closeSelector() {
                window.close();
            }
            
            function filterImages() {
                const search = document.getElementById('searchBox').value.toLowerCase();
                document.querySelectorAll('.gallery-item').forEach(item => {
                    const filename = item.dataset.filename.toLowerCase();
                    item.style.display = filename.includes(search) ? '' : 'none';
                });
            }
            
            // Dvojklik pro rychlý výběr
            document.querySelectorAll('.gallery-item').forEach(item => {
                item.addEventListener('dblclick', () => {
                    selectImage(item.dataset.filename, item.dataset.path);
                    confirmSelection();
                });
            });
            
            // ESC pro zavření
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeSelector();
            });
        </script>
    </body>
    </html>`;
    res.send(html);
});

router.get('/transfers/manage', requireAdmin, async (req, res) => {
    const teams = await Teams.findAll();
    const selectedSeason = await ChosenSeason.findAll();
    const allowedLeagues = await AllowedLeagues.findAll();

    const selectedLiga = req.query.liga || allowedLeagues[0];

    let transfersData = await Transfers.findAll();
    if (!transfersData || Object.keys(transfersData).length === 0) transfersData = {};

    const currentTransfers = transfersData[selectedSeason]?.[selectedLiga] || {};
    // Filter teams by selectedSeason - admin should only see teams from current season
    const teamsFromCurrentSeason = teams.filter(t => t.season === selectedSeason);
    const teamsInLiga = teamsFromCurrentSeason.filter(t => t.liga === selectedLiga && t.active);

    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
                        <span class="code-tag">(K)</span> = <span style="color: orange; font-weight: bold;"></span>
                    </div>
                    <div class="legend-item">
                        <span class="code-tag">(-)</span> = <span style="color: #888; text-decoration: line-through; opacity: 0.5; font-style: italic;">🚫 Konec smlouvy</span>
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

            <form method="POST" action="/admin/transfers/save?_csrf=${req.session.csrfToken || ''}" enctype="multipart/form-data">
                <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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

                <!-- NOTIFIKAČNÍ NASTAVENÍ -->
                <div style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); border: 2px solid #00d4ff; padding: 20px; margin: 20px 0;">
                    <h3 style="margin: 0 0 15px 0; color: #00d4ff; display: flex; align-items: center; gap: 10px;">
                        🔔 Notifikační nastavení
                    </h3>
                    
                    <!-- Zapnout/vypnout notifikace -->
                    <label style="display: flex; align-items: center; gap: 10px; color: white; cursor: pointer; margin-bottom: 15px;">
                        <input type="checkbox" name="sendNotification" id="sendNotification" style="transform: scale(1.3);" checked>
                        <strong>Poslat push notifikaci o změnách</strong>
                    </label>
                    
                    <!-- Typ obrázku -->
                    <div style="margin-bottom: 15px;">
                        <label style="color: #aaa; display: block; margin-bottom: 8px;">Typ obrázku v notifikaci:</label>
                        <div style="display: flex; gap: 15px; flex-wrap: wrap;">
                            <label style="display: flex; align-items: center; gap: 8px; color: white; cursor: pointer;">
                                <input type="radio" name="imageType" value="auto" checked onchange="toggleImageSections()">
                                <span>🤖 Auto (z týmů)</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 8px; color: white; cursor: pointer;">
                                <input type="radio" name="imageType" value="generate" onchange="toggleImageSections()">
                                <span>🎨 Generovat obrázek</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 8px; color: white; cursor: pointer;">
                                <input type="radio" name="imageType" value="custom" onchange="toggleImageSections()">
                                <span>🖼️ Vlastní obrázek</span>
                            </label>
                            <label style="display: flex; align-items: center; gap: 8px; color: white; cursor: pointer;">
                                <input type="radio" name="imageType" value="none" onchange="toggleImageSections()">
                                <span>❌ Bez obrázku</span>
                            </label>
                        </div>
                    </div>
                    
                    <!-- Semi-auto generování obrázku (skryté默认) -->
                    <div id="generateImageSection" style="display: none; margin-bottom: 15px; padding: 15px; background: rgba(0,0,0,0.3); border: 1px solid #00d4ff;">
                        <h4 style="color: #00d4ff; margin: 0 0 15px 0;">🎨 Nastavení obrázku</h4>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom: 15px;">
                            <div>
                                <label style="color: #aaa; display: block; margin-bottom: 5px;">Z týmu:</label>
                                <select name="genFromTeam" style="width: 100%; padding: 8px; background: #111; border: 1px solid #444; color: white;">
                                    <option value="">Vyber tým</option>
                                    ${teamsInLiga.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                                </select>
                            </div>
                            <div>
                                <label style="color: #aaa; display: block; margin-bottom: 5px;">Do týmu:</label>
                                <select name="genToTeam" style="width: 100%; padding: 8px; background: #111; border: 1px solid #444; color: white;">
                                    <option value="">Vyber tým</option>
                                    ${teamsInLiga.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                                </select>
                            </div>
                        </div>
                        <div style="margin-bottom: 15px;">
                            <label style="color: #aaa; display: block; margin-bottom: 5px;">Jméno hráče (nepovinné):</label>
                            <input type="text" name="genPlayerName" placeholder="např. Jan Novák" style="width: 100%; padding: 8px; background: #111; border: 1px solid #444; color: white;">
                        </div>
                        <div style="margin-bottom: 15px;">
                            <label style="color: #aaa; display: block; margin-bottom: 5px;">Fotka hráče (nepovinné):</label>
                            <input type="file" name="genPlayerPhoto" accept="image/*" id="genPlayerPhoto" style="color: white; width: 100%;">
                            <input type="hidden" name="selectedGenPlayerPhoto" id="selectedGenPlayerPhoto" value="">
                            <button type="button" class="btn" style="background: #444; color: white; padding: 5px 10px; font-size: 0.85em; margin-top: 8px; width: 100%;" onclick="openImageSelector('selectedGenPlayerPhoto', 'genPlayerPhotoPreview')">🖼️ Vybrat z galerie</button>
                            <img id="genPlayerPhotoPreview" src="" style="width: 60px; height: 60px; object-fit: contain; margin-top: 5px; display: none;" alt=""/>
                            <p style="color: #888; font-size: 0.85em; margin: 5px 0 0 0;">Max 2MB, zobrazí se mezi týmy</p>
                        </div>
                        <div style="display: flex; gap: 10px; align-items: center;">
                            <button type="button" onclick="previewTransferImage()" class="btn" style="background: #00d4ff; color: #000; border: none; padding: 10px 20px; cursor: pointer;">
                                👁️ Náhled obrázku
                            </button>
                            <span id="previewStatus" style="color: #888; font-size: 0.9em;"></span>
                        </div>
                        <!-- Náhled obrázku -->
                        <div id="imagePreview" style="display: none; margin-top: 15px; text-align: center;">
                            <img id="previewImg" src="" alt="Náhled" style="max-width: 100%; max-height: 300px; border: 2px solid #00d4ff;">
                            <input type="hidden" name="generatedImageUrl" id="generatedImageUrl">
                        </div>
                    </div>
                    
                    <!-- Upload vlastního obrázku (skrytý) -->
                    <div id="customImageUpload" style="display: none; margin-bottom: 15px; padding: 15px; background: rgba(0,0,0,0.3);">
                        <label style="color: #00d4ff; display: block; margin-bottom: 10px;">Nahrát obrázek hráče/týmu:</label>
                        <input type="file" name="customImage" accept="image/*" id="customImageFile" style="color: white; padding: 10px; background: #111; border: 1px solid #00d4ff; width: 100%; max-width: 400px;">
                        <input type="hidden" name="selectedCustomImage" id="selectedCustomImage" value="">
                        <button type="button" class="btn" style="background: #444; color: white; padding: 5px 10px; font-size: 0.85em; margin-top: 8px; width: 100%; max-width: 400px;" onclick="openImageSelector('selectedCustomImage', 'customImagePreview')">🖼️ Vybrat z galerie</button>
                        <img id="customImagePreview" src="" style="width: 100px; height: 100px; object-fit: contain; margin-top: 5px; display: none; border: 1px solid #00d4ff;" alt=""/>
                        <p style="color: #888; font-size: 0.85em; margin: 5px 0 0 0;">Doporučené rozměry: 800x400px, max 5MB</p>
                    </div>
                    
                    <!-- Vlastní zpráva -->
                    <div style="margin-bottom: 10px;">
                        <label style="color: #aaa; display: block; margin-bottom: 8px;">Vlastní text zprávy (volitelné):</label>
                        <input type="text" name="customMessage" placeholder="Např: Bomba! Nový hvězdný hráč v lize..." style="width: 100%; max-width: 500px; padding: 10px; background: #111; border: 1px solid #444; color: white;">
                    </div>
                </div>

                <script>
                    // Otevře popup pro výběr obrázku
                    function openImageSelector(hiddenInputId, previewId) {
                        const popup = window.open(
                            '/admin/images/selector?callback=' + hiddenInputId + '&preview=' + previewId,
                            'imageSelector',
                            'width=900,height=700,scrollbars=yes,resizable=yes,top=100,left=100'
                        );
                        
                        if (!popup || popup.closed || typeof popup.closed === 'undefined') {
                            alert('Popup byl zablokován. Povolte popup okna pro tento web.');
                        }
                    }
                    
                    // Posluchač pro zprávu z popup okna
                    window.addEventListener('message', function(event) {
                        if (event.data && event.data.type === 'imageSelected') {
                            const { filename, path, callbackField, previewId } = event.data;
                            
                            // Nastavit hidden input
                            const hiddenInput = document.getElementById(callbackField);
                            if (hiddenInput) {
                                hiddenInput.value = filename;
                            }
                            
                            // Zobrazit náhled
                            const preview = document.getElementById(previewId);
                            if (preview) {
                                preview.src = path;
                                preview.style.display = 'block';
                            }
                            
                            // Vyčistit file input (pokud je vybrán existující, nový soubor se nepoužije)
                            let fileInput;
                            if (callbackField === 'selectedGenPlayerPhoto') {
                                fileInput = document.querySelector('input[type="file"][name="genPlayerPhoto"]');
                            } else if (callbackField === 'selectedCustomImage') {
                                fileInput = document.querySelector('input[type="file"][name="customImage"]');
                            }
                            if (fileInput) {
                                fileInput.value = '';
                            }
                        }
                    });

                    function toggleImageSections() {
                        const imageType = document.querySelector('input[name="imageType"]:checked').value;
                        const customUpload = document.getElementById('customImageUpload');
                        const generateSection = document.getElementById('generateImageSection');
                        
                        customUpload.style.display = imageType === 'custom' ? 'block' : 'none';
                        generateSection.style.display = imageType === 'generate' ? 'block' : 'none';
                    }
                    
                    async function previewTransferImage() {
                        const fromTeam = document.querySelector('select[name="genFromTeam"]').value;
                        const toTeam = document.querySelector('select[name="genToTeam"]').value;
                        const playerName = document.querySelector('input[name="genPlayerName"]').value;
                        const playerPhotoInput = document.querySelector('input[name="genPlayerPhoto"]');
                        const previewStatus = document.getElementById('previewStatus');
                        const imagePreview = document.getElementById('imagePreview');
                        const previewImg = document.getElementById('previewImg');
                        const generatedImageUrl = document.getElementById('generatedImageUrl');
                        
                        if (!fromTeam || !toTeam) {
                            previewStatus.textContent = '❌ Vyber oba týmy!';
                            previewStatus.style.color = '#ff6666';
                            return;
                        }
                        
                        previewStatus.textContent = '⏳ Generuji náhled...';
                        previewStatus.style.color = '#00d4ff';
                        
                        try {
                            const formData = new FormData();
                            formData.append('fromTeamId', fromTeam);
                            formData.append('toTeamId', toTeam);
                            formData.append('playerName', playerName);
                            formData.append('watermark', 'true');
                            if (playerPhotoInput.files[0]) {
                                formData.append('playerPhoto', playerPhotoInput.files[0]);
                            }
                            
                            const res = await fetch('/admin/transfers/generate-preview', {
                                method: 'POST',
                                body: formData
                            });
                            
                            if (res.ok) {
                                const result = await res.json();
                                previewImg.src = result.url + '?t=' + Date.now();
                                generatedImageUrl.value = result.url;
                                imagePreview.style.display = 'block';
                                previewStatus.textContent = '✅ Obrázek vygenerován!';
                                previewStatus.style.color = '#00ff00';
                            } else {
                                previewStatus.textContent = '❌ Chyba při generování';
                                previewStatus.style.color = '#ff6666';
                            }
                        } catch (err) {
                            console.error(err);
                            previewStatus.textContent = '❌ Chyba při generování';
                            previewStatus.style.color = '#ff6666';
                        }
                    }
                </script>

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

// Endpoint pro generování náhledu obrázku přestupu
router.post('/transfers/generate-preview', express.urlencoded({ extended: true }), requireAdmin, upload.single('playerPhoto'), async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    try {
        const { fromTeamId, toTeamId, playerName, watermark } = req.body;
        
        const teams = await Teams.findAll();
        const fromTeam = teams.find(t => t.id === parseInt(fromTeamId));
        const toTeam = teams.find(t => t.id === parseInt(toTeamId));
        
        if (!fromTeam || !toTeam) {
            return res.status(400).json({ error: 'Týmy nenalezeny' });
        }
        
        // Import createTransferImage z fileUtils (správná verze s podporou playerName a fotky)
        const { createTransferImage } = require('../utils/fileUtils');
        
        let playerPhotoPath = null;
        if (req.file) {
            playerPhotoPath = req.file.path;
        }
        
        const buffer = await createTransferImage(
            fromTeam, 
            toTeam, 
            playerName || null, 
            watermark !== 'false',
            playerPhotoPath
        );
        
        // Uložit obrázek do public/images/notifications
        const fs = require('fs');
        const path = require('path');
        const notifDir = path.join(__dirname, '../public/images/notifications');
        
        if (!fs.existsSync(notifDir)) {
            fs.mkdirSync(notifDir, { recursive: true });
        }
        
        const timestamp = Date.now();
        const filename = `transfer-generated-${timestamp}.png`;
        const outPath = path.join(notifDir, filename);
        
        fs.writeFileSync(outPath, buffer);
        
        // Vyčistit temporary file pokud existuje
        if (playerPhotoPath && fs.existsSync(playerPhotoPath)) {
            try { fs.unlinkSync(playerPhotoPath); } catch (e) {}
        }
        
        const publicUrl = `/images/notifications/${filename}`;
        res.json({ url: publicUrl, filename });
        
    } catch (err) {
        console.error('Chyba při generování náhledu:', err);
        res.status(500).json({ error: 'Chyba při generování náhledu' });
    }
});

router.post('/transfers/save', express.urlencoded({ extended: true }), requireAdmin, upload.any(), async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const notif = require('./notificationService');

    const { liga, season, t, sendNotification, imageType, customMessage } = req.body;

    // Kontrola, zda máme data týmů
    if (!t) {
        console.error("CHYBA: Objekt 't' s daty týmů chybí v req.body!");
        return res.redirect('back');
    }

    // Zpracování checkboxu - přijde jako string 'on' když je zaškrtnuto
    const shouldSendNotification = sendNotification === 'on';

    // Načtení z MongoDB
    let teams = await Teams.findAll();
    let transfersData = await Transfers.findAll();
    
    if (!transfersData || Object.keys(transfersData).length === 0) transfersData = {};

    if (!transfersData[season]) transfersData[season] = {};
    if (!transfersData[season][liga]) transfersData[season][liga] = {};

    let newTransfersNotification = [];
    let involvedTeams = []; // NOVÉ: Pole pro sledování týmů, kterých se změna týká

    for (const rawKey in t) {
        const teamId = rawKey.replace('id_', '');
        const teamObj = t[rawKey];

        const cleanList = (text) => text ? text.split('\n').map(name => name.trim()).filter(name => name !== "") : [];

        const newConfIn = cleanList(teamObj.confIn);
        const newConfOut = cleanList(teamObj.confOut);
        const newSpecIn = cleanList(teamObj.specIn);
        const newSpecOut = cleanList(teamObj.specOut);

        const oldData = transfersData[season][liga][teamId] || {};
        const oldConfIn = Array.isArray(oldData.confIn) ? oldData.confIn.map(p => p.trim()) : [];
        const oldConfOut = Array.isArray(oldData.confOut) ? oldData.confOut.map(p => p.trim()) : [];
        const oldSpecIn = Array.isArray(oldData.specIn) ? oldData.specIn.map(p => p.trim()) : [];
        const oldSpecOut = Array.isArray(oldData.specOut) ? oldData.specOut.map(p => p.trim()) : [];

        const teamName = teams.find(tm => Number(tm.id) === Number(teamId))?.name || `Tým ${teamId}`;
        const getAdded = (newArr, oldArr) => newArr.filter(p => p !== "" && !oldArr.includes(p));

        let hasChanged = false; // Detekce, zda se u tohoto týmu něco změnilo

        getAdded(newConfIn, oldConfIn).forEach(p => { newTransfersNotification.push(`✅ ${p} -> ${teamName}`); hasChanged = true; });
        getAdded(newConfOut, oldConfOut).forEach(p => { newTransfersNotification.push(`❌ ${p} opouští ${teamName}`); hasChanged = true; });
        getAdded(newSpecIn, oldSpecIn).forEach(p => { 
            const isResolvedSpec = p.includes('(-)');
            const cleanName = p.replace('(-)', '').trim();
            if (isResolvedSpec) {
                newTransfersNotification.push(`🚫 Spekulace o ${cleanName} ukončena`);
            } else {
                newTransfersNotification.push(`❓ ${p} (spekulace) -> ${teamName}`);
            }
            hasChanged = true; 
        });
        getAdded(newSpecOut, oldSpecOut).forEach(p => { 
            const isResolvedSpec = p.includes('(-)');
            const cleanName = p.replace('(-)', '').trim();
            if (isResolvedSpec) {
                newTransfersNotification.push(`🚫 Spekulace o odchodu ${cleanName} ukončena`);
            } else {
                newTransfersNotification.push(`⚠️ ${p} (možný odchod) -> ${teamName}`);
            }
            hasChanged = true; 
        });

        // Pokud se tým změnil, přidáme ho do seznamu pro obrázek v notifikaci
        if (hasChanged) {
            const teamFullInfo = teams.find(tm => Number(tm.id) === Number(teamId));
            if (teamFullInfo) involvedTeams.push(teamFullInfo);
        }

        transfersData[season][liga][teamId] = {
            specIn: newSpecIn,
            specOut: newSpecOut,
            confIn: newConfIn,
            confOut: newConfOut
        };
    }

    // Uložení do MongoDB
    try {
        await Transfers.replaceAll(transfersData);
    } catch (err) {
        console.error("Chyba při zápisu do MongoDB:", err);
    }

    // NOTIFIKACE - pouze pokud je zaškrtnuto "Poslat push notifikaci"
    if (shouldSendNotification && newTransfersNotification.length > 0) {
        let message;
        
        // Použití vlastní zprávy pokud je zadána, jinak automatická
        if (customMessage && customMessage.trim()) {
            message = customMessage.trim();
        } else if (newTransfersNotification.length <= 4) {
            message = `Změny v kádrech: ${newTransfersNotification.join(', ')}`;
        } else {
            const firstFew = newTransfersNotification.slice(0, 3).join(', ');
            message = `Nové pohyby v lize (${newTransfersNotification.length}): ${firstFew} a další...`;
        }

        try {
            // Určení typu obrázku pro notifikaci
            let heroImageUrl = null;
            
            if (imageType === 'custom') {
                // Vlastní obrázek - buď nahraný soubor nebo vybraný z galerie
                const customImageFile = req.files && req.files.find(f => f.fieldname === 'customImage');
                const selectedCustomImage = req.body.selectedCustomImage;
                
                if (customImageFile) {
                    // Uživatel nahrál nový soubor
                    const fs = require('fs');
                    const path = require('path');
                    const notifDir = path.join(__dirname, '../public/images/notifications');
                    
                    if (!fs.existsSync(notifDir)) {
                        fs.mkdirSync(notifDir, { recursive: true });
                    }
                    
                    const timestamp = Date.now();
                    const ext = path.extname(customImageFile.originalname) || '.jpg';
                    const newFilename = `transfer-custom-${timestamp}${ext}`;
                    const destPath = path.join(notifDir, newFilename);
                    
                    fs.renameSync(customImageFile.path, destPath);
                    heroImageUrl = `/images/notifications/${newFilename}`;
                    console.log(`[Transfer] Vlastní obrázek (upload) uložen: ${heroImageUrl}`);
                } else if (selectedCustomImage) {
                    // Uživatel vybral obrázek z galerie
                    heroImageUrl = `/logoteamu/${selectedCustomImage}`;
                    console.log(`[Transfer] Vlastní obrázek (galerie) použit: ${heroImageUrl}`);
                }
            } else if (imageType === 'generate') {
                // Semi-auto vygenerovaný obrázek - URL je uložena v hidden inputu
                const { generatedImageUrl, selectedGenPlayerPhoto } = req.body;
                
                if (generatedImageUrl) {
                    heroImageUrl = generatedImageUrl;
                    console.log(`[Transfer] Vygenerovaný obrázek použit: ${heroImageUrl}`);
                }
                
                // Pokud byla vybrána fotka hráče z galerie, ale ještě nebyl vygenerován náhled,
                // můžeme ji použít pro notifikaci
                if (selectedGenPlayerPhoto && !heroImageUrl) {
                    heroImageUrl = `/logoteamu/${selectedGenPlayerPhoto}`;
                    console.log(`[Transfer] Fotka hráče z galerie použita: ${heroImageUrl}`);
                }
                
            } else if (imageType === 'auto') {
                // Auto-generovaný obrázek z týmů - ponecháme na notifyTransfer
                heroImageUrl = null; // bude vygenerováno v notifyTransfer
            }
            // imageType === 'none' => heroImageUrl zůstává null, bez obrázku
            
            // ZDE POSÍLÁME S VOLITELNÝM OBRÁZKEM
            await notif.notifyTransfer(message, involvedTeams, heroImageUrl);
            console.log(`[Transfer] Notifikace odeslána: ${message.substring(0, 50)}...`);
            
        } catch (err) {
            console.error("Selhalo volání notif.notifyTransfer:", err);
        }
    } else {
        console.log(`[Transfer] Notifikace přeskočena: send=${shouldSendNotification}, changes=${newTransfersNotification.length}`);
    }
    await logAdminAction(req.session.user, "PŘESTUPY", `Uloženy přestupy pro ligu ${liga}`);
    res.redirect(`/admin/transfers/manage?liga=${encodeURIComponent(liga)}`);
});

router.get('/broadcast-ping', requireAdmin, async (req, res) => {
    try {
        // 1. Čteme z MongoDB
        const users = await Users.findAll();

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
router.get('/users', requireAdmin, async (req, res) => {
    // Načtení z MongoDB
    const users = await Users.findAll();

    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
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
                                    <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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

router.post('/users/delete', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { usernameToDelete } = req.body;

    if (usernameToDelete === req.session.user) {
        return res.status(400).send("Chyba: Nemůžete smazat svůj vlastní účet.");
    }

    try {
        // 1. Smazání z MongoDB (Users) - použít deleteOne místo updateAll
        await Users.deleteOne({ username: usernameToDelete });

        // 2. Smazání z Tips (Tipy na zápasy)
        let tips = await Tips.findAll();
        if (tips && tips[usernameToDelete]) {
            delete tips[usernameToDelete];
            await Tips.replaceAll(tips);
        }

        // 3. Smazání z TableTips (Tipy na tabulky)
        let tableTips = await TableTips.findAll();
        if (tableTips && tableTips[usernameToDelete]) {
            delete tableTips[usernameToDelete];
            await TableTips.replaceAll(tableTips);
        }

        console.log(`🧹 Uživatel ${usernameToDelete} byl kompletně vymazán z MongoDB.`);
        await logAdminAction(req.session.user, "SMAZÁNÍ_UŽIVATELE", `Smazán účet: ${usernameToDelete}`);
        res.redirect('/admin/users');
    } catch (error) {
        console.error("Kritická chyba při mazání:", error);
        await logAdminAction(req.session.user, "POKUS_SMAZÁNÍ_UŽIVATELE", `Účet: ${usernameToDelete}`);
        res.status(500).send("Chyba při hloubkovém mazání uživatele.");
    }
});

// Formulář úpravy
router.get('/users/edit/:username', requireAdmin, async (req, res) => {
    const usernameToEdit = req.params.username;
    const users = await Users.findAll();
    const user = users.find(u => u.username === usernameToEdit);

    if (!user) return res.send("Uživatel nenalezen.");

    res.send(`
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/public/images/logo.png">
        <title>Upravit uživatele - ${user.username}</title>
            }
                margin-top: 0;
                border-bottom: 1px solid #fb6a18;
                padding-bottom: 10px;
            }
                margin-bottom: 20px;
            }
                margin-bottom: 8px;
                font-weight: bold;
            }
                box-sizing: border-box;
            }
                border-color: #fb6a18;
                outline: none;
            }
                font-weight: bold;
            }
            }
                margin-top: 20px;
                text-decoration: none;
            }
            }
    </head>
    <body class="usersite">
        <main class="admin_site">
            <div class="edit-card">
                <h1>Upravit účet</h1>
                <form action="/admin/users/update" method="POST">
                    <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
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
router.post('/users/update', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { oldUsername, newUsername, newPassword, newRole } = req.body;
    let users = await Users.findAll();

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

    await Users.updateAll(users);

    // Pokud se změnilo jméno, přepíšeme ho v tipech (Hloubková synchronizace)
    if (oldUsername !== newUsername) {
        // Aktualizace Tips
        let tips = await Tips.findAll();
        if (tips && tips[oldUsername]) {
            tips[newUsername] = tips[oldUsername];
            delete tips[oldUsername];
            await Tips.replaceAll(tips);
        }
        // Aktualizace TableTips
        let tableTips = await TableTips.findAll();
        if (tableTips && tableTips[oldUsername]) {
            tableTips[newUsername] = tableTips[oldUsername];
            delete tableTips[oldUsername];
            await TableTips.replaceAll(tableTips);
        }
    }
    await logAdminAction(req.session.user, "ÚPRAVA_UŽIVATELE", `Úprava účtu: ${oldUsername} -> ${newUsername}, Nová role: ${newRole || 'beze změny'}`);
    res.redirect('/admin/users');
});

router.get('/toggleLocked/:id', requireAdmin, async (req, res) => {
    const matchId = parseInt(req.params.id);
    const matches = await Matches.findAll();
    const match = matches.find(m => m.id === matchId);
    if (!match) return renderErrorHtml(res, "Zápas nebyl nalezen.", 404);

    // Provede změnu stavu zámku (true na false a naopak)
    match.locked = !match.locked;

    if (match.locked) {
        await removeTipsForDeletedMatch(matchId);
    }

    await Matches.replaceAll(matches);
    await logAdminAction(req.session.user, "ZÁMEK_ZÁPASU", `Zápas ID ${matchId} byl manuálně ${match.locked ? 'UZAMČEN' : 'ODEMČEN'}`);
    res.redirect('/admin');
});

// ==========================================
// HROMADNÉ ZAMKNUTÍ/ODEMKNUTÍ ZÁPASŮ (všechny v lize/sezóně)
// ==========================================
router.post('/matches/bulk-lock', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { liga, season, action, redirectUrl } = req.body;
    
    if (!liga || !season || !action) {
        return renderErrorHtml(res, "Chybí povinné parametry (liga, sezóna nebo akce).", 400);
    }
    
    if (action !== 'lock' && action !== 'unlock') {
        return renderErrorHtml(res, "Neplatná akce. Povolené hodnoty: 'lock' nebo 'unlock'.", 400);
    }
    
    try {
        // Načtení všech zápasů
        let matches = await Matches.findAll();
        const shouldLock = action === 'lock';
        
        // Filtrování zápasů podle ligy a sezóny
        let affectedCount = 0;
        
        for (const match of matches) {
            if (match.liga === liga && match.season === season) {
                // Normalizace locked hodnoty - může být boolean true/false, string "true"/"on", nebo undefined
                const isCurrentlyLocked = match.locked === true || match.locked === 'true' || match.locked === 'on' || match.locked === 1;
                
                // Pokud měníme na zamčeno a zápas není již zamčen, zamkneme ho
                // Pokud měníme na odemčeno a zápas je zamčen, odemkneme ho
                if (isCurrentlyLocked !== shouldLock) {
                    match.locked = shouldLock;
                    affectedCount++;
                    
                    // Pokud zamykáme, odstraníme tipy POUZE pokud zápas NENÍ vyhodnocený
                    // (u vyhodnocených zápasů ponecháme tipy pro historii)
                    if (shouldLock && !match.result) {
                        await removeTipsForDeletedMatch(match.id);
                    }
                }
            }
        }
        
        // Uložení změn
        await Matches.replaceAll(matches);
        
        const actionText = shouldLock ? 'UZAMČENY' : 'ODEMČENY';
        await logAdminAction(req.session.user, "HROMADNÝ_ZÁMEK", `${affectedCount} zápasů v lize ${liga} (${season}) bylo ${actionText}`);
        
        // Přesměrování zpět (buď na redirectUrl nebo na /admin)
        const redirect = redirectUrl || '/admin';
        res.redirect(redirect);
        
    } catch (error) {
        console.error('Chyba při hromadném zamknutí/odemknutí:', error);
        return renderErrorHtml(res, `Chyba při zpracování: ${error.message}`, 500);
    }
});

// ==========================================
// HROMADNÉ SMAZÁNÍ NEVYHODNOCENÝCH ZÁPASŮ
// ==========================================
router.post('/matches/bulk-delete', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { liga, season, redirectUrl } = req.body;
    
    if (!liga || !season) {
        return renderErrorHtml(res, "Chybí povinné parametry (liga nebo sezóna).", 400);
    }
    
    try {
        // Načtení všech zápasů
        let matches = await Matches.findAll();
        let deletedCount = 0;
        let preservedCount = 0;
        
        // Filtrování a mazání pouze nevyhodnocených zápasů
        const matchesToKeep = matches.filter(match => {
            if (match.liga === liga && match.season === season) {
                // Pokud zápas má výsledek (je vyhodnocený), ponecháme ho
                if (match.result) {
                    preservedCount++;
                    return true;
                }
                // Pokud zápas nemá výsledek, smažeme ho (nevrátíme ho do nového pole)
                deletedCount++;
                return false;
            }
            // Zápasy z jiných lig/sezón ponecháme
            return true;
        });
        
        // Uložení změn - pouze pokud se něco změnilo
        if (deletedCount > 0) {
            await Matches.replaceAll(matchesToKeep);
            
            await logAdminAction(req.session.user, "HROMADNÉ_SMAZÁNÍ", 
                `Smazeno ${deletedCount} nevyhodnocených zápasů v lize ${liga} (${season}), zachováno ${preservedCount} vyhodnocených`);
        }
        
        // Přesměrování zpět
        const redirect = redirectUrl || '/admin';
        res.redirect(redirect);
        
    } catch (error) {
        console.error('Chyba při hromadném mazání:', error);
        return renderErrorHtml(res, `Chyba při zpracování: ${error.message}`, 500);
    }
});

// ==========================================
// STRÁNKA PRO HROMADNÉ ZAMKNUTÍ/ODEMKNUTÍ
// ==========================================
router.get('/matches/bulk-lock', requireAdmin, async (req, res) => {
    const { liga, season } = req.query;
    
    // Načtení dat
    const allMatches = await Matches.findAll();
    const allowedLeagues = await AllowedLeagues.findAll();
    const currentSeason = await ChosenSeason.findAll();
    
    // Pokud není vybrána liga, zobrazíme formulář pro výběr
    if (!liga || !season) {
        const html = `
        <!DOCTYPE html>
        <html lang="cs">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <title>Hromadné zamknutí/odemknutí zápasů</title>
            <link rel="stylesheet" href="/css/styles.css">
            <link rel="icon" href="/images/logo.png">
        </head>
        <body class="admin_site">
            <header class="header">
                <div class="logo_title">
                    <img alt="Logo" class="image_logo" src="/images/logo.png">
                    <h1 id="title">Hromadné zamknutí/odemknutí</h1>
                </div>
                <div style="display:flex; gap:10px;">
                    <a href="/admin" style="color: orangered">Zpět do menu</a>
                </div>
            </header>

            <main class="main_page" style="flex-direction: column; align-items: center;">
                <div class="stats-container" style="width: 100%; max-width: 600px;">
                    <h2 style="color: orangered;">Výběr ligy a sezóny</h2>
                    <p style="color: lightgrey; margin-bottom: 20px;">
                        Zde můžeš hromadně zamknout nebo odemknout všechny zápasy v dané lize a sezóně.
                    </p>
                    
                    <form method="GET" action="/admin/matches/bulk-lock" style="display: flex; flex-direction: column; gap: 15px;">
                        <label style="display: flex; flex-direction: column; color: orangered;">
                            Liga:
                            <select name="liga" required style="padding: 10px; background-color: #222; border: 1px solid orangered; color: white;">
                                ${allowedLeagues.map(l => `<option value="${l}" ${l === allowedLeagues[0] ? 'selected' : ''}>${l}</option>`).join('')}
                            </select>
                        </label>
                        
                        <label style="display: flex; flex-direction: column; color: orangered;">
                            Sezóna:
                            <select name="season" required style="padding: 10px; background-color: #222; border: 1px solid orangered; color: white;">
                                <option value="${currentSeason}" selected>${currentSeason}</option>
                            </select>
                        </label>
                        
                        <button type="submit" class="login_button" style="width: 100%; margin-top: 10px;">Pokračovat</button>
                    </form>
                </div>
            </main>
        </body>
        </html>`;
        return res.send(html);
    }
    
    // Zobrazení přehledu zápasů pro vybranou ligu a sezónu
    const filteredMatches = allMatches.filter(m => m.liga === liga && m.season === season);
    
    // Helper funkce pro kontrolu zamčení - musí odpovídat POST endpointu
    const isMatchLocked = (m) => m.locked === true || m.locked === 'true' || m.locked === 'on' || m.locked === 1;
    
    const lockedCount = filteredMatches.filter(isMatchLocked).length;
    const unevaluatedCount = filteredMatches.filter(m => !m.result).length;
    const unlockedCount = filteredMatches.length - lockedCount;
    
    const html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Hromadné zamknutí - ${liga}</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png">
    </head>
    <body class="admin_site">
        <header class="header">
            <div class="logo_title">
                <img alt="Logo" class="image_logo" src="/images/logo.png">
                <h1 id="title">Hromadné zamknutí/odemknutí</h1>
            </div>
            <div style="display:flex; gap:10px;">
                <a href="/admin" style="color: orangered">Zpět do menu</a>
            </div>
        </header>

        <main class="main_page" style="flex-direction: column; align-items: center;">
            <div class="stats-container" style="width: 100%; max-width: 700px;">
                <h2 style="color: orangered;">${liga} - ${season}</h2>
                
                <div style="display: flex; gap: 20px; margin: 20px 0; justify-content: center;">
                    <div style="background: rgba(0,255,0,0.1); border: 1px solid #00ff00; padding: 15px; border-radius: 5px; text-align: center;">
                        <div style="font-size: 24px; color: #00ff00; font-weight: bold;">${unlockedCount}</div>
                        <div style="color: lightgrey;">Odemčených</div>
                    </div>
                    <div style="background: rgba(255,0,0,0.1); border: 1px solid #ff0000; padding: 15px; border-radius: 5px; text-align: center;">
                        <div style="font-size: 24px; color: #ff0000; font-weight: bold;">${lockedCount}</div>
                        <div style="color: lightgrey;">Zamčených</div>
                    </div>
                    <div style="background: rgba(255,165,0,0.1); border: 1px solid orange; padding: 15px; border-radius: 5px; text-align: center;">
                        <div style="font-size: 24px; color: orange; font-weight: bold;">${filteredMatches.length}</div>
                        <div style="color: lightgrey;">Celkem</div>
                    </div>
                </div>
                
                <p style="color: lightgrey; margin-bottom: 20px; text-align: center;">
                    Vyber akci pro všechny zápasy v této lize a sezóně:
                </p>
                
                <div style="display: flex; gap: 15px; justify-content: center; flex-wrap: wrap;">
                    <form method="POST" action="/admin/matches/bulk-lock" onsubmit="return confirm('Opravdu chceš ZAMKNOUT všechny ${unlockedCount} odemčené zápasy v lize ${liga}?');">
                        <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                        <input type="hidden" name="liga" value="${liga}">
                        <input type="hidden" name="season" value="${season}">
                        <input type="hidden" name="action" value="lock">
                        <input type="hidden" name="redirectUrl" value="/admin/matches/bulk-lock?liga=${encodeURIComponent(liga)}&season=${encodeURIComponent(season)}">
                        <button type="submit" class="action-btn delete-btn" style="font-size: 16px; padding: 15px 30px;" ${unlockedCount === 0 ? 'disabled style="opacity:0.5;"' : ''}>
                            🔒 Zamknout vše (${unlockedCount})
                        </button>
                    </form>
                    
                    <form method="POST" action="/admin/matches/bulk-lock" onsubmit="return confirm('Opravdu chceš ODEMKNOUT všechny ${lockedCount} zamčené zápasy v lize ${liga}?');">
                        <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                        <input type="hidden" name="liga" value="${liga}">
                        <input type="hidden" name="season" value="${season}">
                        <input type="hidden" name="action" value="unlock">
                        <input type="hidden" name="redirectUrl" value="/admin/matches/bulk-lock?liga=${encodeURIComponent(liga)}&season=${encodeURIComponent(season)}">
                        <button type="submit" class="action-btn edit-btn" style="font-size: 16px; padding: 15px 30px;" ${lockedCount === 0 ? 'disabled style="opacity:0.5;"' : ''}>
                            🔓 Odemknout vše (${lockedCount})
                        </button>
                    </form>
                    
                    <form method="POST" action="/admin/matches/bulk-delete" onsubmit="return confirm('⚠️ POZOR! Opravdu chceš SMAZAT všechny ${unevaluatedCount} NEVYHODNOCENÉ zápasy v lize ${liga}?\\n\\nVyhodnocené zápasy zůstanou zachovány.');">
                        <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                        <input type="hidden" name="liga" value="${liga}">
                        <input type="hidden" name="season" value="${season}">
                        <input type="hidden" name="redirectUrl" value="/admin/matches/bulk-lock?liga=${encodeURIComponent(liga)}&season=${encodeURIComponent(season)}">
                        <button type="submit" class="action-btn delete-btn" style="font-size: 16px; padding: 15px 30px; background: #8B0000; border-color: #ff0000;" ${unevaluatedCount === 0 ? 'disabled style="opacity:0.5;"' : ''}>
                            🗑️ Smazat nevyhodnocené (${unevaluatedCount})
                        </button>
                    </form>
                </div>
                
                <div style="margin-top: 30px; padding: 15px; background: rgba(255,69,0,0.1); border: 1px dashed orangered; border-radius: 5px;">
                    <h4 style="color: orangered; margin: 0 0 10px 0;">⚠️ Upozornění</h4>
                    <p style="color: lightgrey; font-size: 14px; margin: 0;">
                        Zamknutí zápasů způsobí, že uživatelé nebudou moci zadávat ani měnit tipy.
                        <br>Již existující tipy u zamčených zápasů budou zachovány, ale nebude možné je měnit.
                        <br><strong>Smazání:</strong> Smažou se pouze nevyhodnocené zápasy (bez výsledku). Vyhodnocené zápasy zůstanou.
                    </p>
                </div>
                
                <div style="margin-top: 20px; text-align: center;">
                    <a href="/admin/matches/bulk-lock" class="action-btn" style="background-color: #333; border: 1px solid orangered;">← Změnit ligu/sezónu</a>
                </div>
            </div>
        </main>
    </body>
    </html>`;
    
    res.send(html);
});

// ==========================================
// SPRÁVA TEMPLATŮ PRO PLAYOFF (VÝPIS A TVORBA)
// ==========================================
router.get('/playoff/templates', requireAdmin, async (req, res) => {
    const templates = await PlayoffTemplates.findAll() || {};

    let templatesListHTML;
    if (Object.keys(templates).length === 0) {
        templatesListHTML = '<p style="color: gray;">Zatím nejsou vytvořeny žádné formáty.</p>';
    } else {
        templatesListHTML = Object.keys(templates).map(key => `
            <div style="background: #1a1a1a; padding: 15px; margin-bottom: 10px; border: 1px solid #333; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong style="color: orangered; font-size: 1.2em;">${templates[key].label}</strong> <span style="color: gray;">(${key})</span>
                </div>
                <div style="display: flex; gap: 10px;">
                    <a href="/admin/playoff/templates/edit/${key}" class="action-btn edit-btn">Upravit</a>
                    <form action="/admin/playoff/templates/delete/${key}" method="POST" style="display:inline;" onsubmit="return confirm('Opravdu smazat formát ${key}?');">
                        <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                        <button type="submit" class="action-btn delete-btn">Smazat</button>
                    </form>
                </div>
            </div>
        `).join('');
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="cs">
        <head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Editor formátů</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png"/>
        </head>
        <body class="admin_site">
            <h1>Správa formátů playoff</h1>
            <div style="background: #1a1a1a; padding: 20px; border: 1px solid #333; margin-bottom: 20px;">
                <h2>Vytvořit nový formát</h2>
                <form action="/admin/playoff/templates/save" method="POST">
                    <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                    <label>Kód formátu (bez mezer, např. spengler_6): <input type="text" name="key" required class="league-select" style="width: 250px;"></label><br><br>
                    <label>Název (pro lidi): <input type="text" name="label" required class="league-select" style="width: 250px;"></label><br><br>
                    <label>JSON struktura sloupců (viz manuál):<br>
                        <textarea name="structure" style="width:100%; height:150px; background:#000; color:lime; font-family:monospace; padding: 10px;">[
  { "title": "Čtvrtfinále", "slots": ["qf1", "qf2"], "gap": "60px" },
  { "title": "Semifinále", "slots": ["sf1", "sf2"], "gap": "30px" },
  { "title": "Finále", "slots": ["fin"], "gap": "30px" }
]</textarea>
                    </label><br>
                    <button type="submit" class="action-btn edit-btn" style="margin-top: 10px;">Uložit nový formát</button>
                </form>
            </div>
            
            <h2>Stávající formáty</h2>
            ${templatesListHTML}

            <br>
            <a href="/admin/playoff" class="back-link">← Zpět na Playoff</a>
        </body></html>
    `);
});

router.post('/playoff/templates/save', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const { key, label, structure } = req.body;
    let templates = await PlayoffTemplates.findAll() || {};

    try {
        templates[key] = { label, columns: JSON.parse(structure) };
        await PlayoffTemplates.replaceAll(templates);
        res.redirect('/admin/playoff/templates');
    } catch (e) {
        res.status(400).send("Chyba v JSON struktuře!");
    }
});

// ==========================================
// UPRAVIT EXISTUJÍCÍ FORMÁT
// ==========================================
router.get('/playoff/templates/edit/:key', requireAdmin, async (req, res) => {
    const key = req.params.key;
    const templates = await PlayoffTemplates.findAll() || {};

    const template = templates[key];
    if (!template) return res.status(404).send("Formát nenalezen.");

    // Převedeme zpět na text, aby šel editovat
    const jsonString = JSON.stringify(template.columns, null, 2);

    res.send(`
        <!DOCTYPE html>
        <html lang="cs">
        <head><meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Upravit formát</title>
        <link rel="stylesheet" href="/css/styles.css">
        <link rel="icon" href="/images/logo.png"/>
        </head>
        <body class="admin_site">
            <h1>Upravit formát playoff: <span style="color: orangered;">${key}</span></h1>
            <div style="background: #1a1a1a; padding: 20px; border: 1px solid #333; margin-bottom: 20px;">
                <form action="/admin/playoff/templates/edit/${key}" method="POST">
                    <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                    <label>Název (pro lidi): <br><input type="text" name="label" value="${template.label}" required class="league-select" style="width: 300px; margin-top: 5px;"></label><br><br>
                    <label>JSON struktura sloupců:<br>
                        <textarea name="structure" style="width:100%; height:300px; background:#000; color:lime; font-family:monospace; padding: 10px; margin-top: 5px;">${jsonString}</textarea>
                    </label><br>
                    <button type="submit" class="action-btn edit-btn" style="margin-top: 15px;">Uložit změny</button>
                </form>
            </div>
            <a href="/admin/playoff/templates" class="back-link">← Zpět na seznam formátů</a>
        </body></html>
    `);
});

router.post('/playoff/templates/edit/:key', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const key = req.params.key;
    const { label, structure } = req.body;
    let templates = await PlayoffTemplates.findAll() || {};

    if (!templates[key]) return res.status(404).send("Formát nenalezen.");

    try {
        templates[key].label = label;
        templates[key].columns = JSON.parse(structure);
        await PlayoffTemplates.replaceAll(templates);
        res.redirect('/admin/playoff/templates');
    } catch (e) {
        res.status(400).send("Chyba v JSON struktuře!");
    }
});

// ==========================================
// SMAZAT FORMÁT
// ==========================================
router.post('/playoff/templates/delete/:key', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).send('Neplatný CSRF token');
    }
    
    const key = req.params.key;
    let templates = await PlayoffTemplates.findAll() || {};

    if (templates[key]) {
        delete templates[key];
        await PlayoffTemplates.replaceAll(templates);
    }
    res.redirect('/admin/playoff/templates');
});

// ==========================================
// KONTROLA A OPRAVA STATISTIK
// ==========================================
router.post('/verify-stats', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    // CSRF kontrola
    if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
        return res.status(403).json({ success: false, message: 'Neplatný CSRF token' });
    }
    
    try {
        const { season, liga } = req.body;
        
        if (!season || !liga) {
            return res.json({ success: false, message: 'Chybí sezóna nebo liga.' });
        }
        
        await evaluateAndAssignPoints(liga, season);
        
        await logAdminAction(req.session.user, "KONTROLA_STATISTIK", `Kontrola a oprava statistik pro ${liga} - ${season}`);
        
        res.json({ 
            success: true, 
            message: `✅ Statistiky pro ${liga} - ${season} byly zkontrolovány a případně opraveny.` 
        });
        
    } catch (error) {
        console.error('Chyba při kontrole statistik:', error);
        res.json({ 
            success: false, 
            message: `❌ Chyba při kontrole statistik: ${error.message}` 
        });
    }
});
router.get('/transfer-data', requireAdmin, async (req, res) => {
    try {
        // Získání všech dostupných sezón
        const matches = await Matches.findAll();
        const teams = await Teams.findAll();
        const allSeasons = [...new Set([
            ...matches.map(m => m.season).filter(Boolean),
            ...teams.map(t => t.season).filter(Boolean)
        ])].sort();
        
        const currentSeason = await ChosenSeason.findAll();
        
        // Sezóny kromě aktuální
        const availableSeasons = allSeasons.filter(s => s !== currentSeason);
        
        // Získání všech lig pro výběr
        const allLeagues = [...new Set([
            ...matches.map(m => m.liga).filter(Boolean),
            ...teams.map(t => t.liga).filter(Boolean)
        ])].sort();
        
        let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>Převod dat z minulého roku</title>
    <link rel="stylesheet" href="/css/styles.css">
    <link rel="icon" href="/images/logo.png">
</head>
<body class="usersite">
    <header class="header">
        <div class="logo_title">
            <img class="image_logo" src="/images/logo.png" alt="Logo">
            <h1 id="title">Tipovačka</h1>
        </div>
        <a href="/admin">← Zpět na admin panel</a>
    </header>
    
    <main class="admin_site">
        <div class="transfer-container">
            <h1>🔄 Převod dat z minulého roku</h1>
            <p style="color: #ccc; margin-bottom: 20px;">Zde můžete vybrat data z předchozích sezón pro převod do aktuální sezóny "${currentSeason}".</p>
            
            <div class="warning-box">
                <strong>⚠️ UPOZORNĚNÍ:</strong><br>
                Tato operace zkopíruje vybraná data ze staré sezóny do aktuální sezóny. 
                Duplicitní data budou přepsána. Doporučuje se vytvořit zálohu před převodem.
            </div>
            
            <form method="POST" action="/admin/transfer-data" id="transferForm">
                <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                
                <div class="transfer-section">
                    <h3>📅 Zdrojová sezóna</h3>
                    <select name="sourceSeason" class="season-select" required>
                        <option value="">-- Vyberte zdrojovou sezónu --</option>
                        ${availableSeasons.map(season => `
                            <option value="${season}">${season}</option>
                        `).join('')}
                    </select>
                </div>
                
                <div class="transfer-section">
                    <h3>🏆 Výběr lig</h3>
                    <div class="checkbox-group">
                        ${allLeagues.map(league => `
                            <div class="checkbox-item">
                                <input type="checkbox" id="league_${league}" name="selectedLeagues" value="${league}">
                                <label for="league_${league}">
                                    <strong>${league}</strong><br>
                                    <small>Přenést pouze data z této ligy</small>
                                </label>
                            </div>
                        `).join('')}
                    </div>
                </div>
                
                <div class="transfer-section">
                    <h3>⚽ Zápasy a týmy</h3>
                    <div class="checkbox-group">
                        <div class="checkbox-item">
                            <input type="checkbox" id="transferMatches" name="transferMatches" value="true">
                            <label for="transferMatches">
                                <strong>Zápasy</strong><br>
                                <small>Všechny zápasy včetně výsledků</small>
                            </label>
                        </div>
                        <div class="checkbox-item">
                            <input type="checkbox" id="transferTeams" name="transferTeams" value="true">
                            <label for="transferTeams">
                                <strong>Týmy</strong><br>
                                <small>Všechny týmy včetně skupin</small>
                            </label>
                        </div>
                    </div>
                </div>
                
                <div class="transfer-section">
                    <h3>🏆 Playoff a soutěže</h3>
                    <div class="checkbox-group">
                        <div class="checkbox-item">
                            <input type="checkbox" id="transferPlayoff" name="transferPlayoff" value="true">
                            <label for="transferPlayoff">
                                <strong>Playoff data</strong><br>
                                <small>Konfigurace a výsledky playoff</small>
                            </label>
                        </div>
                        <div class="checkbox-item">
                            <input type="checkbox" id="transferPlayoffTemplates" name="transferPlayoffTemplates" value="true">
                            <label for="transferPlayoffTemplates">
                                <strong>Playoff šablony</strong><br>
                                <small>Šablony formátů playoff</small>
                            </label>
                        </div>
                    </div>
                </div>
                
                <div class="transfer-section">
                    <h3>🔒 Nastavení lig</h3>
                    <div class="checkbox-group">
                        <div class="checkbox-item">
                            <input type="checkbox" id="transferLeagueStatus" name="transferLeagueStatus" value="true">
                            <label for="transferLeagueStatus">
                                <strong>Lockovací mechanismy</strong><br>
                                <small>Uzamčení tipování tabulek</small>
                            </label>
                        </div>
                        <div class="checkbox-item">
                            <input type="checkbox" id="transferTeamBonuses" name="transferTeamBonuses" value="true">
                            <label for="transferTeamBonuses">
                                <strong>Bonusy týmů</strong><br>
                                <small>Bonusové body pro týmy</small>
                            </label>
                        </div>
                        <div class="checkbox-item">
                            <input type="checkbox" id="transferTableTips" name="transferTableTips" value="true">
                            <label for="transferTableTips">
                                <strong>Tipy na tabulky</strong><br>
                                <small>Uživatelské tipy na konečné pořadí</small>
                            </label>
                        </div>
                    </div>
                </div>
                
                <div class="transfer-section">
                    <h3>💰 Přestupy</h3>
                    <div class="checkbox-group">
                        <div class="checkbox-item">
                            <input type="checkbox" id="transferTransfers" name="transferTransfers" value="true">
                            <label for="transferTransfers">
                                <strong>Přestupové okno</strong><br>
                                <small>Nastavení a data přestupů</small>
                            </label>
                        </div>
                    </div>
                </div>
                
                <button type="submit" class="btn-transfer" id="transferBtn">
                    🔄 Spustit převod dat
                </button>
            </form>
        </div>
    </main>
    
    <script>
        document.getElementById('transferForm').addEventListener('submit', function(e) {
            const checkboxes = document.querySelectorAll('input[type="checkbox"]:checked');
            const sourceSeason = document.querySelector('select[name="sourceSeason"]').value;
            const leagueCheckboxes = document.querySelectorAll('input[name="selectedLeagues"]:checked');
            const transferMatches = document.querySelector('#transferMatches').checked;
            const transferTeams = document.querySelector('#transferTeams').checked;
            
            if (!sourceSeason) {
                e.preventDefault();
                alert('Prosím vyberte zdrojovou sezónu.');
                return;
            }
            
            if ((transferMatches || transferTeams) && leagueCheckboxes.length === 0) {
                e.preventDefault();
                alert('Pro převod zápasů a týmů musíte vybrat alespoň jednu ligu.');
                return;
            }
            
            if (checkboxes.length === 0) {
                e.preventDefault();
                alert('Prosím vyberte alespoň jednu položku k převodu.');
                return;
            }
            
            const confirmMsg = 'Opravdu chcete převést vybraná data ze sezóny ' + sourceSeason + ' do aktuální sezóny?\\n\\n' +
                              'Tato operace může přepsat existující data v aktuální sezóně.\\n' +
                              'Doporučuje se vytvořit zálohu před pokračováním.';
                              
            if (!confirm(confirmMsg)) {
                e.preventDefault();
            }
        });
        
        // Zabránit odeslání formuláře při stisku Enter v selectu
        document.querySelector('select[name="sourceSeason"]').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
            }
        });
    </script>
</body>
</html>`;
        
        res.send(html);
        
    } catch (error) {
        console.error('Chyba při načítání stránky převodu dat:', error);
        res.status(500).send('Chyba při načítání stránky');
    }
});

router.post('/transfer-data', express.urlencoded({ extended: true }), requireAdmin, async (req, res) => {
    try {
        // CSRF kontrola
        if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
            return res.status(403).send('Neplatný CSRF token');
        }
        
        const { sourceSeason, selectedLeagues, transferMatches, transferTeams, transferPlayoff, transferPlayoffTemplates, 
                transferLeagueStatus, transferTeamBonuses, transferTableTips, transferTransfers } = req.body;
        
        if (!sourceSeason) {
            return res.status(400).json({ success: false, message: 'Zdrojová sezóna není vybrána.' });
        }
        
        // Zpracování vybraných lig
        const leaguesToTransfer = Array.isArray(selectedLeagues) ? selectedLeagues : [selectedLeagues].filter(Boolean);
        
        if (transferMatches === 'true' || transferTeams === 'true') {
            if (leaguesToTransfer.length === 0) {
                return res.status(400).json({ success: false, message: 'Pro převod zápasů a týmů musíte vybrat alespoň jednu ligu.' });
            }
        }
        
        const currentSeason = await ChosenSeason.findAll();
        const transferResults = [];
        
        if (transferMatches === 'true') {
            try {
                const sourceMatches = await Matches.findMany({ season: sourceSeason });
                // Filtrování zápasů podle vybraných lig
                const filteredMatches = sourceMatches.filter(match => leaguesToTransfer.includes(match.liga));
                const matchesToTransfer = filteredMatches.map(match => ({
                    ...match,
                    season: currentSeason,
                    _id: undefined // Odstraníme MongoDB _id pro vytvoření nových dokumentů
                }));
                
                if (matchesToTransfer.length > 0) {
                    // Nejprve smažeme existující zápasy v aktuální sezóně pro vybrané ligy
                    await Matches.deleteMany({ season: currentSeason, liga: { $in: leaguesToTransfer } });
                    // Pak vložíme nové
                    await Matches.insertMany(matchesToTransfer);
                    transferResults.push(`✅ Přeneseno ${matchesToTransfer.length} zápasů z lig: ${leaguesToTransfer.join(', ')}`);
                } else {
                    transferResults.push(`⚠️ V sezóně ${sourceSeason} nebyly nalezeny žádné zápasy z vybraných lig`);
                }
            } catch (error) {
                transferResults.push(`❌ Chyba při převodu zápasů: ${error.message}`);
            }
        }
        
        // 2. Převod definic lig (DŮLEŽITÉ!)
        if (transferMatches === 'true' || transferTeams === 'true') {
            try {
                const allSeasonData = await Leagues.findAll();
                if (allSeasonData[sourceSeason] && allSeasonData[sourceSeason].leagues) {
                    // Získáme ligy ze zdrojové sezóny
                    const sourceLeagues = allSeasonData[sourceSeason].leagues;
                    // Filtrování podle vybraných lig
                    const leaguesToCopy = sourceLeagues.filter(l => leaguesToTransfer.includes(l.name));
                    
                    if (leaguesToCopy.length > 0) {
                        // Vytvoříme strukturu pro cílovou sezónu
                        if (!allSeasonData[currentSeason]) {
                            allSeasonData[currentSeason] = { leagues: [] };
                        }
                        if (!allSeasonData[currentSeason].leagues) {
                            allSeasonData[currentSeason].leagues = [];
                        }
                        
                        // Přidáme/aktualizujeme ligy
                        for (const league of leaguesToCopy) {
                            const existingIndex = allSeasonData[currentSeason].leagues.findIndex(
                                l => l.name === league.name
                            );
                            if (existingIndex >= 0) {
                                // Aktualizujeme existující
                                allSeasonData[currentSeason].leagues[existingIndex] = { ...league };
                            } else {
                                // Přidáme novou
                                allSeasonData[currentSeason].leagues.push({ ...league });
                            }
                        }
                        
                        await Leagues.replaceAll(allSeasonData);
                        transferResults.push(`✅ Přeneseny definice ${leaguesToCopy.length} lig: ${leaguesToCopy.map(l => l.name).join(', ')}`);
                    }
                } else {
                    transferResults.push(`⚠️ V sezóně ${sourceSeason} nebyly nalezeny definic lig`);
                }
            } catch (error) {
                transferResults.push(`❌ Chyba při převodu definic lig: ${error.message}`);
            }
        }
        
        // 3. Převod týmů
        if (transferTeams === 'true') {
            try {
                const sourceTeams = await Teams.findMany({ season: sourceSeason });
                // Filtrování týmů podle vybraných lig
                const filteredTeams = sourceTeams.filter(team => leaguesToTransfer.includes(team.liga));
                const teamsToTransfer = filteredTeams.map(team => ({
                    ...team,
                    season: currentSeason,
                    _id: undefined
                }));
                
                if (teamsToTransfer.length > 0) {
                    // Nejprve smažeme existující týmy v aktuální sezóně pro vybrané ligy
                    await Teams.deleteMany({ season: currentSeason, liga: { $in: leaguesToTransfer } });
// Pak vložíme nové
                    await Teams.insertMany(teamsToTransfer);
                    transferResults.push(`✅ Přeneseno ${teamsToTransfer.length} týmů z lig: ${leaguesToTransfer.join(', ')}`);
                } else {
                    transferResults.push(`⚠️ V sezóně ${sourceSeason} nebyly nalezeny žádné týmy z vybraných lig`);
                }
            } catch (error) {
                transferResults.push(`❌ Chyba při převodu týmů: ${error.message}`);
            }
        }
        
        // 3. Převod playoff dat
        if (transferPlayoff === 'true') {
            try {
                const playoffData = await Playoff.findAll();
                if (playoffData[sourceSeason]) {
                    const updatedPlayoff = { ...playoffData };
                    updatedPlayoff[currentSeason] = playoffData[sourceSeason];
                    await Playoff.replaceAll(updatedPlayoff);
                    transferResults.push(`✅ Přenesena playoff data`);
                } else {
                    transferResults.push(`⚠️ V sezóně ${sourceSeason} nebyla nalezena playoff data`);
                }
            } catch (error) {
                transferResults.push(`❌ Chyba při převodu playoff dat: ${error.message}`);
            }
        }
        
        // 4. Převod playoff šablon
        if (transferPlayoffTemplates === 'true') {
            try {
                const templatesData = await PlayoffTemplates.findAll();
                let templatesFound = false;
                const updatedTemplates = { ...templatesData };
                
                for (const league of leaguesToTransfer) {
                    // Hledej klíče které obsahují název ligy
                    const matchingKeys = Object.keys(templatesData).filter(key => 
                        key.toLowerCase().includes(league.toLowerCase())
                    );
                    
                    if (matchingKeys.length > 0) {
                        templatesFound = true;
                        // Přidej šablony pro novou sezónu s ligovým prefixem
                        for (const key of matchingKeys) {
                            const newKey = key.replace(/_\d+$/, ''); // Odstraň starý suffix
                            updatedTemplates[`${newKey}_${currentSeason}`] = templatesData[key];
                        }
                        console.log(`✅ Found ${matchingKeys.length} templates for league: ${league}`);
                    }
                }
                
                if (templatesFound) {
                    await PlayoffTemplates.replaceAll(updatedTemplates);
                    transferResults.push(`✅ Přeneseny playoff šablony pro ligy: ${leaguesToTransfer.join(', ')}`);
                } else {
                    transferResults.push(`⚠️ V sezóně ${sourceSeason} nebyly nalezeny playoff šablony pro vybrané ligy`);
                }
            } catch (error) {
                transferResults.push(`❌ Chyba při převodu playoff šablon: ${error.message}`);
            }
        }
        
        // 5. Převod lockovacích mechanismů
        if (transferLeagueStatus === 'true') {
            try {
                const leagueStatusData = await LeagueStatus.findAll();
                if (leagueStatusData[sourceSeason]) {
                    const updatedLeagueStatus = { ...leagueStatusData };
                    updatedLeagueStatus[currentSeason] = leagueStatusData[sourceSeason];
                    await LeagueStatus.replaceAll(updatedLeagueStatus);
                    transferResults.push(`✅ Přeneseny lockovací mechanismy`);
                } else {
                    transferResults.push(`⚠️ V sezóně ${sourceSeason} nebyly nalezeny lockovací mechanismy`);
                }
            } catch (error) {
                transferResults.push(`❌ Chyba při převodu lockovacích mechanismů: ${error.message}`);
            }
        }
        
        // 6. Převod bonusů týmů
        if (transferTeamBonuses === 'true') {
            try {
                const bonusesData = await TeamBonuses.findAll();
                if (bonusesData[sourceSeason]) {
                    const updatedBonuses = { ...bonusesData };
                    updatedBonuses[currentSeason] = bonusesData[sourceSeason];
                    await TeamBonuses.replaceAll(updatedBonuses);
                    transferResults.push(`✅ Přeneseny bonusy týmů`);
                } else {
                    transferResults.push(`⚠️ V sezóně ${sourceSeason} nebyly nalezeny bonusy týmů`);
                }
            } catch (error) {
                transferResults.push(`❌ Chyba při převodu bonusů týmů: ${error.message}`);
            }
        }
        
        // 7. Převod tipů na tabulky
        if (transferTableTips === 'true') {
            try {
                const tableTipsData = await TableTips.findAll();
                if (tableTipsData[sourceSeason]) {
                    const updatedTableTips = { ...tableTipsData };
                    updatedTableTips[currentSeason] = tableTipsData[sourceSeason];
                    await TableTips.replaceAll(updatedTableTips);
                    transferResults.push(`✅ Přeneseny tipy na tabulky`);
                } else {
                    transferResults.push(`⚠️ V sezóně ${sourceSeason} nebyly nalezeny tipy na tabulky`);
                }
            } catch (error) {
                transferResults.push(`❌ Chyba při převodu tipů na tabulky: ${error.message}`);
            }
        }
        
        // 8. Převod přestupů
        if (transferTransfers === 'true') {
            try {
                const transfersData = await Transfers.findAll();
                if (transfersData[sourceSeason]) {
                    const updatedTransfers = { ...transfersData };
                    updatedTransfers[currentSeason] = transfersData[sourceSeason];
                    await Transfers.replaceAll(updatedTransfers);
                    transferResults.push(`✅ Přeneseny přestupy`);
                } else {
                    transferResults.push(`⚠️ V sezóně ${sourceSeason} nebyly nalezeny přestupy`);
                }
            } catch (error) {
                transferResults.push(`❌ Chyba při převodu přestupů: ${error.message}`);
            }
        }
        
        await logAdminAction(req.session.user, "PREVOD_DAT", 
            `Převod dat ze sezóny "${sourceSeason}" do "${currentSeason}". Výsledky: ${transferResults.join(', ')}`);
        
        // Vrátíme HTML stránku s výsledky
        let resultsHtml = `
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
    <title>Výsledky převodu dat</title>
    <link rel="stylesheet" href="/css/styles.css">
    <link rel="icon" href="/images/logo.png">
</head>
<body class="usersite">
    <header class="header">
        <div class="logo_title">
            <img class="image_logo" src="/images/logo.png" alt="Logo">
            <h1 id="title">Tipovačka</h1>
        </div>
        <a href="/admin">← Zpět na admin panel</a>
    </header>
    
    <main class="admin_site">
        <div class="results-container">
            <h1>🎉 Převod dat dokončen</h1>
            <p style="color: #ccc; margin-bottom: 20px;">
                Převod dat ze sezóny <strong>${sourceSeason}</strong> do aktuální sezóny <strong>${currentSeason}</strong> byl dokončen.
            </p>
            
            <h3>📋 Výsledky převodu:</h3>
            <div class="results-list">
`;
        
        transferResults.forEach(result => {
            let cssClass = 'result-success';
            if (result.includes('⚠️')) cssClass = 'result-warning';
            if (result.includes('❌')) cssClass = 'result-error';
            
            resultsHtml += `<div class="result-item ${cssClass}">${result}</div>`;
        });
        
        resultsHtml += `
            </div>
            
            <div style="text-align: center; margin-top: 30px;">
                <a href="/admin/transfer-data" class="btn-back">🔄 Další převod</a>
                <a href="/admin" class="btn-back">🏠 Admin panel</a>
            </div>
        </div>
    </main>
</body>
</html>`;
        
        res.send(resultsHtml);
        
    } catch (error) {
        console.error('Chyba při převodu dat:', error);
        res.status(500).json({
            success: false,
            message: `Chyba při převodu dat: ${error.message}`
        });
    }
});

// Jednorázová oprava sezón na 25/26 pro týmy bez sezóny
router.get('/fix-season-25-26', requireAdmin, async (req, res) => {
    try {
        const teams = await Teams.findAll();
        let fixedCount = 0;
        let alreadyHasSeason = 0;
        let errors = [];
        
        for (const team of teams) {
            // Hledej týmy bez season nebo s undefined/empty season
            if (!team.season || team.season === 'undefined' || team.season === '' || team.season === null) {
                try {
                    await Teams.updateOne({ id: team.id }, { season: '25/26' });
                    fixedCount++;
                } catch (err) {
                    errors.push(`${team.name}: ${err.message}`);
                }
            } else {
                alreadyHasSeason++;
            }
        }
        
        await logAdminAction(req.session.user, "OPRAVA_SEZON", 
            `Nastaveno ${fixedCount} týmů na sezónu 25/26, ${alreadyHasSeason} již mělo sezónu`);
        
        res.send(`
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Oprava sezón - Výsledek</title>
    <link rel="stylesheet" href="/css/styles.css">
    <link rel="icon" href="/images/logo.png">
    <style>
        body { background-color: #121212; color: white; font-family: Arial, sans-serif; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; background: #1a1a1a; padding: 30px; border-radius: 10px; }
        h1 { color: orangered; }
        .stats { background: #222; padding: 15px; border-radius: 5px; margin: 20px 0; }
        .stat-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #333; }
        .btn { display: inline-block; background: orangered; color: black; padding: 10px 20px; 
               text-decoration: none; border-radius: 5px; margin-top: 20px; font-weight: bold; }
        .btn:hover { background: #ff6633; }
        .success { color: #28a745; }
        .info { color: #17a2b8; }
        .error { color: #dc3545; }
    </style>
</head>
<body>
    <div class="container">
        <h1>✅ Oprava sezón dokončena</h1>
        
        <div class="stats">
            <div class="stat-row">
                <span>Celkem týmů v databázi:</span>
                <strong>${teams.length}</strong>
            </div>
            <div class="stat-row">
                <span class="success">Nastaveno na 25/26:</span>
                <strong class="success">${fixedCount}</strong>
            </div>
            <div class="stat-row">
                <span class="info">Již mělo sezónu:</span>
                <strong class="info">${alreadyHasSeason}</strong>
            </div>
            ${errors.length > 0 ? `
            <div class="stat-row">
                <span class="error">Chyby:</span>
                <strong class="error">${errors.length}</strong>
            </div>
            ` : ''}
        </div>
        
        ${errors.length > 0 ? `
        <div style="background: #330000; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3 class="error">Chyby při zpracování:</h3>
            <ul style="color: #ff6666;">
                ${errors.map(e => `<li>${e}</li>`).join('')}
            </ul>
        </div>
        ` : ''}
        
        <p style="color: #aaa; font-size: 0.9em;">
            Týmy bez sezóny byly nastaveny na <strong>25/26</strong>. 
            Nyní by se při přepnutí na sezónu 26/27 neměly zobrazovat žádné týmy z minulé sezóny.
        </p>
        
        <a href="/admin" class="btn">← Zpět na admin panel</a>
    </div>
</body>
</html>`);
        
        console.log(`🔧 Dokončeno: ${fixedCount} týmů nastaveno na 25/26, ${alreadyHasSeason} již mělo sezónu`);
        
    } catch (error) {
        console.error('Chyba při nastavování sezón:', error);
        res.status(500).send(`
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <title>Chyba</title>
    <link rel="stylesheet" href="/css/styles.css">
</head>
<body style="background: #121212; color: white; padding: 20px;">
    <h1 style="color: #dc3545;">❌ Chyba při nastavování sezón</h1>
    <p>${error.message}</p>
    <a href="/admin" style="color: orangered;">← Zpět na admin panel</a>
</body>
</html>`);
    }
});

router.get('/fix-team-seasons', requireAdmin, async (req, res) => {
    try {
        const teams = await Teams.findAll();
        let fixedCount = 0;
        let skippedCount = 0;
        
        for (const team of teams) {
            // Hledej týmy bez season nebo s undefined season
            if (!team.season || team.season === 'undefined' || team.season === '') {
                if (team.stats && Object.keys(team.stats).length > 0) {
                    // Najdi sezónu z stats klíčů
                    const seasonKeys = Object.keys(team.stats);
                    const latestSeason = seasonKeys.sort().pop();
                    await Teams.updateOne({ id: team.id }, { season: latestSeason });
                    fixedCount++;
                } else {
                    skippedCount++;
                }
            }
        }
        
        res.send(`
            <h1>✅ Sezóny týmů opraveny</h1>
            <p>Opraveno ${fixedCount} z ${teams.length} týmů</p>
            <p>Přeskočeno ${skippedCount} týmů (bez stats dat)</p>
            <a href="/admin">← Zpět na admin panel</a>
        `);
        
    } catch (error) {
        console.error('Chyba při opravě sezón týmů:', error);
        res.status(500).send('Chyba při opravě sezón týmů');
    }
});

// Diagnostická routa pro kontrolu všech kolekcí
router.get('/diagnose-seasons', requireAdmin, async (req, res) => {
    try {
        const results = {
            teams: { total: 0, withoutSeason: [], bySeason: {} },
            matches: { total: 0, withoutSeason: [], bySeason: {} },
            leagues: { total: 0, seasons: [], withoutSeason: 0 },
            playoff: { total: 0, seasons: [], withoutSeason: 0 },
            playoffTemplates: { total: 0, seasons: [], withoutSeason: 0 },
            transfers: { total: 0, seasons: [], withoutSeason: 0 },
            tableTips: { total: 0, seasons: [], withoutSeason: 0 },
            teamBonuses: { total: 0, seasons: [], withoutSeason: 0 },
            leagueStatus: { total: 0, seasons: [], withoutSeason: 0 }
        };
        
        // 1. Kontrola týmů
        const teams = await Teams.findAll();
        results.teams.total = teams.length;
        teams.forEach(t => {
            if (!t.season || t.season === 'undefined' || t.season === '' || t.season === null) {
                results.teams.withoutSeason.push({ id: t.id, name: t.name, liga: t.liga });
            } else {
                results.teams.bySeason[t.season] = (results.teams.bySeason[t.season] || 0) + 1;
            }
        });
        
        // 2. Kontrola zápasů
        const matches = await Matches.findAll();
        results.matches.total = matches.length;
        matches.forEach(m => {
            if (!m.season || m.season === 'undefined' || m.season === '' || m.season === null) {
                results.matches.withoutSeason.push({ id: m.id, liga: m.liga, homeTeamId: m.homeTeamId, awayTeamId: m.awayTeamId });
            } else {
                results.matches.bySeason[m.season] = (results.matches.bySeason[m.season] || 0) + 1;
            }
        });
        
        // 3. Kontrola lig (objekt se sezónami jako klíči)
        const leaguesData = await Leagues.findAll();
        const leagueKeys = Object.keys(leaguesData).filter(k => k !== '_id');
        results.leagues.total = leagueKeys.length;
        results.leagues.seasons = leagueKeys;
        results.leagues.withoutSeason = leagueKeys.filter(k => !k.includes('/')).length;
        
        // 4. Kontrola playoff
        const playoffData = await Playoff.findAll();
        const playoffKeys = Object.keys(playoffData).filter(k => k !== '_id');
        results.playoff.total = playoffKeys.length;
        results.playoff.seasons = playoffKeys;
        results.playoff.withoutSeason = playoffKeys.filter(k => !k.includes('/')).length;
        
        // 5. Kontrola playoffTemplates
        const templatesData = await PlayoffTemplates.findAll();
        const templateKeys = Object.keys(templatesData).filter(k => k !== '_id');
        results.playoffTemplates.total = templateKeys.length;
        results.playoffTemplates.seasons = templateKeys;
        
        // 6. Kontrola transfers
        const transfersData = await Transfers.findAll();
        const transferKeys = Object.keys(transfersData).filter(k => k !== '_id');
        results.transfers.total = transferKeys.length;
        results.transfers.seasons = transferKeys;
        results.transfers.withoutSeason = transferKeys.filter(k => !k.includes('/')).length;
        
        // 7. Kontrola tableTips
        const tableTipsData = await TableTips.findAll();
        const tipsKeys = Object.keys(tableTipsData).filter(k => k !== '_id');
        results.tableTips.total = tipsKeys.length;
        results.tableTips.seasons = tipsKeys;
        results.tableTips.withoutSeason = tipsKeys.filter(k => !k.includes('/')).length;
        
        // 8. Kontrola teamBonuses
        const bonusesData = await TeamBonuses.findAll();
        const bonusKeys = Object.keys(bonusesData).filter(k => k !== '_id');
        results.teamBonuses.total = bonusKeys.length;
        results.teamBonuses.seasons = bonusKeys;
        results.teamBonuses.withoutSeason = bonusKeys.filter(k => !k.includes('/')).length;
        
        // 9. Kontrola leagueStatus
        const statusData = await LeagueStatus.findAll();
        const statusKeys = Object.keys(statusData).filter(k => k !== '_id');
        results.leagueStatus.total = statusKeys.length;
        results.leagueStatus.seasons = statusKeys;
        results.leagueStatus.withoutSeason = statusKeys.filter(k => !k.includes('/')).length;
        
        // Generování HTML reportu
        const generateSection = (title, data, isArray = false) => {
            if (isArray) {
                return `
                <div class="section">
                    <h3>${title} (${data.total})</h3>
                    <p><strong>Bez sezóny:</strong> ${data.withoutSeason.length} záznamů</p>
                    ${data.withoutSeason.length > 0 ? `
                    <div class="details">
                        <ul>
                            ${data.withoutSeason.map(item => `<li>${JSON.stringify(item)}</li>`).join('')}
                        </ul>
                    </div>
                    ` : ''}
                    <p><strong>Podle sezón:</strong></p>
                    <ul>
                        ${Object.entries(data.bySeason).map(([season, count]) => `<li>${season}: ${count}</li>`).join('')}
                    </ul>
                </div>
                `;
            } else {
                const hasInvalid = data.seasons && data.seasons.some(s => !s.includes('/') && s !== '_id');
                return `
                <div class="section">
                    <h3>${title} (${data.total} klíčů)</h3>
                    <p><strong>Sezóny:</strong> ${data.seasons ? data.seasons.join(', ') : 'N/A'}</p>
                    ${data.withoutSeason > 0 || hasInvalid ? `<p class="warning">⚠️ Nalezeny klíče bez formátu sezóny (např. "25/26")</p>` : ''}
                </div>
                `;
            }
        };
        
        res.send(`
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <title>Diagnostika sezón</title>
    <link rel="stylesheet" href="/css/styles.css">
    <style>
        body { background: #121212; color: white; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        h1 { color: orangered; }
        .section { background: #1a1a1a; padding: 15px; margin: 10px 0; border-radius: 5px; }
        .section h3 { margin-top: 0; color: #00d4ff; }
        .warning { color: #ff4444; font-weight: bold; }
        .details { background: #0d0d0d; padding: 10px; border-radius: 3px; max-height: 200px; overflow-y: auto; }
        .details ul { margin: 0; padding-left: 20px; }
        .details li { color: #ff9999; font-size: 0.9em; }
        .btn { display: inline-block; background: orangered; color: black; padding: 10px 20px; 
               text-decoration: none; border-radius: 5px; margin-top: 20px; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍 Diagnostika sezón v databázi</h1>
        
        ${generateSection('Týmy', results.teams, true)}
        ${generateSection('Zápasy', results.matches, true)}
        ${generateSection('Ligy', results.leagues)}
        ${generateSection('Playoff', results.playoff)}
        ${generateSection('Playoff šablony', results.playoffTemplates)}
        ${generateSection('Přestupy', results.transfers)}
        ${generateSection('Tipy na tabulky', results.tableTips)}
        ${generateSection('Bonusy týmů', results.teamBonuses)}
        ${generateSection('Status lig', results.leagueStatus)}
        
        <a href="/admin/fix-season-25-26" class="btn">Opravit týmy bez sezóny</a>
        <a href="/admin" class="btn">← Zpět na admin</a>
    </div>
</body>
</html>`);
        
    } catch (error) {
        console.error('Chyba při diagnostice:', error);
        res.status(500).send('Chyba při diagnostice: ' + error.message);
    }
});

module.exports = router;
