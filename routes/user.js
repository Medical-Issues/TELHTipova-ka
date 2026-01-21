const fs = require("fs");
const express = require("express");
const router = express.Router();
const path = require('path');
const {loadTeams, requireLogin, calculateTeamScores, getLeagueZones, getTeamZone, isLockedPosition} = require("../utils/fileUtils");

router.get("/table-tip", requireLogin, (req, res) => {
    const username = req.session.user;
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));

    // 1. Načtení dat
    JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'));
    const teams = loadTeams().filter(t => t.active);
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf-8'));
    const allowedLeagues = JSON.parse(fs.readFileSync('./data/allowedLeagues.json', 'utf-8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];

    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];
    const uniqueLeagues = allLeagues.filter(l => allowedLeagues.includes(l));

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga) ? req.query.liga : uniqueLeagues[0];
    const teamsInSelectedLiga = teams.filter(t => t.liga === selectedLiga);

    const scores = calculateTeamScores(matches, selectedSeason, selectedLiga);

    const leagueObj = leagues.find(l => l.name === selectedLiga) || {
        name: selectedLiga || "Neznámá liga",
        maxMatches: 0, quarterfinal: 0, playin: 0, relegation: 0, isMultigroup: false
    };

    // Načtení tipů
    let tableTips;
    try { tableTips = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8')); } catch (e) { tableTips = {}; }
    const userTipData = tableTips?.[selectedSeason]?.[selectedLiga]?.[username] || null;

    // --- LOGIKA SKUPIN (Backend = Čísla) ---
    const groupedTeams = {};
    teamsInSelectedLiga.forEach(team => {
        let gKey = "default";
        if (leagueObj.isMultigroup) {
            // Použijeme číslo z databáze (1, 2...) převedené na string
            // Tím pádem to bude sedět na zámky v Adminu (["1"])
            gKey = String(team.group || 1);
        }
        if (!groupedTeams[gKey]) groupedTeams[gKey] = [];
        groupedTeams[gKey].push(team);
    });

    // Seřadíme klíče číselně (1, 2, 3...)
    const sortedGroupKeys = Object.keys(groupedTeams).sort((a,b) => {
        if(a === 'default') return -1;
        return parseInt(a) - parseInt(b);
    });

    // --- POMOCNÁ FUNKCE: PŘEVOD ČÍSLA NA PÍSMENO PRO ZOBRAZENÍ ---
    const getGroupDisplayLabel = (gKey) => {
        if (gKey === 'default') return '';
        const num = parseInt(gKey);
        // 1 -> A (ASCII 65), 2 -> B (ASCII 66)...
        return `Skupina ${String.fromCharCode(64 + num)}`;
    };

    // Statistiky (User Stats)
    let userStats = [];
    try {
        const usersData = fs.readFileSync('./data/users.json', 'utf-8');
        const allUsers = JSON.parse(usersData);
        const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);
        userStats = allUsers.filter(u => {
            const tips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
            const tableStats = u.stats?.[selectedSeason]?.[selectedLiga]?.tableCorrect;
            return tips.length > 0 || tableStats !== undefined;
        }).map(u => {
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
                totalPlayoff: stats.totalPlayoff || 0,
                tableCorrect: stats.tableCorrect || 0,
                tableDeviation: stats.tableDeviation || 0
            };
        });
    } catch (err) {}
    const currentUserStats = userStats.find(u => u.username === username);

    // Playoff data
    const playoffPath = path.join(__dirname, '../data/playoff.json');
    let playoffData = [];
    try {
        const raw = fs.readFileSync(playoffPath, 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) {
            playoffData = allPlayoffs[selectedSeason][selectedLiga];
        }
    } catch (e) {}

    // Načtení zámků
    let isTipsLocked = false;
    let isRegularSeasonFinished = false;
    try {
        const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
        isRegularSeasonFinished = statusData?.[selectedSeason]?.[selectedLiga]?.regularSeasonFinished || false;
        // isTipsLocked může být true (vše) nebo ["1", "3"] (částečně)
        isTipsLocked = statusData?.[selectedSeason]?.[selectedLiga]?.tableTipsLocked || false;
    } catch (e) {}

    const statusStyle = isRegularSeasonFinished ? "color: lightgrey; font-weight: bold;" : "color: white; opacity: 0.7; background-color: black";

    // --- HTML ---
    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <title>Tipovačka</title>
        <link rel="stylesheet" href="./css/styles.css" />
        <link rel="icon" href="./images/logo.png">
    </head>
    <body class="usersite">
    <header class="header">
        <form class="league-dropdown" method="GET" action="/table-tip">
            <div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
            <label class="league-select-name">
                Liga:
                <select id="league-select" name="liga" required onchange="this.form.submit()">
                    ${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </label>
            <a class="history-btn" href="/history">Historie</a>
            <a class="history-btn changed" href="/?liga=${encodeURIComponent(selectedLiga)}">Tipovačka</a>
            <a class="history-btn changed" href="/prestupy">Přestupy TELH</a>
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
                    `;

    // --- LEVÝ PANEL (TABULKY) ---
    // Iterujeme "1", "2"
    for (const gKey of sortedGroupKeys) {
        const teamsInGroup = groupedTeams[gKey];
        const zoneConfig = getLeagueZones(leagueObj);

        // Zobrazíme PÍSMENO (Skupina A)
        const groupLabel = getGroupDisplayLabel(gKey);
        const headerText = sortedGroupKeys.length > 1 && groupLabel ? `(${groupLabel})` : '';

        html += `
        <table class="points-table">
            <thead>
                <tr>
                    <th scope="col" id="points-table-header" colspan="10">
                        <h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část ${headerText}</h2>
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

        // Řazení podle bodů (Realita)
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

            const teamStats = scores[team.id] || {gf:0, ga:0};
            const goalDiff = teamStats.gf - teamStats.ga;
            const numberMatches = (team.stats?.[selectedSeason]?.wins||0) + (team.stats?.[selectedSeason]?.otWins||0) + (team.stats?.[selectedSeason]?.otLosses||0) + (team.stats?.[selectedSeason]?.losses||0);

            html += `
            <tr class="${locked ? `${zone} locked` : ''}">
                <td class="rank-cell ${zone}">${index + 1}.</td>
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
        html += `</tbody></table>`;
    }

    // --- ZBYTEK LEVÉHO PANELU (Playoff) ---
    html += `
            </div>
            <div id="playoffTablePreview" style="display:none; overflow:auto; max-width:100%;">
                <table class="points-table"><tr><th scope="col" id="points-table-header" colspan="20"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Playoff</h2></th></tr>
                ${playoffData.map(row => `<tr>${row.map(c => `<td style="${c.bgColor?`background:${c.bgColor};`:''}${c.textColor?`color:${c.textColor}`:''}">${c.text}</td>`).join('')}</tr>`).join('')}
                </table>
            </div>
            <section class="progress-section">
                <h3>Odehráno zápasů v základní části</h3>
            </section>
            <script>
                function showTable(which) {
                    document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none';
                    const p = document.getElementById('playoffTablePreview');
                    p.style.display = which === 'playoff' ? 'block' : 'none';
                }
            </script>
        </div>`;

    // --- STATISTIKY (OBNOVENO V PLNÉ PARÁDĚ) ---
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
            
            ${currentUserStats?.tableCorrect > 0 || currentUserStats?.tableDeviation > 0 ? `
                <hr><h3>Výsledek tipovačky tabulky</h3>
                <p>Trefené pozice: <strong>${currentUserStats.tableCorrect}</strong></p>
                <p>Odchylka: <strong>${currentUserStats.tableDeviation}</strong></p>
            ` : `<p><em>Tipovačka tabulky zatím nebyla vyhodnocena.</em></p>`}
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

            html += `
                <tr>
                    <td>${index + 1}.</td>
                    <td>${user.username}</td>
                    <td>${successRateOverall}%${user.total !== user.maxFromTips ? ` (${successRate}%)` : ''}</td>
                    <td>${user.correct}</td>
                    <td>${user.totalRegular}</td>
                    <td>${user.totalPlayoff}</td>
                    <td style="${statusStyle}">${user.tableCorrect > 0 ? user.tableCorrect : '-'}</td>
                    <td style="${statusStyle}">${user.tableDeviation > 0 ? user.tableDeviation : '-'}</td>
                </tr>`;
        });

        html += `
                </tbody>
            </table>
            <br>
            <table style="color: black" class="points-table">
                <tr style="background-color: #00FF00"><td colspan="3">Za správný tip zápasu v základní části</td><td colspan="3">1 bod</td></tr>
                <tr style="background-color: #FF0000"><td colspan="3">Za správný tip vítěze dané série v playoff ale špatný tip počtu vyhraných zápasů týmu který prohrál</td><td colspan="3">1 bod</td></tr>
                <tr style="background-color: #00FF00"><td colspan="3">Za správný tip vítěze dané série v playoff + počet vyhraných zápasů týmů který prohrál</td><td colspan="3">3 body</td></tr>
                <tr style="background-color: #00FF00"><td colspan="3">Za správný tip vítěze daného zápasu v playoff + správné skóre</td><td colspan="3">5 bodů</td></tr>
                <tr style="background-color: #FFFF00"><td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 1 gól</td><td colspan="3">4 body</td></tr>
                <tr style="background-color: #FF6600"><td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 2 góly</td><td colspan="3">3 body</td></tr>
                <tr style="background-color: #FF0000"><td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 3+ gólů</td><td colspan="3">1 bod</td></tr>
                <tr style="background-color: #00FF00"><td colspan="3">Za přesné trefení pozice týmu v konečné tabulce</td><td colspan="3">1 bod (Tabulka)</td></tr>
                <tr style="background-color: orangered"><td colspan="3">Odchylka tipu tabulky (rozdíl pozic)</td><td colspan="3">Sčítá se (čím méně, tím lépe)</td></tr>
            </table>
        </section>
        </section>`;
    }

    // --- PRAVÝ PANEL: TIPOVÁNÍ TABULKY ---
    html += `
        <section class="matches-container">
            <h2 style="text-align:center;">Seřaď týmy v tabulce</h2>
            <p style="text-align:center;">Chyť tým myší a přetáhni ho na požadovanou pozici.</p>
            
            <form id="sortForm">
    `;

    for (const gKey of sortedGroupKeys) {
        let teamsInGroup = groupedTeams[gKey];
        // Převedeme 1 na "Skupina A" jen pro zobrazení
        const groupLabel = getGroupDisplayLabel(gKey);

        // Kontrola zámku: gKey je "1" (číslo jako string), isTipsLocked v DB je ["1"]
        const isGroupLocked = (isTipsLocked === true) || (Array.isArray(isTipsLocked) && isTipsLocked.includes(gKey));

        // Načtení tipu
        let currentGroupTipIds = [];
        if (userTipData) {
            if (Array.isArray(userTipData)) {
                currentGroupTipIds = userTipData;
            } else {
                currentGroupTipIds = userTipData[gKey] || [];
            }
        }
        const hasTipForGroup = currentGroupTipIds.length > 0;

        // Vypočteme REÁLNÉ pořadí
        const realRankMap = {};
        const realStandings = [...teamsInGroup].sort((a, b) => {
            const statsA = scores[a.id] || { points: 0, gf: 0, ga: 0 };
            const statsB = scores[b.id] || { points: 0, gf: 0, ga: 0 };
            if (statsB.points !== statsA.points) return statsB.points - statsA.points;
            return (statsB.gf - statsB.ga) - (statsA.gf - statsA.ga);
        });
        realStandings.forEach((t, i) => realRankMap[t.id] = i + 1);

        // Řazení pro zobrazení
        if (hasTipForGroup) {
            teamsInGroup.sort((a, b) => {
                const indexA = currentGroupTipIds.indexOf(a.id);
                const indexB = currentGroupTipIds.indexOf(b.id);
                if (indexA === -1) return 1;
                if (indexB === -1) return -1;
                return indexA - indexB;
            });
        } else {
            teamsInGroup.sort((a, b) => {
                const statsA = scores[a.id] || { points: 0, gf: 0, ga: 0 };
                const statsB = scores[b.id] || { points: 0, gf: 0, ga: 0 };
                if (statsB.points !== statsA.points) return statsB.points - statsA.points;
                return (statsB.gf - statsB.ga) - (statsA.gf - statsA.ga);
            });
        }

        html += `
            <div style="margin-top: 30px;">
                ${groupLabel ? `<h3 style="border-bottom:1px solid #555;">${groupLabel}</h3>` : ''}
                
                ${isGroupLocked ? `<div style="background-color:#330000; color:#ffcccc; padding:5px; border:1px solid red; font-size:0.8em; margin-bottom:5px;">Skupina uzamčena</div>` : ''}
                
                <ul class="sortable-list" id="list-${gKey}" data-group="${gKey}">
                    ${teamsInGroup.map((team, index) => {
            const userRank = index + 1;
            const realRank = realRankMap[team.id];
            const diff = userRank - realRank;
            const isCorrect = (diff === 0);

            let bgStyle = "background-color: #1a1a1a; border: 1px solid #444;";
            let diffText;
            let diffColor = "gray";

            if (hasTipForGroup) {
                if (isCorrect) {
                    bgStyle = "background-color: rgba(40, 100, 40, 0.6); border-color: #00ff00;";
                    diffText = "✔";
                    diffColor = "#00ff00";
                } else {
                    diffText = `<span style="font-size: 0.8em">Akt.: ${realRank}. (${Math.abs(diff)})</span>`;
                    diffColor = "orange";
                }
            } else {
                diffText = `<span style="font-size: 0.7em; color: #666;">Neuloženo</span>`;
            }

            return `
                        <li class="sortable-item" 
                            draggable="${!isGroupLocked}" 
                            data-id="${team.id}"
                            data-group="${gKey}"
                            style="${bgStyle} ${isGroupLocked ? 'cursor: default; opacity: 0.9;' : 'cursor: grab;'} display: flex; align-items: center; justify-content: space-between; margin: 5px 0; padding: 15px; color: #fff;">
                            
                            <div style="display:flex; align-items:center;">
                                <span class="rank-number" style="font-weight: bold; color: orangered; margin-right: 15px; width: 30px;">${userRank}.</span>
                                <span class="team-name" style="font-weight: bold;">${team.name}</span>
                            </div>

                            <div style="display:flex; align-items:center; gap: 15px;">
                                <span style="color: ${diffColor}; font-weight: normal; margin-right: 10px;">${diffText}</span>
                                <span style="font-size:20px;">${isGroupLocked ? '🔒' : '☰'}</span>
                            </div>
                        </li>
                        `;
        }).join('')}
                </ul>
            </div>
        `;
    }

    if (isTipsLocked !== true) {
        html += `<button type="button" id="saveBtn" class="save-btn" style="margin-top:20px;">Uložit všechny tipy</button>`;
    }

    // --- SCRIPT (OPRAVA DRAG&DROP BUGU) ---
    html += `
            </form>
        </section>
    </main>
    <script>
        const currentUserUsername = "${username}";
        const sortableLists = document.querySelectorAll('.sortable-list');
        let draggedItem = null;
        let sourceListId = null;

        sortableLists.forEach(list => {
            list.addEventListener('dragstart', (e) => {
                const item = e.target.closest('.sortable-item');
                const isDraggable = item && item.getAttribute('draggable') !== 'false';

                if (isDraggable) {
                    draggedItem = item;
                    sourceListId = list.id;
                    item.classList.add('dragging');
                } else {
                    e.preventDefault();
                }
            });
            
            list.addEventListener('dragend', (e) => {
                const item = e.target.closest('.sortable-item');
                if (item) {
                    item.classList.remove('dragging');
                }
                draggedItem = null;
                sourceListId = null;
                updateRanks(list);
            });
            
            list.addEventListener('dragover', (e) => {
                e.preventDefault();
                
                if (list.id === sourceListId) {
                    const afterElement = getDragAfterElement(list, e.clientY);
                    if (afterElement == null) {
                        list.appendChild(draggedItem);
                    } else {
                        list.insertBefore(draggedItem, afterElement);
                    }
                }
            });
        });

        function getDragAfterElement(container, y) {
            const draggableElements = [...container.querySelectorAll('.sortable-item:not(.dragging)')];
            return draggableElements.reduce((closest, child) => {
                const box = child.getBoundingClientRect();
                const offset = y - box.top - box.height / 2;
                if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
                else return closest;
            }, { offset: Number.NEGATIVE_INFINITY }).element;
        }

        function updateRanks(listContainer) {
            const items = listContainer.querySelectorAll('.sortable-item');
            items.forEach((item, index) => {
                const rs = item.querySelector('.rank-number');
                if (rs) rs.innerText = (index + 1) + '.';
            });
        }

        const saveBtn = document.getElementById('saveBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                if (currentUserUsername === 'Admin') return alert('Admin netipuje.');

                const payloadData = {};
                document.querySelectorAll('.sortable-list').forEach(list => {
                    const gKey = list.getAttribute('data-group');
                    
                    payloadData[gKey] = Array.from(list.querySelectorAll('.sortable-item'))
                                     .map(i => parseInt(i.getAttribute('data-id')));
                });

                fetch('/table-tip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        liga: '${selectedLiga}',
                        season: '${selectedSeason}',
                        teamOrder: payloadData
                    })
                }).then(res => {
                    if(res.ok) { alert('Uloženo!'); location.reload(); }
                    else if(res.status === 403) alert('Některá ze skupin je zamčena!');
                    else alert('Chyba.');
                });
            });
        }
    </script>
    </body>
    </html>
    `;
    res.send(html);
});

router.post("/table-tip", requireLogin, express.json(), (req, res) => {
    const username = req.session.user;
    if (username === "Admin") return res.status(403).send("Admin netipuje.");

    const { liga, season, teamOrder } = req.body; // teamOrder je objekt
    if (!liga || !season || !teamOrder) return res.status(400).send("Chybí data.");

    // Kontrola globálního zámku
    try {
        const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
        const lockedStatus = statusData?.[season]?.[liga]?.tableTipsLocked;
        if (lockedStatus === true) return res.status(403).send("Tipování je uzamčeno.");
    } catch (e) {}

    let tableTips = {};
    try {
        if (fs.existsSync('./data/tableTips.json')) {
            tableTips = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8'));
        }
    } catch (e) { console.error(e); }

    if (!tableTips[season]) tableTips[season] = {};
    if (!tableTips[season][liga]) tableTips[season][liga] = {};

    tableTips[season][liga][username] = teamOrder;

    fs.writeFileSync('./data/tableTips.json', JSON.stringify(tableTips, null, 2));
    res.sendStatus(200);
});

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

    // --- NAČÍTÁNÍ STATISTIK VČETNĚ TABULKY ---
    let userStats = [];
    try {
        const usersData = fs.readFileSync('./data/users.json', 'utf-8');
        const allUsers = JSON.parse(usersData);
        const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);

        userStats = allUsers
            .filter(u => {
                // Zobrazit uživatele, pokud má tipy na zápasy NEBO tip na tabulku
                const tips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
                const tableStats = u.stats?.[selectedSeason]?.[selectedLiga]?.tableCorrect;
                return tips.length > 0 || tableStats !== undefined;
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
                    totalPlayoff: stats.totalPlayoff || 0,
                    // NOVÉ STATISTIKY PRO TABULKU
                    tableCorrect: stats.tableCorrect || 0,
                    tableDeviation: stats.tableDeviation || 0
                };
            });
    } catch (err) {
        console.error("Chyba při načítání statistik uživatelů:", err);
    }

    const currentUserStats = userStats.find(u => u.username === username);

    // ... (PONECHÁNÍ TVÉHO KÓDU PRO PLAYOFF DATA) ...
    const playoffPath = path.join(__dirname, '../data/playoff.json');
    let playoffData = [];
    try {
        const raw = fs.readFileSync(playoffPath, 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) {
            playoffData = allPlayoffs[selectedSeason][selectedLiga];
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

    const sortedGroups = Object.keys(teamsByGroup).sort();

    let isRegularSeasonFinished = false;
    try {
        const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
        isRegularSeasonFinished = statusData?.[selectedSeason]?.[selectedLiga]?.regularSeasonFinished || false;
    } catch (e) {}
    const statusStyle = isRegularSeasonFinished
        ? "color: lightgrey; font-weight: bold;"
        : "color: white; opacity: 0.7; background-color: black";
    // --- ZAČÁTEK HTML ---
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
    <form class="league-dropdown" method="GET" action="/">
    <div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
    <label class="league-select-name">
        Liga:
        <select id="league-select" name="liga" required onchange="this.form.submit()">
        ${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
    </label>
        <a class="history-btn" href="/history">Historie</a>
        <a class="history-btn changed" href="/table-tip?liga=${encodeURIComponent(selectedLiga)}">Základní část</a>
        <a class="history-btn changed" href="/prestupy">Přestupy TELH</a>
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
        `;

    // ... (PONECHEJ TVŮJ KÓD GENERUJÍCÍ TABULKU TÝMŮ - teamsInGroup smyčka) ...
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
    const filledMatches = matches.filter(m => m.result && m.liga === selectedLiga && m.season === selectedSeason).length;
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
        userStats
            .sort((a, b) => {
                if (b.correct !== a.correct) {
                    return b.correct - a.correct;
                }
                if (b.tableCorrect !== a.tableCorrect) return b.tableCorrect - a.tableCorrect;
                return a.tableDeviation - b.tableDeviation;
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
            <td style="${statusStyle}">${user.tableCorrect > 0 ? user.tableCorrect : '-'}</td>
            <td style="${statusStyle}">${user.tableDeviation > 0 ? user.tableDeviation : '-'}</td>
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
        <tr style="background-color: #00FF00">
            <td colspan="3">Za přesné trefení pozice týmu v konečné tabulce</td>
            <td colspan="3">1 bod (Tabulka)</td>
        </tr>
        <tr style="background-color: orangered">
            <td colspan="3">Odchylka tipu tabulky (rozdíl pozic)</td>
            <td colspan="3">Sčítá se (čím méně, tím lépe)</td>
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

        form.querySelectorAll('input[type="number"]').forEach(input => {
    
    // 1. HLAVNÍ LOGIKA - Spustí se při "opuštění" políčka (klik vedle, Tab, nebo vynucený blur)
    input.addEventListener('change', () => {
        if (!winnerInput.value) { 
            alert('Vyber nejdřív vítěze!');
            // Volitelné: vrátit focus zpět, pokud chybí vítěz
            // e.target.focus(); 
            return; 
        }

        const scoreHome = form.querySelector('input[name="scoreHome"]').value;
        const scoreAway = form.querySelector('input[name="scoreAway"]').value;

        // Kontrola, zda jsou vyplněna obě čísla
        if (scoreHome === '' || scoreAway === '') {
            return; 
        }

        const formData = new URLSearchParams();
        formData.append('matchId', matchId);
        formData.append('winner', winnerInput.value);
        formData.append('scoreHome', scoreHome);
        formData.append('scoreAway', scoreAway);

        console.log('Ukládám...'); // Debug
        sendTip(formData, null, null, null);
    });

    // 2. ENTER LOGIKA - Jen "vyhodí" uživatele z políčka
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); // Zabrání odeslání celého formuláře (refresh stránky)
            input.blur();       // TOTO je ten trik -> způsobí, že se spustí 'change' nahoře
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
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf-8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));

    // 1. ZÁKLADNÍ NAČÍTÁNÍ DAT TÝMŮ A LIG
    const teams = loadTeams().filter(t => t.stats[selectedSeason]).filter(t => t.stats[selectedSeason].wins + t.stats[selectedSeason].otWins + t.stats[selectedSeason].otLosses + t.stats[selectedSeason].losses > 0);
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];
    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];
    const uniqueLeagues = allLeagues.filter(l => matches.some(m => m.liga === l && m.season === selectedSeason));

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga) ? req.query.liga : uniqueLeagues[0];
    const teamsInSelectedLiga = teams.filter(t => t.liga === selectedLiga);
    const scores = calculateTeamScores(matches, selectedSeason, selectedLiga);
    const leagueObj = leagues.find(l => l.name === selectedLiga);

    // --- HLAVNÍ OPRAVA: VŠE NAČTEME A SPOČÍTÁME TADY NAHOŘE ---

    // 2. NAČTENÍ UŽIVATELŮ (pouze jednou)
    let allUsers = [];
    try {
        const usersData = fs.readFileSync('./data/users.json', 'utf-8');
        allUsers = JSON.parse(usersData);
    } catch (err) {
        console.error("Chyba při načítání uživatelů:", err);
    }

    // 3. ZJIŠTĚNÍ INITIAL USER (Kdo se má zobrazit)
    const usersWithTips = allUsers.filter(u => {
        const tips = u.tips?.[selectedSeason]?.[selectedLiga];
        return tips && tips.length > 0;
    }).sort((a, b) => a.username.localeCompare(b.username));

    // Pokud je přihlášený uživatel v seznamu, vybereme jeho. Jinak prvního ze seznamu.
    const initialUser = usersWithTips.find(u => u.username === username) ? username : (usersWithTips[0]?.username || "");

    // 4. VÝPOČET STATISTIK (userStats)
    const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);

    const userStats = allUsers
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

    // Najdeme statistiky pro toho uživatele, kterého jsme vybrali jako výchozího
    const displayedUserStats = userStats.find(u => u.username === initialUser);

    // --- KONEC OPRAVY LOGIKY, DÁLE POKRAČUJE HTML GENERACE ---

    const playoffPath = path.join(__dirname, '../data/playoff.json');
    let playoffData = [];
    try {
        const raw = fs.readFileSync(playoffPath, 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) {
            playoffData = allPlayoffs[selectedSeason][selectedLiga];
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

    // ... ZDE JE VÁŠ KÓD PRO TABULKY TÝMŮ (beze změny) ...
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

        html += `<table class="points-table"><thead><tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část${isMultigroup ? ` - Skupina ${groupLetter}` : ''}</h2></th></tr><tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr></thead><tbody>`;

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
            const numberMatches = (team.stats?.[selectedSeason]?.wins || 0) + (team.stats?.[selectedSeason]?.otWins || 0) + (team.stats?.[selectedSeason]?.otLosses || 0) + (team.stats?.[selectedSeason]?.losses || 0);
            const zone = getTeamZone(index, teamsInGroup.length, zoneConfig);
            const locked = isLockedPosition(index, teamsInGroup.length, sorted, zoneConfig, selectedSeason, matchesPerTeam, allTeamsFinished);
            const rowClass = locked ? `${zone} locked` : zone;
            html += `<tr class="${rowClass}"> <td class="rank-cell ${zone}">${index + 1}.</td> <td>${team.name}</td><td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td><td class="numbers">${teamStats.gf}:${teamStats.ga}</td><td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td><td class="numbers">${numberMatches}</td><td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td><td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td><td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td><td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td></tr>`;
        });
        html += `</tbody></table><br>`;
    }
    html += `</div><div id="playoffTablePreview" style="display:none; overflow:auto; max-width:100%;"><table class="points-table"><tr><th scope="col" id="points-table-header" colspan="20"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Playoff</h2></th></tr>`;
    playoffData.forEach((row) => {
        html += '<tr>';
        row.forEach(cell => { const bg = cell.bgColor ? ` style="background-color:${cell.bgColor}"` : ''; const txt = cell.text || ''; html += `<td${bg}>${txt}</td>`; });
        html += '</tr>';
    });
    html += `</table></div><script>function showTable(which) { document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none'; const p = document.getElementById('playoffTablePreview'); p.style.display = which === 'playoff' ? 'block' : 'none'; }</script></div>`;


    // --- HORNÍ STATISTIKY (Používáme initialUser a displayedUserStats spočítané nahoře) ---
    if (initialUser) {
        html += `
            <section class="user_stats">
                <h2>Statistiky uživatele <span id="stats-username-header">${initialUser}</span></h2>
                <div id="stats-content-box">`;

        if (displayedUserStats) {
            const percent = displayedUserStats.total > 0 ? (displayedUserStats.correct / displayedUserStats.total * 100).toFixed(2) : "0.00";
            html += `<p>Správně tipnuto z maximálního počtu všech možných bodů: <strong>${displayedUserStats.correct}</strong> z <strong>${displayedUserStats.total}</strong> (${percent} %)</p>`;
        } else {
            html += `<p>Data nejsou dostupná.</p>`;
        }
        html += `</div></section>`;

        // --- TABULKA VŠECH UŽIVATELŮ ---
        html += `<section class="global_stats"><table class="points-table"><thead><tr><th scope="col" id="points-table-header" colspan="6"><h2>Statistiky všech</h2></th></tr><tr><th class="position">Místo</th><th>Uživatel</th><th>Úspěšnost</th><th>Počet bodů</th><th>Celkem tipů v ZČ</th><th>Celkem tipů v Playoff</th></tr></thead><tbody>`;
        userStats.sort((a, b) => {
            if (b.correct !== a.correct) return b.correct - a.correct;
            return a.maxFromTips - b.maxFromTips;
        }).forEach((user, index) => {
            const successRateOverall = user.maxFromTips > 0 ? ((user.correct / user.maxFromTips) * 100).toFixed(2) : '0.00';
            const successRate = user.total > 0 ? ((user.correct / user.total) * 100).toFixed(2) : '0.00';
            html += `<tr><td>${index + 1}.</td><td>${user.username}</td><td>${successRateOverall}%${user.total !== user.maxFromTips ? ` (${successRate}%)` : ''}</td><td>${user.correct}</td><td>${user.totalRegular}</td><td>${user.totalPlayoff}</td></tr>`;
        });
        html += `</tbody></table><br>
        <table style="color: black" class="points-table">
            <tr style="background-color: #00FF00"><td colspan="3">Za správný tip zápasu v základní části</td><td colspan="3">1 bod</td></tr>
            <tr style="background-color: #FF0000"><td colspan="3">Za správný tip vítěze dané série v playoff ale špatný tip počtu vyhraných zápasů týmu který prohrál</td><td colspan="3">1 bod</td></tr>
            <tr style="background-color: #00FF00"><td colspan="3">Za správný tip vítěze dané série v playoff + počet vyhraných zápasů týmů který prohrál</td><td colspan="3">3 body</td></tr>
            <tr style="background-color: #00FF00"><td colspan="3">Za správný tip vítěze daného zápasu v playoff + správné skóre</td><td colspan="3">5 bodů</td></tr>
            <tr style="background-color: #FFFF00"><td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 1 gól</td><td colspan="3">4 body</td></tr>
            <tr style="background-color: #FF6600"><td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 2 góly</td><td colspan="3">3 body</td></tr>
            <tr style="background-color: #FF0000"><td colspan="3">Za správný tip vítěze daného zápasu v playoff + chyba ve skóre o 3+ gólů</td><td colspan="3">1 bod</td></tr>
        </table>
        </section></section>`;

        // --- SPODNÍ ČÁST (HISTORIE) ---
        html += `
        <section class="matches-container">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                <h2 style="margin: 0;">Historie tipů</h2>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label for="historyUserSelect" style="color: lightgrey;">Zobrazit:</label>
                    <select id="historyUserSelect" onchange="showUserHistory(this.value)" style="background-color: black; color: orangered; border: 1px solid orangered; padding: 5px; border-radius: 5px;">`;

        // ZDE UŽ NEPOČÍTÁME usersWithTips ZNOVU, POUŽIJEME PROMĚNNOU ZE ZAČÁTKU
        if (usersWithTips.length === 0) {
            html += `<option disabled selected>Žádná data</option>`;
        } else {
            usersWithTips.forEach(u => {
                const isSelected = u.username === initialUser ? 'selected' : '';
                html += `<option value="${u.username}" ${isSelected}>${u.username}</option>`;
            });
        }

        html += `   </select></div></div><table class="points-table">`;

        const groupedMatches = matches
            .filter(m => m.liga === selectedLiga && m.result && m.season === selectedSeason)
            .sort((a, b) => new Date(a.datetime) - new Date(b.datetime))
            .reduce((groups, match) => {
                const dateTime = match.datetime || match.date || "Neznámý čas";
                if (!groups[dateTime]) groups[dateTime] = [];
                groups[dateTime].push(match);
                return groups;
            }, {});

        const teamsJSON = JSON.parse(fs.readFileSync('./data/teams.json', 'utf8'));

        const renderUserTip = (u, match, type) => {
            const userTip = u.tips?.[selectedSeason]?.[selectedLiga]?.find(t => t.matchId === match.id);
            const selectedWinner = userTip?.winner;
            const bo = match.bo || 5;
            // Použijeme initialUser pro určení viditelnosti
            const visibilityStyle = u.username === initialUser ? '' : 'display:none;';
            const userClass = `history-item user-${u.username.replace(/[^a-zA-Z0-9]/g, '_')}`;

            if (type === 'home' || type === 'away') {
                const teamName = type === 'home'
                    ? (teamsJSON.find(t => t.id === match.homeTeamId)?.name || '???')
                    : (teamsJSON.find(t => t.id === match.awayTeamId)?.name || '???');
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
                        let sc = diff === 0 ? 'exact-score' : (diff === 1 ? 'diff-1' : (diff === 2 ? 'diff-2' : 'diff-3plus'));
                        return `<div class="${userClass} team-link-history ${sc}" style="${visibilityStyle}">${tH} : ${tA}</div>`;
                    } else {
                        const correct = userTip?.loserWins !== undefined && userTip.loserWins === (match.result.winner === "home" ? match.result.scoreAway : match.result.scoreHome);
                        const sc = correct ? "right-selected" : "wrong-selected";
                        return `<div class="${userClass} team-link-history ${sc}" style="${visibilityStyle}">${userTip?.loserWins ?? '-'}</div>`;
                    }
                }
                return `<div class="${userClass}" style="${visibilityStyle}">-</div>`;
            }
            return '';
        };

        for (const [dateTime, matchesAtSameTime] of Object.entries(groupedMatches)) {
            const formattedDateTime = new Date(dateTime).toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            html += `<h3>${formattedDateTime}</h3><table class="matches-table"><thead class="matches-table-header"><tr><th colSpan="6">Zápasy</th></tr></thead><tbody>`;
            for (const match of matchesAtSameTime) {
                let homeCellHTML = "", awayCellHTML = "", scoreCellHTML = "";
                usersWithTips.forEach(u => {
                    homeCellHTML += renderUserTip(u, match, 'home');
                    awayCellHTML += renderUserTip(u, match, 'away');
                    if (match.isPlayoff) scoreCellHTML += renderUserTip(u, match, 'score');
                });

                if (!match.isPlayoff) {
                    html += `<tr class="match-row"><td class="match-row">${homeCellHTML}</td><td class="vs">${match.result.scoreHome}</td><td class="vs">${match.result.ot === true ? "pp/sn": ":"}</td><td class="vs">${match.result.scoreAway}</td><td class="match-row">${awayCellHTML}</td></tr>`;
                } else {
                    html += `<tr class="match-row"><td>${homeCellHTML}</td><td class="vs">${match.result.scoreHome}</td><td class="vs">vs</td><td class="vs">${match.result.scoreAway}</td><td>${awayCellHTML}</td></tr><tr class="match-row"><td style="color: black" colspan="5">${scoreCellHTML}</td></tr>`;
                }
            }
            html += `</tbody></table>`;
        }

        html += `</section></main>
    <script>
        const globalStatsData = ${JSON.stringify(userStats)};

        function showUserHistory(username) {
            const statsHeader = document.getElementById('stats-username-header');
            const statsBox = document.getElementById('stats-content-box');
            const userStat = globalStatsData.find(u => u.username === username);

            if (statsHeader) statsHeader.innerText = username;
            if (statsBox) {
                if (userStat) {
                    const percent = userStat.total > 0 ? (userStat.correct / userStat.total * 100).toFixed(2) : "0.00";
                    statsBox.innerHTML = '<p>Správně tipnuto z maximálního počtu všech možných bodů: <strong>' + userStat.correct + '</strong> z <strong>' + userStat.total + '</strong> (' + percent + ' %)</p>';
                } else {
                    statsBox.innerHTML = '<p>Data statistik nejsou pro tohoto uživatele dostupná.</p>';
                }
            }

            document.querySelectorAll('.history-item').forEach(el => el.style.display = 'none');
            const safeName = username.replace(/[^a-zA-Z0-9]/g, '_');
            document.querySelectorAll('.user-' + safeName).forEach(el => el.style.display = 'flex');
        }
    </script></body></html>`;

        res.send(html);
    }

});

router.get("/prestupy", requireLogin, (req, res) => {
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

    // --- NAČÍTÁNÍ STATISTIK VČETNĚ TABULKY ---
    let userStats = [];
    try {
        const usersData = fs.readFileSync('./data/users.json', 'utf-8');
        const allUsers = JSON.parse(usersData);
        const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);

        userStats = allUsers
            .filter(u => {
                // Zobrazit uživatele, pokud má tipy na zápasy NEBO tip na tabulku
                const tips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
                const tableStats = u.stats?.[selectedSeason]?.[selectedLiga]?.tableCorrect;
                return tips.length > 0 || tableStats !== undefined;
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
                    totalPlayoff: stats.totalPlayoff || 0,
                    // NOVÉ STATISTIKY PRO TABULKU
                    tableCorrect: stats.tableCorrect || 0,
                    tableDeviation: stats.tableDeviation || 0
                };
            });
    } catch (err) {
        console.error("Chyba při načítání statistik uživatelů:", err);
    }
    const currentUserStats = userStats.find(u => u.username === username);

    // ... (PONECHÁNÍ TVÉHO KÓDU PRO PLAYOFF DATA) ...
    const playoffPath = path.join(__dirname, '../data/playoff.json');
    let playoffData = [];
    try {
        const raw = fs.readFileSync(playoffPath, 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) {
            playoffData = allPlayoffs[selectedSeason][selectedLiga];
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

    const sortedGroups = Object.keys(teamsByGroup).sort();

    let isRegularSeasonFinished = false;
    try {
        const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
        isRegularSeasonFinished = statusData?.[selectedSeason]?.[selectedLiga]?.regularSeasonFinished || false;
    } catch (e) {}
    const statusStyle = isRegularSeasonFinished
        ? "color: lightgrey; font-weight: bold;"
        : "color: white; opacity: 0.7; background-color: black";
    // --- ZAČÁTEK HTML ---
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
    <form class="league-dropdown" method="GET" action="/">
    <div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
    <label class="league-select-name">
        Liga:
        <select id="league-select" name="liga" required onchange="this.form.submit()">
        ${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
    </label>
        <a class="history-btn" href="/history">Historie</a>
        <a class="history-btn changed" href="/?liga=${encodeURIComponent(selectedLiga)}">Tipovačka</a>
        <a class="history-btn changed" href="/table-tip?liga=${encodeURIComponent(selectedLiga)}">Základní část</a>
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
        `;

    // ... (PONECHEJ TVŮJ KÓD GENERUJÍCÍ TABULKU TÝMŮ - teamsInGroup smyčka) ...
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
    const filledMatches = matches.filter(m => m.result && m.liga === selectedLiga && m.season === selectedSeason).length;
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
        userStats
            .sort((a, b) => {
                if (b.correct !== a.correct) {
                    return b.correct - a.correct;
                }
                if (b.tableCorrect !== a.tableCorrect) return b.tableCorrect - a.tableCorrect;
                return a.tableDeviation - b.tableDeviation;
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
            <td style="${statusStyle}">${user.tableCorrect > 0 ? user.tableCorrect : '-'}</td>
            <td style="${statusStyle}">${user.tableDeviation > 0 ? user.tableDeviation : '-'}</td>
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
        <tr style="background-color: #00FF00">
            <td colspan="3">Za přesné trefení pozice týmu v konečné tabulce</td>
            <td colspan="3">1 bod (Tabulka)</td>
        </tr>
        <tr style="background-color: orangered">
            <td colspan="3">Odchylka tipu tabulky (rozdíl pozic)</td>
            <td colspan="3">Sčítá se (čím méně, tím lépe)</td>
        </tr>
    </table>
</section>
</section>
<section class="matches-container">
<h1>Funkce bude v budoucnu přidána</h1>
</section>
</main></body>
` }
    res.send(html)
});
module.exports = router;