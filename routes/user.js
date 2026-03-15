const fs = require("fs");
const express = require("express");
const router = express.Router();
require('path');
const {
    requireLogin, prepareDashboardData, getGroupDisplayLabel, generateLeftPanel,
} = require("../utils/fileUtils");
router.get("/table-tip", requireLogin, (req, res) => {
    // 1. ZAVOLÁME MOZEK, KTERÝ VŠE VYPOČÍTÁ BĚHEM MILISEKUNDY
    const data = prepareDashboardData(req);
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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
<a class="history-btn changed" href="/prestupy?liga=${encodeURIComponent(selectedLiga)}">Přestupy TELH</a>
<div style="text-align: center; margin: 20px;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()" 
        style="width: 220px; height: 40px; cursor: pointer; font-weight: bold; border: none; color: white; border-radius: 5px; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
</form>
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
<main class="main_page">`;

html += generateLeftPanel(data);

    // Potom tam zbylo jen uzavření levého panelu
    html += `</div></section>`;

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

                        payloadData[gKey] = Array.from(list.querySelectorAll('.sortable-item'))
                                .map(i => parseInt(i.getAttribute('data-id')));
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
                            location.reload();
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

router.post("/table-tip", requireLogin, express.json(), (req, res) => {
    const username = req.session.user;
    if (username === "Admin") return res.status(403).send("Admin netipuje.");

    const {liga, season, teamOrder} = req.body; // teamOrder je objekt
    if (!liga || !season || !teamOrder) return res.status(400).send("Chybí data.");

    // Kontrola globálního zámku
    try {
        const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
        const lockedStatus = statusData?.[season]?.[liga]?.tableTipsLocked;
        if (lockedStatus === true) return res.status(403).send("Tipování je uzamčeno.");
    } catch (e) {
    }

    let tableTips = {};
    try {
        if (fs.existsSync('./data/tableTips.json')) {
            tableTips = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8'));
        }
    } catch (e) {
        console.error(e);
    }

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

    fs.writeFileSync('./data/users.json', JSON.stringify(users, null, 2));

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

router.get('/', requireLogin, (req, res) => {
    // 1. ZAVOLÁME MOZEK, KTERÝ VŠE VYPOČÍTÁ BĚHEM MILISEKUNDY
    const data = prepareDashboardData(req);

    // 2. VYBALÍME SI PROMĚNNÉ, KTERÉ POTŘEBUJE HTML (Destructuring)
    const {
        username, selectedSeason, selectedLiga, uniqueLeagues, teams
    } = data;
// --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
<a class="history-btn changed" href="/prestupy?liga=${encodeURIComponent(selectedLiga)}">Přestupy TELH</a>
<div style="text-align: center; margin: 20px;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()" 
        style="width: 220px; height: 40px; cursor: pointer; font-weight: bold; border: none; color: white; border-radius: 5px; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
</form>
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
<main class="main_page">`;

    html += generateLeftPanel(data);
    // ZAČÁTEK PRAVÉHO PANELU SE ZÁPASY
    html += `
    <section class="matches-container">
    <h2>Aktuální zápasy k tipování</h2>
    `;

    const matchesData = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8'))
            .filter(m => m.liga === selectedLiga && !m.result)
            .filter(m => m.season === selectedSeason)
            .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

        const usersData = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));
        const currentUserData = usersData.find(u => u.username === username);
        const userTips = currentUserData?.tips?.[selectedSeason]?.[selectedLiga] || [];

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

            html += `<h3>${formattedDateTime}</h3><table class="matches-table"><thead class="matches-table-header"><tr><th colspan="3">Zápasy</th></tr></thead><tbody>`;

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

                const existingTip = userTips.find(t => t.matchId === match.id);
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
                        <td style="position: relative; overflow: hidden;">${watermarkHTML(homeLogoUrl)}
                            <button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" data-winner="home" ${matchStarted ? 'disabled' : ''} 
                                    style="overflow: hidden;">
                                <div style="z-index: 5;">${homeTeamName}</div>
                            </button>
                        </td>
                        <td class="vs">${vsText}</td> <td style="position: relative; overflow: hidden;">${watermarkHTML(awayLogoUrl)}
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
            <td style="position: relative; overflow: hidden;">${watermarkHTML(homeLogoUrl)}
                <button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" data-winner="home" ${matchStarted ? 'disabled' : ''} style="overflow: hidden;">
                    <span style="z-index: 5;">${homeTeamName}</span>
                </button>
            </td>
            <td class="vs">${vsText}</td>
            <td style="position: relative; overflow: hidden;">${watermarkHTML(awayLogoUrl)}
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
fetch('/tip', { method: 'POST', headers: { 'x-requested-with': 'fetch' }, body: formData })
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

router.get('/history', requireLogin, (req, res) => {
    // Načtení definic lig (aby byly vidět i ty bez zápasů)
    let allSeasonData = {};
    try { allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf8')); } catch (err) { console.error(err); }

    // Načtení zápasů (pro zpětnou kompatibilitu)
    let matches = [];
    try { matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf8')); } catch (err) { console.error(err); }

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
router.get('/history/a', requireLogin, (req, res) => {
    // 0. Bezpečnostní kontrola adresy
    if (!req.query.liga || !req.query.season) return res.redirect('/history');

    // 1. ZAVOLÁME MOZEK (s parametrem true pro režim historie)
    const data = prepareDashboardData(req, true);

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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
<main class="main_page">`
html += generateLeftPanel(data, true);
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
        html += `<h3>${formattedDateTime}</h3><table class="matches-table"><thead class="matches-table-header"><tr><th colSpan="6">Zápasy</th></tr></thead><tbody>`;

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
                    <td class="${initHomeClass}" style="position: relative; overflow: hidden; width: 40%;">${watermarkHTML(homeLogoUrl)}${homeCellHTML}</td>
                    <td class="vs" style="width: 3%;">${match.result.scoreHome}</td>
                    <td class="vs" style="width: 6%;">${match.result.ot === true ? "pp/sn" : ":"}</td>
                    <td class="vs" style="width: 3%;">${match.result.scoreAway}</td>
                    <td class="${initAwayClass}" style="position: relative; overflow: hidden; width: 40%;">${watermarkHTML(awayLogoUrl)}${awayCellHTML}</td>
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
                <td class="${initHomeClass}" style="position: relative; overflow: hidden; width: 40%;">${watermarkHTML(homeLogoUrl)}${homeCellHTML}</td>
                <td class="vs" style="width: 3%;">${match.result.scoreHome}</td>
                <td class="vs" style="width: 6%;">vs</td>
                <td class="vs" style="width: 3%;">${match.result.scoreAway}</td>
                <td class="${initAwayClass}" style="position: relative; overflow: hidden; width: 40%;">${watermarkHTML(awayLogoUrl)}${awayCellHTML}</td>
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
router.get('/history/table', requireLogin, (req, res) => {
    // 0. Bezpečnostní kontrola adresy
    if (!req.query.liga || !req.query.season) return res.redirect('/history');

    // 1. ZAVOLÁME MOZEK (s parametrem true pro režim historie)
    const data = prepareDashboardData(req, true);

    // 2. VYBALÍME SI PROMĚNNÉ
    const {
        username, selectedSeason, selectedLiga, sortedGroupKeys, groupedTeams,
        globalRealRankMap, allUsers, tableTips,
    } = data;

    const usersWithTableTips = allUsers.filter(u => tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username]).sort((a, b) => a.username.localeCompare(b.username));
    const initialUser = usersWithTableTips.find(u => u.username === username) ? username : (usersWithTableTips[0]?.username || "");

    // --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
<main class="main_page">`
html += generateLeftPanel(data, true);
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
                        if (diff === 0) {
                            bgStyle = "background-color: rgba(40, 100, 40, 0.6); border-color: #00ff00;";
                            diffText = "✔";
                            diffColor = "#00ff00";
                        } else {
                            diffText = `<span style="font-size: 0.8em">Akt.: ${realRank}. (${Math.abs(diff)})</span>`;
                            diffColor = "orange";
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

router.get("/prestupy", requireLogin, (req, res) => {
    // 1. ZAVOLÁME MOZEK, KTERÝ VŠE VYPOČÍTÁ BĚHEM MILISEKUNDY
    const data = prepareDashboardData(req);

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
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
<div style="text-align: center; margin: 20px;">
    <button type="button" id="notify-toggle-btn" onclick="toggleNotifications()" 
        style="width: 220px; height: 40px; cursor: pointer; font-weight: bold; border: none; color: white; border-radius: 5px; background-color: #444;">
        Zjišťuji stav...
    </button>
</div>
</form>
<p id="logged_user">${username ? `Přihlášený jako: <strong>${username}</strong> <a href="/auth/logout">Odhlásit se</a>` : '<a href="/login">Přihlásit</a> / <a href="/register">Registrovat</a>'}</p>
</header>
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
html += generateLeftPanel(data);

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

module.exports = router;