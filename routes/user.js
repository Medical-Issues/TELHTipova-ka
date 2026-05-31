const fs = require("fs");
const express = require("express");
const router = express.Router();
const path = require('path');
const {
    requireLogin, prepareDashboardData, getGroupDisplayLabel, generateLeftPanel,
    getLeagueStatusData, getTableTipsData, generateTimeWidget, getAllowedLeagues, createMatchImage
} = require("../utils/fileUtils");
const { Users, Matches, Leagues, TableTips, ChosenSeason} = require('../utils/mongoDataAccess');
// Jednoduchá XSS ochrana - sanitizace HTML tagů
function sanitizeInput(input) {
    if (typeof input !== 'string') return input;
    return input
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/&/g, '&amp;');
}

// Middleware pro sanitizaci req.body
function sanitizeBody(req, res, next) {
    if (req.body) {
        for (const key in req.body) {
            if (typeof req.body[key] === 'string') {
                req.body[key] = sanitizeInput(req.body[key]);
            }
        }
    }
    next();
}

router.use(sanitizeBody);

// Middleware pro zajištění CSRF tokenu v session
router.use((req, res, next) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
        req.session.save((err) => {
            if (err) console.error('Chyba při ukládání session:', err);
        });
    }
    next();
});

router.get("/table-tip", requireLogin, async (req, res) => {
    // Kontrola jest je liga veřejná
    const chosenSeason = await ChosenSeason.findAll();
    const allowedLeagues = await getAllowedLeagues(chosenSeason);
    const requestedLiga = req.query.liga;
    if (requestedLiga && !allowedLeagues.includes(requestedLiga)) {
        // Přesměruj na první veřejnou ligu
        const firstPublic = allowedLeagues[0] || 'Neurčeno';
        return res.redirect(`/table-tip?liga=${encodeURIComponent(firstPublic)}`);
    }
    
    // 1. ZAVOLÁME MOZEK, KTERÝ VŠE VYPOČÍTÁ BĚHEM MILISEKUNDY
    const data = await prepareDashboardData(req);
    const {
        username, selectedSeason, selectedLiga, uniqueLeagues, isTipsLocked, userTipData,
        sortedGroups, teamsByGroup, globalRealRankMap, sortedGroupKeys, groupedTeams,
    } = data;

// --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Tipovačka</title>
<link rel="stylesheet" href="/css/styles.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
<script>
function showTable(which) { 
    document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none'; 
    const p = document.getElementById('playoffTablePreview'); p.style.display = which === 'playoff' ? 'block' : 'none'; 
}

 // Převod klíče
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

async function toggleNotifications() {
    const btn = document.getElementById('notify-toggle-btn');
    if (!btn) return;
    
    btn.disabled = true;
    btn.textContent = "Pracuji...";

    try {
        let registration = await navigator.serviceWorker.getRegistration();
        
        if (!registration) {
            registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        }

        let retry = 0;
        while (!registration.active && retry < 10) {
            await new Promise(res => setTimeout(res, 500));
            registration = await navigator.serviceWorker.getRegistration();
            retry++;
        }

        if (!registration.active) {
            alert("Service Worker se nepodařilo aktivovat.");
            btn.disabled = false;
            await checkSubscriptionStatus();
            return;
        }

        const subscription = await registration.pushManager.getSubscription();

        if (subscription) {
            // ODHLÁŠENÍ
            const res = await fetch('/api/unsubscribe', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': '${req.session.csrfToken || ''}'
                },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            if (res.ok) {
                await subscription.unsubscribe();
                alert('Notifikace vypnuty.');
                await checkSubscriptionStatus();
            }
        } else {
            // PŘIHLÁŠENÍ
            const vapidRes = await fetch('/api/vapid-public-key');
            if (!vapidRes.ok) {
                alert('Server neodpovídá (chyba při získávání klíče).');
                btn.disabled = false;
                await checkSubscriptionStatus();
                return;
            }
            const vapidPublicKey = await vapidRes.text();

            const newSub = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
            });

            const saveRes = await fetch('/api/subscribe', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': '${req.session.csrfToken || ''}'
                },
                body: JSON.stringify(newSub)
            });
            
            if (saveRes.ok) {
                alert('Notifikace zapnuty!');
                await checkSubscriptionStatus();
            } else {
                alert('Nepodařilo se uložit odběr na server.');
            }
        }
    } catch (e) {
        console.error("Kritická chyba notifikací:", e);
        alert('Došlo k nečekané chybě: ' + e.message);
    }
    
    await checkSubscriptionStatus();
    btn.disabled = false;
}

async function checkSubscriptionStatus() {
    const btn = document.getElementById('notify-toggle-btn');
    if (!btn) return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        btn.textContent = "Nepodporováno";
        btn.disabled = true;
        return;
    }

    try {
        // Kontrola stavu bez zbytečného čekání
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = registration ? await registration.pushManager.getSubscription() : null;

        if (subscription) {
            btn.textContent = "Vypnout notifikace 🔕";
            btn.style.backgroundColor = "#555";
        } else {
            btn.textContent = "Zapnout notifikace 🔔";
            btn.style.backgroundColor = "#ff4500";
        }
    } catch (e) {
        btn.textContent = "Klikni pro stav";
    }
}

document.addEventListener('DOMContentLoaded', checkSubscriptionStatus);
</script>
<body class="usersite">
<header class="header">
<div class="header-main">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
<div class="header-user">
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</div>
</div>
<div class="header-controls">
<form class="league-dropdown" method="GET">
<label class="league-select-name">
Liga:
<select id="league-select" name="liga" required onchange="this.form.submit()">
${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
</select>
</label>
<a class="history-btn" href="/history">Historie</a>
<a class="history-btn changed" href="/?liga=${encodeURIComponent(selectedLiga)}">Tipovačka</a>
<a class="history-btn changed" href="/prestupy?liga=${encodeURIComponent(selectedLiga)}">Přestupy</a>
<a class="history-btn changed" href="/image-exporter?liga=${encodeURIComponent(selectedLiga)}">Exportér</a>
<a class="history-btn changed" href="/statistics">Statistiky</a>
<div style="text-align: center; margin: 0;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()"
        style="width: 220px; height: 38px; cursor: pointer; font-weight: bold; border: none; color: white; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
<input type="hidden" id="globalCsrfToken" value="${req.session.csrfToken || ''}">
</form>
</div>
</header>
<header class="time-header">${await generateTimeWidget()}<a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75em; color: #666; text-decoration: none; cursor: pointer; opacity: 0.7; transition: opacity 0.3s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">v<span id="current-version">...</span></a></header>
<main class="main_page">`;

html += await generateLeftPanel(data);

    // =========================================================
    // 1. ZÍSKÁNÍ SKUTEČNÉHO POŘADÍ Z LEVÉ TABULKY
    // =========================================================
    // Levá tabulka už pole v teamsByGroup správně seřadila podle IIHF,
    // takže si jen uložíme výsledné pozice každého týmu, abychom je vpravo nemuseli složitě počítat.
    for (const group of sortedGroups) {
        teamsByGroup[group].forEach((t, i) => {
            globalRealRankMap[t.id] = i + 1;
        });
    }

    // --- PRAVÝ PANEL: TIPOVÁNÍ TABULKY ---
    html += `
        <section class="matches-container">
            <h2 style="text-align:center;">Seřaď týmy v tabulce</h2>
            <p style="text-align:center;">Chyť tým myší a přetáhni ho na požadovanou pozici.</p>
            
            <form id="sortForm">
                <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
    `;

    for (const gKey of sortedGroupKeys) {
        let teamsInGroup = groupedTeams[gKey];
        const groupLabel = getGroupDisplayLabel(gKey);
        const isGroupLocked = (isTipsLocked === true) || (Array.isArray(isTipsLocked) && isTipsLocked.includes(gKey));

        // Načtení tipu uživatele
        let currentGroupTipIds = [];
        if (userTipData) {
            if (Array.isArray(userTipData)) {
                currentGroupTipIds = userTipData;
            } else {
                currentGroupTipIds = userTipData[gKey] || [];
            }
        }
        const hasTipForGroup = currentGroupTipIds.length > 0;

        // Vytvoříme bezpečnou KOPII pole, aby řazení vpravo nerozbilo nic dalšího!
        const teamsForTip = [...teamsInGroup];

        // Seřadíme týmy pro zobrazení v pravém panelu:
        if (hasTipForGroup) {
            // A) Pokud uživatel už tipoval, seřadíme podle jeho tipu
            teamsForTip.sort((a, b) => {
                const indexA = currentGroupTipIds.indexOf(a.id);
                const indexB = currentGroupTipIds.indexOf(b.id);
                if (indexA === -1) return 1;
                if (indexB === -1) return -1;
                return indexA - indexB;
            });
        } else {
            // B) Pokud ještě netipoval, ukážeme mu výchozí správné pořadí (vezmeme ho z naší mapy levé tabulky)
            teamsForTip.sort((a, b) => {
                const rankA = globalRealRankMap[a.id] || 99;
                const rankB = globalRealRankMap[b.id] || 99;
                return rankA - rankB;
            });
        }

        html += `
            <div style="margin-top: 30px;">
                ${groupLabel ? `<h3 style="border-bottom:1px solid #555;">${groupLabel}</h3>` : ''}
                
                ${isGroupLocked ? `<div style="background-color:#330000; color:#ffcccc; padding:5px; border:1px solid red; font-size:0.8em; margin-bottom:5px;">Skupina uzamčena</div>` : ''}
                
                <ul class="sortable-list" id="list-${gKey}" data-group="${gKey}">
                    ${teamsForTip.map((team, index) => {
            const userRank = index + 1;
            // ZDE se bere to jediné oficiální a správné pořadí
            const realRank = globalRealRankMap[team.id] || '?';
            const diff = userRank - realRank;
            const isCorrect = (diff === 0);
            const logoUrl = team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

            let bgStyle = "background-color: #1a1a1a; border: 1px solid #444;";
            let diffText;
            let diffColor = "gray";

            if (hasTipForGroup) {
                // PŘIDÁNA KONTROLA ZÁMKU: Zobrazí vyhodnocení jen pokud je skupina zamčená
                if (isGroupLocked) {
                    if (isCorrect) {
                        bgStyle = "background-color: rgba(40, 100, 40, 0.6); border-color: #00ff00;";
                        diffText = "✔";
                        diffColor = "#00ff00";
                    } else {
                        diffText = `<span style="font-size: 0.8em">Akt.: ${realRank}. (${Math.abs(diff)})</span>`;
                        diffColor = "orange";
                    }
                } else {
                    // Tip je uložený, ale tabulka ještě není zamčená z adminu
                    diffText = `<span style="font-size: 0.7em; color: #aaa;">Uloženo (čeká na uzamčení)</span>` ;
                    diffColor = "#aaa";
                }
            } else {
                diffText = `<span style="font-size: 0.7em; color: #666;">Neuloženo</span>`;
            }

            return `
                        <li class="sortable-item" 
                            draggable="${!isGroupLocked}" 
                            data-id="${team.id}"
                            data-group="${gKey}"
                            style="${bgStyle} ${isGroupLocked ? 'cursor: default; opacity: 0.9;' : 'cursor: grab;'} 
                           display: flex; align-items: center; justify-content: space-between; margin: 5px 0; padding: 15px; color: #fff;
                           position: relative; overflow: hidden;"> 
                           <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); 
                                width: 80%; height: 400%; 
                                background-image: url('${logoUrl}'); background-size: contain; background-repeat: no-repeat; background-position: center; 
                                opacity: 0.30; filter: grayscale(50%); pointer-events: none; z-index: 1;">
                           </div>
                            
                            <div style="display:flex; align-items:center; position: relative; z-index: 2;">
                                <span class="rank-number" style="font-weight: bold; color: orangered; margin-right: 15px; width: 30px;">${userRank}.</span>
                                <span class="team-name" style="font-weight: bold;">${team.name}</span>
                            </div>

                            <div style="display:flex; align-items:center; gap: 15px; position: relative; z-index: 2;">
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
    // language=HTML
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
                    if (offset < 0 && offset > closest.offset) return {offset: offset, element: child};
                    else return closest;
                }, {offset: Number.NEGATIVE_INFINITY}).element;
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
                        
                        // Kontrola zda je skupina zamčená - stejné logika jako v HTML generování
                        const isGroupLocked = list.querySelector('.sortable-item[draggable="false"]') !== null;
                        
                        // Ukládáme jen odemčené skupiny
                        if (!isGroupLocked) {
                            payloadData[gKey] = Array.from(list.querySelectorAll('.sortable-item'))
                                    .map(i => parseInt(i.getAttribute('data-id')));
                        }
                    });

                    fetch('/table-tip', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRF-Token': '${req.session.csrfToken || ''}'
                        },
                        body: JSON.stringify({
                            liga: '${selectedLiga}',
                            season: '${selectedSeason}',
                            teamOrder: payloadData,
                            _csrf: '${req.session.csrfToken || ''}'
                        })
                    }).then(res => {
                        if (res.ok) {
                            alert('Uloženo!');
                            // location.reload(); // Zakomentováno - nechceme reload aby se nevyhodnocovalo
                        } else if (res.status === 403) alert('Některá ze skupin je zamčena!');
                        else alert('Chyba.');
                    });
                });
            }
            document.addEventListener('DOMContentLoaded', () => {
                const sidebar = document.querySelector('.left-panel');
                const container = document.querySelector('.stats-container');

                if (!sidebar || !container) return;

                let lastScrollY = window.scrollY;
                let topOffset = 20; // Výchozí odsazení odshora
                const margin = 20; // Mezera nahoře i dole

                window.addEventListener('scroll', () => {
                    // Pokud je obrazovka dostatečně velká, že se tam panel vejde celý, normálně ho přilepíme k vršku
                    if (sidebar.offsetHeight <= window.innerHeight) {
                        sidebar.style.top = margin + 'px';
                        return;
                    }

                    const currentScrollY = window.scrollY;
                    const scrollDelta = currentScrollY - lastScrollY;
                    const viewportHeight = window.innerHeight;
                    const sidebarHeight = sidebar.offsetHeight;

                    // Minimální hodnota 'top', aby se ukázal spodek panelu (bude to záporné číslo)
                    const minTop = viewportHeight - sidebarHeight - margin;

                    if (scrollDelta > 0) {
                        // SCROLUJEME DOLŮ
                        topOffset -= scrollDelta;
                        if (topOffset < minTop) {
                            topOffset = minTop; // Zastavíme, když dorazíme na konec panelu (přilepí se ke spodku)
                        }
                    } else if (scrollDelta < 0) {
                        // SCROLUJEME NAHORU
                        topOffset -= scrollDelta; // (odčítáme záporné číslo = přičítáme)
                        if (topOffset > margin) {
                            topOffset = margin; // Zastavíme, když dorazíme na začátek panelu (přilepí se k vršku)
                        }
                    }

                    sidebar.style.top = topOffset + 'px';
                    lastScrollY = currentScrollY;
                });

                // Načíst verzi a zobrazit v badge
                fetch('/api/version')
                    .then(res => res.json())
                    .then(data => {
                        const versionBadge = document.getElementById('current-version');
                        if (versionBadge) {
                            versionBadge.textContent = data.version;
                        }
                    })
                    .catch(err => console.log('Nepodařilo se načíst verzi', err));
            });
        </script>
        <script src="/js/version-notification.js"></script>
        </body>
        </html>
    `;
    res.send(html);
});

router.post("/table-tip", requireLogin, express.json(), async (req, res) => {
    const username = req.session.user;
    if (username === "Admin") return res.status(403).send("Admin netipuje.");

    const {liga, season, teamOrder} = req.body; // teamOrder je objekt, např. {"1": [1,2,3]}
    if (!liga || !season || !teamOrder) return res.status(400).send("Chybí data.");

    // 1. KONTROLA ZÁMKŮ PŘED ULOŽENÍM
    let lockedStatus = false;
    try {
        const statusData = await getLeagueStatusData();
        lockedStatus = statusData?.[season]?.[liga]?.tableTipsLocked;
    } catch (e) {
        console.error("Chyba při kontrole zámku:", e);
    }

    // Globální zámek
    if (lockedStatus === true) return res.status(403).send("Tipování je uzamčeno.");

    // Částečný zámek (Multigroup) - zkontrolujeme, jestli se uživatel nesnaží poslat data do zamčené skupiny
    if (Array.isArray(lockedStatus)) {
        for (const groupKey of Object.keys(teamOrder)) {
            if (lockedStatus.includes(groupKey)) {
                return res.status(403).send(`Skupina ${groupKey} je uzamčena, nelze do ní tipovat.`);
            }
        }
    }

    let tableTips = {};
    try {
        tableTips = await getTableTipsData();
    } catch (e) {
        console.error("Chyba při čtení tableTips z MongoDB:", e);
    }

    if (!tableTips[season]) {
        tableTips[season] = {};
    }
    if (!tableTips[season][liga]) {
        tableTips[season][liga] = {};
    }

    // 2. SLOUČENÍ DAT (Abychom nesmazali zamčené skupiny, když uživatel ukládá ty odemčené)
    const existingUserTip = tableTips[season][liga][username] || {};
    let mergedOrder = teamOrder;

    // Pokud je teamOrder objekt (multigroup) a ne pole, sloučíme stará data s novými
    if (typeof teamOrder === 'object' && !Array.isArray(teamOrder)) {
        mergedOrder = { ...existingUserTip, ...teamOrder };
    }

    tableTips[season][liga][username] = mergedOrder;

    // 3. Uložení do MongoDB
    try {
        const existingData = await TableTips.findAll();
        const updateObj = {};
        updateObj[`${season}.${liga}.${username}`] = mergedOrder;

        if (Object.keys(existingData).length === 0) {
            const newDoc = {};
            newDoc[season] = {};
            newDoc[season][liga] = {};
            newDoc[season][liga][username] = mergedOrder;
            await TableTips.updateOne({}, newDoc, { upsert: true });
        } else {
            const { getDatabase } = require('../config/database');
            const db = await getDatabase();
            const collection = db.collection('tableTips');
            await collection.updateOne(
                {},
                { $set: updateObj }
            );
        }
    } catch (err) {
        console.error("Chyba při ukládání tableTips do MongoDB:", err);
        return res.status(500).send("Chyba při ukládání tipu tabulky.");
    }

    res.sendStatus(200);
});

router.post("/tip", requireLogin, async (req, res) => {
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
        matches = await Matches.findAll();
    } catch (err) {
        console.error("Chyba při čtení matches.json:", err);
        return res.status(500).send("Nastala chyba při čtení dat zápasů.");
    }

    const match = matches.find(m => m.id === matchId);
    if (!match) return res.status(400).send("Neplatný zápas.");

    // Bezpečnostní kontrola času: Převedeme aktuální čas na český ISO formát pro přesné porovnání
    // Bezpečnostní kontrola času: Převedeme aktuální čas na český ISO formát pro přesné porovnání
    const currentPragueTimeISO = new Date().toLocaleString('sv-SE', {timeZone: 'Europe/Prague'}).replace(' ', 'T');

    // 1. Ochrana proti manuálnímu zamčení
    if (match.locked) {
        return res.status(403).send("Tento zápas je manuálně uzamčen, nelze na něj tipovat.");
    }

    // 2. Porovnáváme dva textové řetězce (např. "2024-03-10T18:00" <= "2024-03-10T18:05")
    if (match.datetime <= currentPragueTimeISO) {
        return res.status(403).send("Tipování na tento zápas již není možné, zápas už začal.");
    }

    const league = match.liga;
    const season = match.season;

    if (!season || !league) {
        return res.status(400).send("Zápas nemá vyplněnou sezónu nebo ligu.");
    }

    let users;
    try {
        users = await Users.findAll();
    } catch (err) {
        console.error("Chyba při čtení users z MongoDB:", err);
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
        const newTip = {matchId};
        if (typeof winner !== 'undefined') newTip.winner = winner;

        if (match.bo === 1) {
            newTip.scoreHome = scoreHome ?? null;
            newTip.scoreAway = scoreAway ?? null;
        } else {
            newTip.loserWins = isNaN(loserWins) ? 0 : loserWins;
        }

        user.tips[season][league].push(newTip);
    }

    // Uložení do MongoDB
    try {
        await Users.updateOne(
            { username: username },
            user
        );
    } catch (err) {
        console.error("Chyba při ukládání do MongoDB:", err);
        return res.status(500).send("Chyba při ukládání tipu.");
    }

    req.session.save(err => {
        if (err) {
            console.error("Chyba při ukládání session:", err);
            return res.status(500).send("Chyba session.");
        }

        if (req.headers['x-requested-with'] === 'fetch') {
            return res.status(200).send("Tip uložen");
        }
        res.redirect(`/?liga=${encodeURIComponent(league)}&season=${encodeURIComponent(season)}`);
    });
});

router.get('/', requireLogin, async (req, res) => {
    // Kontrola jest je liga veřejná
    const chosenSeason = await ChosenSeason.findAll();
    const allowedLeagues = await getAllowedLeagues(chosenSeason);
    const requestedLiga = req.query.liga;
    if (requestedLiga && !allowedLeagues.includes(requestedLiga)) {
        // Přesměruj na první veřejnou ligu
        const firstPublic = allowedLeagues[0] || 'Neurčeno';
        return res.redirect(`/?liga=${encodeURIComponent(firstPublic)}`);
    }
    
    // 1. ZAVOLÁME MOZEK, KTERÝ VŠE VYPOČÍTÁ BĚHEM MILISEKUNDY
    const data = await prepareDashboardData(req);

    // 2. VYBALÍME SI PROMĚNNÉ, KTERÉ POTŘEBUJE HTML (Destructuring)
    const {
        username, selectedSeason, selectedLiga, uniqueLeagues, teams, currentUserMatchTips
    } = data;
    // DEBUG PRO MAXA LIGU

// --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Tipovačka</title>
<link rel="stylesheet" href="/css/styles.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
<script>
function showTable(which) { 
    document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none'; 
    const p = document.getElementById('playoffTablePreview'); p.style.display = which === 'playoff' ? 'block' : 'none'; 
}

// Převod klíče
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

async function toggleNotifications() {
    const btn = document.getElementById('notify-toggle-btn');
    if (!btn) return;
    
    btn.disabled = true;
    btn.textContent = "Pracuji...";

    try {
        let registration = await navigator.serviceWorker.getRegistration();
        
        if (!registration) {
            registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        }

        let retry = 0;
        while (!registration.active && retry < 10) {
            await new Promise(res => setTimeout(res, 500));
            registration = await navigator.serviceWorker.getRegistration();
            retry++;
        }

        if (!registration.active) {
            alert("Service Worker se nepodařilo aktivovat.");
            btn.disabled = false;
            await checkSubscriptionStatus();
            return;
        }

        const subscription = await registration.pushManager.getSubscription();

        if (subscription) {
            // ODHLÁŠENÍ
            const res = await fetch('/api/unsubscribe', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': '${req.session.csrfToken || ''}'
                },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            if (res.ok) {
                await subscription.unsubscribe();
                alert('Notifikace vypnuty.');
                await checkSubscriptionStatus();
            }
        } else {
            // PŘIHLÁŠENÍ
            const vapidRes = await fetch('/api/vapid-public-key');
            if (!vapidRes.ok) {
                alert('Server neodpovídá (chyba při získávání klíče).');
                btn.disabled = false;
                await checkSubscriptionStatus();
                return;
            }
            const vapidPublicKey = await vapidRes.text();

            const newSub = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
            });

            const saveRes = await fetch('/api/subscribe', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': '${req.session.csrfToken || ''}'
                },
                body: JSON.stringify(newSub)
            });
            
            if (saveRes.ok) {
                alert('Notifikace zapnuty!');
                await checkSubscriptionStatus();
            } else {
                alert('Nepodařilo se uložit odběr na server.');
            }
        }
    } catch (e) {
        console.error("Kritická chyba notifikací:", e);
        alert('Došlo k nečekané chybě: ' + e.message);
    }
    
    await checkSubscriptionStatus();
    btn.disabled = false;
}

async function checkSubscriptionStatus() {
    const btn = document.getElementById('notify-toggle-btn');
    if (!btn) return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        btn.textContent = "Nepodporováno";
        btn.disabled = true;
        return;
    }

    try {
        // Kontrola stavu bez zbytečného čekání
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = registration ? await registration.pushManager.getSubscription() : null;

        if (subscription) {
            btn.textContent = "Vypnout notifikace 🔕";
            btn.style.backgroundColor = "#555";
        } else {
            btn.textContent = "Zapnout notifikace 🔔";
            btn.style.backgroundColor = "#ff4500";
        }
    } catch (e) {
        btn.textContent = "Klikni pro stav";
    }
}

document.addEventListener('DOMContentLoaded', checkSubscriptionStatus);
</script>
<body class="usersite">
<header class="header">
<div class="header-main">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
<div class="header-user">
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</div>
</div>
<div class="header-controls">
<form class="league-dropdown" method="GET">
<label class="league-select-name">
Liga:
<select id="league-select" name="liga" required onchange="this.form.submit()">
${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
</select>
</label>
<a class="history-btn" href="/history">Historie</a>
<a class="history-btn changed" href="/table-tip?liga=${encodeURIComponent(selectedLiga)}">Základní část</a>
<a class="history-btn changed" href="/prestupy?liga=${encodeURIComponent(selectedLiga)}">Přestupy</a>
<a class="history-btn changed" href="/image-exporter?liga=${encodeURIComponent(selectedLiga)}">Exportér</a>
<a class="history-btn changed" href="/statistics">Statistiky</a>
<div style="text-align: center; margin: 0;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()"
        style="width: 220px; height: 38px; cursor: pointer; font-weight: bold; border: none; color: white; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
<input type="hidden" id="globalCsrfToken" value="${req.session.csrfToken || ''}">
</form>
</div>
</header>
<header class="time-header">${await generateTimeWidget()}<a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75em; color: #666; text-decoration: none; cursor: pointer; opacity: 0.7; transition: opacity 0.3s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">v<span id="current-version">...</span></a></header>
<main class="main_page">`;

    html += await generateLeftPanel(data);
    // ZAČÁTEK PRAVÉHO PANELU SE ZÁPASY
    html += `
    <section class="matches-container">
    <h2>Aktuální zápasy k tipování</h2>
    `;

    const matchesData = (await Matches.findAll())
            .filter(m => m.liga === selectedLiga && !m.result)
            .filter(m => m.season === selectedSeason)
            .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
        const groupedMatches = {};
        const postponedMatches = matchesData.filter(m => m.postponed);
        const normalMatches = matchesData.filter(m => !m.postponed).sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

        const LABEL_POSTPONED = "Odložené zápasy";

        if (postponedMatches.length) {
            groupedMatches[LABEL_POSTPONED] = postponedMatches;
        }

        normalMatches.forEach(match => {
            const dateTime = match.datetime || match.date || "Neznámý čas";
            if (!groupedMatches[dateTime]) groupedMatches[dateTime] = [];
            groupedMatches[dateTime].push(match);
        });

        const currentPragueTimeISO = new Date().toLocaleString('sv-SE', {timeZone: 'Europe/Prague'}).replace(' ', 'T');

        for (const [dateTime, matchesAtSameTime] of Object.entries(groupedMatches)) {
            let formattedDateTime = (matchesAtSameTime.some(m => m.postponed) || dateTime === "Neznámý čas") ? "Odložené zápasy" : (() => {
                const [dPart, tPart] = dateTime.split('T');
                const [year, month, day] = dPart.split('-');
                return `${day}. ${month}. ${year} ${tPart}`;
            })();

            html += `<h3>${formattedDateTime}</h3>
<table class="matches-table">
    <colgroup>
        <col style="width: calc(50% - 10px);">
        <col style="width: 20px;">
        <col style="width: calc(50% - 10px);">
    </colgroup>
    <thead class="matches-table-header">
        <tr><th colspan="3">Zápasy</th></tr>
    </thead>
    <tbody>`;

            for (const match of matchesAtSameTime) {
                // Najdeme objekty týmů, abychom měli přístup k logům
                const homeTeamObj = teams.find(t => t.id === match.homeTeamId);
                const awayTeamObj = teams.find(t => t.id === match.awayTeamId);

                const homeTeamName = homeTeamObj?.name || '???';
                const awayTeamName = awayTeamObj?.name || '???';

                // Definice log (Watermark)
                const homeLogoUrl = homeTeamObj?.logo ? `/logoteamu/${homeTeamObj.logo}` : '/images/logo.png';
                const awayLogoUrl = awayTeamObj?.logo ? `/logoteamu/${awayTeamObj.logo}` : '/images/logo.png';

                // HTML PRO WATERMARK (vložíme ho do tlačítek)
                const watermarkHTML = (url) => `
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-10deg); 
                                width: 120%; height: 400%; 
                                background-image: url('${url}'); background-size: contain; background-repeat: no-repeat; background-position: center; 
                                opacity: 0.50; filter: grayscale(50%); pointer-events: none; z-index: 5;">
                    </div>`;

                const existingTip = currentUserMatchTips.find(t => t.matchId === match.id);
                const selectedWinner = existingTip?.winner;

                // Zjištění, zda je zápas zamčen (buď manuálně, odložením, nebo časem)
                const isLockedManually = match.locked === true;
                const matchStarted = isLockedManually ? true : (match.postponed ? true : (match.datetime <= currentPragueTimeISO));
                const vsText = isLockedManually ? '🔒' : 'vs'; // Pokud je zamčeno, ukáže se zámek
                const isPlayoff = match.isPlayoff;

                if (match.postponed) {
                    html += `<tr class="match-row postponed"><td colspan="3"><strong>${homeTeamName} vs ${awayTeamName}</strong></td></tr>`;
                } else if (!isPlayoff) {
                    // --- ZÁKLADNÍ ČÁST (Simple Match) ---
                    html += `
                    <tr class="match-row simple-match-row" data-match-id="${match.id}">
    <td style="position: relative; overflow: hidden; width: 47%;">${watermarkHTML(homeLogoUrl)}
        <button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" data-winner="home" ${matchStarted ? 'disabled' : ''} 
                style="overflow: hidden;">
            <div style="z-index: 5;">${homeTeamName}</div>
        </button>
    </td>
    <td class="vs" style="width: 20px;">${vsText}</td> 
    <td style="position: relative; overflow: hidden; width: 47%;">${watermarkHTML(awayLogoUrl)}
        <button type="button" class="team-link away-btn ${selectedWinner === "away" ? "selected" : ""}" data-winner="away" ${matchStarted ? 'disabled' : ''}
                style="overflow: hidden;">
            <div style="z-index: 5;">${awayTeamName}</div>
        </button>
    </td>
</tr>`;
                } else {
                    // --- PLAYOFF ZÁPAS ---
                    const existingLoserWins = existingTip?.loserWins || 0;
                    const bo = match.bo || 7;
                    const maxLoserWins = Math.floor(bo / 2);

                    let playedMatchesHtml = '';
                    if (match.isPlayoff && match.bo > 1 && match.playedMatches && match.playedMatches.length > 0) {
                        let currentH = 0; let currentA = 0;

                        // Generování řádků pro jednotlivé zápasy série
                        const detailedRows = match.playedMatches.map((pm, idx) => {
                            if (pm.scoreHome > pm.scoreAway) currentH++; else currentA++;

                            // Pokud je v adminu nastaven sideSwap, vizuálně prohodíme jména v řádku
                            const displayHome = pm.sideSwap ? awayTeamName : homeTeamName;
                            const displayAway = pm.sideSwap ? homeTeamName : awayTeamName;
                            const displayScoreH = pm.sideSwap ? pm.scoreAway : pm.scoreHome;
                            const displayScoreA = pm.sideSwap ? pm.scoreHome : pm.scoreAway;
                            const hWinnerClass = (pm.scoreHome > pm.scoreAway && !pm.sideSwap) || (pm.scoreAway > pm.scoreHome && pm.sideSwap);
                            const aWinnerClass = (pm.scoreAway > pm.scoreHome && !pm.sideSwap) || (pm.scoreHome > pm.scoreAway && pm.sideSwap);

                            return `
                                <div style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 5px 10px; border-bottom: 1px solid #222; font-size: 0.8em; background: #0c0c0c;">
                                    <span style="color: #555; width: 15px; font-weight: bold;">${idx + 1}.</span>
                                    <span style="flex: 1; text-align: right; ${hWinnerClass ? 'color: #00ff00; font-weight: bold;' : 'color: #888;'}">${displayHome}</span>
                                    <span style="background: #222; padding: 2px 6px; font-family: monospace; min-width: 35px; text-align: center; border: 1px solid #333;">
                                        ${displayScoreH}:${displayScoreA}${pm.ot ? '<small style="font-size:0.7em">p</small>' : ''}
                                    </span>
                                    <span style="flex: 1; text-align: left; ${aWinnerClass ? 'color: #00ff00; font-weight: bold;' : 'color: #888;'}">${displayAway}</span>
                                    <span style="color: #555; width: 15px; font-weight: bold;">${idx + 1}.</span>
                                </div>
                            `;
                        }).join('');

                        playedMatchesHtml = `
                            <tr style="background: #111; border-top: none;">
                                <td colspan="3" style="padding: 0; border-top: none;">
                                    <div style="background: #ff4500; color: white; font-size: 0.7em; font-weight: bold; text-align: center; padding: 2px 0; text-transform: uppercase;">
                                        Stav série: ${currentH}:${currentA}
                                    </div>
                                    <div style="max-height: 200px; overflow-y: auto; border: 1px solid #ff4500; border-top: none;">
                                        ${detailedRows}
                                    </div>
                                </td>
                            </tr>
                        `;
                    }

                    html += `
        <tr class="match-row playoff-parent-row" data-match-id="${match.id}">
    <td style="position: relative; overflow: hidden; width: 47%;">${watermarkHTML(homeLogoUrl)}
        <button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" data-winner="home" ${matchStarted ? 'disabled' : ''} style="overflow: hidden;">
            <span style="z-index: 5;">${homeTeamName}</span>
        </button>
    </td>
    <td class="vs" style="width: 20px;">${vsText}</td>
    <td style="position: relative; overflow: hidden; width: 47%;">${watermarkHTML(awayLogoUrl)}
        <button type="button" class="team-link away-btn ${selectedWinner === "away" ? "selected" : ""}" data-winner="away" ${matchStarted ? 'disabled' : ''} style="overflow: hidden;">
            <span style="z-index: 5;">${awayTeamName}</span>
        </button>
    </td>
</tr>
        ${playedMatchesHtml}
        <tr class="match-row loser-row" style="display:${existingTip ? 'table-row' : 'none'}">
            <td style="border-top: none" colspan="3">
                <form class="loserwins-form" onsubmit="return false;" data-bo="${match.bo}">
                    <input type="hidden" name="_csrf" value="${req.session.csrfToken || ''}">
                    <input type="hidden" name="matchId" value="${match.id}">
                    <input type="hidden" name="winner" value="${existingTip?.winner ?? ''}">
                    ${match.bo === 1 ?
                        `Skóre: <input type="number" name="scoreHome" value="${existingTip?.scoreHome ?? ''}" min="0" style="width:50px" ${matchStarted ? 'disabled' : ''}> : <input type="number" name="scoreAway" value="${existingTip?.scoreAway ?? ''}" min="0" style="width:50px" ${matchStarted ? 'disabled' : ''}>` :
                        `Kolik zápasů vyhrál poražený: <select name="loserWins" ${matchStarted ? 'disabled' : ''}>${Array.from({length: maxLoserWins + 1}, (_, i) => `<option value="${i}" ${i === existingLoserWins ? 'selected' : ''}>${i}</option>`).join('')}</select>`
                    }
                </form>
            </td>
        </tr>`;
                }
            }
            html += `</tbody></table>`;
        }

        html += `</section></main></body><script>
document.addEventListener('DOMContentLoaded', () => {
function sendTip(formData, homeBtn, awayBtn, loserRow) {
const winner = formData.get('winner');
const csrfToken = document.getElementById('globalCsrfToken')?.value || document.querySelector('input[name="_csrf"]')?.value || '';
formData.append('_csrf', csrfToken);
fetch('/tip', { 
    method: 'POST', 
    headers: { 
        'x-requested-with': 'fetch', 
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken
    }, 
    body: formData 
})
.then(res => { if (res.ok) { 
    if(homeBtn) { homeBtn.classList.toggle('selected', winner === 'home'); if(winner === 'home' && awayBtn) awayBtn.classList.remove('selected'); }
    if(awayBtn) { awayBtn.classList.toggle('selected', winner === 'away'); if(winner === 'away' && homeBtn) homeBtn.classList.remove('selected'); }
    if(loserRow) loserRow.style.display = 'table-row';
} else { alert('Chyba při ukládání.'); } })
.catch(err => { console.error(err); alert('Chyba připojení.'); });
}
document.querySelectorAll('button[data-winner]').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    const row = btn.closest('tr');
                    const matchId = row.dataset.matchId;
                    const winner = btn.dataset.winner;
                    const homeBtn = row.querySelector('.home-btn');
                    const awayBtn = row.querySelector('.away-btn');
                    
                    // Preskočíme informačný riadok o stave série (ak existuje)
                    let nextRow = row.nextElementSibling;
                    if (nextRow && nextRow.classList.contains('played-matches-row')) {
                        nextRow = nextRow.nextElementSibling;
                    }
                    
                    let targetRow = null;
                    let targetForm = null;

                    // Chytíme riadok s tipom nezávisle na tom, či je to "loser-row" (playoff) alebo "score-row" (základná časť)
                    if (nextRow && (nextRow.classList.contains('loser-row') || nextRow.classList.contains('score-row'))) {
                        targetRow = nextRow;
                        targetForm = targetRow.querySelector('form');
                    }

                    if (targetForm) {
                        const wInput = targetForm.querySelector('input[name="winner"]');
                        if (wInput) wInput.value = winner;
                    }

                    const formData = new URLSearchParams();
                    formData.append('matchId', matchId);
                    formData.append('winner', winner);

                    // Odošleme dáta (targetRow pošleme do funkcie, aby vedela, čo má zobraziť/skryť)
                    sendTip(formData, homeBtn, awayBtn, targetRow);
                });
            });
document.querySelectorAll('.loserwins-form').forEach(form => {
const matchId = form.querySelector('input[name="matchId"]').value; const winnerInput = form.querySelector('input[name="winner"]');
form.querySelectorAll('input[type="number"]').forEach(input => {
input.addEventListener('change', () => { if (!winnerInput.value) { alert('Vyber nejdřív vítěze!'); return; }
const scoreHome = form.querySelector('input[name="scoreHome"]').value; const scoreAway = form.querySelector('input[name="scoreAway"]').value;
if (scoreHome === '' || scoreAway === '') return;
const formData = new URLSearchParams(); formData.append('matchId', matchId); formData.append('winner', winnerInput.value);
formData.append('scoreHome', scoreHome); formData.append('scoreAway', scoreAway);
sendTip(formData, null, null, null); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
});
const select = form.querySelector('select');
if (select) { select.addEventListener('change', () => { if (!winnerInput.value) { alert('Vyber nejdřív vítěze!'); return; }
const formData = new URLSearchParams(); formData.append('matchId', matchId); formData.append('winner', winnerInput.value); formData.append('loserWins', select.value);
sendTip(formData, null, null, null); }); }
});
});
document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.querySelector('.left-panel');
    const container = document.querySelector('.stats-container');

    if (!sidebar || !container) return;

    let lastScrollY = window.scrollY;
    let topOffset = 20; // Výchozí odsazení odshora
    const margin = 20; // Mezera nahoře i dole

    window.addEventListener('scroll', () => {
        // Pokud je obrazovka dostatečně velká, že se tam panel vejde celý, normálně ho přilepíme k vršku
        if (sidebar.offsetHeight <= window.innerHeight) {
            sidebar.style.top = margin + 'px';
            return;
        }

        const currentScrollY = window.scrollY;
        const scrollDelta = currentScrollY - lastScrollY;
        const viewportHeight = window.innerHeight;
        const sidebarHeight = sidebar.offsetHeight;

        // Minimální hodnota 'top', aby se ukázal spodek panelu (bude to záporné číslo)
        const minTop = viewportHeight - sidebarHeight - margin;

        if (scrollDelta > 0) {
            // SCROLUJEME DOLŮ
            topOffset -= scrollDelta;
            if (topOffset < minTop) {
                topOffset = minTop; // Zastavíme, když dorazíme na konec panelu (přilepí se ke spodku)
            }
        } else if (scrollDelta < 0) {
            // SCROLUJEME NAHORU
            topOffset -= scrollDelta; // (odčítáme záporné číslo = přičítáme)
            if (topOffset > margin) {
                topOffset = margin; // Zastavíme, když dorazíme na začátek panelu (přilepí se k vršku)
            }
        }

        sidebar.style.top = topOffset + 'px';
        lastScrollY = currentScrollY;
    });

    // Načíst verzi a zobrazit v badge
    fetch('/api/version')
        .then(res => res.json())
        .then(data => {
            const versionBadge = document.getElementById('current-version');
            if (versionBadge) {
                versionBadge.textContent = data.version;
            }
        })
        .catch(err => console.log('Nepodařilo se načíst verzi', err));
});
</script></html>`;
        res.send(html);
});

router.get('/history', requireLogin, async (req, res) => {
    // Načtení definic lig (aby byly vidět i ty bez zápasů)
    let allSeasonData = {};
    try { allSeasonData = await Leagues.findAll(); } catch (err) { console.error(err); }

    // Načtení zápasů (pro zpětnou kompatibilitu)
    let matches = [];
    try { matches = await Matches.findAll(); } catch (err) { console.error(err); }

    // Načtení přestupů pro kontrolu dostupnosti
    const { Transfers } = require('../utils/mongoDataAccess');
    let transfersData = {};
    try { transfersData = await Transfers.findAll(); } catch (err) { console.error(err); }

    const historyMap = new Map();

    // 1. Primární zdroj: Definice v leagues.json
    Object.keys(allSeasonData).forEach(season => {
        if (allSeasonData[season].leagues) {
            allSeasonData[season].leagues.forEach(l => {
                const key = `${season}_${l.name}`;
                const hasTransfers = transfersData?.[season]?.[l.name] && Object.keys(transfersData[season][l.name]).length > 0;
                const matchCount = matches.filter(m => m.season === season && m.liga === l.name).length;
                historyMap.set(key, { season, liga: l.name, hasTransfers, matchCount });
            });
        }
    });

    // 2. Záložní zdroj: Zápasy (pokud by něco chybělo v definici)
    matches.forEach(m => {
        if (m.liga && m.season) {
            const key = `${m.season}_${m.liga}`;
            if (!historyMap.has(key)) {
                const hasTransfers = transfersData?.[m.season]?.[m.liga] && Object.keys(transfersData[m.season][m.liga]).length > 0;
                const matchCount = matches.filter(match => match.season === m.season && match.liga === m.liga).length;
                historyMap.set(key, { season: m.season, liga: m.liga, hasTransfers, matchCount });
            }
        }
    });

    const history = Array.from(historyMap.values());

    // Seskupení podle sezón
    const groupedBySeason = history.reduce((acc, entry) => {
        if (!acc[entry.season]) acc[entry.season] = [];
        acc[entry.season].push(entry);
        return acc;
    }, {});

    // Seřazení sezón sestupně
    const sortedSeasons = Object.keys(groupedBySeason).sort((a, b) => b.localeCompare(a));

    let html = `
    <!DOCTYPE html>
    <html lang="cs">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Historie lig a sezón</title>
        <link rel="stylesheet" href="/css/styles.css">
        <script src="/js/version-notification.js"></script>
        <link rel="icon" href="/images/logo.png">
    </head>
    <body class="usersite">
        <header class="header">
            <div class="header-main">
                <div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Historie sezón a lig</h1></div>
                <div class="header-user">
                    <a href="/" class="history-btn">← Zpět na hlavní stránku</a>
                </div>
            </div>
        </header>
        <header class="time-header">${await generateTimeWidget()}<a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75em; color: #666; text-decoration: none; cursor: pointer; opacity: 0.7; transition: opacity 0.3s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">v<span id="current-version">...</span></a></header>
        <main class="main_page">
            <div class="history-container">
    `;

    for (const season of sortedSeasons) {
        const leagues = groupedBySeason[season].sort((a, b) => a.liga.localeCompare(b.liga));
        
        html += `
            <div class="season-section">
                <h2 class="season-title">${season}</h2>
                <div class="league-grid">
        `;

        for (const entry of leagues) {
            html += `
                <div class="league-card">
                    <div class="league-card-header">
                        <span class="league-name">${entry.liga}</span>
                        <span class="league-badge">${entry.season}</span>
                    </div>
                    <div class="league-stats">
                        <span>🏆 ${entry.matchCount} zápasů</span>
                        ${entry.hasTransfers ? '<span>📜 Přestupy dostupné</span>' : ''}
                    </div>
                    <div class="league-actions">
                        <a href="/history/a/?liga=${encodeURIComponent(entry.liga)}&season=${encodeURIComponent(entry.season)}" class="history-action-btn history-action-btn-primary">
                            ⚽ Tipování zápasů
                        </a>
                        <a href="/history/table/?liga=${encodeURIComponent(entry.liga)}&season=${encodeURIComponent(entry.season)}" class="history-action-btn history-action-btn-secondary">
                            📊 Tipování tabulky
                        </a>
                        ${entry.hasTransfers
                            ? `<a href="/history/prestupy?liga=${encodeURIComponent(entry.liga)}&season=${encodeURIComponent(entry.season)}" class="history-action-btn history-action-btn-tertiary">
                                📜 Přestupy
                               </a>`
                            : `<span class="history-action-btn history-action-btn-disabled" title="Přestupy nejsou dostupné">
                                📜 Přestupy
                               </span>`
                        }
                    </div>
                </div>
            `;
        }

        html += `
                </div>
            </div>
        `;
    }

    html += `
            </div>
        </main>
        <script>
            document.addEventListener('DOMContentLoaded', () => {
                fetch('/api/version')
                    .then(res => res.json())
                    .then(data => {
                        const versionBadge = document.getElementById('current-version');
                        if (versionBadge) {
                            versionBadge.textContent = data.version;
                        }
                    })
                    .catch(err => console.log('Nepodařilo se načíst verzi', err));
            });
        </script>
    </body>
    </html>
    `;

    res.send(html);
});

// NOVÁ ROUTA: Historie přestupů - zobrazí přestupy pro danou ligu a sezónu (stejný layout jako aktuální)
router.get('/history/prestupy', requireLogin, async (req, res) => {
    const { Transfers, Teams, Matches } = require('../utils/mongoDataAccess');
    const transfersData = await Transfers.findAll();
    const allTeams = await Teams.findAll();
    await Matches.findAll();
// Získání parametrů z URL
    const selectedLiga = req.query.liga;
    const selectedSeason = req.query.season;
    
    // Pokud chybí parametry, přesměruj na výběr historie
    if (!selectedLiga || !selectedSeason) {
        return res.redirect('/history');
    }
    
    // Filtrování týmů podle sezóny a ligy (podobně jako v aktuálních přestupech)
    const teamsInSelectedLiga = allTeams.filter(t => 
        t.liga === selectedLiga && t.season === selectedSeason && t.active
    );
    
    // Načtení přestupů pro danou ligu a sezónu
    const currentTransfers = transfersData?.[selectedSeason]?.[selectedLiga] || {};
    
    // Generování HTML s přestupy pro danou sezónu/ligu
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Přestupy - ${selectedLiga} ${selectedSeason}</title>
<link rel="stylesheet" href="/css/styles.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
<body class="usersite">
<header class="header">
<div class="header-main">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Přestupy - ${selectedLiga} ${selectedSeason}</h1></div>
<div class="header-user">
<p id="logged_user">${req.session?.user ? `Přihlášený jako: <strong>${req.session.user}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</div>
</div>
<div class="header-controls">
<div class="league-dropdown">
<a class="history-btn" href="/">Aktuální</a>
<a class="history-btn" href="/history">Zpět na výběr</a>
<a class="history-btn" href="/history/a/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy zápasů</a>
<a class="history-btn" href="/history/table/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy tabulky</a>
</div>
</div>
</header>
<header class="time-header">${await generateTimeWidget()}<a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75em; color: #666; text-decoration: none; cursor: pointer; opacity: 0.7; transition: opacity 0.3s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">v<span id="current-version">...</span></a></header>
<main class="main_page">

<div style="display: grid; gap: 15px; margin-top: 15px; width: 100%;">
<h2 style="margin-top: 0; text-align: center; border-bottom: 2px solid orangered; padding-bottom: 10px;">Přestupy a Spekulace - ${selectedLiga} (${selectedSeason})</h2>
`;

    // FUNKCE PRO OBARVOVÁNÍ (stejné jako v aktuálních přestupech)
    const formatPlayerName = (rawName) => {
        let style = 'color: white;';
        let icon = '';
        let name = rawName;

        if (name.includes('(X)')) {
            style = 'color: #ff6666; text-decoration: line-through; opacity: 0.7;';
            icon = '❌ ';
            name = name.replace('(X)', '');
        }
        else if (name.includes('(-)')) {
            style = 'color: #888; text-decoration: line-through; opacity: 0.5; font-style: italic;';
            icon = '🚫 ';
            name = name.replace('(-)', '');
        }
        else if (name.includes('(!)')) {
            style = 'color: #ffd700; font-weight: bold; text-shadow: 0 0 8px rgba(255, 215, 0, 0.4);';
            icon = '🔥 ';
            name = name.replace('(!)', '');
        }
        else if (name.includes('(?)')) {
            style = 'color: #00d4ff; font-style: italic;';
            icon = '❓ ';
            name = name.replace('(?)', '');
        }
        else if (name.includes('(K)')) {
            style = 'color: #ffaa00; font-weight: bold;';
            icon = '📄 ';
            name = name.replace('(K)', '');
        }

        const colorMatch = name.match(/#([0-9a-fA-F]{3,6})/);
        if (colorMatch) {
            style = `color: ${colorMatch[0]}; font-weight: bold;`;
            name = name.replace(colorMatch[0], '');
        }

        return `<span style="${style}">${icon}${name.trim()}</span>`;
    };

    const renderList = (arr) => {
        if (!arr || arr.length === 0) return '<div style="color: gray; font-size: 0.8em; font-style: italic;">-</div>';

        return arr.map(player => `
        <div style="font-size: 0.95em; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
            ${formatPlayerName(player)}
        </div>
    `).join('');
    };

    // VYKRESLENÍ KARET TÝMŮ
    if (teamsInSelectedLiga.length === 0) {
        html += `<div style="text-align: center; padding: 40px; color: #888;">Žádné týmy v lize ${selectedLiga} pro sezónu ${selectedSeason}</div>`;
    } else {
        teamsInSelectedLiga.sort((a, b) => a.id - b.id).forEach(team => {
            const tId = String(team.id);
            const tData = currentTransfers[tId] || { specIn: [], specOut: [], confIn: [], confOut: [] };
            const logoUrl = team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

            html += `
    <div style="position: relative; background-color: #000; border: 2px solid #ff4500; overflow: hidden; display: flex; flex-direction: column; min-height: 250px; box-shadow: 0 4px 15px rgba(0,0,0,0.8);">
        
        <div style="position: relative; z-index: 1; background: linear-gradient(to bottom, #222, #111); border-bottom: 3px solid #ff4500; display: flex; align-items: center; padding: 10px;">
            <img src="${logoUrl}" alt="${team.name}" style="height: 45px; width: 45px; object-fit: contain; margin-right: 12px; filter: drop-shadow(0 0 5px rgba(255,255,255,0.2));">
            <strong style="color: white; font-size: 1.3em; text-transform: uppercase; letter-spacing: 1px;">${team.name}</strong>
        </div>

        <div style="position: relative; z-index: 1; display: flex; flex-direction: row; flex: 1;">
            
            <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-10deg); width: 80%; height: 80%; background-image: url('${logoUrl}'); background-size: contain; background-repeat: no-repeat; background-position: center; opacity: 0.30; filter: grayscale(50%); z-index: -50; pointer-events: none;"></div>
            
            <div style="flex: 1; padding: 8px; border-right: 1px solid #333; background-color: rgba(0, 50, 80, 0.3);">
                <div style="color: #00d4ff; font-size: 0.7em; font-weight: 900; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Spekulace IN</div>
                ${renderList(tData.specIn)}
            </div>

            <div style="flex: 1; padding: 8px; border-right: 1px solid #333; background-color: rgba(0, 50, 80, 0.3);">
                <div style="color: #00d4ff; font-size: 0.7em; font-weight: 900; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Spekulace OUT</div>
                ${renderList(tData.specOut)}
            </div>

            <div style="flex: 1; padding: 8px; border-right: 1px solid #333; background-color: rgba(0, 100, 0, 0.2);">
                <div style="color: #00ff00; font-size: 0.7em; font-weight: 900; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Příchody</div>
                ${renderList(tData.confIn)}
            </div>

            <div style="flex: 1; padding: 8px; background-color: rgba(100, 0, 0, 0.2);">
                <div style="color: #ff4444; font-size: 0.7em; font-weight: 900; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Odchody</div>
                ${renderList(tData.confOut)}
            </div>
        </div>
    </div>
    `;
        });
    }

    html += `
</div>
</main>
<script>
    document.addEventListener('DOMContentLoaded', () => {
        fetch('/api/version')
            .then(res => res.json())
            .then(data => {
                const versionBadge = document.getElementById('current-version');
                if (versionBadge) {
                    versionBadge.textContent = data.version;
                }
            })
            .catch(err => console.log('Nepodařilo se načíst verzi', err));
    });
</script>
</body>
</html>
`;

    res.send(html);
});

router.get('/history/a', requireLogin, async (req, res) => {
    // 0. Bezpečnostní kontrola adresy
    if (!req.query.liga || !req.query.season) return res.redirect('/history');

    // 1. ZAVOLÁME MOZEK (s parametrem true pro režim historie)
    const data = await prepareDashboardData(req, true);

    // 2. VYBALÍME SI PROMĚNNÉ
    const {
        username, selectedSeason, selectedLiga, teams,
        matches, allUsers, userStats,
    } = data;

    // 3. NAČTENÍ PŘESTUPŮ PRO KONTROLU ZDA EXISTUJÍ
    const { Transfers } = require('../utils/mongoDataAccess');
    const transfersData = await Transfers.findAll();
    const seasonTransfers = transfersData?.[selectedSeason]?.[selectedLiga] || {};
    const hasTransfers = Object.keys(seasonTransfers).length > 0;

    // 4. DATA SPECIFICKÁ PRO HISTORII (Výběr uživatele z rolovacího menu vpravo)
    const usersWithTips = allUsers.filter(u => u.tips?.[selectedSeason]?.[selectedLiga]?.length > 0).sort((a, b) => a.username.localeCompare(b.username));
    const initialUser = usersWithTips.find(u => u.username === username) ? username : (usersWithTips[0]?.username || "");

    // --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Tipovačka</title>
<link rel="stylesheet" href="/css/styles.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
<script>
function showTable(which) {
document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none';
const p = document.getElementById('playoffTablePreview');
p.style.display = which === 'playoff' ? 'block' : 'none';
}
</script>
<body class="usersite">
<header class="header">
<div class="header-main">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
<div class="header-user">
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</div>
</div>
<div class="header-controls">
<div class="league-dropdown">
<a class="history-btn" href="/">Aktuální</a>
<a class="history-btn" href="/history">Zpět na výběr</a>
<a class="history-btn" style="background:orangered; color:black;" href="/history/a/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy zápasů</a>
<a class="history-btn" href="/history/table/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy tabulky</a>
${hasTransfers
    ? `<a class="history-btn" style="background:#00d4ff; color:black;" href="/history/prestupy?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">📜 Přestupy</a>`
    : `<span class="history-btn" style="background:#333; color:#666; cursor:not-allowed;" title="Pro tuto sezónu/ligu nejsou dostupné přestupy">📜 Přestupy</span>`
}
</div>
</div>
</header>
<header class="time-header">${await generateTimeWidget()}<a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75em; color: #666; text-decoration: none; cursor: pointer; opacity: 0.7; transition: opacity 0.3s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">v<span id="current-version">...</span></a></header>
<main class="main_page">`
html += await generateLeftPanel(data, true);
    html += `<script>
        const globalStatsData = ${JSON.stringify(userStats)};

        // Načíst verzi a zobrazit v badge
        fetch('/api/version')
            .then(res => res.json())
            .then(data => {
                const versionBadge = document.getElementById('current-version');
                if (versionBadge) {
                    versionBadge.textContent = data.version;
                }
            })
            .catch(err => console.log('Nepodařilo se načíst verzi', err));

        // Funkce pro zobrazení historie a dynamické barvení políček
        function showUserHistory(username) {
        // 1. Schovat všechny tipy
        document.querySelectorAll('.history-item').forEach(el => el.style.display = 'none');

        const safeName = username.replace(/[^a-zA-Z0-9]/g, '_');
        const userSelector = '.user-' + safeName;

        // 2. Zobrazit tipy vybraného uživatele a aktualizovat rodičovské TD
        document.querySelectorAll(userSelector).forEach(el => {
        el.style.display = 'flex'; // Zobrazíme text (např. 3:2)

        // Najdeme rodičovskou buňku tabulky
        const parentTd = el.closest('td');
        if (parentTd) {
        // Resetujeme třídy (odstraníme staré barvy, necháme jen základ)
        parentTd.classList.remove('right-selected', 'wrong-selected', 'wrong-selected-hidden', 'exact-score', 'diff-1', 'diff-2', 'diff-3plus');

        // Pokud má element data-td-class, přidáme ji rodiči
        if (el.dataset.tdClass) {
        parentTd.classList.add(el.dataset.tdClass);
        }
        }
        });
        }
        // Přidej do <script> v proměnné html v user.js
function toggleSeriesDetails(btn) {
    const details = btn.nextElementSibling;
    if (details.style.display === "none") {
        details.style.display = "block";
        btn.innerText = btn.innerText.replace("▼", "▲").replace("Zobrazit", "Skrýt");
        btn.style.background = "#ff4500";
        btn.style.color = "black";
    } else {
        details.style.display = "none";
        btn.innerText = btn.innerText.replace("▲", "▼").replace("Skrýt", "Zobrazit");
        btn.style.background = "#222";
        btn.style.color = "#ff4500";
    }
}
        </script>
        <section class="matches-container">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                <h2 style="margin: 0;">Historie tipů</h2>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label for="historyUserSelect" style="color: lightgrey;">Zobrazit:</label>
                    <select id="historyUserSelect" onchange="showUserHistory(this.value)" style="background-color: black; color: orangered; border: 1px solid orangered; padding: 5px;">`;

    if (usersWithTips.length === 0) {
        html += `<option disabled selected>Žádná data</option>`;
    } else {
        usersWithTips.forEach(u => {
            const isSelected = u.username === initialUser ? 'selected' : '';
            html += `<option value="${u.username}" ${isSelected}>${u.username}</option>`;
        });
    }

    html += `   </select></div></div>
   <table class="points-table">`;

    // Seskupení zápasů
    const groupedMatches = matches
        .filter(m => m.liga === selectedLiga && m.result && m.season === selectedSeason)
        .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))
        .reduce((groups, match) => {
            const dateTime = match.datetime || match.date || "Neznámý čas";
            if (!groups[dateTime]) groups[dateTime] = [];
            groups[dateTime].push(match);
            return groups;
        }, {});

    // Funkce pro watermark (OPRAVENO: position: absolute)
    // 1. OPRAVA: Sjednocení opacity vodoznaku na 0.15, aby vypadal stejně jako na hlavní straně
    const watermarkHTML = (url) => `
        <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-10deg); 
                    width: 120%; height: 400%; 
                    background-image: url('${url}'); background-size: contain; background-repeat: no-repeat; background-position: center; 
                    opacity: 0.50; filter: grayscale(50%); pointer-events: none; z-index: 1;">
        </div>`;

    // 2. OPRAVA: Přidáno Number() pro správné nalezení tipu
    const renderUserTip = (u, match, type) => {
        // TADY BYLA CHYBA: Porovnával se text s číslem!
        const userTip = u.tips?.[selectedSeason]?.[selectedLiga]?.find(t => Number(t.matchId) === Number(match.id));
        const selectedWinner = userTip?.winner;
        const bo = match.bo || 5;

        const visibilityStyle = u.username === initialUser ? '' : 'display:none;';
        const userClass = `history-item user-${u.username.replace(/[^a-zA-Z0-9]/g, '_')}`;

        let tdStatusClass = "";

        if (type === 'home' || type === 'away') {
            const teamName = type === 'home' ? (teams.find(t => t.id === match.homeTeamId)?.name || '???') : (teams.find(t => t.id === match.awayTeamId)?.name || '???');

            // Pokud má tipnuto, vyhodnotíme třídu
            if (selectedWinner === type) {
                tdStatusClass = match.result.winner === type ? "right-selected" : "wrong-selected";
            }

            return `<div class="${userClass} team-link-history" style="position: absolute; inset: 0; z-index: 2; background: transparent; color: inherit; ${visibilityStyle}" data-td-class="${tdStatusClass}">${teamName}</div>`;        }

        if (type === 'score') {
            let content = '-';
            if (selectedWinner === "home" || selectedWinner === "away") {
                if (bo === 1) {
                    if (selectedWinner === match.result.winner) {
                        const tH = userTip?.scoreHome ?? 0;
                        const tA = userTip?.scoreAway ?? 0;
                        const totalDiff = Math.abs(tH - match.result.scoreHome) + Math.abs(tA - match.result.scoreAway);
                        if (totalDiff === 0) tdStatusClass = 'exact-score';
                        else if (totalDiff === 1) tdStatusClass = 'diff-1';
                        else if (totalDiff === 2) tdStatusClass = 'diff-2';
                        else tdStatusClass = 'diff-3plus';
                        content = `${tH} : ${tA}`;
                    } else {
                        const tH = userTip?.scoreHome ?? 0;
                        const tA = userTip?.scoreAway ?? 0;
                        content = `${tH} : ${tA}`;
                        tdStatusClass = 'wrong-selected-hidden';
                    }
                } else {
                    content = userTip?.loserWins ?? '-';
                    let realLoserWins = 0;
                    if (match.result.winner === 'home') {
                        realLoserWins = match.result.scoreAway || 0;
                    } else if (match.result.winner === 'away') {
                        realLoserWins = match.result.scoreHome || 0;
                    }

                    if (selectedWinner === match.result.winner) {
                        if (parseInt(userTip?.loserWins) === realLoserWins) {
                            tdStatusClass = 'exact-score';
                        } else {
                            tdStatusClass = 'diff-3plus';
                        }
                    } else {
                        tdStatusClass = 'wrong-selected-hidden';
                    }
                }
            }
            return `<div class="${userClass} team-link-history" style="position: absolute; inset: 0; z-index: 2; background: transparent; color: inherit; ${visibilityStyle}" data-td-class="${tdStatusClass}">${content}</div>`;        }
        return '';
    };

    for (const [dateTime, matchesAtSameTime] of Object.entries(groupedMatches)) {
        const formattedDateTime = new Date(dateTime).toLocaleString('cs-CZ', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        html += `<h3>${formattedDateTime}</h3>
<table class="matches-table">
    <colgroup>
        <col style="width: calc(50% - 50px);"> <col style="width: 30px;">             <col style="width: 40px;">             <col style="width: 30px;">             <col style="width: calc(50% - 50px);"> </colgroup>
    <thead class="matches-table-header">
        <tr><th colspan="5">Zápasy</th></tr>
    </thead>
    <tbody>`;

        for (const match of matchesAtSameTime) {
            const homeTeamObj = teams.find(t => t.id === match.homeTeamId);
            const awayTeamObj = teams.find(t => t.id === match.awayTeamId);

            const homeLogoUrl = homeTeamObj?.logo ? `/logoteamu/${homeTeamObj.logo}` : '/images/logo.png';
            const awayLogoUrl = awayTeamObj?.logo ? `/logoteamu/${awayTeamObj.logo}` : '/images/logo.png';

            let homeCellHTML = "", awayCellHTML = "", scoreCellHTML = "";
            let initHomeClass = "", initAwayClass = "", initScoreClass = "";

            usersWithTips.forEach(u => {
                homeCellHTML += renderUserTip(u, match, 'home');
                awayCellHTML += renderUserTip(u, match, 'away');
                if (match.isPlayoff) scoreCellHTML += renderUserTip(u, match, 'score');

                if (u.username === initialUser) {
                    const homeMatch = renderUserTip(u, match, 'home').match(/data-td-class="([^"]*)"/);
                    if (homeMatch) initHomeClass = homeMatch[1];

                    const awayMatch = renderUserTip(u, match, 'away').match(/data-td-class="([^"]*)"/);
                    if (awayMatch) initAwayClass = awayMatch[1];

                    if(match.isPlayoff) {
                        const scoreMatch = renderUserTip(u, match, 'score').match(/data-td-class="([^"]*)"/);
                        if (scoreMatch) initScoreClass = scoreMatch[1];
                    }
                }
            });

            // OPRAVENO: Odstraněna třída match-row u tagů <td>!
            if (!match.isPlayoff) {
                html += `<tr class="match-row">
    <td class="${initHomeClass}" style="position: relative; overflow: hidden; width: 41%;">${watermarkHTML(homeLogoUrl)}${homeCellHTML}</td>
    <td style="width: 4%;">${match.result.scoreHome}</td>
    <td class="vs" style="width: 20px;">${match.result.ot === true ? "pp/sn" : ":"}</td>
    <td style="width: 4%;">${match.result.scoreAway}</td>
    <td class="${initAwayClass}" style="position: relative; overflow: hidden; width: 41%;">${watermarkHTML(awayLogoUrl)}${awayCellHTML}</td>
</tr>`;
            } else {
                // NOVÁ "DROPDOWN" VERZE PRO HISTORII
                let playedMatchesHtml = '';
                if (match.isPlayoff && match.bo > 1 && match.playedMatches && match.playedMatches.length > 0) {
                    let currentH = 0; let currentA = 0;

                    const detailedRows = match.playedMatches.map((pm, idx) => {
                        if (pm.scoreHome > pm.scoreAway) currentH++; else currentA++;

                        const displayHome = pm.sideSwap ? (teams.find(t => t.id === match.awayTeamId)?.name || '???') : (teams.find(t => t.id === match.homeTeamId)?.name || '???');
                        const displayAway = pm.sideSwap ? (teams.find(t => t.id === match.homeTeamId)?.name || '???') : (teams.find(t => t.id === match.awayTeamId)?.name || '???');
                        const displayScoreH = pm.sideSwap ? pm.scoreAway : pm.scoreHome;
                        const displayScoreA = pm.sideSwap ? pm.scoreHome : pm.scoreAway;

                        const hWinner = (pm.scoreHome > pm.scoreAway && !pm.sideSwap) || (pm.scoreAway > pm.scoreHome && pm.sideSwap);
                        const aWinner = (pm.scoreAway > pm.scoreHome && !pm.sideSwap) || (pm.scoreHome > pm.scoreAway && pm.sideSwap);

                        return `
                        <div style="display: flex; align-items: center; justify-content: center; gap: 8px; padding: 4px 10px; border-bottom: 1px solid #222; font-size: 0.85em; background: #0c0c0c;">
                            <span style="color: #555; width: 15px; font-weight: bold;">${idx + 1}.</span>
                            <span style="flex: 1; text-align: right; ${hWinner ? 'color: #00ff00; font-weight: bold;' : 'color: #888;'}">${displayHome}</span>
                            <span style="background: #222; padding: 1px 6px; font-family: monospace; min-width: 35px; text-align: center; border: 1px solid #333;">
                                ${displayScoreH}:${displayScoreA}${pm.ot ? '<small>p</small>' : ''}
                            </span>
                            <span style="flex: 1; text-align: left; ${aWinner ? 'color: #00ff00; font-weight: bold;' : 'color: #888;'}">${displayAway}</span>
                            <span style="color: #555; width: 15px; font-weight: bold;">${idx + 1}.</span>
                        </div>`;
                    }).join('');

                    playedMatchesHtml = `
                <tr style="background: #111; border-top: none;">
                    <td colspan="5" style="padding: 0; border-top: none;">
                        <div onclick="toggleSeriesDetails(this)" style="cursor: pointer; background: #222; color: #ff4500; font-size: 0.65em; font-weight: bold; text-align: center; padding: 5px 0; text-transform: uppercase; border-bottom: 1px solid #333; transition: 0.3s;">
                            ▼ Zobrazit průběh série (${currentH}:${currentA}) ▼
                        </div>
                        <div class="series-details" style="display: none; max-height: 300px; overflow-y: auto; border-bottom: 2px solid #ff4500; transition: all 0.5s ease;">
                            ${detailedRows}
                        </div>
                    </td>
                </tr>`;
                }

                // Samotné vykreslení (zůstává stejné jako minule)
                html += `<tr style="border-top: none" class="match-row">
    <td class="${initHomeClass}" style="position: relative; overflow: hidden; width: 41%;">${watermarkHTML(homeLogoUrl)}${homeCellHTML}</td>
    <td style="width: 4%;">${match.result.scoreHome}</td>
    <td class="vs" style="width: 20px;">vs</td>
    <td style="width: 4%;">${match.result.scoreAway}</td>
    <td class="${initAwayClass}" style="position: relative; overflow: hidden; width: 41%;">${watermarkHTML(awayLogoUrl)}${awayCellHTML}</td>
</tr>
            ${playedMatchesHtml}
            <tr class="match-row">
                <td style="height: 25px; position: relative;" colspan="5" class="${initScoreClass}">${scoreCellHTML}</td>
            </tr>`;
            }
            }
        html += `</tbody></table>`;
    }

    html += `</section></main>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.querySelector('.left-panel');
    const container = document.querySelector('.stats-container');
    
    if (!sidebar || !container) return;

    let lastScrollY = window.scrollY;
    let topOffset = 20; 
    const margin = 20; 

    window.addEventListener('scroll', () => {
        if (sidebar.offsetHeight <= window.innerHeight) {
            sidebar.style.top = margin + 'px';
            return;
        }

        const currentScrollY = window.scrollY;
        const scrollDelta = currentScrollY - lastScrollY;
        const viewportHeight = window.innerHeight;
        const sidebarHeight = sidebar.offsetHeight;
        
        const minTop = viewportHeight - sidebarHeight - margin;

        if (scrollDelta > 0) {
            topOffset -= scrollDelta;
            if (topOffset < minTop) {
                topOffset = minTop; 
            }
        } else if (scrollDelta < 0) {
            topOffset -= scrollDelta; 
            if (topOffset > margin) {
                topOffset = margin; 
            }
        }

        sidebar.style.top = topOffset + 'px';
        lastScrollY = currentScrollY;
    });
});
    </script></body></html>`;
    res.send(html);
});
router.get('/history/table', requireLogin, async (req, res) => {
    // 0. Bezpečnostní kontrola adresy
    if (!req.query.liga || !req.query.season) return res.redirect('/history');

    // 1. ZAVOLÁME MOZEK (s parametrem true pro režim historie)
    const data = await prepareDashboardData(req, true);

    // 2. VYBALÍME SI PROMĚNNÉ
    let isTipsLocked;
    const {
        username, selectedSeason, selectedLiga, sortedGroupKeys, groupedTeams,
        globalRealRankMap, allUsers, tableTips,
    } = data;
    isTipsLocked = data.isTipsLocked;

    // 3. NAČTENÍ PŘESTUPŮ PRO KONTROLU ZDA EXISTUJÍ
    const { Transfers } = require('../utils/mongoDataAccess');
    const transfersData = await Transfers.findAll();
    const seasonTransfers = transfersData?.[selectedSeason]?.[selectedLiga] || {};
    const hasTransfers = Object.keys(seasonTransfers).length > 0;

    const usersWithTableTips = allUsers.filter(u => tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username]).sort((a, b) => a.username.localeCompare(b.username));
    const initialUser = usersWithTableTips.find(u => u.username === username) ? username : (usersWithTableTips[0]?.username || "");

    // --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Tipovačka</title>
<link rel="stylesheet" href="/css/styles.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
<script>
function showTable(which) { 
    document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none'; 
    const p = document.getElementById('playoffTablePreview'); p.style.display = which === 'playoff' ? 'block' : 'none'; 
}
</script>
<body class="usersite">
<header class="header">
<div class="header-main">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
<div class="header-user">
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</div>
</div>
<div class="header-controls">
<div class="league-dropdown">
<a class="history-btn" href="/">Aktuální</a>
<a class="history-btn" href="/history">Zpět na výběr</a>
<a class="history-btn" href="/history/a/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy zápasů</a>
<a class="history-btn" style="background:orangered; color:black;" href="/history/table/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy tabulky</a>
${hasTransfers
    ? `<a class="history-btn" style="background:#00d4ff; color:black;" href="/history/prestupy?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">📜 Přestupy</a>`
    : `<span class="history-btn" style="background:#333; color:#666; cursor:not-allowed;" title="Pro tuto sezónu/ligu nejsou dostupné přestupy">📜 Přestupy</span>`
}
</div>
</div>
</header>
    <header class="time-header">${await generateTimeWidget()}<a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75em; color: #666; text-decoration: none; cursor: pointer; opacity: 0.7; transition: opacity 0.3s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">v<span id="current-version">...</span></a></header>
<main class="main_page">`
html += await generateLeftPanel(data, true);
    html += `
        <script>
        function showUserTableHistory(username) {
            document.querySelectorAll('.user-history-table-container').forEach(el => el.style.display = 'none');
            const safeName = username.replace(/[^a-zA-Z0-9]/g, '_');
            document.querySelectorAll('.user-table-' + safeName).forEach(el => el.style.display = 'block');
        }

        // Načíst verzi a zobrazit v badge
        fetch('/api/version')
            .then(res => res.json())
            .then(data => {
                const versionBadge = document.getElementById('current-version');
                if (versionBadge) {
                    versionBadge.textContent = data.version;
                }
            })
            .catch(err => console.log('Nepodařilo se načíst verzi', err));
        </script>
        </section>
        <section class="matches-container">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                <h2 style="margin: 0;">Historie tipu tabulky</h2>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label for="historyUserSelect" style="color: lightgrey;">Zobrazit:</label>
                    <select id="historyUserSelect" onchange="showUserTableHistory(this.value)" style="background-color: black; color: orangered; border: 1px solid orangered; padding: 5px;">`;

    if (usersWithTableTips.length === 0) {
        html += `<option disabled selected>Žádná data</option>`;
    } else {
        usersWithTableTips.forEach(u => {
            const isSelected = u.username === initialUser ? 'selected' : '';
            html += `<option value="${u.username}" ${isSelected}>${u.username}</option>`;
        });
    }
    html += `</select></div></div>`;

    if (usersWithTableTips.length === 0) {
        html += `<p style="text-align:center;">V této sezóně nikdo netipoval tabulku.</p>`;
    } else {
        usersWithTableTips.forEach(u => {
            const safeName = u.username.replace(/[^a-zA-Z0-9]/g, '_');
            const isVisible = u.username === initialUser ? 'block' : 'none';
            const userTipData = tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username] || {};

            html += `<div class="user-history-table-container user-table-${safeName}" style="display:${isVisible};">`;
            for (const gKey of sortedGroupKeys) {
                const groupLabel = getGroupDisplayLabel(gKey);

                // Výpočet isGroupLocked pro tuto skupinu
                const isGroupLocked = (isTipsLocked === true) || (Array.isArray(isTipsLocked) && isTipsLocked.includes(gKey));

                // KOPIE SKUPINY ABYCHOM NEROZBILI LEVOU STRANU
                const teamsForTip = [...groupedTeams[gKey]];

                let userGroupTipIds = [];
                if (Array.isArray(userTipData)) userGroupTipIds = userTipData; else userGroupTipIds = userTipData[gKey] || [];
                const hasTip = userGroupTipIds.length > 0;

                if (hasTip) {
                    teamsForTip.sort((a, b) => {
                        const idxA = userGroupTipIds.indexOf(a.id);
                        const idxB = userGroupTipIds.indexOf(b.id);
                        if (idxA === -1) return 1;
                        if (idxB === -1) return -1;
                        return idxA - idxB;
                    });
                } else {
                    teamsForTip.sort((a, b) => (globalRealRankMap[a.id] || 99) - (globalRealRankMap[b.id] || 99));
                }

                html += `<div style="margin-top: 20px;">
                    ${groupLabel ? `<h3 style="border-bottom:1px solid #555;">${groupLabel}</h3>` : ''}
                    <ul style="list-style: none; padding: 0;">`;

                teamsForTip.forEach((team, index) => {
                    const userRank = index + 1;
                    const realRank = globalRealRankMap[team.id] || '?';
                    const diff = userRank - realRank;

                    // 1. DEFINICE LOGA
                    const logoUrl = team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

                    let bgStyle = "background-color: #1a1a1a; border: 1px solid #444;";
                    let diffText;
                    let diffColor = "gray";

                    if (hasTip) {
                        // PŘIDÁNA KONTROLA ZÁMKU: Zobrazí vyhodnocení jen pokud je skupina zamčená
                        if (isGroupLocked) {
                            if (diff === 0) {
                                bgStyle = "background-color: rgba(40, 100, 40, 0.6); border-color: #00ff00;";
                                diffText = "✔";
                                diffColor = "#00ff00";
                            } else {
                                diffText = `<span style="font-size: 0.8em">Akt.: ${realRank}. (${Math.abs(diff)})</span>`;
                                diffColor = "orange";
                            }
                        } else {
                            // Tip je uložený, ale tabulka ještě není zamčená z adminu
                            diffText = `<span style="font-size: 0.7em; color: #aaa;">Uloženo (čeká na uzamčení)</span>` ;
                            diffColor = "#aaa";
                        }
                    } else {
                        diffText = "Netipováno";
                    }

                    // 2. UPRAVENÉ LI S WATERMARKEM
                    html += `
                    <li style="${bgStyle} display: flex; align-items: center; justify-content: space-between; margin: 5px 0; padding: 15px; color: #fff;
                                position: relative; overflow: hidden;"> <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); 
                                    width: 80%; height: 400%; 
                                    background-image: url('${logoUrl}'); background-size: contain; background-repeat: no-repeat; background-position: center; 
                                    opacity: 0.30; filter: grayscale(50%); pointer-events: none; z-index: 1;">
                        </div>

                        <div style="display:flex; align-items:center; position: relative; z-index: 2;">
                            <span class="rank-number" style="font-weight: bold; color: orangered; margin-right: 15px; width: 30px;">${userRank}.</span>
                            <span class="team-name" style="font-weight: bold;">${team.name}</span>
                        </div>
                        
                        <div style="display:flex; align-items:center; gap: 15px; position: relative; z-index: 2;">
                            <span style="color: ${diffColor}; font-weight: normal; margin-right: 10px;">${diffText}</span>
                        </div>
                    </li>`;
                });
                html += `</ul></div>`;
            }
            html += `</div>`;
        });
    }

    html += `</section></main>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.querySelector('.left-panel');
    const container = document.querySelector('.stats-container');
    
    if (!sidebar || !container) return;

    let lastScrollY = window.scrollY;
    let topOffset = 20; // Výchozí odsazení odshora
    const margin = 20; // Mezera nahoře i dole

    window.addEventListener('scroll', () => {
        // Pokud je obrazovka dostatečně velká, že se tam panel vejde celý, normálně ho přilepíme k vršku
        if (sidebar.offsetHeight <= window.innerHeight) {
            sidebar.style.top = margin + 'px';
            return;
        }

        const currentScrollY = window.scrollY;
        const scrollDelta = currentScrollY - lastScrollY;
        const viewportHeight = window.innerHeight;
        const sidebarHeight = sidebar.offsetHeight;
        
        // Minimální hodnota 'top', aby se ukázal spodek panelu (bude to záporné číslo)
        const minTop = viewportHeight - sidebarHeight - margin;

        if (scrollDelta > 0) {
            // SCROLUJEME DOLŮ
            topOffset -= scrollDelta;
            if (topOffset < minTop) {
                topOffset = minTop; // Zastavíme, když dorazíme na konec panelu (přilepí se ke spodku)
            }
        } else if (scrollDelta < 0) {
            // SCROLUJEME NAHORU
            topOffset -= scrollDelta; // (odčítáme záporné číslo = přičítáme)
            if (topOffset > margin) {
                topOffset = margin; // Zastavíme, když dorazíme na začátek panelu (přilepí se k vršku)
            }
        }

        sidebar.style.top = topOffset + 'px';
        lastScrollY = currentScrollY;
    });
});
    </script></body></html>`;
    res.send(html);
});

router.get("/prestupy", requireLogin, async (req, res) => {
    // Odstraněna podmínka kontroly veřejné ligy - přestupy jsou viditelné vždy
    
    // 1. ZAVOLÁME MOZEK, KTERÝ VŠE VYPOČÍTÁ BĚHEM MILISEKUNDY
    const data = await prepareDashboardData(req);

    // 2. VYBALÍME SI PROMĚNNÉ, KTERÉ POTŘEBUJE HTML (Destructuring)
    const {
        username, selectedLiga, uniqueLeagues, teamsInSelectedLiga,
        activeTransferLeagues, currentTransfers,
    } = data;
// --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Tipovačka</title>
<link rel="stylesheet" href="/css/styles.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
<script>
function showTable(which) { 
    document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none'; 
    const p = document.getElementById('playoffTablePreview'); p.style.display = which === 'playoff' ? 'block' : 'none'; 
}

// Převod klíče
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

async function toggleNotifications() {
    const btn = document.getElementById('notify-toggle-btn');
    if (!btn) return;
    
    btn.disabled = true;
    btn.textContent = "Pracuji...";

    try {
        let registration = await navigator.serviceWorker.getRegistration();
        
        if (!registration) {
            registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        }

        let retry = 0;
        while (!registration.active && retry < 10) {
            await new Promise(res => setTimeout(res, 500));
            registration = await navigator.serviceWorker.getRegistration();
            retry++;
        }

        if (!registration.active) {
            alert("Service Worker se nepodařilo aktivovat.");
            btn.disabled = false;
            await checkSubscriptionStatus();
            return;
        }

        const subscription = await registration.pushManager.getSubscription();

        if (subscription) {
            // ODHLÁŠENÍ
            const res = await fetch('/api/unsubscribe', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': '${req.session.csrfToken || ''}'
                },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            if (res.ok) {
                await subscription.unsubscribe();
                alert('Notifikace vypnuty.');
                await checkSubscriptionStatus();
            }
        } else {
            // PŘIHLÁŠENÍ
            const vapidRes = await fetch('/api/vapid-public-key');
            if (!vapidRes.ok) {
                alert('Server neodpovídá (chyba při získávání klíče).');
                btn.disabled = false;
                await checkSubscriptionStatus();
                return;
            }
            const vapidPublicKey = await vapidRes.text();

            const newSub = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
            });

            const saveRes = await fetch('/api/subscribe', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': '${req.session.csrfToken || ''}'
                },
                body: JSON.stringify(newSub)
            });
            
            if (saveRes.ok) {
                alert('Notifikace zapnuty!');
                await checkSubscriptionStatus();
            } else {
                alert('Nepodařilo se uložit odběr na server.');
            }
        }
    } catch (e) {
        console.error("Kritická chyba notifikací:", e);
        alert('Došlo k nečekané chybě: ' + e.message);
    }
    
    await checkSubscriptionStatus();
    btn.disabled = false;
}

async function checkSubscriptionStatus() {
    const btn = document.getElementById('notify-toggle-btn');
    if (!btn) return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        btn.textContent = "Nepodporováno";
        btn.disabled = true;
        return;
    }

    try {
        // Kontrola stavu bez zbytečného čekání
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = registration ? await registration.pushManager.getSubscription() : null;

        if (subscription) {
            btn.textContent = "Vypnout notifikace 🔕";
            btn.style.backgroundColor = "#555";
        } else {
            btn.textContent = "Zapnout notifikace 🔔";
            btn.style.backgroundColor = "#ff4500";
        }
    } catch (e) {
        btn.textContent = "Klikni pro stav";
    }
}

document.addEventListener('DOMContentLoaded', checkSubscriptionStatus);
</script>
<body class="usersite">
<header class="header">
<div class="header-main">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
<div class="header-user">
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</div>
</div>
<div class="header-controls">
<form class="league-dropdown" method="GET">
<label class="league-select-name">
Liga:
<select id="league-select" name="liga" required onchange="this.form.submit()">
${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
</select>
</label>
<a class="history-btn" href="/history">Historie</a>
<a class="history-btn changed" href="/?liga=${encodeURIComponent(selectedLiga)}">Tipovačka</a>
<a class="history-btn changed" href="/table-tip?liga=${encodeURIComponent(selectedLiga)}">Základní část</a>
<a class="history-btn changed" href="/image-exporter?liga=${encodeURIComponent(selectedLiga)}">Exportér</a>
<a class="history-btn changed" href="/statistics">Statistiky</a>
<div style="text-align: center; margin: 0;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()"
        style="width: 220px; height: 38px; cursor: pointer; font-weight: bold; border: none; color: white; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
<input type="hidden" id="globalCsrfToken" value="${req.session.csrfToken || ''}">
</form>
</div>
</header>
<header class="time-header">${await generateTimeWidget()}<a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75em; color: #666; text-decoration: none; cursor: pointer; opacity: 0.7; transition: opacity 0.3s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">v<span id="current-version">...</span></a></header>
<script>
document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.querySelector('.left-panel');
    const container = document.querySelector('.stats-container');
    
    if (!sidebar || !container) return;

    let lastScrollY = window.scrollY;
    let topOffset = 20; // Výchozí odsazení odshora
    const margin = 20; // Mezera nahoře i dole

    window.addEventListener('scroll', () => {
        // Pokud je obrazovka dostatečně velká, že se tam panel vejde celý, normálně ho přilepíme k vršku
        if (sidebar.offsetHeight <= window.innerHeight) {
            sidebar.style.top = margin + 'px';
            return;
        }

        const currentScrollY = window.scrollY;
        const scrollDelta = currentScrollY - lastScrollY;
        const viewportHeight = window.innerHeight;
        const sidebarHeight = sidebar.offsetHeight;
        
        // Minimální hodnota 'top', aby se ukázal spodek panelu (bude to záporné číslo)
        const minTop = viewportHeight - sidebarHeight - margin;

        if (scrollDelta > 0) {
            // SCROLUJEME DOLŮ
            topOffset -= scrollDelta;
            if (topOffset < minTop) {
                topOffset = minTop; // Zastavíme, když dorazíme na konec panelu (přilepí se ke spodku)
            }
        } else if (scrollDelta < 0) {
            // SCROLUJEME NAHORU
            topOffset -= scrollDelta; // (odčítáme záporné číslo = přičítáme)
            if (topOffset > margin) {
                topOffset = margin; // Zastavíme, když dorazíme na začátek panelu (přilepí se k vršku)
            }
        }

        sidebar.style.top = topOffset + 'px';
        lastScrollY = currentScrollY;
    });

    // Načíst verzi a zobrazit v badge
    fetch('/api/version')
        .then(res => res.json())
        .then(data => {
            const versionBadge = document.getElementById('current-version');
            if (versionBadge) {
                versionBadge.textContent = data.version;
            }
        })
        .catch(err => console.log('Nepodařilo se načíst verzi', err));
});
</script>
<main class="main_page">
`
html += await generateLeftPanel(data);

    html += `<section class="matches-container" style="flex: 1; padding: 10px;">`;
        // KONTROLA: Má tato liga zapnuté přestupy?
        if (!activeTransferLeagues.includes(selectedLiga)) {
            html += `
            <div style="display: flex; justify-content: center; align-items: center; height: 50vh; flex-direction: column;">
                <h1 style="color: gray; text-align: center;">V této lize/turnaji nejsou přestupy k dispozici.</h1>
            </div>
        </section></main></body>`; // Ukončení HTML
        } else {
            // --- SEKCE PŘESTUPŮ ---
            html += `<div style="text-align: center; margin-bottom: 10px;">
                <a href="/history/prestupy" style="color: #00d4ff; text-decoration: none; font-size: 0.9em;">📜 Historie přestupů</a>
            </div>
            <h2 style="margin-top: 0; text-align: center; border-bottom: 2px solid orangered; padding-bottom: 10px;">Přestupy a Spekulace - ${selectedLiga}</h2>
            
            <div style="display: grid; gap: 15px; margin-top: 15px;">`;

            // --- Uvnitř router.get("/prestupy", ...) v sekci else (kde jsou povolené přestupy) ---

// 1. FUNKCE PRO OBARVOVÁNÍ (Vlož ji před cyklus forEach)
            const formatPlayerName = (rawName) => {
                let style = 'color: white;'; // Výchozí barva
                let icon = '';
                let name = rawName;

                // A. Detekce značek
                if (name.includes('(X)')) { // Potvrzený odchod
                    style = 'color: #ff6666; text-decoration: line-through; opacity: 0.7;';
                    icon = '❌ ';
                    name = name.replace('(X)', '');
                }
                else if (name.includes('(-)')) { // Ukončená spekulace
                    style = 'color: #888; text-decoration: line-through; opacity: 0.5; font-style: italic;';
                    icon = '🚫 ';
                    name = name.replace('(-)', '');
                }
                else if (name.includes('(!)')) { // Bomba přechod
                    style = 'color: #ffd700; font-weight: bold; text-shadow: 0 0 8px rgba(255, 215, 0, 0.4);';
                    icon = '🔥 ';
                    name = name.replace('(!)', '');
                }
                else if (name.includes('(?)')) { //spekulace
                    style = 'color: #00d4ff; font-style: italic;';
                    icon = '❓ ';
                    name = name.replace('(?)', '');
                }
                else if (name.includes('(K)')) { // Konec smlouvy
                    style = 'color: #ffaa00; font-weight: bold;';
                    icon = '📄 ';
                    name = name.replace('(K)', '');
                }

                // B. Detekce vlastní barvy přes hashtag (např. #00ff00)
                const colorMatch = name.match(/#([0-9a-fA-F]{3,6})/);
                if (colorMatch) {
                    style = `color: ${colorMatch[0]}; font-weight: bold;`;
                    name = name.replace(colorMatch[0], ''); // Odstraníme ten kód z textu
                }

                return `<span style="${style}">${icon}${name.trim()}</span>`;
            };

// 2. VYLEPŠENÝ RENDER LIST
            const renderList = (arr) => {
                if (!arr || arr.length === 0) return '<div style="color: gray; font-size: 0.8em; font-style: italic;">-</div>';

                return arr.map(player => `
        <div style="font-size: 0.95em; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
            ${formatPlayerName(player)}
        </div>
    `).join('');
            };
// 3. VYKRESLENÍ KARET (Zůstává podobné, jen volá vylepšený renderList)
            teamsInSelectedLiga.sort((a, b) => a.id - b.id).forEach(team => {
                const tId = String(team.id);
                const tData = currentTransfers[tId] || { specIn: [], specOut: [], confIn: [], confOut: [] }; // Zde už používáme sjednocené názvy confIn/confOut
                const logoUrl = team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

                html += `
    <div style="position: relative; background-color: #000; border: 2px solid #ff4500; overflow: hidden; display: flex; flex-direction: column; min-height: 250px; box-shadow: 0 4px 15px rgba(0,0,0,0.8);">
        
        <div style="position: relative; z-index: 1; background: linear-gradient(to bottom, #222, #111); border-bottom: 3px solid #ff4500; display: flex; align-items: center; padding: 10px;">
            <img src="${logoUrl}" alt="${team.name}" style="height: 45px; width: 45px; object-fit: contain; margin-right: 12px; filter: drop-shadow(0 0 5px rgba(255,255,255,0.2));">
            <strong style="color: white; font-size: 1.3em; text-transform: uppercase; letter-spacing: 1px;">${team.name}</strong>
        </div>

        <div style="position: relative; z-index: 1; display: flex; flex-direction: row; flex: 1;">
            
            <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-10deg); width: 80%; height: 80%; background-image: url('${logoUrl}'); background-size: contain; background-repeat: no-repeat; background-position: center; opacity: 0.30; filter: grayscale(50%); z-index: -50; pointer-events: none;"></div>
            <div style="flex: 1; padding: 8px; border-right: 1px solid #333; background-color: rgba(0, 50, 80, 0.3);">
                <div style="color: #00d4ff; font-size: 0.7em; font-weight: 900; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Spekulace IN</div>
                ${renderList(tData.specIn)}
            </div>

            <div style="flex: 1; padding: 8px; border-right: 1px solid #333; background-color: rgba(0, 50, 80, 0.3);">
                <div style="color: #00d4ff; font-size: 0.7em; font-weight: 900; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Spekulace OUT</div>
                ${renderList(tData.specOut)}
            </div>

            <div style="flex: 1; padding: 8px; border-right: 1px solid #333; background-color: rgba(0, 100, 0, 0.2);">
                <div style="color: #00ff00; font-size: 0.7em; font-weight: 900; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Příchody</div>
                ${renderList(tData.confIn)}
            </div>

            <div style="flex: 1; padding: 8px; background-color: rgba(100, 0, 0, 0.2);">
                <div style="color: #ff4444; font-size: 0.7em; font-weight: 900; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Odchody</div>
                ${renderList(tData.confOut)}
            </div>

        </div>
    </div>`;
            });

            html += `</div></section>`;
        }
        `</main></body>`;
    res.send(html)
});



// POST routa pro generování obrázků
router.post("/image-exporter/generate", requireLogin, express.json({ limit: '50mb' }), async (req, res) => {
    const { createTransferImage, createWinnerImage, createStandingsImage, createStatisticsImage, createPlayoffBracketImage } = require("../utils/fileUtils");
    const { createVersusImageForExport } = require("../routes/notificationService.js");
    const { getChosenSeason } = require('../utils/fileUtils');

    try {
        const { type, homeTeamId, awayTeamId, fromTeamId, toTeamId, winnerTeamId, scoreHome, scoreAway, title, winnerTitle, playerName, playerPhoto, watermark, isPlayoff, seriesHomeWins, seriesAwayWins, season: exportSeason } = req.body;

        const { Teams } = require('../utils/mongoDataAccess');
        const currentSeason = await getChosenSeason();
        // NOVÉ: Použij exportovanou sezónu pokud je specifikována, jinak aktuální
        const selectedSeason = exportSeason || currentSeason;
        const allTeams = await Teams.findAll();
        // OPRAVA: Filtrovat týmy podle zvolené sezóny (ne pouze aktuální)
        const seasonTeams = allTeams.filter(t => t.active && t.season === selectedSeason);

        const outDir = path.join(__dirname, '../public/images/exports');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        let buffer;
        let filename;
        const timestamp = Date.now();

        switch (type) {
            case 'match': {
                const homeTeam = seasonTeams.find(t => t.id === parseInt(homeTeamId));
                const awayTeam = seasonTeams.find(t => t.id === parseInt(awayTeamId));
                if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'Týmy nenalezeny' });

                buffer = await createVersusImageForExport(homeTeam, awayTeam);
                filename = `match-${homeTeam.id}-vs-${awayTeam.id}-${timestamp}.png`;
                break;
            }
            case 'result': {
                const homeTeam = seasonTeams.find(t => t.id === parseInt(homeTeamId));
                const awayTeam = seasonTeams.find(t => t.id === parseInt(awayTeamId));
                if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'Týmy nenalezeny' });

                const seriesData = (isPlayoff && seriesHomeWins !== undefined && seriesAwayWins !== undefined)
                    ? { homeWins: parseInt(seriesHomeWins), awayWins: parseInt(seriesAwayWins) }
                    : null;

                buffer = await createMatchImage(homeTeam, awayTeam, parseInt(scoreHome), parseInt(scoreAway), title || null, watermark !== 'false', seriesData);
                filename = `result-${homeTeam.id}-${scoreHome}-${awayTeam.id}-${scoreAway}-${timestamp}.png`;
                break;
            }
            case 'transfer': {
                const fromTeam = seasonTeams.find(t => t.id === parseInt(fromTeamId));
                const toTeam = seasonTeams.find(t => t.id === parseInt(toTeamId));
                if (!fromTeam || !toTeam) return res.status(400).json({ error: 'Týmy nenalezeny' });

                let playerPhotoPath = null;
                if (playerPhoto && playerPhoto.startsWith('data:image')) {
                    const base64Data = playerPhoto.replace(/^data:image\/\w+;base64,/, '');
                    const tempDir = path.join(__dirname, '../temp');
                    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
                    playerPhotoPath = path.join(tempDir, `player-${timestamp}.png`);
                    fs.writeFileSync(playerPhotoPath, Buffer.from(base64Data, 'base64'));
                }

                buffer = await createTransferImage(fromTeam, toTeam, playerName || null, watermark !== 'false', playerPhotoPath);

                if (playerPhotoPath && fs.existsSync(playerPhotoPath)) {
                    try { fs.unlinkSync(playerPhotoPath); } catch (e) {}
                }
                const playerSuffix = playerName ? `-${playerName.replace(/\s+/g, '-')}` : '';
                filename = `transfer-${fromTeam.id}-to-${toTeam.id}${playerSuffix}-${timestamp}.png`;
                break;
            }
            case 'winner': {
                const { winnerColor, showTrophy } = req.body;
                const winnerTeam = seasonTeams.find(t => t.id === parseInt(winnerTeamId));
                if (!winnerTeam) return res.status(400).json({ error: 'Tým nenalezen' });

                const titleText = winnerTitle || `VÍTĚZ`;
                const winnerOptions = {
                    accentColor: winnerColor || '#ffd700',
                    showTrophy: showTrophy === 'true' || showTrophy === true
                };
                buffer = await createWinnerImage(winnerTeam, titleText, watermark !== 'false', winnerOptions);
                filename = `winner-${winnerTeam.id}-${timestamp}.png`;
                break;
            }
            case 'standings': {
                const { selectedLiga, standingsType, standingsTitle, clinchMode } = req.body;
                if (!selectedLiga) return res.status(400).json({ error: 'Chybí vybraná liga' });

                // Použijeme prepareDashboardData pro získání stejných dat jako left panel
                const dashboardData = await prepareDashboardData({
                    user: req.user,
                    query: { liga: selectedLiga },
                    session: req.session
                }, false, true);
                
                const {
                    selectedSeason, sortedGroups, leagueObj,
                    playoffData, matches, teams, scores, clinchMode: defaultClinchMode
                } = dashboardData;
                
                const mode = clinchMode || defaultClinchMode || 'cascade';
                const isPlayoff = standingsType === 'playoff';
                
                // Zóny z konfigurace ligy
                const qf = leagueObj?.quarterfinal || 0;
                const pi = leagueObj?.playin || 0;
                const rel = leagueObj?.relegation || 0;

                if (isPlayoff) {
                    // PLAYOFF - vygenerujeme pavouka
                    // Vytvoříme standings data pro playoff
                    const playoffStandings = [];
                    for (const group of sortedGroups) {
                        const teamsInGroup = dashboardData.teamsByGroup[group] || [];
                        if (!teamsInGroup.length) continue;
                        
                        // Seřadíme stejně jako pro základní část
                        teamsInGroup.sort((a, b) => {
                            const aStats = a.stats?.[selectedSeason] || {};
                            const bStats = b.stats?.[selectedSeason] || {};
                            const aPoints = aStats.points || 0;
                            const bPoints = bStats.points || 0;
                            if (bPoints !== aPoints) return bPoints - aPoints;
                            
                            const aTiebreaker = aStats.tiebreaker || 0;
                            const bTiebreaker = bStats.tiebreaker || 0;
                            if (aTiebreaker !== bTiebreaker) {
                                if (aTiebreaker === 0) return 1;
                                if (bTiebreaker === 0) return -1;
                                return aTiebreaker - bTiebreaker;
                            }
                            
                            // Podle priority tiebreaker určíme pořadí kritérií
                            if (leagueObj?.tiebreakerPriority === 'goalDiff') {
                                // Priorita: Celkové skóre před H2H
                                const aScores = scores[a.id] || { gf: 0, ga: 0 };
                                const bScores = scores[b.id] || { gf: 0, ga: 0 };
                                const aTotalGF = aStats.gf || aScores.gf || 0;
                                const bTotalGF = bStats.gf || bScores.gf || 0;
                                const aTotalGA = aStats.ga || aScores.ga || 0;
                                const bTotalGA = bStats.ga || bScores.ga || 0;
                                const aDiff = aTotalGF - aTotalGA;
                                const bDiff = bTotalGF - bTotalGA;
                                if (bDiff !== aDiff) return bDiff - aDiff;
                                if (bTotalGF !== aTotalGF) return bTotalGF - aTotalGF;

                                // H2H kontrola (jen pokud není goalDiff priority)
                                const directMatch = matches.find(m =>
                                    m.season === selectedSeason && m.liga === selectedLiga && m.result && !m.isPlayoff &&
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
                            } else {
                                // Priorita: H2H před celkovým skórem (výchozí)
                                const aScores = scores[a.id] || { gf: 0, ga: 0 };
                                const bScores = scores[b.id] || { gf: 0, ga: 0 };
                                const aTotalGF = aStats.gf || aScores.gf || 0;
                                const bTotalGF = bStats.gf || bScores.gf || 0;
                                const aTotalGA = aStats.ga || aScores.ga || 0;
                                const bTotalGA = bStats.ga || bScores.ga || 0;
                                const aDiff = aTotalGF - aTotalGA;
                                const bDiff = bTotalGF - bTotalGA;
                                if (bDiff !== aDiff) return bDiff - aDiff;
                                if (bTotalGF !== aTotalGF) return bTotalGF - aTotalGF;

                                const directMatch = matches.find(m =>
                                    m.season === selectedSeason && m.liga === selectedLiga && m.result && !m.isPlayoff &&
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
                            }
                            return 0;
                        });
                        
                        teamsInGroup.forEach((team, index) => {
                            playoffStandings.push({
                                teamId: team.id,
                                teamName: team.name,
                                position: index + 1,
                                points: team.stats?.[selectedSeason]?.points || 0
                            });
                        });
                    }
                    
                    buffer = await createPlayoffBracketImage({
                        playoffData,
                        matches,
                        teams,
                        leagueObj,
                        selectedSeason,
                        selectedLiga,
                        title: standingsTitle || `Playoff - ${selectedLiga}`,
                        standings: playoffStandings
                    }, watermark !== 'false');
                    filename = `playoff-bracket-${selectedLiga}-${timestamp}.png`;
                } else {
                    // ZÁKLADNÍ ČÁST - použijeme stejné výpočty jako left panel
                    // Zavoláme evaluateRegularSeasonTable pro každou skupinu (stejně jako left panel)
                    const { evaluateRegularSeasonTable, calculateClinchStatusesForGroup } = require("../utils/fileUtils");
                    for (const group of sortedGroups) {
                        await evaluateRegularSeasonTable(selectedSeason, selectedLiga, group, true);
                    }
                    
                    const standingsData = [];
                    
                    for (const group of sortedGroups) {
                        // Použijeme teamsByGroup z dashboardData - zajišťuje konzistenci s left panelem
                        const teamsInGroup = dashboardData.teamsByGroup[group] || [];
                        if (!teamsInGroup.length) continue;
                        
                        // Seřadíme týmy podle bodů, tiebreakerů, skóre atd.
                        teamsInGroup.sort((a, b) => {
                            const aStats = a.stats?.[selectedSeason] || {};
                            const bStats = b.stats?.[selectedSeason] || {};
                            
                            // POZOR: prepareDashboardData už přičetla manuální body k stats.points
                            // Nepřičítáme znovu - používáme body přímo z stats
                            const aPoints = aStats.points || 0;
                            const bPoints = bStats.points || 0;
                            if (bPoints !== aPoints) return bPoints - aPoints;
                            
                            // Tiebreaker (decider) - menší číslo = lepší pozice
                            const aTiebreaker = aStats.tiebreaker || 0;
                            const bTiebreaker = bStats.tiebreaker || 0;
                            if (aTiebreaker !== bTiebreaker) {
                                if (aTiebreaker === 0) return 1;  // A bez tiebreakeru padá dolů
                                if (bTiebreaker === 0) return -1; // B bez tiebreakeru padá dolů
                                return aTiebreaker - bTiebreaker; // Menší číslo vyhrává
                            }
                            
                            // Skóre z bonusů + zápasové - manuální skóre už je v stats.gf/ga díky prepareDashboardData
                            const aScores = scores[a.id] || { gf: 0, ga: 0 };
                            const bScores = scores[b.id] || { gf: 0, ga: 0 };
                            
                            const aTotalGF = aStats.gf || aScores.gf || 0;
                            const bTotalGF = bStats.gf || bScores.gf || 0;
                            const aTotalGA = aStats.ga || aScores.ga || 0;
                            const bTotalGA = bStats.ga || bScores.ga || 0;
                            
                            const aDiff = aTotalGF - aTotalGA;
                            const bDiff = bTotalGF - bTotalGA;
                            if (bDiff !== aDiff) return bDiff - aDiff;
                            return bTotalGF - aTotalGF;
                        });
                        
                        // Použijeme calculateClinchStatusesForGroup pro výpočet jistot (stejné jako left panel)
                        const teamsWithClinch = calculateClinchStatusesForGroup(
                            teamsInGroup,
                            leagueObj,
                            selectedSeason,
                            mode,
                            scores,
                            matches,
                            selectedLiga
                        );
                        
                        // Pro každý tým vytvoříme záznam s daty - manuální body už jsou v stats.points
                        teamsWithClinch.forEach((team, index) => {
                            const stats = team.stats?.[selectedSeason] || {};
                            const clinchStatus = team._clinchStatus || {};
                            
                            standingsData.push({
                                id: team.id,
                                name: team.name + (sortedGroups.length > 1 ? ` (${group})` : ''),
                                points: stats.points || 0, // Body už obsahují manuální body z prepareDashboardData
                                wins: stats.wins || 0,
                                otWins: stats.otWins || 0,
                                otLosses: stats.otLosses || 0,
                                losses: stats.losses || 0,
                                gf: clinchStatus.gf || 0,
                                ga: clinchStatus.ga || 0,
                                group: group,
                                position: index + 1,
                                tiebreaker: stats.tiebreaker || 0, // Tiebreaker je také už v stats
                                // Přidáme jistoty pro createStandingsImage
                                _clinchStatus: clinchStatus
                            });
                        });
                    }
                    
                    // Seřadíme podle skupin a pozic
                    standingsData.sort((a, b) => {
                        if (a.group !== b.group) return a.group.localeCompare(b.group);
                        return a.position - b.position;
                    });

                    const title = standingsTitle || `Tabulka ${selectedLiga} - Základní část`;
                    const options = {
                        isPlayoff: false,
                        quarterfinal: qf,
                        playin: pi,
                        relegation: rel,
                        clinchMode: mode,
                        multiGroup: sortedGroups.length > 1
                    };
                    buffer = await createStandingsImage(standingsData, title, watermark !== 'false', options);
                    filename = `standings-${selectedLiga}-${timestamp}.png`;
                }
                break;
            }
            case 'statistics': {
                const { selectedLiga, statisticsTitle } = req.body;
                if (!selectedLiga) return res.status(400).json({ error: 'Chybí vybraná liga' });

                // Použijeme prepareDashboardData pro získání stejných dat jako left panel
                const dashboardData = await prepareDashboardData({
                    user: req.user,
                    query: { liga: selectedLiga },
                    session: req.session
                }, false, true);
                
                const { userStats } = dashboardData;
                
                // Použijeme přímo userStats z prepareDashboardData - má všechny správné výpočty
                const usersStats = userStats.map(u => ({
                    username: u.username,
                    correct: u.correct || 0,
                    total: u.total || 0,
                    totalRegular: u.totalRegular || 0,
                    totalPlayoff: u.totalPlayoff || 0,
                    tableCorrect: u.tableCorrect || 0,
                    tableDeviation: u.tableDeviation || 0
                })).sort((a, b) => {
                    // Seřazení podle správných tipů, pak trefených pozic, pak odchylky
                    if (b.correct !== a.correct) return b.correct - a.correct;
                    if (b.tableCorrect !== a.tableCorrect) return b.tableCorrect - a.tableCorrect;
                    return a.tableDeviation - b.tableDeviation;
                });

                const title = statisticsTitle || `Statistiky tipujících - ${selectedLiga}`;
                buffer = await createStatisticsImage(usersStats, title, watermark !== 'false');
                filename = `statistics-${selectedLiga}-${timestamp}.png`;
                break;
            }

            default:
                return res.status(400).json({ error: 'Neznámý typ obrázku' });
        }

        const outPath = path.join(outDir, filename);
        fs.writeFileSync(outPath, buffer);

        res.json({
            url: `/images/exports/${filename}`,
            filename: filename
        });

    } catch (err) {
        console.error('Chyba při generování obrázku:', err);
        res.status(500).json({ error: 'Chyba při generování obrázku' });
    }
});

router.get("/image-exporter", requireLogin, async (req, res) => {
    const { getMatches, loadTeams, getAllowedLeagues, getLeaguesData } = require('../utils/fileUtils');
    
    // Načteme všechny ligy v sezóně (ne jen veřejné)
    const matches = await getMatches();
    const data = await prepareDashboardData(req, false, true);
    const { username, selectedSeason } = data;
    const teams = (await loadTeams()).filter(t => t.active && t.season === selectedSeason); // OPRAVA: Filtrování podle chosenSeason
    const allowedLeagues = await getAllowedLeagues(selectedSeason);
    const allSeasonData = await getLeaguesData();
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];
    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.filter(m => m.season === selectedSeason).map(m => m.liga))]; // OPRAVA: Filtrování zápasů podle sezóny
    const leaguesFromLeagues = [...new Set(leagues.map(l => l.name))];
    // OPRAVA: Prioritizovat pořadí z definice lig - nejprve definice, pak doplnit z týmů a zápasů
    const uniqueLeagues = [...new Set([...leaguesFromLeagues, ...leaguesFromTeams, ...leaguesFromMatches])];
    
    // Zjistíme jest je vybraná liga veřejná
    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga)
        ? req.query.liga
        : (allowedLeagues.find(l => uniqueLeagues.includes(l)) || uniqueLeagues[0] || "Neurčeno");
    
    const isPublicLeague = allowedLeagues.includes(selectedLiga);
    
    const teamsList = teams || [];
    const leagueTeams = teamsList.filter(t =>
        t.liga === selectedLiga ||
        t.liga.toLowerCase() === selectedLiga.toLowerCase()
    );
    
    // CSS pro disabled tlačítka
    const disabledStyle = "background-color: #555; color: #888; cursor: not-allowed; pointer-events: none;";
    let html = `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Image Exporter - Tipovačka</title>
<link rel="stylesheet" href="/css/styles.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
<script>
function showImageType(type) {
    document.querySelectorAll('.image-type-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.form-section').forEach(section => section.classList.remove('active'));
    document.getElementById(type + '-section').classList.add('active');
    event.target.classList.add('active');
    document.getElementById('preview-container').classList.remove('active');
}

function handlePlayerPhoto(input) { 
    const file = input.files[0]; 
    if (!file) return; 
    if (file.size > 2 * 1024 * 1024) {  
        alert("Fotka je příliš velká. Maximum je 2MB."); 
        input.value = ""; 
        return; 
    } 
    const reader = new FileReader(); 
    reader.onload = function(e) { 
        document.getElementById("playerPhotoBase64").value = e.target.result; 
    };
    reader.readAsDataURL(file);
}

async function generateImage(type) {
    const btn = document.getElementById('generate-btn-' + type);
    btn.disabled = true;
    btn.textContent = 'Generuji...';
    
    const formData = new FormData(document.getElementById(type + '-form'));
    const data = Object.fromEntries(formData);
    data.type = type;
    
    try {
        const csrfToken = document.getElementById('globalCsrfToken')?.value || '';
        const res = await fetch('/image-exporter/generate', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify(data)
        });
        
        if (res.ok) {
            const result = await res.json();
            const preview = document.getElementById('preview-container');
            const img = document.getElementById('preview-img');
            const downloadBtn = document.getElementById('download-btn');
            
            img.src = result.url + '?t=' + Date.now();
            downloadBtn.href = result.url;
            downloadBtn.download = result.filename;
            preview.classList.add('active');
            preview.scrollIntoView({ behavior: 'smooth' });
        } else {
            alert('Chyba při generování obrázku');
        }
    } catch (e) {
        console.error('Chyba:', e);
        alert('Chyba při generování obrázku');
    }
    
    btn.disabled = false;
    btn.textContent = 'Vygenerovat obrázek';
}
</script>
<body class="usersite">
<header class="header">
<div class="header-main">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
<div class="header-user">
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</div>
</div>
<div class="header-controls">
<form class="league-dropdown" method="GET">
<label class="league-select-name">
Liga:
<select id="league-select" name="liga" required onchange="this.form.submit()">
${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
</select>
</label>
<a class="history-btn" href="/history">Historie</a>
<a class="history-btn changed" ${!isPublicLeague ? `style="${disabledStyle}" onclick="return false;"` : `href="/?liga=${encodeURIComponent(selectedLiga)}"`}>Tipovačka</a>
<a class="history-btn changed" ${!isPublicLeague ? `style="${disabledStyle}" onclick="return false;"` : `href="/table-tip?liga=${encodeURIComponent(selectedLiga)}"`}>Základní část</a>
<a class="history-btn changed" href="/prestupy?liga=${encodeURIComponent(selectedLiga)}">Přestupy</a>
<a class="history-btn changed" href="/statistics">Statistiky</a>
<input type="hidden" id="globalCsrfToken" value="${req.session.csrfToken || ''}">
</form>
</div>
</header>
<header class="time-header">${await generateTimeWidget()}<a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75em; color: #666; text-decoration: none; cursor: pointer; opacity: 0.7; transition: opacity 0.3s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">v<span id="current-version">...</span></a></header>
<main class="main_page">`;

html += await generateLeftPanel(data);

html += `<section class="matches-container" style="flex: 1; padding: 20px;">
    <div class="info-box">
        <h3>🎨 Image Exporter</h3>
        <p>Vygeneruj si vlastní obrázky se zápasy, přestupy nebo vítězi ligy.</p>
    </div>
    
    <div class="image-exporter-container">
        <div class="image-type-selector">
            <button type="button" class="image-type-btn active" onclick="showImageType('match')">🏒 Zápas VS</button>
            <button type="button" class="image-type-btn" onclick="showImageType('result')">📊 Výsledek zápasu</button>
            <button type="button" class="image-type-btn" onclick="showImageType('transfer')">🔄 Přestup</button>
            <button type="button" class="image-type-btn" onclick="showImageType('winner')">🏆 Vítěz ligy</button>
            <button type="button" class="image-type-btn" onclick="showImageType('standings')">📋 Tabulka</button>
            <button type="button" class="image-type-btn" onclick="showImageType('statistics')">📈 Statistiky</button>
        </div>
        
        <div id="match-section" class="form-section active">
            <h3 style="color: #ff4500; margin-top: 0;">Obrázek zápasu (VS)</h3>
            <form id="match-form" onsubmit="event.preventDefault(); generateImage('match');">
                <div class="form-row">
                    <div class="form-group">
                        <label>Domácí tým</label>
                        <select name="homeTeamId" required>
                            <option value="">Vyber tým</option>
                            ${leagueTeams.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Hostující tým</label>
                        <select name="awayTeamId" required>
                            <option value="">Vyber tým</option>
                            ${leagueTeams.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="form-group watermark-option">
                    <input type="checkbox" name="watermark" id="match-watermark" checked>
                    <label for="match-watermark" style="margin: 0;">Přidat watermark</label>
                </div>
                <button type="submit" id="generate-btn-match" class="generate-btn">Vygenerovat obrázek</button>
            </form>
        </div>
        
        <div id="result-section" class="form-section">
            <h3 style="color: #ff4500; margin-top: 0;">Obrázek výsledku zápasu</h3>
            <form id="result-form" onsubmit="event.preventDefault(); generateImage('result');">
                <div class="form-row">
                    <div class="form-group">
                        <label>Domácí tým</label>
                        <select name="homeTeamId" required>
                            <option value="">Vyber tým</option>
                            ${leagueTeams.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Hostující tým</label>
                        <select name="awayTeamId" required>
                            <option value="">Vyber tým</option>
                            ${leagueTeams.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Skóre domácí</label>
                        <input type="number" name="scoreHome" min="0" value="0" required>
                    </div>
                    <div class="form-group">
                        <label>Skóre hosté</label>
                        <input type="number" name="scoreAway" min="0" value="0" required>
                    </div>
                </div>
                <div class="form-group">
                    <label>Nadpis (nepovinné)</label>
                    <input type="text" name="title" placeholder="např. Finále série, 3. zápas...">
                </div>
                <div class="form-group watermark-option">
                    <input type="checkbox" name="isPlayoff" id="is-playoff" onchange="document.getElementById('series-row').style.display = this.checked ? 'flex' : 'none'">
                    <label for="is-playoff" style="margin: 0;">Playoff zápas (zobrazit stav série)</label>
                </div>
                <div class="form-row" id="series-row" style="display: none;">
                    <div class="form-group">
                        <label>Výhry domácí v sérii</label>
                        <input type="number" name="seriesHomeWins" min="0" max="4" value="0">
                    </div>
                    <div class="form-group">
                        <label>Výhry hosté v sérii</label>
                        <input type="number" name="seriesAwayWins" min="0" max="4" value="0">
                    </div>
                </div>
                <div class="form-group watermark-option">
                    <input type="checkbox" name="watermark" id="result-watermark" checked>
                    <label for="result-watermark" style="margin: 0;">Přidat watermark</label>
                </div>
                <button type="submit" id="generate-btn-result" class="generate-btn">Vygenerovat obrázek</button>
            </form>
        </div>
        
        <div id="transfer-section" class="form-section">
            <h3 style="color: #ff4500; margin-top: 0;">Obrázek přestupu</h3>
            <form id="transfer-form" onsubmit="event.preventDefault(); generateImage('transfer');">
                <div class="form-row">
                    <div class="form-group">
                        <label>Z týmu</label>
                        <select name="fromTeamId" required>
                            <option value="">Vyber tým</option>
                            ${leagueTeams.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Do týmu</label>
                        <select name="toTeamId" required>
                            <option value="">Vyber tým</option>
                            ${leagueTeams.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label>Jméno hráče (nepovinné)</label>
                    <input type="text" name="playerName" placeholder="např. Jan Novák">
                </div>
                <div class="form-group">
                    <label>Fotka hráče (nepovinné)</label>
                    <input type="file" id="playerPhotoInput" accept="image/*" onchange="handlePlayerPhoto(this)">
                    <input type="hidden" name="playerPhoto" id="playerPhotoBase64">
                    <small style="color: #888; display: block; margin-top: 5px;">Max 2MB, zobrazí se mezi týmy</small>
                </div>
                <div class="form-group watermark-option">
                    <input type="checkbox" name="watermark" id="transfer-watermark" checked>
                    <label for="transfer-watermark" style="margin: 0;">Přidat watermark</label>
                </div>
                <button type="submit" id="generate-btn-transfer" class="generate-btn">Vygenerovat obrázek</button>
            </form>
        </div>
        
        <div id="winner-section" class="form-section">
            <h3 style="color: #ff4500; margin-top: 0;">Obrázek vítěze ligy</h3>
            <form id="winner-form" onsubmit="event.preventDefault(); generateImage('winner');">
                <div class="form-group">
                    <label>Vítězný tým</label>
                    <select name="winnerTeamId" required>
                        <option value="">Vyber tým</option>
                        ${leagueTeams.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Text nadpisu</label>
                    <input type="text" name="winnerTitle" value="VÍTĚZ ${selectedLiga}" placeholder="např. VÍTĚZ TELH 2024/25">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Barva akcentu</label>
                        <input type="color" name="winnerColor" value="#ffd700" style="width: 60px; height: 40px; padding: 0; border: none; cursor: pointer;">
                        <small style="color: #888; display: block; margin-top: 5px;">Zlatá, stříbrná, bronzová nebo jiná...</small>
                    </div>
                    <div class="form-group watermark-option" style="align-items: flex-start; margin-top: 20px;">
                        <input type="checkbox" name="showTrophy" id="show-trophy" checked value="true">
                        <label for="show-trophy" style="margin: 0;">Zobrazit hvězdičku ⭐</label>
                    </div>
                </div>
                <div class="form-group watermark-option">
                    <input type="checkbox" name="watermark" id="winner-watermark" checked>
                    <label for="winner-watermark" style="margin: 0;">Přidat watermark</label>
                </div>
                <button type="submit" id="generate-btn-winner" class="generate-btn">Vygenerovat obrázek</button>
            </form>
        </div>
        
        <div id="standings-section" class="form-section">
            <h3 style="color: #ff4500; margin-top: 0;">Export tabulky</h3>
            <form id="standings-form" onsubmit="event.preventDefault(); generateImage('standings');">
                <div class="form-group">
                    <label>Typ tabulky</label>
                    <select name="standingsType" id="standings-type" onchange="document.getElementById('clinch-mode-row').style.display = this.value === 'regular' ? 'block' : 'none'">
                        <option value="regular">Základní část</option>
                        <option value="playoff">Playoff</option>
                    </select>
                </div>
                <div class="form-group" id="clinch-mode-row">
                    <label>Mód zobrazení zóny</label>
                    <select name="clinchMode">
                        <option value="cascade">Kaskádový (výchozí)</option>
                        <option value="strict">Přísný</option>
                    </select>
                    <small style="color: #888; display: block; margin-top: 5px;">Kaskádový = kumulativní zóny, Přísný = striktní dělení</small>
                </div>
                <div class="form-group">
                    <label>Nadpis tabulky</label>
                    <input type="text" name="standingsTitle" placeholder="např. Tabulka TELH 2024/25">
                </div>
                <input type="hidden" name="selectedLiga" value="${selectedLiga}">
                <div class="form-group watermark-option">
                    <input type="checkbox" name="watermark" id="standings-watermark" checked>
                    <label for="standings-watermark" style="margin: 0;">Přidat watermark</label>
                </div>
                <button type="submit" id="generate-btn-standings" class="generate-btn">Vygenerovat obrázek</button>
            </form>
        </div>
        
        <div id="statistics-section" class="form-section">
            <h3 style="color: #ff4500; margin-top: 0;">Export statistik tipujících</h3>
            <form id="statistics-form" onsubmit="event.preventDefault(); generateImage('statistics');">
                <div class="form-group">
                    <label>Nadpis statistik</label>
                    <input type="text" name="statisticsTitle" value="Statistiky tipujících" placeholder="např. Statistiky TELH 2024/25">
                </div>
                <input type="hidden" name="selectedLiga" value="${selectedLiga}">
                <div class="form-group watermark-option">
                    <input type="checkbox" name="watermark" id="statistics-watermark" checked>
                    <label for="statistics-watermark" style="margin: 0;">Přidat watermark</label>
                </div>
                <button type="submit" id="generate-btn-statistics" class="generate-btn">Vygenerovat obrázek</button>
            </form>
        </div>
        
        <div id="preview-container" class="preview-container">
            <h3 style="color: #00d4ff; margin-top: 0;">Náhled vygenerovaného obrázku</h3>
            <img id="preview-img" src="" alt="Generated image preview">
            <br>
            <a id="download-btn" href="" download class="download-btn">📥 Stáhnout obrázek</a>
        </div>
    </div>
</section>
</main>
<script>
    document.addEventListener('DOMContentLoaded', () => {
        fetch('/api/version')
            .then(res => res.json())
            .then(data => {
                const versionBadge = document.getElementById('current-version');
                if (versionBadge) {
                    versionBadge.textContent = data.version;
                }
            })
            .catch(err => console.log('Nepodařilo se načíst verzi', err));
    });
</script>
</body>
<script src="/js/version-notification.js"></script>
</html>`;
    res.send(html);
});
// Endpoint pro statistiky
router.get("/statistics", requireLogin, async (req, res) => {
    try {
        const username = req.session.user;
        const chosenSeason = await ChosenSeason.findAll();
        const selectedSeason = chosenSeason || 'Neurčeno';
        
        // Načtení všech uživatelů
        const users = await Users.findAll();
        
        // Načtení lig pro aktuální sezónu
        const leaguesData = await Leagues.findAll();
        const leagues = Array.isArray(leaguesData?.[selectedSeason]) ? leaguesData[selectedSeason] : [];
        
        // Načtení zápasů pro výpočet playoff statistik
        const matches = await Matches.findAll();

        // Nejprve zjistíme všechny ligy, které se skutečně používají v user.stats
        const allLeaguesInStats = new Set();
        for (const user of users) {
            const stats = user.stats?.[selectedSeason] || {};
            for (const league of Object.keys(stats)) {
                allLeaguesInStats.add(league);
            }
        }

        // Výpočet max. možných bodů pro každou ligu
        const leagueMaxPointsMap = {};
        for (const league of allLeaguesInStats) {
            const leagueMatches = matches.filter(m =>
                m.liga === league &&
                m.season === selectedSeason &&
                m.result?.winner
            );

            let maxPoints = 0;
            for (const match of leagueMatches) {
                if (match.isPlayoff && Number(match.bo) === 1) {
                    maxPoints += 5; // Playoff BO1: max 5 bodů
                } else if (match.isPlayoff && Number(match.bo) > 1) {
                    maxPoints += 3; // Playoff série: max 3 body
                } else {
                    maxPoints += 1; // Základní část: 1 bod
                }
            }
            leagueMaxPointsMap[league] = maxPoints;
        }

        // Výpočet statistik pro každého uživatele
        const userStats = users
            .filter(u => u.username !== 'Admin') // Vynechat admina
            .map(user => {
                const stats = user.stats?.[selectedSeason] || {};
                
                // Celkové statistiky napříč všemi ligami
                let totalCorrect = 0;
                let totalRegular = 0;
                let totalPlayoff = 0;
                let totalTableCorrect = 0;
                let totalTableDeviation = 0;
                let leagueCount;
                
                // Agregace statistik z jednotlivých lig
                const activeLeagues = [];
                let totalRegularCorrect = 0;
                let totalPlayoffBO1Correct = 0;
                let totalPlayoffBO1Tips = 0;
                let totalPlayoffBOSeriesCorrect = 0;
                let totalPlayoffBOSeriesTips = 0;
                
                // Pokud playoff statistiky neexistují, vypočítáme je ze zápasů
                let needsPlayoffCalculation = false;
                for (const league of Object.keys(stats)) {
                    const leagueStats = stats[league];
                    if (leagueStats.totalPlayoff > 0 && 
                        (leagueStats.playoffBO1Correct === undefined || leagueStats.playoffBOSeriesCorrect === undefined)) {
                        needsPlayoffCalculation = true;
                        break;
                    }
                }
                
                // Výpočet playoff statistik ze zápasů (pokud chybí)
                if (needsPlayoffCalculation) {
                    for (const league of Object.keys(stats)) {
                        const leagueStats = stats[league];
                        if (leagueStats.totalPlayoff === 0) continue;
                        
                        const tipsInLeague = user.tips?.[selectedSeason]?.[league] || [];
                        let bo1Correct = 0;
                        let bo1Tips = 0;
                        let seriesCorrect = 0;
                        let seriesTips = 0;
                        
                        for (const tip of tipsInLeague) {
                            const match = matches.find(m => m.id === tip.matchId);
                            if (!match?.result || !match.result.winner) continue;
                            if (!match.isPlayoff) continue;
                            
                            if (Number(match.bo) === 1) {
                                // BO1
                                bo1Tips++;
                                const realHome = Number(match.result.scoreHome ?? 0);
                                const realAway = Number(match.result.scoreAway ?? 0);
                                let tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                                let tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);
                                
                                if (match.result?.sideSwap === true) {
                                    const temp = tipHome;
                                    tipHome = tipAway;
                                    tipAway = temp;
                                }
                                
                                if (Number.isNaN(tipHome) || Number.isNaN(tipAway)) continue;
                                
                                const realOutcome = Math.sign(realHome - realAway);
                                const tipOutcome = Math.sign(tipHome - tipAway);
                                
                                if (realOutcome === tipOutcome) {
                                    bo1Correct++;
                                }
                            } else {
                                // BO > 1 (série)
                                seriesTips++;
                                const realWinner = match.result.winner;
                                const tipWinner = tip.winner;
                                
                                if (tipWinner === realWinner) {
                                    seriesCorrect++;
                                }
                            }
                        }
                        
                        // Uložení vypočítaných statistik do leagueStats
                        leagueStats.playoffBO1Correct = bo1Correct;
                        leagueStats.playoffBO1Tips = bo1Tips;
                        leagueStats.playoffBOSeriesCorrect = seriesCorrect;
                        leagueStats.playoffBOSeriesTips = seriesTips;
                    }
                }
                
                for (const league of Object.keys(stats)) {
                    const leagueStats = stats[league];
                    const leagueTips = (leagueStats.correct || 0) + (leagueStats.totalRegular || 0) + (leagueStats.totalPlayoff || 0) + (leagueStats.tableCorrect || 0);
                    
                    if (leagueTips > 0) {
                        totalCorrect += leagueStats.correct || 0;
                        totalRegular += leagueStats.totalRegular || 0;
                        totalPlayoff += leagueStats.totalPlayoff || 0;
                        totalTableCorrect += leagueStats.tableCorrect || 0;
                        totalTableDeviation += leagueStats.tableDeviation || 0;
                        
                        // Statistiky pro základní část - pokud neexistují, odhadneme z celkových bodů
                        if (leagueStats.correctRegular !== undefined) {
                            totalRegularCorrect += leagueStats.correctRegular || 0;
                        } else {
                            // Pokud neexistují, odhadneme: předpokládáme, že všechny body jsou ze základní části
                            // (pokud má totalRegular > 0, jinak 0)
                            if (leagueStats.totalRegular > 0) {
                                totalRegularCorrect += Math.min(leagueStats.correct || 0, leagueStats.totalRegular);
                            }
                        }
                        
                        // Statistiky pro playoff (pokud neexistují, použijeme 0)
                        totalPlayoffBO1Correct += leagueStats.playoffBO1Correct || 0;
                        totalPlayoffBO1Tips += leagueStats.playoffBO1Tips || 0;
                        totalPlayoffBOSeriesCorrect += leagueStats.playoffBOSeriesCorrect || 0;
                        totalPlayoffBOSeriesTips += leagueStats.playoffBOSeriesTips || 0;
                        
                        activeLeagues.push(league);
                    }
                }
                
                // Oprava počtu lig
                leagueCount = activeLeagues.length;

                // Výpočet celkových max. bodů napříč všemi ligami
                let totalMaxPoints = 0;
                for (const league of activeLeagues) {
                    totalMaxPoints += leagueMaxPointsMap[league] || 0;
                }

                // Výpočet úspěšnosti v %
                const totalTips = totalRegular + totalPlayoff;
                const successRate = totalMaxPoints > 0 ? ((totalCorrect / totalMaxPoints) * 100).toFixed(1) : 0;
                const regularSuccessRate = totalRegular > 0 ? ((totalRegularCorrect / totalRegular) * 100).toFixed(1) : 0;
                const playoffBO1SuccessRate = totalPlayoffBO1Tips > 0 ? ((totalPlayoffBO1Correct / totalPlayoffBO1Tips) * 100).toFixed(1) : 0;
                const playoffBOSeriesSuccessRate = totalPlayoffBOSeriesTips > 0 ? ((totalPlayoffBOSeriesCorrect / totalPlayoffBOSeriesTips) * 100).toFixed(1) : 0;
                const tableSuccessRate = leagueCount > 0 ? ((totalTableCorrect / (leagueCount * 10)) * 100).toFixed(1) : 0; // Předpokládáme 10 týmů na ligu
                
                return {
                    username: user.username,
                    totalCorrect,
                    totalRegular,
                    totalPlayoff,
                    totalTableCorrect,
                    totalTableDeviation,
                    totalTips,
                    successRate: parseFloat(successRate),
                    regularSuccessRate: parseFloat(regularSuccessRate),
                    playoffBO1SuccessRate: parseFloat(playoffBO1SuccessRate),
                    playoffBOSeriesSuccessRate: parseFloat(playoffBOSeriesSuccessRate),
                    tableSuccessRate: parseFloat(tableSuccessRate),
                    leagueCount,
                    leagues: activeLeagues,
                    // Detailní statistiky
                    totalRegularCorrect,
                    totalPlayoffBO1Correct,
                    totalPlayoffBO1Tips,
                    totalPlayoffBOSeriesCorrect,
                    totalPlayoffBOSeriesTips
                };
            })
            .filter(u => u.totalTips > 0) // Vyloučit uživatele s 0 zápasy
            .sort((a, b) => b.totalCorrect - a.totalCorrect); // Seřazení podle celkových bodů
        
        // Statistiky pro aktuálního uživatele
        const currentUserStats = userStats.find(u => u.username === username);
        const currentUserRank = userStats.findIndex(u => u.username === username) + 1;
        
        // Celkové statistiky aplikace
        // Oprava: Počet lig počítáme z unikátních lig v userStats, ne z leagues pole
        userStats.forEach(u => u.leagues.forEach(l => allLeaguesInStats.add(l)));

        // Výpočet distribuce úspěšnosti
        const successRateDistribution = {};
        const bins = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        for (let i = 0; i < bins.length; i++) {
            const min = bins[i];
            const max = bins[i + 1] || 100;
            const key = `${min}-${max}%`;
            successRateDistribution[key] = userStats.filter(u => u.successRate >= min && u.successRate < max).length;
        }

        const appStats = {
            totalUsers: users.filter(u => u.username !== 'Admin').length,
            totalLeagues: allLeaguesInStats.size,
            totalTips: userStats.reduce((sum, u) => sum + u.totalTips, 0),
            totalCorrect: userStats.reduce((sum, u) => sum + u.totalCorrect, 0),
            avgSuccessRate: userStats.length > 0 ? (userStats.reduce((sum, u) => sum + u.successRate, 0) / userStats.length).toFixed(1) : 0,
            successRateDistribution
        };
        
        // Statistiky podle lig
        const leagueStats = {};
        
        for (const league of allLeaguesInStats) {
            const leagueUsers = userStats.filter(u => u.leagues.includes(league));

            // Získání všech zápasů v lize s výsledkem pro výpočet max. bodů
            const leagueMatches = matches.filter(m =>
                m.liga === league &&
                m.season === selectedSeason &&
                m.result?.winner
            );

            // Výpočet max. možných bodů v lize
            let leagueMaxPoints = 0;
            for (const match of leagueMatches) {
                if (match.isPlayoff && Number(match.bo) === 1) {
                    leagueMaxPoints += 5; // Playoff BO1: max 5 bodů
                } else if (match.isPlayoff && Number(match.bo) > 1) {
                    leagueMaxPoints += 3; // Playoff série: max 3 body
                } else {
                    leagueMaxPoints += 1; // Základní část: 1 bod
                }
            }

            // Výpočet statistik jen pro tuto ligu
            let leagueTotalTips = 0;
            let leagueTotalCorrect = 0;
            
            // Výpočet úspěšnosti pro každého uživatele v této lize
            const leagueUserStats = [];
            for (const user of users) {
                if (user.username === 'Admin') continue;
                const userStat = userStats.find(u => u.username === user.username);
                if (!userStat || !userStat.leagues.includes(league)) continue;

                // Použijeme data z user.stats, která už jsou vypočítaná
                const leagueStats = user.stats?.[selectedSeason]?.[league] || {};
                const userLeaguePoints = leagueStats.correct || 0;

                const userSuccessRate = leagueMaxPoints > 0 ? ((userLeaguePoints / leagueMaxPoints) * 100).toFixed(1) : 0;

                leagueTotalTips += (leagueStats.totalRegular || 0) + (leagueStats.totalPlayoff || 0);
                leagueTotalCorrect += userLeaguePoints;

                leagueUserStats.push({
                    username: user.username,
                    successRate: parseFloat(userSuccessRate),
                    totalCorrect: userLeaguePoints,
                    totalTips: (leagueStats.totalRegular || 0) + (leagueStats.totalPlayoff || 0)
                });
            }
            
            // Seřazení podle úspěšnosti v procentech pro určení nejlepšího/horšího uživatele
            // Filtrujeme jen uživatele s alespoň 5 tipy v dané lize
            const eligibleUsers = leagueUserStats.filter(u => u.totalTips >= 5);
            eligibleUsers.sort((a, b) => b.successRate - a.successRate);

            leagueStats[league] = {
                users: leagueUsers.length,
                avgSuccessRate: leagueMaxPoints > 0 ? ((leagueTotalCorrect / (leagueMaxPoints * leagueUsers.length)) * 100).toFixed(1) : 0,
                totalTips: leagueTotalTips,
                totalCorrect: leagueTotalCorrect,
                bestUser: eligibleUsers.length > 0 ? eligibleUsers[0].username : null,
                worstUser: eligibleUsers.length > 0 ? eligibleUsers[eligibleUsers.length - 1].username : null
            };
        }

        // Výpočet matice úspěšnosti uživatel x liga pro heatmapu
        const leagueHeatmapData = {};
        for (const user of users) {
            if (user.username === 'Admin') continue;
            leagueHeatmapData[user.username] = {};
            const userSeasonStats = user.stats?.[selectedSeason] || {};
            for (const league of Object.keys(userSeasonStats)) {
                const leagueStats = userSeasonStats[league] || {};
                const userLeaguePoints = leagueStats.correct || 0;
                const userLeagueTips = (leagueStats.totalRegular || 0) + (leagueStats.totalPlayoff || 0);
                const userLeagueMaxPoints = leagueMaxPointsMap[league] || 0;
                const userLeagueSuccessRate = userLeagueMaxPoints > 0 ? ((userLeaguePoints / userLeagueMaxPoints) * 100).toFixed(1) : 0;
                leagueHeatmapData[user.username][league] = {
                    successRate: parseFloat(userLeagueSuccessRate),
                    points: userLeaguePoints,
                    tips: userLeagueTips
                };
            }
        }

        // Statistiky sérií pro všechny uživatele
        const streakStats = [];
        for (const user of users) {
            if (user.username === 'Admin') continue;
            // Přeskočit uživatele s 0 zápasy
            const userStat = userStats.find(u => u.username === user.username);
            if (!userStat || userStat.totalTips === 0) continue;
            
            const allTips = [];
            const tips = user.tips?.[selectedSeason] || {};
            for (const league of Object.keys(tips)) {
                const leagueTips = tips[league] || [];
                for (const tip of leagueTips) {
                    const match = matches.find(m => m.id === tip.matchId);
                    if (!match?.result || !match.result.winner) continue;
                    
                    let isCorrect = false;
                    if (match.isPlayoff && Number(match.bo) === 1) {
                        const realHome = Number(match.result.scoreHome ?? 0);
                        const realAway = Number(match.result.scoreAway ?? 0);
                        let tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                        let tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);
                        
                        if (match.result?.sideSwap === true) {
                            const temp = tipHome;
                            tipHome = tipAway;
                            tipAway = temp;
                        }
                        
                        if (!Number.isNaN(tipHome) && !Number.isNaN(tipAway)) {
                            const realOutcome = Math.sign(realHome - realAway);
                            const tipOutcome = Math.sign(tipHome - tipAway);
                            isCorrect = realOutcome === tipOutcome;
                        }
                    } else if (match.isPlayoff && Number(match.bo) > 1) {
                        const realWinner = match.result.winner;
                        const tipWinner = tip.winner;
                        isCorrect = tipWinner === realWinner;
                    } else {
                        let evaluatedWinner = tip.winner;
                        if (match.result?.sideSwap === true) {
                            evaluatedWinner = tip.winner === 'home' ? 'away' : 'home';
                        }
                        isCorrect = evaluatedWinner === match.result.winner;
                    }
                    
                    allTips.push({ isCorrect, date: match.date });
                }
            }
            
            // Seřazení podle data
            allTips.sort((a, b) => new Date(a.date) - new Date(b.date));
            
            // Výpočet sérií
            let longestWinStreak = 0;
            let longestLoseStreak = 0;
            let currentWinStreak = 0;
            let currentLoseStreak = 0;
            
            for (const tip of allTips) {
                if (tip.isCorrect) {
                    currentWinStreak++;
                    currentLoseStreak = 0;
                    longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
                } else {
                    currentLoseStreak++;
                    currentWinStreak = 0;
                    longestLoseStreak = Math.max(longestLoseStreak, currentLoseStreak);
                }
            }
            
            streakStats.push({
                username: user.username,
                longestWinStreak,
                longestLoseStreak
            });
        }
        
        // Seřazení podle nejdelší série výher
        streakStats.sort((a, b) => b.longestWinStreak - a.longestWinStreak);
        
        // Trendy v čase (úspěšnost podle měsíce)
        const monthlyStats = {};
        for (const user of users) {
            if (user.username === 'Admin') continue;
            // Přeskočit uživatele s 0 zápasy
            const userStat = userStats.find(u => u.username === user.username);
            if (!userStat || userStat.totalTips === 0) continue;
            const tips = user.tips?.[selectedSeason] || {};
            for (const league of Object.keys(tips)) {
                const leagueTips = tips[league] || [];
                for (const tip of leagueTips) {
                    const match = matches.find(m => m.id === tip.matchId);
                    if (!match?.result || !match.result.winner) continue;
                    
                    // Zkusíme různé pole pro datum
                    const matchDate = match.date || match.datetime || match.timestamp;
                    if (!matchDate) continue;
                    
                    const month = new Date(matchDate).toISOString().slice(0, 7); // YYYY-MM
                    if (!monthlyStats[month]) {
                        monthlyStats[month] = { total: 0, correct: 0 };
                    }
                    
                    monthlyStats[month].total++;
                    
                    let isCorrect = false;
                    if (match.isPlayoff && Number(match.bo) === 1) {
                        const realHome = Number(match.result.scoreHome ?? 0);
                        const realAway = Number(match.result.scoreAway ?? 0);
                        
                        // Získání tipovaného skóre - zkusíme různé názvy polí
                        let tipHome = 0;
                        let tipAway = 0;
                        
                        if (tip.scoreHome !== undefined && tip.scoreAway !== undefined) {
                            tipHome = Number(tip.scoreHome);
                            tipAway = Number(tip.scoreAway);
                        } else if (tip.scoreH !== undefined && tip.scoreA !== undefined) {
                            tipHome = Number(tip.scoreH);
                            tipAway = Number(tip.scoreA);
                        } else if (tip.homeGoals !== undefined && tip.awayGoals !== undefined) {
                            tipHome = Number(tip.homeGoals);
                            tipAway = Number(tip.awayGoals);
                        }
                        
                        if (match.result?.sideSwap === true) {
                            const temp = tipHome;
                            tipHome = tipAway;
                            tipAway = temp;
                        }
                        
                        if (!Number.isNaN(tipHome) && !Number.isNaN(tipAway)) {
                            const realOutcome = Math.sign(realHome - realAway);
                            const tipOutcome = Math.sign(tipHome - tipAway);
                            isCorrect = realOutcome === tipOutcome;
                        }
                    } else if (match.isPlayoff && Number(match.bo) > 1) {
                        const realWinner = match.result.winner;
                        const tipWinner = tip.winner;
                        isCorrect = tipWinner === realWinner;
                    } else {
                        let evaluatedWinner = tip.winner;
                        if (match.result?.sideSwap === true) {
                            evaluatedWinner = tip.winner === 'home' ? 'away' : 'home';
                        }
                        isCorrect = evaluatedWinner === match.result.winner;
                    }
                    
                    if (isCorrect) {
                        monthlyStats[month].correct++;
                    }
                }
            }
        }
        
        // Výpočet úspěšnosti pro měsíce
        for (const month in monthlyStats) {
            monthlyStats[month].successRate = monthlyStats[month].total > 0
                ? ((monthlyStats[month].correct / monthlyStats[month].total) * 100).toFixed(1)
                : 0;
        }

        // Statistiky podle dnů v týdnu
        const dayOfWeekStats = {
            0: { name: 'Neděle', total: 0, correct: 0 },
            1: { name: 'Pondělí', total: 0, correct: 0 },
            2: { name: 'Úterý', total: 0, correct: 0 },
            3: { name: 'Středa', total: 0, correct: 0 },
            4: { name: 'Čtvrtek', total: 0, correct: 0 },
            5: { name: 'Pátek', total: 0, correct: 0 },
            6: { name: 'Sobota', total: 0, correct: 0 }
        };

        for (const user of users) {
            if (user.username === 'Admin') continue;
            const tips = user.tips?.[selectedSeason] || {};
            for (const league of Object.keys(tips)) {
                const leagueTips = tips[league] || [];
                for (const tip of leagueTips) {
                    const match = matches.find(m => m.id === tip.matchId);
                    if (!match?.result || !match.result.winner) continue;

                    const matchDate = match.datetime || match.date;
                    if (!matchDate) continue;

                    const dayOfWeek = new Date(matchDate).getDay();
                    dayOfWeekStats[dayOfWeek].total++;

                    let isCorrect = false;
                    if (match.isPlayoff && Number(match.bo) === 1) {
                        // Playoff BO1
                        const tipHome = tip.scoreHome !== undefined ? tip.scoreHome : tip.home;
                        const tipAway = tip.scoreAway !== undefined ? tip.scoreAway : tip.away;
                        const realHome = match.result.home;
                        const realAway = match.result.away;

                        if (tipHome === realHome && tipAway === realAway) {
                            isCorrect = true;
                        } else {
                            const delta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
                            if (delta <= 3) isCorrect = true;
                        }
                    } else if (match.isPlayoff && Number(match.bo) > 1) {
                        // Playoff série
                        const tipWinner = tip.winner;
                        const realWinner = match.result.winner;
                        if (tipWinner === realWinner) isCorrect = true;
                    } else {
                        // Základní část
                        const tipWinner = tip.winner;
                        const realWinner = match.result.winner;
                        if (tipWinner === realWinner) isCorrect = true;
                    }

                    if (isCorrect) {
                        dayOfWeekStats[dayOfWeek].correct++;
                    }
                }
            }
        }

        // Výpočet úspěšnosti pro dny v týdnu
        for (const day in dayOfWeekStats) {
            dayOfWeekStats[day].successRate = dayOfWeekStats[day].total > 0
                ? ((dayOfWeekStats[day].correct / dayOfWeekStats[day].total) * 100).toFixed(1)
                : 0;
        }

        // Statistiky přesnosti tipů (jen playoff BO1 zápasy, které mají skóre)
        const tipAccuracyStats = {
            exact: 0,           // Přesně na skóre
            offBy1: 0,          // O 1 gól
            offBy2: 0,          // O 2 góly
            offBy3: 0,          // O 3 góly
            offByMore: 0,       // O více než 3 góly
            total: 0
        };

        for (const user of users) {
            if (user.username === 'Admin') continue;
            const tips = user.tips?.[selectedSeason] || {};
            for (const league of Object.keys(tips)) {
                const leagueTips = tips[league] || [];
                for (const tip of leagueTips) {
                    const match = matches.find(m => m.id === tip.matchId);
                    if (!match?.result || !match.result.winner) continue;

                    // Jen playoff BO1 zápasy (mají skóre)
                    if (!match.isPlayoff || Number(match.bo) !== 1) continue;

                    const tipHome = tip.scoreHome !== undefined ? tip.scoreHome : tip.home;
                    const tipAway = tip.scoreAway !== undefined ? tip.scoreAway : tip.away;
                    const realHome = match.result.scoreHome;
                    const realAway = match.result.scoreAway;

                    const totalDelta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
                    tipAccuracyStats.total++;

                    if (totalDelta === 0) {
                        tipAccuracyStats.exact++;
                    } else if (totalDelta === 1) {
                        tipAccuracyStats.offBy1++;
                    } else if (totalDelta === 2) {
                        tipAccuracyStats.offBy2++;
                    } else if (totalDelta === 3) {
                        tipAccuracyStats.offBy3++;
                    } else {
                        tipAccuracyStats.offByMore++;
                    }
                }
            }
        }

        // Trend výkonu v průběhu sezóny (moving average)
        const performanceTrend = [];
        const windowSize = 10; // Klouzavé okno 10 tipů

        for (const user of users) {
            if (user.username === 'Admin') continue;
            const tips = user.tips?.[selectedSeason] || {};
            const allTips = [];

            for (const league of Object.keys(tips)) {
                const leagueTips = tips[league] || [];
                for (const tip of leagueTips) {
                    const match = matches.find(m => m.id === tip.matchId);
                    if (!match?.result || !match.result.winner) continue;

                    let isCorrect = false;
                    if (match.isPlayoff && Number(match.bo) === 1) {
                        const tipHome = tip.scoreHome !== undefined ? tip.scoreHome : tip.home;
                        const tipAway = tip.scoreAway !== undefined ? tip.scoreAway : tip.away;
                        const realHome = match.result.home;
                        const realAway = match.result.away;

                        if (tipHome === realHome && tipAway === realAway) {
                            isCorrect = true;
                        } else {
                            const delta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
                            if (delta <= 3) isCorrect = true;
                        }
                    } else if (match.isPlayoff && Number(match.bo) > 1) {
                        const tipWinner = tip.winner;
                        const realWinner = match.result.winner;
                        if (tipWinner === realWinner) isCorrect = true;
                    } else {
                        const tipWinner = tip.winner;
                        const realWinner = match.result.winner;
                        if (tipWinner === realWinner) isCorrect = true;
                    }

                    allTips.push({
                        date: match.datetime || match.date,
                        correct: isCorrect ? 1 : 0
                    });
                }
            }

            // Seřazení podle data
            allTips.sort((a, b) => new Date(a.date) - new Date(b.date));

            // Výpočet moving average
            for (let i = windowSize - 1; i < allTips.length; i++) {
                const window = allTips.slice(i - windowSize + 1, i + 1);
                const avg = window.reduce((sum, t) => sum + t.correct, 0) / windowSize;
                performanceTrend.push({
                    date: allTips[i].date,
                    username: user.username,
                    movingAverage: (avg * 100).toFixed(1)
                });
            }
        }

        // Seřazení podle data
        performanceTrend.sort((a, b) => new Date(a.date) - new Date(b.date));

        // Sezónní porovnání
        const seasonComparison = {};
        const allSeasons = Object.keys(users[0]?.tips || {}).sort();

        for (const season of allSeasons) {
            const seasonStats = {
                totalTips: 0,
                totalCorrect: 0,
                users: {}
            };

            for (const user of users) {
                if (user.username === 'Admin') continue;
                const userSeasonStats = user.stats?.[season] || {};
                let userTotalCorrect = 0;
                let userTotalTips = 0;

                for (const league of Object.keys(userSeasonStats)) {
                    const leagueStats = userSeasonStats[league] || {};
                    userTotalCorrect += leagueStats.correct || 0;
                    userTotalTips += (leagueStats.totalRegular || 0) + (leagueStats.totalPlayoff || 0);
                }

                seasonStats.totalTips += userTotalTips;
                seasonStats.totalCorrect += userTotalCorrect;
                seasonStats.users[user.username] = {
                    totalCorrect: userTotalCorrect,
                    totalTips: userTotalTips,
                    successRate: userTotalTips > 0 ? ((userTotalCorrect / userTotalTips) * 100).toFixed(1) : 0
                };
            }

            seasonStats.avgSuccessRate = seasonStats.totalTips > 0
                ? ((seasonStats.totalCorrect / seasonStats.totalTips) * 100).toFixed(1)
                : 0;

            seasonComparison[season] = seasonStats;
        }

        // Porovnání uživatele s průměrem
        const userComparison = currentUserStats ? {
            successRateDiff: (currentUserStats.successRate - parseFloat(appStats.avgSuccessRate)).toFixed(1),
            totalCorrectDiff: currentUserStats.totalCorrect - (appStats.totalCorrect / (appStats.totalUsers || 1)).toFixed(0),
            totalTipsDiff: currentUserStats.totalTips - (appStats.totalTips / (appStats.totalUsers || 1)).toFixed(0),
            isAboveAverage: currentUserStats.successRate > parseFloat(appStats.avgSuccessRate),
            rankPercentile: ((currentUserRank / userStats.length) * 100).toFixed(0)
        } : null;
        
        // Detailní statistiky pro aktuálního uživatele (průměrné skóre, odchylka)
        let detailedStats = null;
        if (currentUserStats) {
            const currentUser = users.find(u => u.username === username);
            if (currentUser) {
                let totalMatches = 0;
                
                // Základní část
                let regularScoreHome = 0;
                let regularScoreAway = 0;
                let regularMatches = 0;
                let regularDeviation = 0;
                
                // Playoff BO1
                let bo1ScoreHome = 0;
                let bo1ScoreAway = 0;
                let bo1Matches = 0;
                let bo1Deviation = 0;
                
                // Playoff série
                let seriesMatches = 0;
                
                const tips = currentUser.tips?.[selectedSeason] || {};
                for (const league of Object.keys(tips)) {
                    const leagueTips = tips[league] || [];
                    for (const tip of leagueTips) {
                        const match = matches.find(m => m.id === tip.matchId);
                        if (!match?.result || !match.result.winner) continue;
                        
                        if (match.isPlayoff && Number(match.bo) === 1) {
                            // BO1
                            bo1Matches++;
                            const realHome = Number(match.result.scoreHome ?? 0);
                            const realAway = Number(match.result.scoreAway ?? 0);
                            let tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                            let tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);
                            
                            if (match.result?.sideSwap === true) {
                                const temp = tipHome;
                                tipHome = tipAway;
                                tipAway = temp;
                            }
                            
                            if (!Number.isNaN(tipHome) && !Number.isNaN(tipAway)) {
                                bo1ScoreHome += tipHome;
                                bo1ScoreAway += tipAway;
                                bo1Deviation += Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
                            }
                        } else if (match.isPlayoff && Number(match.bo) > 1) {
                            // Série
                            seriesMatches++;
                        } else {
                            // Základní část - tipuje se jen vítěz, ne skóre
                            regularMatches++;
                            totalMatches++;
                            
                            // V základní části se nepočítá skóre, jen vítěz
                            // Takže zde nepřidáváme žádné skóre do statistik
                        }
                    }
                }
                
                detailedStats = {
                    regular: {
                        avgScoreHome: regularMatches > 0 ? (regularScoreHome / regularMatches).toFixed(2) : 0,
                        avgScoreAway: regularMatches > 0 ? (regularScoreAway / regularMatches).toFixed(2) : 0,
                        avgDeviation: regularMatches > 0 ? (regularDeviation / regularMatches).toFixed(2) : 0,
                        totalMatches: regularMatches
                    },
                    playoffBO1: {
                        avgScoreHome: bo1Matches > 0 ? (bo1ScoreHome / bo1Matches).toFixed(2) : 0,
                        avgScoreAway: bo1Matches > 0 ? (bo1ScoreAway / bo1Matches).toFixed(2) : 0,
                        avgDeviation: bo1Matches > 0 ? (bo1Deviation / bo1Matches).toFixed(2) : 0,
                        totalMatches: bo1Matches
                    },
                    playoffSeries: {
                        totalMatches: seriesMatches
                    }
                };
            }
        }
        
        const data = {
            username,
            selectedSeason,
            availableSeasons: Object.keys(users[0]?.tips || {}).sort().reverse(),
            userStats,
            currentUserStats,
            currentUserRank,
            appStats,
            leagueStats,
            monthlyStats,
            dayOfWeekStats,
            tipAccuracyStats,
            performanceTrend,
            seasonComparison,
            streakStats,
            userComparison,
            detailedStats,
            leagues
        };
        
        // Pokud je to API request, vrátíme JSON
        if (req.headers.accept === 'application/json') {
            return res.json(data);
        }
        
        // Jinak vyrenderujeme HTML stránku
        const { availableSeasons } = data;
        
        let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Statistiky - Tipovačka</title>
<link rel="stylesheet" href="/css/styles.css" />
<style>
    .highlight-row {
        background-color: rgba(0, 212, 255, 0.2) !important;
        font-weight: bold;
    }
    .charts-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 20px;
    }
    @media (max-width: 768px) {
        .charts-grid {
            grid-template-columns: 1fr;
        }
    }
</style>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"></script>
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
<body class="usersite" style="justify-content: center">
<header class="header">
<div class="header-main">
<div class="logo_title">
    <img alt="Logo" class="image_logo" src="/images/logo.png">
    <h1 id="title">Statistiky</h1>
</div>
<div class="header-user">
    <p id="logged_user">Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a></p>
</div>
</div>
<div class="header-controls">
<form class="league-dropdown" method="GET">
<a class="history-btn" href="/history">Historie</a>
<a class="history-btn changed" href="/">Tipovačka</a>
<a class="history-btn changed" href="/table-tip">Základní část</a>
<a class="history-btn changed" href="/prestupy">Přestupy</a>
<a class="history-btn changed" href="/image-exporter">Exportér</a>
<div style="text-align: center; margin: 0;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()"
        style="width: 220px; height: 38px; cursor: pointer; font-weight: bold; border: none; color: white; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
<input type="hidden" id="globalCsrfToken" value="${req.session.csrfToken || ''}">
</form>
</div>
</header>
<header class="time-header">${await generateTimeWidget()}<a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" style="position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 0.75em; color: #666; text-decoration: none; cursor: pointer; opacity: 0.7; transition: opacity 0.3s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">v<span id="current-version">...</span></a></header>

<main class="stats-container" style="margin: 10px; width: 95%; ">
    <div class="stats-header">
        <h2>Statistiky tipovačka - ${selectedSeason}</h2>
        <div style="margin-bottom: 10px;">
            <label for="season-select" style="color: #aaa; margin-right: 10px;">Vyber sezónu:</label>
            <select id="season-select" onchange="window.location.href='/statistics?season=' + this.value" style="padding: 5px; border: 1px solid #444; background: #222; color: #fff;">
                ${availableSeasons.map(season => `
                    <option value="${season}" ${season === selectedSeason ? 'selected' : ''}>${season}</option>
                `).join('')}
            </select>
        </div>
        <p style="color: #aaa;">Komplexní přehled výkonů všech uživatelů</p>
    </div>
    
    <div class="stats-overview">
        <div class="stat-card">
            <h3>Celkem uživatelů</h3>
            <p class="value">${appStats.totalUsers}</p>
            <p class="label">Aktivních tipujících</p>
        </div>
        <div class="stat-card">
            <h3>Celkem lig</h3>
            <p class="value">${appStats.totalLeagues}</p>
            <p class="label">V sezóně ${selectedSeason}</p>
        </div>
        <div class="stat-card">
            <h3>Celkem tipů</h3>
            <p class="value">${appStats.totalTips}</p>
            <p class="label">Základní část + playoff</p>
        </div>
        <div class="stat-card">
            <h3>Průměrná úspěšnost</h3>
            <p class="value">${appStats.avgSuccessRate}%</p>
            <p class="label">Napříč všemi uživateli</p>
        </div>
    </div>
    
    <div class="charts-section">
        <div class="chart-container">
            <h3>Žebříček uživatelů podle bodů</h3>
            <canvas id="rankingChart"></canvas>
        </div>
        <div class="chart-container">
            <h3>Úspěšnost tipů (%)</h3>
            <canvas id="successRateChart"></canvas>
        </div>
    </div>
    
    <div class="chart-container">
        <h3>Podrobný žebříček uživatelů</h3>
        <table class="user-table">
            <thead>
                <tr>
                    <th title="Pořadí v žebříčku">#</th>
                    <th title="Jméno uživatele">Uživatel</th>
                    <th title="Celkový počet správně tipovaných zápasů">Celkem bodů</th>
                    <th title="Základní část - počet správných/celek (úspěšnost)">Základní část</th>
                    <th title="Playoff BO1 - počet správných/celek (úspěšnost)">Playoff BO1</th>
                    <th title="Playoff série - počet správných/celek (úspěšnost)">Playoff série</th>
                    <th title="Tabulka - počet správně tipovaných pozic">Tabulka (trefený pozice)</th>
                    <th title="Počet lig, ve kterých uživatel tipuje">Ligy</th>
                </tr>
            </thead>
            <tbody>
                ${userStats.map((user, index) => `
                    <tr class="${user.username === username ? 'current-user' : ''}">
                        <td><span class="rank-badge rank-${index + 1}">${index + 1}</span></td>
                        <td><strong>${user.username}</strong>${user.username === username ? ' (ty)' : ''}</td>
                        <td>${user.totalCorrect}</td>
                        <td>${user.totalRegularCorrect}/${user.totalRegular} (${user.regularSuccessRate}%)</td>
                        <td>${user.totalPlayoffBO1Correct}/${user.totalPlayoffBO1Tips} (${user.playoffBO1SuccessRate}%)</td>
                        <td>${user.totalPlayoffBOSeriesCorrect}/${user.totalPlayoffBOSeriesTips} (${user.playoffBOSeriesSuccessRate}%)</td>
                        <td>${user.totalTableCorrect}</td>
                        <td>${user.leagueCount} lig</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>
    
    ${currentUserStats ? `
    <div class="chart-container" style="margin-top: 30px;">
        <h3>Tvé statistiky - ${username} (pořadí: ${currentUserRank}.)</h3>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px;">
            <div class="stat-card">
                <h3>Celkem bodů</h3>
                <p class="value">${currentUserStats.totalCorrect}</p>
                <p class="label">${currentUserStats.totalCorrect}/${currentUserStats.totalTips} tipů</p>
            </div>
            <div class="stat-card">
                <h3>Základní část</h3>
                <p class="value">${currentUserStats.totalRegularCorrect}/${currentUserStats.totalRegular}</p>
                <p class="label">Úspěšnost: ${currentUserStats.regularSuccessRate}%</p>
            </div>
            <div class="stat-card">
                <h3>Playoff BO1</h3>
                <p class="value">${currentUserStats.totalPlayoffBO1Correct}/${currentUserStats.totalPlayoffBO1Tips}</p>
                <p class="label">Úspěšnost: ${currentUserStats.playoffBO1SuccessRate}%</p>
            </div>
            <div class="stat-card">
                <h3>Playoff série</h3>
                <p class="value">${currentUserStats.totalPlayoffBOSeriesCorrect}/${currentUserStats.totalPlayoffBOSeriesTips}</p>
                <p class="label">Úspěšnost: ${currentUserStats.playoffBOSeriesSuccessRate}%</p>
            </div>
        </div>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 20px;">
            <div class="stat-card">
                <h3>Tabulka správně</h3>
                <p class="value">${currentUserStats.totalTableCorrect}</p>
                <p class="label">Z ${currentUserStats.leagueCount} lig</p>
            </div>
            <div class="stat-card">
                <h3>Celková úspěšnost</h3>
                <p class="value">${currentUserStats.successRate}%</p>
                <p class="label">Z ${currentUserStats.totalTips} tipů</p>
            </div>
        </div>
    </div>
    ` : ''}
    
    <div class="chart-container" style="margin-top: 30px;">
        <h3>Nejdelší série tipů</h3>
        <p style="color: #888; margin-bottom: 15px;">Nejdelší série správných a špatných tipů za sebou</p>
        <table class="user-table">
            <thead>
                <tr>
                    <th title="Pořadí v žebříčku">#</th>
                    <th title="Jméno uživatele">Uživatel</th>
                    <th title="Nejdelší série správných tipů za sebou">Nejdelší série výher</th>
                    <th title="Nejdelší série špatných tipů za sebou">Nejdelší série proher</th>
                </tr>
            </thead>
            <tbody>
                ${streakStats.map((user, index) => `
                    <tr class="${user.username === username ? 'current-user' : ''}">
                        <td><span class="rank-badge rank-${index + 1}">${index + 1}</span></td>
                        <td><strong>${user.username}</strong>${user.username === username ? ' (ty)' : ''}</td>
                        <td class="success-rate">${user.longestWinStreak}</td>
                        <td>${user.longestLoseStreak}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>
    
    ${userComparison ? `
    <div class="chart-container" style="margin-top: 30px;">
        <h3>Porovnání s průměrem</h3>
        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px;">
            <div class="stat-card">
                <h3>Úspěšnost vs průměr</h3>
                <p class="value ${userComparison.isAboveAverage ? 'success-rate' : ''}">${userComparison.successRateDiff > 0 ? '+' : ''}${userComparison.successRateDiff}%</p>
                <p class="label">${userComparison.isAboveAverage ? 'Nad průměrem' : 'Pod průměrem'}</p>
            </div>
            <div class="stat-card">
                <h3>Percentilové pořadí</h3>
                <p class="value">${userComparison.rankPercentile}%</p>
                <p class="label">Jsi lepší než ${userComparison.rankPercentile}% uživatelů</p>
            </div>
        </div>
    </div>
    ` : ''}
    
    ${detailedStats ? `
    <div class="chart-container" style="margin-top: 30px;">
        <h3>Detailní statistiky tipování</h3>
        <h4>Základní část</h4>
        <div style="display: grid; grid-template-columns: repeat(1, 1fr); gap: 20px; margin-bottom: 20px;">
            <div class="stat-card">
                <h3>Celkem zápasů</h3>
                <p class="value">${detailedStats.regular.totalMatches}</p>
                <p class="label">V základní části se tipuje jen vítěz zápasu</p>
            </div>
        </div>
        <h4>Playoff BO1</h4>
        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-bottom: 20px;">
            <div class="stat-card">
                <h3>Průměrné skóre domácí</h3>
                <p class="value">${detailedStats.playoffBO1.avgScoreHome}</p>
                <p class="label">Z ${detailedStats.playoffBO1.totalMatches} zápasů</p>
            </div>
            <div class="stat-card">
                <h3>Průměrné skóre hosté</h3>
                <p class="value">${detailedStats.playoffBO1.avgScoreAway}</p>
                <p class="label">Z ${detailedStats.playoffBO1.totalMatches} zápasů</p>
            </div>
            <div class="stat-card">
                <h3>Průměrná odchylka</h3>
                <p class="value">${detailedStats.playoffBO1.avgDeviation}</p>
                <p class="label">Od skutečného výsledku</p>
            </div>
        </div>
        <h4>Playoff série</h4>
        <div style="display: grid; grid-template-columns: repeat(1, 1fr); gap: 20px;">
            <div class="stat-card">
                <h3>Celkem zápasů</h3>
                <p class="value">${detailedStats.playoffSeries.totalMatches}</p>
                <p class="label">V sériích se tipuje počet prohraných zápasů</p>
            </div>
        </div>
    </div>
    ` : ''}
    
    <div class="chart-container" style="margin-top: 30px;">
        <h3>Statistiky podle lig</h3>
        <p style="color: #888; margin-bottom: 15px;">Statistiky pro každou ligu zvlášť (úspěšnost uživatelů v dané lize)</p>
        <table class="user-table">
            <thead>
                <tr>
                    <th title="Název ligy">Liga</th>
                    <th title="Počet uživatelů, kteří tipují v této lize">Uživatelů</th>
                    <th title="Průměrná úspěšnost všech uživatelů v této lize">Průměrná úspěšnost</th>
                    <th title="Celkový počet tipů v této lize">Celkem tipů</th>
                    <th title="Uživatel s nejvyšší úspěšností v této lize">Nejlepší uživatel</th>
                    <th title="Uživatel s nejnižší úspěšností v této lize">Nejhorší uživatel</th>
                </tr>
            </thead>
            <tbody>
                ${Object.keys(leagueStats).map(league => `
                    <tr>
                        <td><strong>${league}</strong></td>
                        <td>${leagueStats[league].users}</td>
                        <td class="success-rate">${leagueStats[league].avgSuccessRate}%</td>
                        <td>${leagueStats[league].totalTips}</td>
                        <td>${leagueStats[league].bestUser || '-'}</td>
                        <td>${leagueStats[league].worstUser || '-'}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>

    <div class="charts-grid" style="margin-top: 30px;">
        <div class="chart-container">
            <h3>Statistiky podle dnů v týdnu</h3>
            <p style="color: #888; margin-bottom: 15px;">V jaké dny tipuješ lépe</p>
            <canvas id="dayOfWeekChart"></canvas>
        </div>

        <div class="chart-container">
            <h3>Statistiky podle typu zápasu</h3>
            <p style="color: #888; margin-bottom: 15px;">Rozdělení úspěšnosti podle typu zápasu (Základní část vs Playoff)</p>
            <canvas id="matchTypeChart"></canvas>
        </div>

        <div class="chart-container">
            <h3>Statistiky přesnosti tipů</h3>
            <p style="color: #888; margin-bottom: 15px;">Jak přesné jsou tipy (přesně na skóre, o 1 gól, atd.)</p>
            <canvas id="tipAccuracyChart"></canvas>
        </div>

        <div class="chart-container">
            <h3>Distribuce úspěšnosti</h3>
            <p style="color: #888; margin-bottom: 15px;">Kolik uživatelů má jakou úspěšnost (tvá úspěšnost: ${currentUserStats?.successRate || 0}%)</p>
            <canvas id="distributionChart"></canvas>
        </div>
    </div>

    <div class="charts-grid" style="margin-top: 30px;">
        <div class="chart-container">
            <h3>Heatmapa úspěšnosti podle lig</h3>
        <p style="color: #888; margin-bottom: 15px;">Matice zobrazující úspěšnost každého uživatele v každé lize</p>
        <table class="user-table">
            <thead>
                <tr>
                    <th title="Jméno uživatele">Uživatel</th>
                    ${Array.from(allLeaguesInStats).map(league => `<th title="${league}">${league}</th>`).join('')}
                </tr>
            </thead>
            <tbody>
                ${userStats.map(user => `
                    <tr class="${user.username === username ? 'current-user' : ''}">
                        <td><strong>${user.username}</strong>${user.username === username ? ' (ty)' : ''}</td>
                        ${Array.from(allLeaguesInStats).map(league => {
                            const data = leagueHeatmapData[user.username]?.[league];
                            if (!data) return '<td style="background-color: #333;">-</td>';
                            const intensity = Math.min(data.successRate / 100, 1);
                            const bgColor = `rgba(0, 212, 255, ${intensity * 0.8})`;
                            return `<td style="background-color: ${bgColor};">${data.successRate}%</td>`;
                        }).join('')}
                    </tr>
                `).join('')}
            </tbody>
        </table>
    </div>

        <div class="chart-container">
            <h3>Porovnání úspěšnosti v ligách</h3>
            <p style="color: #888; margin-bottom: 15px;">Srovnání úspěšnosti uživatelů v jednotlivých ligách</p>
            <canvas id="leagueComparisonChart"></canvas>
        </div>

        <div class="chart-container">
            <h3>Trend výkonu v průběhu sezóny</h3>
            <p style="color: #888; margin-bottom: 15px;">Klouzavý průměr úspěšnosti (okno 10 tipů)</p>
            <canvas id="performanceTrendChart"></canvas>
        </div>

        <div class="chart-container">
            <h3>Sezónní porovnání</h3>
            <p style="color: #888; margin-bottom: 15px;">Jak se uživatel zlepšuje mezi sezónami</p>
            <canvas id="seasonComparisonChart"></canvas>
        </div>

        <div class="chart-container">
            <h3>Trendy v čase (úspěšnost podle měsíce)</h3>
            <p style="color: #888; margin-bottom: 15px;">Vývoj úspěšnosti v průběhu sezóny podle měsíců</p>
            <canvas id="monthlyTrendChart"></canvas>
        </div>
    </div>
</main>

<script>
// Registrace chartjs-plugin-datalabels
Chart.register(ChartDataLabels);

// Převod klíče
function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

async function toggleNotifications() {
    const btn = document.getElementById('notify-toggle-btn');
    if (!btn) return;
    
    btn.disabled = true;
    btn.textContent = "Pracuji...";

    try {
        let registration = await navigator.serviceWorker.getRegistration();
        
        if (!registration) {
            registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        }

        let retry = 0;
        while (!registration.active && retry < 10) {
            await new Promise(res => setTimeout(res, 500));
            registration = await navigator.serviceWorker.getRegistration();
            retry++;
        }

        if (!registration.active) {
            alert("Service Worker se nepodařilo aktivovat.");
            btn.disabled = false;
            await checkSubscriptionStatus();
            return;
        }

        const subscription = await registration.pushManager.getSubscription();

        if (subscription) {
            // ODHLÁŠENÍ
            const res = await fetch('/api/unsubscribe', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': '${req.session.csrfToken || ''}'
                },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            if (res.ok) {
                await subscription.unsubscribe();
                alert('Notifikace vypnuty.');
                await checkSubscriptionStatus();
            }
        } else {
            // PŘIHLÁŠENÍ
            const vapidRes = await fetch('/api/vapid-public-key');
            if (!vapidRes.ok) {
                alert('Server neodpovídá (chyba při získávání klíče).');
                btn.disabled = false;
                await checkSubscriptionStatus();
                return;
            }
            const vapidPublicKey = await vapidRes.text();

            const newSub = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
            });

            const saveRes = await fetch('/api/subscribe', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': '${req.session.csrfToken || ''}'
                },
                body: JSON.stringify(newSub)
            });
            
            if (saveRes.ok) {
                alert('Notifikace zapnuty!');
                await checkSubscriptionStatus();
            } else {
                alert('Nepodařilo se uložit odběr na server.');
            }
        }
    } catch (e) {
        console.error("Kritická chyba notifikací:", e);
        alert('Došlo k nečekané chybě: ' + e.message);
    }
    
    await checkSubscriptionStatus();
    btn.disabled = false;
}

async function checkSubscriptionStatus() {
    const btn = document.getElementById('notify-toggle-btn');
    if (!btn) return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        btn.textContent = "Nepodporováno";
        btn.disabled = true;
        return;
    }

    try {
        // Kontrola stavu bez zbytečného čekání
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = registration ? await registration.pushManager.getSubscription() : null;

        if (subscription) {
            btn.textContent = "Vypnout notifikace 🔕";
            btn.style.backgroundColor = "#555";
        } else {
            btn.textContent = "Zapnout notifikace 🔔";
            btn.style.backgroundColor = "#ff4500";
        }
    } catch (e) {
        btn.textContent = "Klikni pro stav";
    }
}

document.addEventListener('DOMContentLoaded', checkSubscriptionStatus);

    // Data pro grafy
    const userStats = ${JSON.stringify(userStats)};
    
    // Graf žebříčku podle bodů
    const rankingCtx = document.getElementById('rankingChart').getContext('2d');
    new Chart(rankingCtx, {
        type: 'bar',
        data: {
            labels: userStats.map(u => u.username),
            datasets: [{
                label: 'Celkem bodů',
                data: userStats.map(u => u.totalCorrect),
                backgroundColor: userStats.map(u => u.username === '${username}' ? 'rgba(255, 69, 0, 0.8)' : 'rgba(0, 212, 255, 0.6)'),
                borderColor: userStats.map(u => u.username === '${username}' ? 'rgba(255, 69, 0, 1)' : 'rgba(0, 212, 255, 1)'),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                datalabels: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                },
                x: {
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                }
            }
        }
    });
    
    // Graf úspěšnosti
    const successRateCtx = document.getElementById('successRateChart').getContext('2d');
    new Chart(successRateCtx, {
        type: 'line',
        data: {
            labels: userStats.map(u => u.username),
            datasets: [{
                label: 'Úspěšnost (%)',
                data: userStats.map(u => u.successRate),
                borderColor: '#ff4500',
                backgroundColor: 'rgba(255, 69, 0, 0.2)',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                datalabels: {
                    display: false
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: { 
                        color: '#fff',
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    grid: { color: '#444' }
                },
                x: {
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                }
            }
        }
    });

    // Graf statistik přesnosti tipů (pie chart)
    const tipAccuracyCtx = document.getElementById('tipAccuracyChart').getContext('2d');
    const tipAccuracyData = ${JSON.stringify(tipAccuracyStats)};
    const tipAccuracyLabels = ['Přesně na skóre', 'O 1 gól', 'O 2 góly', 'O 3 góly', 'O více gólů'];
    const tipAccuracyValues = [tipAccuracyData.exact, tipAccuracyData.offBy1, tipAccuracyData.offBy2, tipAccuracyData.offBy3, tipAccuracyData.offByMore];

    new Chart(tipAccuracyCtx, {
        type: 'pie',
        data: {
            labels: tipAccuracyLabels,
            datasets: [{
                data: tipAccuracyValues,
                backgroundColor: [
                    'rgba(0, 212, 255, 0.7)',
                    'rgba(54, 162, 235, 0.7)',
                    'rgba(255, 206, 86, 0.7)',
                    'rgba(255, 99, 132, 0.7)',
                    'rgba(153, 102, 255, 0.7)'
                ],
                borderColor: [
                    'rgba(0, 212, 255, 1)',
                    'rgba(54, 162, 235, 1)',
                    'rgba(255, 206, 86, 1)',
                    'rgba(255, 99, 132, 1)',
                    'rgba(153, 102, 255, 1)'
                ],
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#fff' }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((context.raw / total) * 100).toFixed(1);
                            return context.label + ': ' + context.raw + ' (' + percentage + '%)';
                        }
                    }
                },
                datalabels: {
                    display: true,
                    formatter: (value, ctx) => {
                        const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                        const percentage = ((value / total) * 100).toFixed(1);
                        return percentage + '%';
                    },
                    color: '#fff',
                    font: {
                        weight: 'bold',
                        size: 14
                    }
                }
            }
        }
    });

    // Graf porovnání úspěšnosti v ligách (grouped bar chart)
    const leagueComparisonCtx = document.getElementById('leagueComparisonChart').getContext('2d');
    const leagues = ${JSON.stringify(Array.from(allLeaguesInStats))};
    const users = ${JSON.stringify(userStats.map(u => u.username))};
    const leagueHeatmapData = ${JSON.stringify(leagueHeatmapData)};

    const datasets = users.map((username, index) => {
        const colors = [
            'rgba(0, 212, 255, 0.7)',
            'rgba(255, 99, 132, 0.7)',
            'rgba(54, 162, 235, 0.7)',
            'rgba(255, 206, 86, 0.7)',
            'rgba(75, 192, 192, 0.7)',
            'rgba(153, 102, 255, 0.7)'
        ];
        const color = colors[index % colors.length];

        return {
            label: username,
            data: leagues.map(league => leagueHeatmapData[username]?.[league]?.successRate || 0),
            backgroundColor: color,
            borderColor: color.replace('0.7', '1'),
            borderWidth: 1
        };
    });

    new Chart(leagueComparisonCtx, {
        type: 'bar',
        data: {
            labels: leagues,
            datasets: datasets
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    grid: { color: '#444' }
                },
                x: {
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                datalabels: {
                    display: false
                }
            }
        }
    });

    // Graf distribuce úspěšnosti (bar chart)
    const distributionCtx = document.getElementById('distributionChart').getContext('2d');
    const distributionLabels = ${JSON.stringify(Object.keys(appStats.successRateDistribution))};
    const distributionData = ${JSON.stringify(Object.values(appStats.successRateDistribution))};
    const currentUserSuccessRate = ${currentUserStats?.successRate || 0};

    // Najdeme index binu, kde se nachází uživatel
    let currentUserBinIndex = -1;
    for (let i = 0; i < distributionLabels.length; i++) {
        const range = distributionLabels[i];
        const min = parseInt(range.split('-')[0]);
        const max = parseInt(range.split('-')[1]);
        if (currentUserSuccessRate >= min && currentUserSuccessRate < max) {
            currentUserBinIndex = i;
            break;
        }
    }

    const backgroundColors = distributionData.map((_, index) =>
        index === currentUserBinIndex ? 'rgba(0, 212, 255, 0.8)' : 'rgba(100, 100, 100, 0.6)'
    );

    new Chart(distributionCtx, {
        type: 'bar',
        data: {
            labels: distributionLabels,
            datasets: [{
                label: 'Počet uživatelů',
                data: distributionData,
                backgroundColor: backgroundColors,
                borderColor: backgroundColors.map(color => color.replace('0.6', '1').replace('0.8', '1')),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                },
                x: {
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                datalabels: {
                    display: false
                }
            }
        }
    });

    // Graf trendu výkonu v průběhu sezóny (line chart)
    const performanceTrendCtx = document.getElementById('performanceTrendChart').getContext('2d');
    const performanceTrendData = ${JSON.stringify(performanceTrend)};

    // Seskupení dat podle data a průměrná hodnota
    const trendByDate = {};
    performanceTrendData.forEach(point => {
        const date = new Date(point.date).toISOString().slice(0, 10);
        if (!trendByDate[date]) {
            trendByDate[date] = { total: 0, count: 0 };
        }
        trendByDate[date].total += parseFloat(point.movingAverage);
        trendByDate[date].count++;
    });

    const trendLabels = Object.keys(trendByDate).sort();
    const trendValues = trendLabels.map(date => (trendByDate[date].total / trendByDate[date].count).toFixed(1));

    new Chart(performanceTrendCtx, {
        type: 'line',
        data: {
            labels: trendLabels,
            datasets: [{
                label: 'Klouzavý průměr úspěšnosti (%)',
                data: trendValues,
                borderColor: 'rgba(0, 212, 255, 1)',
                backgroundColor: 'rgba(0, 212, 255, 0.1)',
                borderWidth: 2,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    grid: { color: '#444' }
                },
                x: {
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                datalabels: {
                    display: false
                }
            }
        }
    });

    // Graf statistik podle dnů v týdnu (bar chart)
    const dayOfWeekCtx = document.getElementById('dayOfWeekChart').getContext('2d');
    const dayOfWeekLabels = ${JSON.stringify(Object.values(dayOfWeekStats).map(d => d.name))};
    const dayOfWeekRates = ${JSON.stringify(Object.values(dayOfWeekStats).map(d => parseFloat(d.successRate)))};
    const dayOfWeekTotals = ${JSON.stringify(Object.values(dayOfWeekStats).map(d => d.total))};

    // Změna pořadí dnů: pondělí až neděle
    const dayOrder = [1, 2, 3, 4, 5, 6, 0]; // Pondělí až Neděle
    const orderedLabels = dayOrder.map(i => dayOfWeekLabels[i]);
    const orderedRates = dayOrder.map(i => dayOfWeekRates[i]);
    const orderedTotals = dayOrder.map(i => dayOfWeekTotals[i]);

    new Chart(dayOfWeekCtx, {
        type: 'bar',
        data: {
            labels: orderedLabels,
            datasets: [{
                label: 'Úspěšnost (%)',
                data: orderedRates,
                backgroundColor: orderedTotals.map(total => total > 0 ? 'rgba(0, 212, 255, 0.7)' : 'rgba(100, 100, 100, 0.3)'),
                borderColor: orderedTotals.map(total => total > 0 ? 'rgba(0, 212, 255, 1)' : 'rgba(100, 100, 100, 0.5)'),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    grid: { color: '#444' }
                },
                x: {
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                datalabels: {
                    display: false
                }
            }
        }
    });

    // Graf statistik podle typu zápasu (radar chart)
    const matchTypeCtx = document.getElementById('matchTypeChart').getContext('2d');
    new Chart(matchTypeCtx, {
        type: 'radar',
        data: {
            labels: ['Základní část', 'Playoff BO1', 'Playoff série', 'Tipování tabulky'],
            datasets: [{
                label: 'Úspěšnost (%)',
                data: [
                    ${currentUserStats?.regularSuccessRate || 0},
                    ${currentUserStats?.playoffBO1SuccessRate || 0},
                    ${currentUserStats?.playoffBOSeriesSuccessRate || 0},
                    ${currentUserStats?.tableSuccessRate || 0}
                ],
                backgroundColor: 'rgba(0, 212, 255, 0.2)',
                borderColor: 'rgba(0, 212, 255, 1)',
                borderWidth: 2,
                pointBackgroundColor: 'rgba(0, 212, 255, 1)',
                pointBorderColor: '#fff',
                pointHoverBackgroundColor: '#fff',
                pointHoverBorderColor: 'rgba(0, 212, 255, 1)'
            }]
        },
        options: {
            responsive: true,
            scales: {
                r: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                        color: '#fff',
                        backdropColor: 'transparent',
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    grid: { color: '#444' },
                    angleLines: { color: '#444' },
                    pointLabels: { color: '#fff' }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                datalabels: {
                    display: false
                }
            }
        }
    });

    // Graf sezónního porovnání (line chart)
    const seasonComparisonCtx = document.getElementById('seasonComparisonChart').getContext('2d');
    const seasonComparisonData = ${JSON.stringify(seasonComparison)};
    const seasonLabels = Object.keys(seasonComparisonData).sort();

    // Vytvoření datasetů pro každého uživatele
    const seasonDatasets = [];
    const colors = [
        'rgba(0, 212, 255, 1)',
        'rgba(255, 99, 132, 1)',
        'rgba(54, 162, 235, 1)',
        'rgba(255, 206, 86, 1)',
        'rgba(75, 192, 192, 1)',
        'rgba(153, 102, 255, 1)'
    ];

    let colorIndex = 0;
    for (const user of userStats) {
        const userSeasonData = seasonLabels.map(season => {
            return seasonComparisonData[season]?.users[user.username]?.successRate || 0;
        });

        seasonDatasets.push({
            label: user.username,
            data: userSeasonData,
            borderColor: colors[colorIndex % colors.length],
            backgroundColor: colors[colorIndex % colors.length].replace('1', '0.1'),
            borderWidth: 2,
            tension: 0.4
        });
        colorIndex++;
    }

    new Chart(seasonComparisonCtx, {
        type: 'line',
        data: {
            labels: seasonLabels,
            datasets: seasonDatasets
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    grid: { color: '#444' }
                },
                x: {
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                datalabels: {
                    display: false
                }
            }
        }
    });

    // Graf trendů v čase (úspěšnost podle měsíce - line chart)
    const monthlyTrendCtx = document.getElementById('monthlyTrendChart').getContext('2d');
    const monthlyStatsData = ${JSON.stringify(monthlyStats)};
    const monthLabels = Object.keys(monthlyStatsData).sort();
    const monthRates = monthLabels.map(month => parseFloat(monthlyStatsData[month].successRate));

    new Chart(monthlyTrendCtx, {
        type: 'line',
        data: {
            labels: monthLabels,
            datasets: [{
                label: 'Úspěšnost (%)',
                data: monthRates,
                borderColor: 'rgba(0, 212, 255, 1)',
                backgroundColor: 'rgba(0, 212, 255, 0.1)',
                borderWidth: 2,
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    max: 100,
                    ticks: {
                        color: '#fff',
                        callback: function(value) {
                            return value + '%';
                        }
                    },
                    grid: { color: '#444' }
                },
                x: {
                    ticks: { color: '#fff' },
                    grid: { color: '#444' }
                }
            },
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                datalabels: {
                    display: false
                }
            }
        }
    });

    // Fetch and display version
    fetch('/api/version')
        .then(res => res.json())
        .then(data => {
            const versionBadge = document.getElementById('current-version');
            if (versionBadge) {
                versionBadge.textContent = data.version;
            }
        })
        .catch(err => console.error('Failed to fetch version:', err));
</script>
<script src="/js/version-notification.js"></script>
</body>
</html>`;
        
        res.send(html);
    } catch (error) {
        console.error('Chyba při načítání statistik:', error);
        res.status(500).send('Došlo k chybě při načítání statistik.');
    }
});

module.exports = router;
