const fs = require("fs");
const express = require("express");
const router = express.Router();
const path = require('path');
const {
    requireLogin, prepareDashboardData, getGroupDisplayLabel, generateLeftPanel,
    getLeagueStatusData, getTableTipsData, generateTimeWidget, getAllowedLeagues
} = require("../utils/fileUtils");
const { Users, Matches, Leagues, TableTips } = require('../utils/mongoDataAccess');
router.get("/table-tip", requireLogin, async (req, res) => {
    // Kontrola jest je liga veřejná
    const allowedLeagues = await getAllowedLeagues();
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
                headers: { 'Content-Type': 'application/json' },
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
                headers: { 'Content-Type': 'application/json' },
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
<form class="league-dropdown" method="GET">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
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
<div style="text-align: center; margin: 20px;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()" 
        style="width: 220px; height: 38px; cursor: pointer; font-weight: bold; border: none; color: white; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
</form>
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
<header class="time-header">${await generateTimeWidget()}</header>
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
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            liga: '${selectedLiga}',
                            season: '${selectedSeason}',
                            teamOrder: payloadData
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
            });
        </script>
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

    if (!tableTips[season]) tableTips[season] = {};
    if (!tableTips[season][liga]) tableTips[season][liga] = {};

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
    const allowedLeagues = await getAllowedLeagues();
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
// --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Tipovačka</title>
<link rel="stylesheet" href="/css/styles.css" />
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
                headers: { 'Content-Type': 'application/json' },
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
                headers: { 'Content-Type': 'application/json' },
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
<form class="league-dropdown" method="GET">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
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
<div style="text-align: center; margin: 20px;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()" 
        style="width: 220px; height: 38px; cursor: pointer; font-weight: bold; border: none; color: white; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
</form>
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
<header class="time-header">${await generateTimeWidget()}</header>
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
fetch('/tip', { method: 'POST', headers: { 'x-requested-with': 'fetch', 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData })
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

    const historyMap = new Map();

    // 1. Primární zdroj: Definice v leagues.json
    Object.keys(allSeasonData).forEach(season => {
        if (allSeasonData[season].leagues) {
            allSeasonData[season].leagues.forEach(l => {
                const key = `${season}_${l.name}`;
                historyMap.set(key, { season, liga: l.name });
            });
        }
    });

    // 2. Záložní zdroj: Zápasy (pokud by něco chybělo v definici)
    matches.forEach(m => {
        if (m.liga && m.season) {
            const key = `${m.season}_${m.liga}`;
            if (!historyMap.has(key)) {
                historyMap.set(key, { season: m.season, liga: m.liga });
            }
        }
    });

    const history = Array.from(historyMap.values());

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
        <header class="time-header">${await generateTimeWidget()}</header>
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
                <td><a href="/history/a/?liga=${encodeURIComponent(entry.liga)}&season=${encodeURIComponent(entry.season)}">Zobrazit</a></td>
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

    // 3. DATA SPECIFICKÁ PRO HISTORII (Výběr uživatele z rolovacího menu vpravo)
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
<div class="league-dropdown">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
<a class="history-btn" href="/">Aktuální</a>
<a class="history-btn" href="/history">Zpět na výběr</a>
<a class="history-btn" style="background:orangered; color:black;" href="/history/a/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy zápasů</a>
<a class="history-btn" href="/history/table/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy tabulky</a>
</div>
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
<header class="time-header">${await generateTimeWidget()}</header>
<main class="main_page">`
html += await generateLeftPanel(data, true);
    html += `<script>
        const globalStatsData = ${JSON.stringify(userStats)};

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
        <div class="league-dropdown">
            <div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
            <a class="history-btn" href="/">Aktuální</a>
            <a class="history-btn" href="/history">Zpět na výběr</a>
            <a class="history-btn" href="/history/a/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy zápasů</a>
            <a class="history-btn" style="background:orangered; color:black;" href="/history/table/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy tabulky</a>
        </div>
        <p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
    </header>
    <header class="time-header">${await generateTimeWidget()}</header>
<main class="main_page">`
html += await generateLeftPanel(data, true);
    html += `
        <script>
        function showUserTableHistory(username) {
            document.querySelectorAll('.user-history-table-container').forEach(el => el.style.display = 'none');
            const safeName = username.replace(/[^a-zA-Z0-9]/g, '_');
            document.querySelectorAll('.user-table-' + safeName).forEach(el => el.style.display = 'block');
        }
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
    // Kontrola jest je liga veřejná
    const allowedLeagues = await getAllowedLeagues();
    const requestedLiga = req.query.liga;
    if (requestedLiga && !allowedLeagues.includes(requestedLiga)) {
        // Přesměruj na první veřejnou ligu
        const firstPublic = allowedLeagues[0] || 'Neurčeno';
        return res.redirect(`/prestupy?liga=${encodeURIComponent(firstPublic)}`);
    }
    
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
                headers: { 'Content-Type': 'application/json' },
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
                headers: { 'Content-Type': 'application/json' },
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
<form class="league-dropdown" method="GET">
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
<a class="history-btn changed" href="/image-exporter?liga=${encodeURIComponent(selectedLiga)}">Exportér</a>
<div style="text-align: center; margin: 20px;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()" 
        style="width: 220px; height: 38px; cursor: pointer; font-weight: bold; border: none; color: white; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
</form>
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
<header class="time-header">${await generateTimeWidget()}</header>
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
            html += `<h2 style="margin-top: 0; text-align: center; border-bottom: 2px solid orangered; padding-bottom: 10px;">Přestupy a Spekulace - ${selectedLiga}</h2>
            
            <div style="display: grid; gap: 15px; margin-top: 15px;">`;

            // --- Uvnitř router.get("/prestupy", ...) v sekci else (kde jsou povolené přestupy) ---

// 1. FUNKCE PRO OBARVOVÁNÍ (Vlož ji před cyklus forEach)
            const formatPlayerName = (rawName) => {
                let style = 'color: white;'; // Výchozí barva
                let icon = '';
                let name = rawName;

                // A. Detekce značek
                if (name.includes('(X)')) {
                    style = 'color: #ff6666; text-decoration: line-through; opacity: 0.7;';
                    icon = '❌ ';
                    name = name.replace('(X)', '');
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
            teamsInSelectedLiga.forEach(team => {
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
router.post("/image-exporter/generate", requireLogin, express.json(), async (req, res) => {
    const { createMatchImage, createTransferImage, createWinnerImage, createStandingsImage, createStatisticsImage, createPlayoffBracketImage } = require("../utils/fileUtils");

    try {
        const { type, homeTeamId, awayTeamId, fromTeamId, toTeamId, winnerTeamId, scoreHome, scoreAway, title, winnerTitle, playerName, playerPhoto, watermark, isPlayoff, seriesHomeWins, seriesAwayWins } = req.body;

        const { Teams } = require('../utils/mongoDataAccess');
        const allTeams = await Teams.findAll();

        const outDir = path.join(__dirname, '../public/images/exports');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        let buffer;
        let filename;
        const timestamp = Date.now();

        switch (type) {
            case 'match': {
                const homeTeam = allTeams.find(t => t.id === parseInt(homeTeamId));
                const awayTeam = allTeams.find(t => t.id === parseInt(awayTeamId));
                if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'Týmy nenalezeny' });

                buffer = await createMatchImage(homeTeam, awayTeam, null, null, watermark !== 'false');
                filename = `match-${homeTeam.id}-vs-${awayTeam.id}-${timestamp}.png`;
                break;
            }
            case 'result': {
                const homeTeam = allTeams.find(t => t.id === parseInt(homeTeamId));
                const awayTeam = allTeams.find(t => t.id === parseInt(awayTeamId));
                if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'Týmy nenalezeny' });

                const seriesData = (isPlayoff && seriesHomeWins !== undefined && seriesAwayWins !== undefined) 
                    ? { homeWins: parseInt(seriesHomeWins), awayWins: parseInt(seriesAwayWins) }
                    : null;

                buffer = await createMatchImage(homeTeam, awayTeam, parseInt(scoreHome), parseInt(scoreAway), title || null, watermark !== 'false', seriesData);
                filename = `result-${homeTeam.id}-${scoreHome}-${awayTeam.id}-${scoreAway}-${timestamp}.png`;
                break;
            }
            case 'transfer': {
                const fromTeam = allTeams.find(t => t.id === parseInt(fromTeamId));
                const toTeam = allTeams.find(t => t.id === parseInt(toTeamId));
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
                const playerSuffix = playerName ? `-${playerName.replace(/\\s+/g, '-')}` : '';
                filename = `transfer-${fromTeam.id}-to-${toTeam.id}${playerSuffix}-${timestamp}.png`;
                break;
            }
            case 'winner': {
                const { winnerColor, showTrophy } = req.body;
                const winnerTeam = allTeams.find(t => t.id === parseInt(winnerTeamId));
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
                            scores
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
    const teams = (await loadTeams()).filter(t => t.active);
    const allowedLeagues = await getAllowedLeagues();
    await getLeaguesData();
    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    // Všechny ligy v sezóně (pro image-exporter zobrazíme všechny)
    const uniqueLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];
    
    // Zjistíme jest je vybraná liga veřejná
    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga)
        ? req.query.liga
        : (allowedLeagues.find(l => uniqueLeagues.includes(l)) || uniqueLeagues[0] || "Neurčeno");
    
    const isPublicLeague = allowedLeagues.includes(selectedLiga);
    
    const data = await prepareDashboardData(req, false, true);
    const { username } = data;
    
    const teamsList = teams || [];
    const leagueTeams = teamsList.filter(t => t.liga === selectedLiga);
    
    // CSS pro disabled tlačítka
    const disabledStyle = "background-color: #555; color: #888; cursor: not-allowed; pointer-events: none;";
    let html = `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Image Exporter - Tipovačka</title>
<link rel="stylesheet" href="/css/styles.css" />
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
        const res = await fetch('/image-exporter/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
<form class="league-dropdown" method="GET">
<div class="logo_title"><img alt="Logo" class="image_logo" src="/images/logo.png"><h1 id="title">Tipovačka</h1></div>
<label class="league-select-name">
Liga:
<select id="league-select" name="liga" required onchange="this.form.submit()">
${uniqueLeagues.map(l => `<option value="${l}" ${l === selectedLiga ? 'selected' : ''}>${l}</option>`).join('')}
</select>
</label>
<a class="history-btn" href="/history">Historie</a>
<a class="history-btn changed" ${!isPublicLeague ? `style="${disabledStyle}" onclick="return false;"` : `href="/?liga=${encodeURIComponent(selectedLiga)}"`}>Tipovačka</a>
<a class="history-btn changed" ${!isPublicLeague ? `style="${disabledStyle}" onclick="return false;"` : `href="/table-tip?liga=${encodeURIComponent(selectedLiga)}"`}>Základní část</a>
<a class="history-btn changed" ${!isPublicLeague ? `style="${disabledStyle}" onclick="return false;"` : `href="/prestupy?liga=${encodeURIComponent(selectedLiga)}"`}>Přestupy</a>
</form>
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
<header class="time-header">${await generateTimeWidget()}</header>
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
                            ${leagueTeams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Hostující tým</label>
                        <select name="awayTeamId" required>
                            <option value="">Vyber tým</option>
                            ${leagueTeams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
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
                            ${leagueTeams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Hostující tým</label>
                        <select name="awayTeamId" required>
                            <option value="">Vyber tým</option>
                            ${leagueTeams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
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
                            ${leagueTeams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Do týmu</label>
                        <select name="toTeamId" required>
                            <option value="">Vyber tým</option>
                            ${leagueTeams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
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
                        ${leagueTeams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
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
                        <label for="show-trophy" style="margin: 0;">Zobrazit pohár 🏆</label>
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
</body>
<script src="/js/version-notification.js"></script>
</html>`;
    res.send(html);
});
module.exports = router;
