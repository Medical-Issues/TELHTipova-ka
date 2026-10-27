const fs = require("fs");
const express = require("express");
const router = express.Router();
const path = require('path');
const {
    requireLogin, prepareDashboardData, getGroupDisplayLabel, generateLeftPanel,
    getLeagueStatusData, getTableTipsData, generateTimeWidget, getAllowedLeagues, createMatchImage, logUserAction
} = require("../utils/fileUtils");
const { Users, Matches, Leagues, TableTips, ChosenSeason, Players, Settings, Teams} = require('../utils/mongoDataAccess');

function toPragueDateTime(value) {
    if (!value) return null;
    const rawValue = value instanceof Date ? value.toISOString() : String(value);
    if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(rawValue)) {
        return rawValue.replace(' ', 'T').slice(0, 16);
    }

    const date = new Date(rawValue);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString('sv-SE', { timeZone: 'Europe/Prague', hour12: false }).replace(' ', 'T').slice(0, 16);
}

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

async function renderUserHeader({ username, selectedLiga, uniqueLeagues = [], activeTab = 'matches', csrfToken = '', timeWidgetHtml = '' }) {
    const initials = (username ? username.substring(0, 2).toUpperCase() : 'U');
    const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]);
    return `
    <header class="app-header">
        <script>
            (() => {
                const beginNavigation = () => document.body.classList.add('is-navigating');

                document.addEventListener('click', (event) => {
                    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

                    const target = event.target instanceof Element ? event.target : event.target.parentElement;
                    const link = target?.closest('a[href]');
                    if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;

                    const destination = new URL(link.href, window.location.href);
                    if (destination.origin !== window.location.origin || destination.href === window.location.href) return;
                    if (destination.pathname === window.location.pathname && destination.search === window.location.search && destination.hash) return;

                    beginNavigation();
                });

                document.addEventListener('submit', (event) => {
                    if (event.defaultPrevented) return;
                    if (event.target instanceof HTMLFormElement && event.target.method.toLowerCase() === 'get') beginNavigation();
                });

                document.addEventListener('click', (event) => {
                    const target = event.target instanceof Element ? event.target : event.target.parentElement;
                    const trigger = target?.closest('.league-select-trigger');
                    const openDropdown = document.querySelector('.league-select-wrap.is-open');

                    if (trigger) {
                        const dropdown = trigger.closest('.league-select-wrap');
                        const willOpen = !dropdown.classList.contains('is-open');
                        openDropdown?.classList.remove('is-open');
                        openDropdown?.querySelector('.league-select-trigger')?.setAttribute('aria-expanded', 'false');
                        if (openDropdown) openDropdown.querySelector('.league-select-menu').hidden = true;
                        dropdown.classList.toggle('is-open', willOpen);
                        trigger.setAttribute('aria-expanded', String(willOpen));
                        dropdown.querySelector('.league-select-menu').hidden = !willOpen;
                        if (willOpen) dropdown.querySelector('[role="option"]')?.focus();
                        return;
                    }

                    if (openDropdown && !openDropdown.contains(target)) {
                        openDropdown.classList.remove('is-open');
                        openDropdown.querySelector('.league-select-trigger')?.setAttribute('aria-expanded', 'false');
                        openDropdown.querySelector('.league-select-menu').hidden = true;
                    }
                });

                document.addEventListener('keydown', (event) => {
                    const dropdown = event.target.closest?.('.league-select-wrap.is-open');
                    if (!dropdown) return;
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        const options = [...dropdown.querySelectorAll('[role="option"]')];
                        const currentIndex = options.indexOf(document.activeElement);
                        const nextIndex = event.key === 'ArrowDown'
                            ? (currentIndex + 1) % options.length
                            : (currentIndex - 1 + options.length) % options.length;
                        event.preventDefault();
                        options[nextIndex]?.focus();
                        return;
                    }
                    if (event.key !== 'Escape') return;
                    dropdown.classList.remove('is-open');
                    dropdown.querySelector('.league-select-menu').hidden = true;
                    const trigger = dropdown.querySelector('.league-select-trigger');
                    trigger?.setAttribute('aria-expanded', 'false');
                    trigger?.focus();
                });

                const sizeLeagueDropdowns = () => {
                    document.querySelectorAll('.league-select-wrap').forEach((dropdown) => {
                        const trigger = dropdown.querySelector('.league-select-trigger');
                        const label = dropdown.querySelector('.league-select-label');
                        const options = [...dropdown.querySelectorAll('.league-select-option')];
                        if (!trigger || !label || options.length === 0) return;

                        const probe = document.createElement('span');
                        const optionStyle = getComputedStyle(options[0]);
                        Object.assign(probe.style, {
                            position: 'fixed',
                            visibility: 'hidden',
                            whiteSpace: 'nowrap',
                            fontFamily: optionStyle.fontFamily,
                            fontSize: optionStyle.fontSize,
                            fontWeight: optionStyle.fontWeight,
                            letterSpacing: optionStyle.letterSpacing,
                        });
                        document.body.append(probe);

                        const longestOptionWidth = Math.max(...options.map((option) => {
                            probe.textContent = option.textContent.replace('✓', '').trim();
                            return probe.getBoundingClientRect().width;
                        }));
                        probe.remove();

                        const triggerStyle = getComputedStyle(trigger);
                        const labelWidth = label.getBoundingClientRect().width;
                        const horizontalPadding = parseFloat(triggerStyle.paddingLeft) + parseFloat(triggerStyle.paddingRight);
                        const gaps = 16;
                        const chevron = 7;
                        const border = parseFloat(triggerStyle.borderLeftWidth) + parseFloat(triggerStyle.borderRightWidth);
                        const width = Math.ceil(longestOptionWidth + labelWidth + horizontalPadding + gaps + chevron + border);
                        dropdown.style.width = width + 'px';
                    });
                };

                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', sizeLeagueDropdowns, { once: true });
                } else {
                    sizeLeagueDropdowns();
                }
                window.addEventListener('resize', sizeLeagueDropdowns);

                window.addEventListener('pageshow', () => document.body.classList.remove('is-navigating'));
            })();
        </script>
        <div class="header-top">
            <a href="/?liga=${encodeURIComponent(selectedLiga || '')}" class="brand">
                <img class="brand-logo-img" src="/images/logo.png" alt="Logo">
                <div class="brand-title">Tipovačka<span>.</span></div>
            </a>

            <nav class="nav-pills">
                <a href="/?liga=${encodeURIComponent(selectedLiga || '')}" class="nav-pill ${activeTab === 'matches' ? 'active' : ''}">Zápasy</a>
                <a href="/table-tip?liga=${encodeURIComponent(selectedLiga || '')}" class="nav-pill ${activeTab === 'table-tip' ? 'active' : ''}">Základní část</a>
                <a href="/prestupy?liga=${encodeURIComponent(selectedLiga || '')}" class="nav-pill ${activeTab === 'prestupy' ? 'active' : ''}">Přestupy</a>
                <a href="/image-exporter?liga=${encodeURIComponent(selectedLiga || '')}" class="nav-pill ${activeTab === 'exporter' ? 'active' : ''}">Exportér</a>
                <a href="/statistics" class="nav-pill ${activeTab === 'statistics' ? 'active' : ''}">Statistiky</a>
                <a href="/history" class="nav-pill ${activeTab === 'history' ? 'active' : ''}">Historie</a>
            </nav>

            <div class="user-menu">
                ${uniqueLeagues && uniqueLeagues.length > 0 ? `
                <form class="league-dropdown" method="GET" style="margin:0;">
                    <div class="league-select-wrap">
                        <button type="button" class="league-select-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="league-select-menu">
                            <span class="league-select-label">Liga</span>
                            <span class="league-select-value">${escapeHtml(selectedLiga)}</span>
                            <span class="league-select-chevron" aria-hidden="true"></span>
                        </button>
                        <div class="league-select-menu" id="league-select-menu" role="listbox" aria-label="Vyber ligu" hidden>
                            ${uniqueLeagues.map(l => `<button type="submit" class="league-select-option${l === selectedLiga ? ' is-selected' : ''}" role="option" aria-selected="${l === selectedLiga}" name="liga" value="${escapeHtml(l)}">${escapeHtml(l)}${l === selectedLiga ? '<span class="league-option-check" aria-hidden="true">✓</span>' : ''}</button>`).join('')}
                        </div>
                    </div>
                </form>` : ''}

                <button type="button" class="bell-btn" id="notify-toggle-btn" onclick="toggleNotifications()" title="Push notifikace">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                    </svg>
                </button>

                <div class="user-avatar">
                    <div class="avatar-circle">${initials}</div>
                    <span class="user-name">${username || 'Uživatel'}</span>
                    ${username ? `<a href="/auth/logout" class="logout-link" title="Odhlásit se">Odhlásit</a>` : `<a href="/auth/login" class="logout-link">Přihlásit</a>`}
                </div>
            </div>
        </div>

        <div class="time-bar">
            <div class="time-bar-inner">
                <div class="time-badge">
                    <div class="live-dot"></div>
                    <span>${timeWidgetHtml}</span>
                </div>
                <div>
                    <a href="#" onclick="showVersionNotificationManual(); return false;" id="version-badge" class="version-link">v<span id="current-version">...</span></a>
                </div>
            </div>
        </div>
    </header>
    <input type="hidden" id="globalCsrfToken" value="${csrfToken}">
    `;
}

function renderNotificationScript(csrfToken = '') {
    return `
<script>
function showTable(which) { 
    const reg = document.getElementById('regularTable');
    if (reg) reg.style.display = which === 'regular' ? 'block' : 'none'; 
    const p = document.getElementById('playoffTablePreview');
    if (p) p.style.display = which === 'playoff' ? 'block' : 'none'; 
}

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

    try {
        let registration = await navigator.serviceWorker.getRegistration();
        
        if (!registration) {
            registration = await navigator.serviceWorker.register('./sw.js');
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
                    'X-CSRF-Token': '${csrfToken}'
                },
                body: JSON.stringify({ endpoint: subscription.endpoint })
            });
            if (res.ok) {
                await subscription.unsubscribe();
                alert('Notifikace byly vypnuty.');
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
                    'X-CSRF-Token': '${csrfToken}'
                },
                body: JSON.stringify(newSub)
            });
            
            if (saveRes.ok) {
                alert('Notifikace byly zapnuty!');
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
        btn.title = "Notifikace nejsou podporovány";
        btn.disabled = true;
        return;
    }

    try {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = registration ? await registration.pushManager.getSubscription() : null;

        if (subscription) {
            btn.classList.add('active');
            btn.title = "Notifikace jsou zapnuté (kliknutím vypnete)";
        } else {
            btn.classList.remove('active');
            btn.title = "Notifikace jsou vypnuté (kliknutím zapnete)";
        }
    } catch (e) {
        btn.title = "Klikněte pro zjištění stavu notifikací";
    }
}

document.addEventListener('DOMContentLoaded', checkSubscriptionStatus);
</script>
`;
}

router.get("/table-tip", requireLogin, async (req, res) => {
    // Kontrola jest je liga veřejná
    const chosenSeason = await ChosenSeason.findAll();
    const userSelectedSeason = req.query.season || chosenSeason;
    const allowedLeagues = await getAllowedLeagues(userSelectedSeason);
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
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<title>Tipování tabulky – Tipovačka</title>
<link rel="stylesheet" href="/css/modern-design.css?v=standings-layout-20261024" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
${renderNotificationScript(req.session.csrfToken || '')}
<body class="usersite">
${await renderUserHeader({
    username,
    selectedLiga,
    uniqueLeagues,
    activeTab: 'table-tip',
    csrfToken: req.session.csrfToken || '',
    timeWidgetHtml: await generateTimeWidget()
})}
<main class="main_page">`;

html += await generateLeftPanel(data);

    // =========================================================
    // 1. ZÍSKÁNÍ SKUTEČNÉHO POŘADÍ Z LEVÉ TABULKY
    // =========================================================
    for (const group of sortedGroups) {
        teamsByGroup[group].forEach((t, i) => {
            globalRealRankMap[t.id] = i + 1;
        });
    }

    // --- PRAVÝ PANEL: TIPOVÁNÍ TABULKY ---
    html += `
        <section class="matches-container">
            <div class="section-header">
                <div class="section-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
                    Tipování pořadí základní části
                </div>
            </div>
            <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 16px;">Chyťte tým a přetáhněte jej na požadovanou pozici. Pořadí nezapomeňte dole uložit.</p>
            
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
            teamsForTip.sort((a, b) => {
                const indexA = currentGroupTipIds.indexOf(a.id);
                const indexB = currentGroupTipIds.indexOf(b.id);
                if (indexA === -1) return 1;
                if (indexB === -1) return -1;
                return indexA - indexB;
            });
        } else {
            teamsForTip.sort((a, b) => {
                const rankA = globalRealRankMap[a.id] || 99;
                const rankB = globalRealRankMap[b.id] || 99;
                return rankA - rankB;
            });
        }

        html += `
            <div style="margin-top: 20px;">
                ${groupLabel ? `<h3 style="padding-bottom: 8px; border-bottom: 1px solid var(--border-subtle); margin-bottom: 12px; font-size: 15px;">${groupLabel}</h3>` : ''}
                
                ${isGroupLocked ? `<div style="background: var(--accent-red-bg); color: var(--accent-red); padding: 8px 14px; border: 1px solid rgba(239,68,68,0.3); border-radius: var(--radius-md); font-size: 12px; font-weight: 700; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">🔒 Skupina je uzamčena pro tipování</div>` : ''}
                
                <ul class="sortable-list" id="list-${gKey}" data-group="${gKey}">
                    ${teamsForTip.map((team, index) => {
            const userRank = index + 1;
            const realRank = globalRealRankMap[team.id] || '?';
            const diff = userRank - realRank;
            const isCorrect = (diff === 0);
            const logoUrl = team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

            let diffText;
            let diffColor = "var(--text-dim)";

            if (hasTipForGroup) {
                if (isGroupLocked) {
                    if (isCorrect) {
                        diffText = "✔ Trefa (+1)";
                        diffColor = "var(--accent-green)";
                    } else {
                        diffText = `Skutečnost: ${realRank}. (${Math.abs(diff)})`;
                        diffColor = "var(--accent-amber)";
                    }
                } else {
                    diffText = `Uloženo`;
                    diffColor = "var(--text-muted)";
                }
            } else {
                diffText = `Netipováno`;
            }

            return `
                        <li class="sortable-item ${isCorrect && isGroupLocked ? 'is-correct' : ''}" 
                            draggable="${!isGroupLocked}" 
                            data-id="${team.id}"
                            data-group="${gKey}"
                            style="${isGroupLocked ? 'cursor: default; opacity: 0.85;' : 'cursor: grab;'}"> 
                            
                            <span class="sortable-rank">${userRank}</span>
                            <div class="team-cell">
                                <img src="${logoUrl}" alt="" class="team-logo-small">
                                <span class="sortable-team-name">${team.name}</span>
                            </div>

                            <div style="display:flex; align-items:center; gap: 12px; margin-left: auto;">
                                <span style="color: ${diffColor}; font-weight: 700; font-size: 12px;">${diffText}</span>
                                <span class="drag-handle">${isGroupLocked ? '🔒' : '☰'}</span>
                            </div>
                        </li>
                        `;
        }).join('')}
                </ul>
            </div>
        `;
    }

    if (isTipsLocked !== true) {
        html += `<button type="button" id="saveBtn" class="login_button" style="margin-top:24px; width: 100%;">💾 Uložit všechny tipy</button>`;
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
        .catch(err => console.error('Nepodařilo se načíst verzi', err));
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

    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

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
        await logUserAction(username, "TABLE_TIP", `Neúspěšné tipování tabulky pro ${liga} (${season}) - ${err.message}`, 'table_tip', null, req, 'error', false);
        return res.status(500).send("Chyba při ukládání tipu tabulky.");
    }

    await logUserAction(username, "TABLE_TIP", `Tipování tabulky pro ${liga} (${season})`, 'table_tip', null, req, 'info', true);
    res.sendStatus(200);
});

router.post("/tip", requireLogin, async (req, res) => {
    const username = req.session.user;
    if (username === "Admin") {
        return res.status(403).send("Administrátor se nemůže účastnit tipování.");
    }

    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

    const matchId = Number.parseInt(req.body.matchId, 10);
    if (!Number.isSafeInteger(matchId)) {
        return res.status(400).send("Neplatný zápas.");
    }
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

    const match = matches.find(m => Number(m.id) === matchId);
    if (!match) return res.status(400).send("Neplatný zápas.");

    const matchStartPrague = toPragueDateTime(match.datetime || match.date);
    const currentPragueTimeISO = toPragueDateTime(new Date());

    // 1. Ochrana proti manuálnímu zamčení
    if (match.locked || match.postponed) {
        return res.status(403).send("Na uzamčený nebo odložený zápas nelze tipovat.");
    }

    // 2. Porovnáváme dva textové řetězce (např. "2024-03-10T18:00" <= "2024-03-10T18:05")
    if (matchStartPrague && matchStartPrague <= currentPragueTimeISO) {
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

    const existing = user.tips[season][league].find(t => Number(t.matchId) === matchId);

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
        await logUserAction(username, "MATCH_TIP", `Neúspěšné tipování zápasu ID ${matchId} - ${err.message}`, 'match_tip', matchId, req, 'error', false);
        return res.status(500).send("Chyba při ukládání tipu.");
    }

    await logUserAction(username, "MATCH_TIP", `Tipování zápasu ID ${matchId} (${match.homeTeam} vs ${match.awayTeam})`, 'match_tip', matchId, req, 'info', true);

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


function escapeHtmlGlobal(value = '') {
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]);
}

function getMatchTipsBreakdown(match, allUsers, season, liga, currentUsername, isHistory = false) {
    const homeTippers = [];
    const awayTippers = [];

    if (Array.isArray(allUsers)) {
        allUsers.forEach(u => {
            if (!u || !u.username) return;
            const tipsList = u.tips?.[season]?.[liga];
            if (!Array.isArray(tipsList)) return;
            const tip = tipsList.find(t => String(t.matchId) === String(match.id));
            if (!tip || (tip.winner !== 'home' && tip.winner !== 'away')) return;

            let extraDetail = '';
            if (match.isPlayoff) {
                const bo = match.bo || 1;
                if (bo > 1) {
                    const winsNeeded = Math.ceil(bo / 2);
                    const lWins = tip.loserWins != null ? parseInt(tip.loserWins, 10) : 0;
                    extraDetail = tip.winner === 'home' ? `${winsNeeded}:${lWins}` : `${lWins}:${winsNeeded}`;
                } else if (bo === 1 && tip.scoreHome != null && tip.scoreAway != null) {
                    extraDetail = `${tip.scoreHome}:${tip.scoreAway}`;
                }
            }

            let earnedPoints = 0;
            const isCorrect = match.result?.winner ? tip.winner === match.result.winner : null;
            if (isHistory && match.result?.winner && isCorrect) {
                const bo = match.bo || 1;
                if (!match.isPlayoff) {
                    earnedPoints = 1;
                } else if (match.isPlayoff && bo === 1) {
                    const tH = tip.scoreHome ?? 0;
                    const tA = tip.scoreAway ?? 0;
                    const totalDiff = Math.abs(tH - (match.result.scoreHome || 0)) + Math.abs(tA - (match.result.scoreAway || 0));
                    if (totalDiff === 0) earnedPoints = 5;
                    else if (totalDiff === 1) earnedPoints = 4;
                    else if (totalDiff === 2) earnedPoints = 3;
                    else earnedPoints = 1;
                } else if (match.isPlayoff && bo > 1) {
                    const realLoserWins = match.result.winner === 'home' ? (match.result.scoreAway || 0) : (match.result.scoreHome || 0);
                    if (parseInt(tip.loserWins, 10) === realLoserWins) {
                        earnedPoints = 3;
                    } else {
                        earnedPoints = 1;
                    }
                }
            }

            const tipper = {
                username: u.username,
                isCurrentUser: u.username === currentUsername,
                extraDetail,
                isCorrect,
                points: earnedPoints
            };

            if (tip.winner === 'home') homeTippers.push(tipper);
            else awayTippers.push(tipper);
        });
    }

    const sortFn = (a, b) => {
        if (a.isCurrentUser) return -1;
        if (b.isCurrentUser) return 1;
        return a.username.localeCompare(b.username, 'cs', { sensitivity: 'base' });
    };
    homeTippers.sort(sortFn);
    awayTippers.sort(sortFn);

    const totalTips = homeTippers.length + awayTippers.length;
    let homePct = 0;
    let awayPct = 0;
    if (totalTips > 0) {
        homePct = Math.round((homeTippers.length / totalTips) * 100);
        awayPct = 100 - homePct;
    }

    return {
        totalTips,
        home: { tippers: homeTippers, pct: homePct },
        away: { tippers: awayTippers, pct: awayPct }
    };
}

function renderMatchTipsSide(sideData, matchId, side, teamName, isHistory = false) {
    const { tippers, pct } = sideData;
    const isHome = side === 'home';
    const alignClass = isHome ? 'tips-align-left' : 'tips-align-right';

    if (!tippers || tippers.length === 0) {
        return `
        <div class="match-tips-panel ${isHome ? 'home-tips' : 'away-tips'} ${alignClass}">
            <div class="match-tips-track">
                <div class="match-tips-fill ${isHome ? 'home-fill' : 'away-fill'}" style="width: 0;"></div>
            </div>
            <div class="match-tips-row">
                <span class="match-tips-empty">0 tipů (0%)</span>
            </div>
        </div>`;
    }

    const directCount = tippers.length <= 3 ? tippers.length : 2;
    const visibleTippers = tippers.slice(0, directCount);
    const hasMore = tippers.length > directCount;
    const moreCount = tippers.length - directCount;

    const renderChip = (t) => {
        const initial = (t.username || '?')[0].toUpperCase();
        let statusClass = '';
        let pointsTag = '';
        if (isHistory && t.isCorrect !== null) {
            statusClass = t.isCorrect ? 'chip-correct' : 'chip-wrong';
            if (t.points > 0) {
                pointsTag = `<span class="chip-pts">+${t.points}b</span>`;
            }
        }
        return `
        <span class="tip-chip ${t.isCurrentUser ? 'is-me' : ''} ${statusClass}" onclick="openUserProfileModal('${escapeHtmlGlobal(t.username)}'); event.stopPropagation();" style="cursor: pointer;" title="${escapeHtmlGlobal(t.username)}${t.extraDetail ? ` (${t.extraDetail})` : ''}">
            <span class="chip-avatar">${initial}</span>
            <span class="chip-name">${escapeHtmlGlobal(t.username)}</span>
            ${t.extraDetail ? `<span class="chip-detail">${t.extraDetail}</span>` : ''}
            ${pointsTag}
        </span>`;
    };

    const chipsHtml = visibleTippers.map(renderChip).join('');

    const moreBtnHtml = hasMore ? `
        <button type="button" class="tip-chip tip-more-btn" onclick="toggleTipsPopover(event, '${matchId}', '${side}')" aria-label="Zobrazit všechny tipy (${tippers.length})">
            +${moreCount} ${moreCount === 1 ? 'další' : (moreCount < 5 ? 'další' : 'dalších')} ▾
        </button>
    ` : '';

    const popoverItemsHtml = tippers.map(t => {
        const initial = (t.username || '?')[0].toUpperCase();
        let statusClass = '';
        let ptsHtml = '';
        if (isHistory && t.isCorrect !== null) {
            statusClass = t.isCorrect ? 'popover-correct' : 'popover-wrong';
            ptsHtml = `<span class="popover-pts ${t.points > 0 ? 'pts-win' : 'pts-zero'}">${t.points > 0 ? `+${t.points} b.` : '0 b.'}</span>`;
        }
        return `
        <div class="popover-item ${t.isCurrentUser ? 'is-me' : ''} ${statusClass}" onclick="openUserProfileModal('${escapeHtmlGlobal(t.username)}'); event.stopPropagation();" style="cursor: pointer;">
            <span class="popover-avatar">${initial}</span>
            <span class="popover-user">
                <span class="popover-username">${escapeHtmlGlobal(t.username)}</span>
                ${t.isCurrentUser ? '<span class="popover-me-badge">Ty</span>' : ''}
                ${t.extraDetail ? `<span class="popover-detail">(${t.extraDetail})</span>` : ''}
            </span>
            ${ptsHtml}
        </div>`;
    }).join('');

    const popoverHtml = `
    <div id="tips-popover-${matchId}-${side}" class="tips-popover ${alignClass}" hidden onclick="event.stopPropagation()">
        <div class="tips-popover-header">
            <span class="tips-popover-title">Tipy pro <strong>${escapeHtmlGlobal(teamName)}</strong> (${tippers.length})</span>
            <button type="button" class="tips-popover-close" onclick="closeTipsPopover('${matchId}', '${side}')" aria-label="Zavřít">&times;</button>
        </div>
        <div class="tips-popover-list">
            ${popoverItemsHtml}
        </div>
    </div>`;

    const countBadge = `
        <span class="match-tips-count" title="${tippers.length} tipů (${pct}%)" onclick="toggleTipsPopover(event, '${matchId}', '${side}')" style="cursor: pointer;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
            <strong>${tippers.length}</strong>
            <span class="tips-pct">(${pct}%)</span>
        </span>
    `;

    return `
    <div class="match-tips-panel ${isHome ? 'home-tips' : 'away-tips'} ${alignClass}" data-match-id="${matchId}" data-side="${side}">
        <div class="match-tips-track">
            <div class="match-tips-fill ${isHome ? 'home-fill' : 'away-fill'}" style="width: ${pct}%;"></div>
        </div>
        <div class="match-tips-row">
            ${isHome ? countBadge : ''}
            <div class="match-tips-chips">
                ${isHome ? chipsHtml + moreBtnHtml : moreBtnHtml + chipsHtml}
            </div>
            ${!isHome ? countBadge : ''}
        </div>
        ${popoverHtml}
    </div>`;
}

router.get('/', requireLogin, async (req, res) => {
    // Kontrola jest je liga veřejná
    const chosenSeason = await ChosenSeason.findAll();
    const userSelectedSeason = req.query.season || chosenSeason;
    const allowedLeagues = await getAllowedLeagues(userSelectedSeason);
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
        username, selectedSeason, selectedLiga, uniqueLeagues, teams, currentUserMatchTips, allUsers
    } = data;
    // DEBUG PRO MAXA LIGU

// --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<title>Tipovačka</title>
<link rel="stylesheet" href="/css/modern-design.css" />
<script src="/js/version-notification.js"></script>
<script src="/js/match-tips.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
${renderNotificationScript(req.session.csrfToken || '')}
<body class="usersite">
${await renderUserHeader({
    username,
    selectedLiga,
    uniqueLeagues,
    activeTab: 'matches',
    csrfToken: req.session.csrfToken || '',
    timeWidgetHtml: await generateTimeWidget()
})}
<main class="main_page">`;

    html += await generateLeftPanel(data);
    // ZAČÁTEK PRAVÉHO PANELU SE ZÁPASY
    html += `
    <section class="matches-container">
        <div class="section-header">
            <div class="section-title">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/></svg>
                Aktuální zápasy k tipování
            </div>
        </div>
    `;

    const matchesData = (await Matches.findAll())
            .filter(m => m.liga === selectedLiga && !m.result)
            .filter(m => m.season === selectedSeason)
            .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));
    const postponedMatches = matchesData.filter(m => m.postponed);
    const normalMatches = matchesData.filter(m => !m.postponed);
    const LABEL_POSTPONED = "Odložené zápasy";
    const groupedByDate = {};

    if (postponedMatches.length) {
        groupedByDate[LABEL_POSTPONED] = { postponed: true, matches: postponedMatches };
    }

    normalMatches.forEach(match => {
        const dateTime = match.datetime || match.date || "Neznámý čas";
        const datePart = dateTime.includes('T') ? dateTime.split('T')[0] : dateTime.split(' ')[0];
        if (!groupedByDate[datePart]) groupedByDate[datePart] = { postponed: false, matches: [] };
        groupedByDate[datePart].matches.push(match);
    });

    const currentPragueTimeISO = toPragueDateTime(new Date());

        for (const [dateKey, dateGroup] of Object.entries(groupedByDate)) {
            if (dateGroup.postponed) {
                // Show postponed matches with divider
                html += `
                <div class="date-divider">
                    <span class="date-badge">📅 ${LABEL_POSTPONED}</span>
                    <div class="date-line"></div>
                </div>
                <table class="matches-table">
                    <colgroup>
                        <col style="width: calc(45%);">
                        <col style="width: 5%;">
                        <col style="width: calc(45%);">
                    </colgroup>
                    <thead class="matches-table-header">
                        <tr><th colspan="3">Zápasy</th></tr>
                    </thead>
                    <tbody>`;
                
                for (const match of dateGroup.matches) {
                    const homeTeamName = teams.find(t => t.id === match.homeTeamId)?.name || '???';
                    const awayTeamName = teams.find(t => t.id === match.awayTeamId)?.name || '???';
                    html += `<tr class="match-row postponed"><td colspan="3" style="text-align:center; padding:12px; color:var(--accent-amber);"><strong>${homeTeamName} vs ${awayTeamName} (Odloženo)</strong></td></tr>`;
                }
                html += `</tbody></table>`;
                continue;
            }

            const dateValue = new Date(`${dateKey}T12:00:00`);
            const formattedDate = Number.isNaN(dateValue.getTime())
                ? dateKey
                : new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Europe/Prague' }).format(dateValue);
            
            html += `
            <div class="date-divider date-divider-subtle">
                <span class="date-badge">📅 ${formattedDate}</span>
                <div class="date-line"></div>
            </div>`;

            html += `<table class="matches-table">
                    <colgroup>
                        <col style="width: calc(45%);">
                        <col style="width: 5%;">
                        <col style="width: calc(45%);">
                    </colgroup>
                    <thead class="matches-table-header">
                        <tr><th colspan="3">Zápasy</th></tr>
                    </thead>
                    <tbody>`;

            for (const match of dateGroup.matches) {
                // Najdeme objekty týmů, abychom měli přístup k logům
                const homeTeamObj = teams.find(t => t.id === match.homeTeamId);
                const awayTeamObj = teams.find(t => t.id === match.awayTeamId);

                const homeTeamName = homeTeamObj?.name || '???';
                const awayTeamName = awayTeamObj?.name || '???';

                const homeLogoUrl = homeTeamObj?.logo ? `/logoteamu/${homeTeamObj.logo}` : '/images/logo.png';
                const awayLogoUrl = awayTeamObj?.logo ? `/logoteamu/${awayTeamObj.logo}` : '/images/logo.png';

                const existingTip = currentUserMatchTips.find(t => String(t.matchId) === String(match.id));
                const selectedWinner = existingTip?.winner;

                // Zjištění, zda je zápas zamčen (buď manuálně, odložením, nebo časem)
                const isLockedManually = match.locked === true;
                const matchStartPrague = toPragueDateTime(match.datetime || match.date);
                const matchStarted = isLockedManually || match.postponed || Boolean(matchStartPrague && matchStartPrague <= currentPragueTimeISO);
                const vsText = isLockedManually ? '🔒' : 'vs';
const matchTime = matchStartPrague?.slice(11, 16) || '';
const isPlayoff = match.isPlayoff;
const tipsBreakdown = matchStarted ? getMatchTipsBreakdown(match, allUsers, selectedSeason, selectedLiga, username, false) : null;
const homeTipsHtml = tipsBreakdown ? renderMatchTipsSide(tipsBreakdown.home, match.id, 'home', homeTeamName, false) : '';
const awayTipsHtml = tipsBreakdown ? renderMatchTipsSide(tipsBreakdown.away, match.id, 'away', awayTeamName, false) : '';

                if (match.postponed) {
                    html += `<tr class="match-row postponed"><td colspan="3" style="text-align:center; padding:12px; color:var(--accent-amber);"><strong>${homeTeamName} vs ${awayTeamName} (Odloženo)</strong></td></tr>`;
                } else if (!isPlayoff) {
                    // --- ZÁKLADNÍ ČÁST (Simple Match) ---
                    html += `
<tr class="match-row simple-match-row ${matchStarted ? 'is-locked' : ''}" data-match-id="${match.id}">
    <td style="width: calc(45%);">
        <button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" data-winner="home" ${matchStarted ? 'disabled' : ''}>
            <div class="team-info-row">
                <div class="team-logo-small-wrap"><img src="${homeLogoUrl}" alt=""></div>
                <span>${homeTeamName}</span>
            </div>
        </button>
        ${homeTipsHtml}
    </td>
    <td class="vs"><div class="vs-inner"><span class="match-vs">${vsText}</span>${matchTime ? `<span class="match-time">${matchTime}</span>` : ''}</div></td>
    <td style="width: calc(45%);">
        <button type="button" class="team-link away-btn ${selectedWinner === "away" ? "selected" : ""}" data-winner="away" ${matchStarted ? 'disabled' : ''}>
            <div class="team-info-row" style="justify-content: flex-end; width:100%;">
                <span>${awayTeamName}</span>
                <div class="team-logo-small-wrap"><img src="${awayLogoUrl}" alt=""></div>
            </div>
        </button>
        ${awayTipsHtml}
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
                            // Pokud je v adminu nastaven sideSwap, vizuálně prohodíme jména v řádku
                            const displayHome = pm.sideSwap ? awayTeamName : homeTeamName;
                            const displayAway = pm.sideSwap ? homeTeamName : awayTeamName;
                            const displayScoreH = pm.sideSwap ? pm.scoreAway : pm.scoreHome;
                            const displayScoreA = pm.sideSwap ? pm.scoreHome : pm.scoreAway;
                            const hWinnerClass = (pm.scoreHome > pm.scoreAway && !pm.sideSwap) || (pm.scoreAway > pm.scoreHome && pm.sideSwap);
                            const aWinnerClass = (pm.scoreAway > pm.scoreHome && !pm.sideSwap) || (pm.scoreHome > pm.scoreAway && pm.sideSwap);

                            if (hWinnerClass) currentH++; else if (aWinnerClass) currentA++;

                            return `
                                <div class="playoff-series-game">
                                    <span class="playoff-series-game-number">${idx + 1}.</span>
                                    <span class="playoff-series-game-team home ${hWinnerClass ? 'winner' : ''}">${displayHome}</span>
                                    <span class="playoff-series-game-score">
                                        ${displayScoreH}:${displayScoreA}${pm.ot ? '<small>p</small>' : ''}
                                    </span>
                                    <span class="playoff-series-game-team away ${aWinnerClass ? 'winner' : ''}">${displayAway}</span>
                                </div>
                            `;
                        }).join('');

                        playedMatchesHtml = `
                            <tr class="played-matches-row" style="background: transparent; border-top: none;">
                                <td colspan="3" style="padding: 0; border-top: none;">
                                    <div class="playoff-series-progress">
                                        <div class="playoff-series-header">
                                            <span>Průběh série</span>
                                            <span class="playoff-series-score">${currentH}:${currentA}</span>
                                        </div>
                                        <div class="playoff-series-matches">
                                            ${detailedRows}
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        `;
                    }

                    html += `
        <tr class="match-row playoff-parent-row" data-match-id="${match.id}">
    <td style="width: calc(45%);">
        <button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" data-winner="home" ${matchStarted ? 'disabled' : ''}>
            <div class="team-info-row">
                <div class="team-logo-small-wrap"><img src="${homeLogoUrl}" alt=""></div>
                <span>${homeTeamName}</span>
            </div>
        </button>
        ${homeTipsHtml}
    </td>
    <td class="vs"><div class="vs-inner"><span class="match-vs">${vsText}</span>${matchTime ? `<span class="match-time">${matchTime}</span>` : ''}</div></td>
    <td style="width: calc(45%);">
        <button type="button" class="team-link away-btn ${selectedWinner === "away" ? "selected" : ""}" data-winner="away" ${matchStarted ? 'disabled' : ''}>
            <div class="team-info-row" style="justify-content: flex-end; width:100%;">
                <span>${awayTeamName}</span>
                <div class="team-logo-small-wrap"><img src="${awayLogoUrl}" alt=""></div>
            </div>
        </button>
        ${awayTipsHtml}
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

        html += `</section></main><script>
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
    body: formData.toString()
})
.then(async res => {
    if (!res.ok) {
        const message = await res.text();
        throw new Error(message || 'Chyba při ukládání tipu.');
    }
    if(homeBtn) { homeBtn.classList.toggle('selected', winner === 'home'); if(winner === 'home' && awayBtn) awayBtn.classList.remove('selected'); }
    if(awayBtn) { awayBtn.classList.toggle('selected', winner === 'away'); if(winner === 'away' && homeBtn) homeBtn.classList.remove('selected'); }
    if(loserRow) loserRow.style.display = 'table-row';
})
.catch(err => { console.error('Tip se nepodařilo uložit:', err); alert(err.message || 'Chyba připojení.'); });
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
    if (!sidebar) return;

    // Načíst verzi a zobrazit v badge
    fetch('/api/version')
        .then(res => res.json())
        .then(data => {
            const versionBadge = document.getElementById('current-version');
            if (versionBadge) {
                versionBadge.textContent = data.version;
            }
        })
        .catch(err => console.error('Nepodařilo se načíst verzi', err));
});
</script></body></html>`;
        res.send(html);
});

// =========================================================
// 1. VÝBĚR HISTORIE (VŠECHNY LIGY & SEZÓNY)
// =========================================================
router.get('/history', requireLogin, async (req, res) => {
    try {
        const { Transfers, TransferLeagues, Leagues, Matches } = require('../utils/mongoDataAccess');

        const [allSeasonData, matches, transfersData, transferLeaguesData] = await Promise.all([
            Leagues.findAll().catch(err => { console.error('Chyba načtení Leagues:', err); return {}; }),
            Matches.findAll().catch(err => { console.error('Chyba načtení Matches:', err); return []; }),
            Transfers.findAll().catch(err => { console.error('Chyba načtení Transfers:', err); return {}; }),
            TransferLeagues.findAll().catch(err => { console.error('Chyba načtení TransferLeagues:', err); return {}; })
        ]);

        const isTransferEnabled = (season, leagueName) => {
            const hasData = transfersData?.[season]?.[leagueName] && Object.keys(transfersData[season][leagueName]).length > 0;
            if (hasData) return true;

            if (Array.isArray(transferLeaguesData)) {
                return transferLeaguesData.includes(leagueName);
            }
            if (transferLeaguesData?.[season]) {
                if (Array.isArray(transferLeaguesData[season])) {
                    return transferLeaguesData[season].includes(leagueName);
                }
                return !!transferLeaguesData[season][leagueName];
            }
            return false;
        };

        const historyMap = new Map();

        if (allSeasonData && typeof allSeasonData === 'object') {
            Object.keys(allSeasonData).forEach(season => {
                if (Array.isArray(allSeasonData[season]?.leagues)) {
                    allSeasonData[season].leagues.forEach(l => {
                        const leagueName = l.name || l;
                        const key = `${season}_${leagueName}`;
                        const hasTransfers = isTransferEnabled(season, leagueName);
                        const matchCount = Array.isArray(matches)
                            ? matches.filter(m => String(m.season) === String(season) && String(m.liga) === String(leagueName)).length
                            : 0;

                        historyMap.set(key, { season, liga: leagueName, hasTransfers, matchCount });
                    });
                }
            });
        }

        if (Array.isArray(matches)) {
            matches.forEach(m => {
                if (m.liga && m.season) {
                    const key = `${m.season}_${m.liga}`;
                    if (!historyMap.has(key)) {
                        const hasTransfers = isTransferEnabled(m.season, m.liga);
                        const matchCount = matches.filter(match => String(match.season) === String(m.season) && String(match.liga) === String(m.liga)).length;
                        historyMap.set(key, { season: m.season, liga: m.liga, hasTransfers, matchCount });
                    }
                }
            });
        }

        const history = Array.from(historyMap.values());
        const groupedBySeason = history.reduce((acc, entry) => {
            if (!acc[entry.season]) acc[entry.season] = [];
            acc[entry.season].push(entry);
            return acc;
        }, {});

        const sortedSeasons = Object.keys(groupedBySeason).sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

        let html = `
        <!DOCTYPE html>
        <html lang="cs">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
            <title>Historie lig a sezón – Tipovačka</title>
            <link rel="stylesheet" href="/css/modern-design.css">
            <script src="/js/version-notification.js"></script>
            <link rel="icon" href="/images/logo.png">
        </head>
        ${typeof renderNotificationScript === 'function' ? renderNotificationScript(req.session?.csrfToken || '') : ''}
        <body class="usersite">
            ${await renderUserHeader({
            username: req.session?.user,
            selectedLiga: '',
            uniqueLeagues: [],
            activeTab: 'history',
            csrfToken: req.session?.csrfToken || '',
            timeWidgetHtml: typeof generateTimeWidget === 'function' ? await generateTimeWidget() : ''
        })}
            <main class="layout-single-column">
                <div class="section-header">
                    <h1 class="section-title">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 0 0118 0z"/></svg>
                        Historie lig a sezón
                    </h1>
                </div>

                <div class="history-container" style="background: transparent; border: none; padding: 0; box-shadow: none;">
        `;

        if (sortedSeasons.length === 0) {
            html += `
                <div class="dashboard-section" style="text-align: center; padding: 40px 20px;">
                    <p style="color: var(--text-muted);">Zatím nebyla nalezena žádná historie lig ani sezón.</p>
                </div>
            `;
        }

        for (const season of sortedSeasons) {
            const leagues = groupedBySeason[season].sort((a, b) => a.liga.localeCompare(b.liga));

            html += `
                <div class="season-section" style="margin-bottom: 32px;">
                    <div class="date-divider" style="margin-top: 0; margin-bottom: 16px;">
                        <span class="date-badge">📅 Sezóna ${season}</span>
                        <div class="date-line"></div>
                    </div>
                    <div class="league-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px;">
            `;

            for (const entry of leagues) {
                html += `
                    <div class="league-card" style="background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); padding: 18px; display: flex; flex-direction: column; justify-content: space-between; gap: 14px; box-shadow: var(--shadow-card);">
                        <div class="league-card-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-subtle); padding-bottom: 10px;">
                            <span class="league-name" style="font-size: 16px; font-weight: 800; color: #fff;">${entry.liga}</span>
                            <span class="league-badge" style="font-size: 11px; font-weight: 700; color: var(--primary); background: var(--primary-subtle); padding: 2px 8px; border-radius: var(--radius-full);">${entry.season}</span>
                        </div>
                        
                        <div class="league-stats" style="display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--text-muted);">
                            <span>🏆 <strong>${entry.matchCount}</strong> zápasů</span>
                            ${entry.hasTransfers
                    ? '<span style="color: var(--accent-green);">📜 Přestupy dostupné</span>'
                    : '<span style="color: var(--text-dim);">📜 Přestupy nedostupné</span>'
                }
                        </div>

                        <div class="league-actions" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                            <a href="/history/a/?liga=${encodeURIComponent(entry.liga)}&season=${encodeURIComponent(entry.season)}" class="btn-secondary" style="font-size: 12px; padding: 8px 10px; text-align: center;">
                                ⚽ Zápasy
                            </a>
                            <a href="/history/table/?liga=${encodeURIComponent(entry.liga)}&season=${encodeURIComponent(entry.season)}" class="btn-secondary" style="font-size: 12px; padding: 8px 10px; text-align: center;">
                                📊 Tabulka
                            </a>
                            ${entry.hasTransfers
                    ? `<a href="/history/prestupy?liga=${encodeURIComponent(entry.liga)}&season=${encodeURIComponent(entry.season)}" class="btn-secondary" style="font-size: 12px; padding: 8px 10px; text-align: center;">
                                    📜 Přestupy
                                   </a>`
                    : `<button disabled class="btn-secondary" style="font-size: 12px; padding: 8px 10px; opacity: 0.4; cursor: not-allowed;" title="Přestupy pro tuto ligu/sezónu nejsou k dispozici">
                                    📜 Přestupy
                                   </button>`
                }
                            <a href="/history/roster?liga=${encodeURIComponent(entry.liga)}&season=${encodeURIComponent(entry.season)}" class="btn-secondary" style="font-size: 12px; padding: 8px 10px; text-align: center;">
                                👥 Soupisky
                            </a>
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
                        .catch(err => console.error('Nepodařilo se načíst verzi', err));
                });
            </script>
        </body>
        </html>
        `;

        res.send(html);

    } catch (globalErr) {
        console.error('Kritická chyba při generování stránky historie:', globalErr);
        res.status(500).send('Nastala chyba při načítání historie.');
    }
});

// =========================================================
// 2. HISTORIE PŘESTUPŮ (/history/prestupy)
// =========================================================
router.get('/history/prestupy', requireLogin, async (req, res) => {
    try {
        const { Transfers, Teams } = require('../utils/mongoDataAccess');
        const transfersData = await Transfers.findAll();
        const allTeams = await Teams.findAll();

        const selectedLiga = req.query.liga;
        const selectedSeason = req.query.season;

        if (!selectedLiga || !selectedSeason) {
            return res.redirect('/history');
        }

        const teamsInSelectedLiga = allTeams.filter(t =>
            t.liga === selectedLiga && t.season === selectedSeason && t.active
        );

        const currentTransfers = transfersData?.[selectedSeason]?.[selectedLiga] || {};

        let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<title>Přestupy – ${selectedLiga} ${selectedSeason}</title>
<link rel="stylesheet" href="/css/modern-design.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
${typeof renderNotificationScript === 'function' ? renderNotificationScript(req.session?.csrfToken || '') : ''}
<body class="usersite">
${await renderUserHeader({
            username: req.session?.user,
            selectedLiga: selectedLiga,
            uniqueLeagues: [],
            activeTab: 'history',
            csrfToken: req.session?.csrfToken || '',
            timeWidgetHtml: typeof generateTimeWidget === 'function' ? await generateTimeWidget() : ''
        })}
<main class="layout-single-column">
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom: 20px;">
        <div class="segmented-tabs">
            <a class="segmented-btn" href="/">Aktuální sezóna</a>
            <a class="segmented-btn" href="/history">← Zpět na výběr</a>
            <a class="segmented-btn" href="/history/a/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy zápasů</a>
            <a class="segmented-btn" href="/history/table/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy tabulky</a>
            <a class="segmented-btn active" href="/history/prestupy?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">📜 Přestupy</a>
            <a class="segmented-btn" href="/history/roster?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">👥 Soupisky</a>
        </div>
    </div>

    <div class="section-header">
        <div class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 3h5v5"/><path d="M4 20L21 3"/><path d="M21 16v5h-5"/><path d="M15 15l6 6"/><path d="M4 4l5 5"/></svg>
            Přestupy a Spekulace – ${selectedLiga} (${selectedSeason})
        </div>
    </div>
    <div style="display: grid; gap: 15px; width: 100%;">
`;

        const formatPlayerName = (rawName) => {
            let style = 'color: white;';
            let icon = '';
            let name = rawName;

            if (name.includes('(X)')) {
                style = 'color: #ff6666; text-decoration: line-through; opacity: 0.7;';
                icon = '❌ ';
                name = name.replace('(X)', '');
            } else if (name.includes('(-)')) {
                style = 'color: #888; text-decoration: line-through; opacity: 0.5; font-style: italic;';
                icon = '🚫 ';
                name = name.replace('(-)', '');
            } else if (name.includes('(!)')) {
                style = 'color: #ffd700; font-weight: bold; text-shadow: 0 0 8px rgba(255, 215, 0, 0.4);';
                icon = '🔥 ';
                name = name.replace('(!)', '');
            } else if (name.includes('(?)')) {
                style = 'color: #00d4ff; font-style: italic;';
                icon = '❓ ';
                name = name.replace('(?)', '');
            } else if (name.includes('(K)')) {
                style = 'color: #ffaa00; font-weight: bold;';
                icon = '📄 ';
                name = name.replace('(K)', '');
            } else if (name.includes('(loan)')) {
                style = 'color: #9b59b6; font-weight: bold; text-shadow: 0 0 8px rgba(155, 89, 182, 0.4);';
                icon = '🔄 ';
                name = name.replace('(loan)', '');
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

        if (teamsInSelectedLiga.length === 0) {
            html += `<div class="dashboard-section" style="text-align: center; padding: 40px; color: var(--text-dim);">Žádné týmy v lize ${selectedLiga} pro sezónu ${selectedSeason}</div>`;
        } else {
            teamsInSelectedLiga.sort((a, b) => (a.id || 0) - (b.id || 0)).forEach(team => {
                const tId = String(team.id);
                const tData = currentTransfers[tId] || { specIn: [], specOut: [], confIn: [], confOut: [] };
                const logoUrl = team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

                html += `
                <div class="transfer-team-card">
                    <div class="transfer-team-header">
                        <div class="transfer-team-info">
                            <img src="${logoUrl}" alt="${team.name}" class="transfer-team-logo">
                            <div class="transfer-team-title">${team.name}</div>
                        </div>
                    </div>

                    <div class="transfer-cols-grid">
                        <div class="transfer-watermark" style="background-image: url('${logoUrl}');"></div>
                        
                        <div class="transfer-col col-spec-in">
                            <div class="transfer-col-header">⚡ Spekulace IN</div>
                            ${renderList(tData.specIn)}
                        </div>

                        <div class="transfer-col col-spec-out">
                            <div class="transfer-col-header">⚡ Spekulace OUT</div>
                            ${renderList(tData.specOut)}
                        </div>

                        <div class="transfer-col col-conf-in">
                            <div class="transfer-col-header">✓ Příchody</div>
                            ${renderList(tData.confIn)}
                        </div>

                        <div class="transfer-col col-conf-out">
                            <div class="transfer-col-header">✕ Odchody</div>
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
            .catch(err => console.error('Nepodařilo se načíst verzi', err));
    });
</script>
</body>
</html>
`;

        res.send(html);
    } catch (err) {
        console.error('Chyba v /history/prestupy:', err);
        res.status(500).send('Nastala chyba při načítání historie přestupů.');
    }
});

// =========================================================
// 3. HISTORIE TIPŮ ZÁPASŮ (/history/a)
// =========================================================
router.get('/history/a', requireLogin, async (req, res) => {
    try {
        if (!req.query.liga || !req.query.season) return res.redirect('/history');

        const data = await prepareDashboardData(req, true);
        const { username, selectedSeason, selectedLiga, teams, matches, allUsers, userStats } = data;

        const { TransferLeagues } = require('../utils/mongoDataAccess');
        const transferLeaguesData = await TransferLeagues.findAll().catch(() => ({}));
        const hasTransferLeagues = Array.isArray(transferLeaguesData)
            ? transferLeaguesData.includes(selectedLiga)
            : (transferLeaguesData?.[selectedSeason]?.includes(selectedLiga) || false);

        const usersWithTips = allUsers.filter(u => u.tips?.[selectedSeason]?.[selectedLiga]?.length > 0).sort((a, b) => a.username.localeCompare(b.username));
        const initialUser = usersWithTips.find(u => u.username === username) ? username : (usersWithTips[0]?.username || "");

        let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<title>Tipovačka – Historie ${selectedLiga} ${selectedSeason}</title>
<link rel="stylesheet" href="/css/modern-design.css" />
<script src="/js/version-notification.js"></script>
<script src="/js/match-tips.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
${typeof renderNotificationScript === 'function' ? renderNotificationScript(req.session?.csrfToken || '') : ''}
<body class="usersite">
${await renderUserHeader({
            username: username,
            selectedLiga: selectedLiga,
            uniqueLeagues: [],
            activeTab: 'history',
            csrfToken: req.session?.csrfToken || '',
            timeWidgetHtml: typeof generateTimeWidget === 'function' ? await generateTimeWidget() : ''
        })}
<main class="main_page">
<div style="grid-column: 1 / -1; margin-bottom: 12px;">
    <div class="segmented-tabs">
        <a class="segmented-btn" href="/">Aktuální sezóna</a>
        <a class="segmented-btn" href="/history">← Zpět na výběr</a>
        <a class="segmented-btn active" href="/history/a/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy zápasů</a>
        <a class="segmented-btn" href="/history/table/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy tabulky</a>
        ${hasTransferLeagues
            ? `<a class="segmented-btn" href="/history/prestupy?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">📜 Přestupy</a>`
            : ''
        }
        <a class="segmented-btn" href="/history/roster?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">👥 Soupisky</a>
    </div>
</div>
`;
        html += await generateLeftPanel(data, true);
        html += `<script>
        const globalStatsData = ${JSON.stringify(userStats)};

        fetch('/api/version')
            .then(res => res.json())
            .then(data => {
                const versionBadge = document.getElementById('current-version');
                if (versionBadge) versionBadge.textContent = data.version;
            })
            .catch(err => console.error('Nepodařilo se načíst verzi', err));

        function showUserHistory(username) {
    const safeName = username.replace(/[^a-zA-Z0-9]/g, '_');

    document.querySelectorAll('.history-team-wrapper').forEach(wrapper => {
        // 1. Najdeme skrytý span s informací o třídě (right-selected / wrong-selected)
        const activeItem = wrapper.querySelector('span.history-item.user-' + safeName + ':not(.badge)');
        const parentBtn = wrapper.querySelector('.team-link');
        if (!parentBtn) return;

        // Resetujeme předchozí výběry
        parentBtn.classList.remove('selected', 'right-selected', 'wrong-selected');

        // Pokud daný uživatel tipoval tento tým
        if (activeItem) {
            const statusClass = activeItem.dataset.tdClass;
            if (statusClass) {
                parentBtn.classList.add('selected', statusClass);
            }
        }

        // 2. Schováme VŠECHNY bodové odznaky v tomto týmu
        wrapper.querySelectorAll('span.badge.history-item').forEach(badge => {
            badge.style.display = 'none';
        });

        // 3. Zobrazíme POUZE bodový odznak nově vybraného uživatele
        const activeBadge = wrapper.querySelector('span.badge.history-item.user-' + safeName);
        if (activeBadge) {
            activeBadge.style.display = 'inline-flex';
        }
    });

    // 4. Přepnutí skóre pro Playoff
    document.querySelectorAll('.history-score-wrapper').forEach(wrapper => {
        wrapper.querySelectorAll('.history-score-item').forEach(el => el.style.display = 'none');
        const activeScore = wrapper.querySelector('.user-' + safeName);
        if (activeScore) {
            activeScore.style.display = 'flex';
        }
    });
}

        
function toggleSeriesDetails(btn) {
            const details = btn.nextElementSibling;
            const expanded = btn.getAttribute('aria-expanded') === 'true';
            details.hidden = expanded;
            btn.setAttribute('aria-expanded', String(!expanded));
            btn.querySelector('.series-toggle-icon').textContent = expanded ? '▾' : '▴';
        }
        </script>
        <section class="matches-container">
            <div class="section-header" style="justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                <div class="section-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 0 0118 0z"/></svg>
                    Historie tipů zápasů
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label for="historyUserSelect" style="color: var(--text-muted); font-size: 13px; font-weight: 600;">Zobrazit tipéra:</label>
                    <select id="historyUserSelect" class="modern-select" onchange="showUserHistory(this.value)" style="width: auto; padding: 6px 12px; font-weight: 700;">`;

        if (usersWithTips.length === 0) {
            html += `<option disabled selected>Žádná data</option>`;
        } else {
            usersWithTips.forEach(u => {
                const isSelected = u.username === initialUser ? 'selected' : '';
                html += `<option value="${u.username}" ${isSelected}>${u.username}</option>`;
            });
        }

        html += `   </select></div></div>`;

        const groupedMatches = matches
            .filter(m => m.liga === selectedLiga && m.result && m.season === selectedSeason)
            .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))
            .reduce((groups, match) => {
                const dateTime = match.datetime || match.date || "Neznámý čas";
                const datePart = dateTime.includes('T') ? dateTime.split('T')[0] : dateTime.split(' ')[0];
                if (!groups[datePart]) groups[datePart] = [];
                groups[datePart].push(match);
                return groups;
            }, {});

        const renderUserTip = (u, match, type) => {
            const userTip = u.tips?.[selectedSeason]?.[selectedLiga]?.find(t => Number(t.matchId) === Number(match.id));
            const selectedWinner = userTip?.winner;
            const bo = match.bo || 1;
            const isPlayoffBo1 = match.isPlayoff && bo === 1;

            const safeUser = u.username.replace(/[^a-zA-Z0-9]/g, '_');
            const isInitial = u.username === initialUser;

            let earnedPoints = 0;
            let isCorrectTip = selectedWinner === match.result?.winner;

            if (isCorrectTip) {
                if (!match.isPlayoff) {
                    earnedPoints = 1;
                } else if (isPlayoffBo1) {
                    const tH = userTip?.scoreHome ?? 0;
                    const tA = userTip?.scoreAway ?? 0;
                    const totalDiff = Math.abs(tH - match.result.scoreHome) + Math.abs(tA - match.result.scoreAway);
                    if (totalDiff === 0) earnedPoints = 5;
                    else if (totalDiff === 1) earnedPoints = 4;
                    else if (totalDiff === 2) earnedPoints = 3;
                    else earnedPoints = 1;
                } else if (match.isPlayoff && bo > 1) {
                    let realLoserWins = match.result.winner === 'home' ? (match.result.scoreAway || 0) : (match.result.scoreHome || 0);
                    if (parseInt(userTip?.loserWins) === realLoserWins) {
                        earnedPoints = 3;
                    } else {
                        earnedPoints = 1;
                    }
                }
            }

            if (type === 'home' || type === 'away') {
                const isSelected = selectedWinner === type;
                const tdStatusClass = isSelected ? (isCorrectTip ? 'right-selected' : 'wrong-selected') : '';

                let badgeStyle = "background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid #ef4444;";
                if (isCorrectTip) {
                    badgeStyle = "background: rgba(34, 197, 94, 0.2); color: #22c55e; border: 1px solid #22c55e;";
                }

                // Badge s body pro ZČ (s mezerou od fajfky/textu)
                // Místo staré podmínky (isSelected && !match.isPlayoff)
                const pointsBadgeHtml = (!match.isPlayoff && isSelected) ? `
                    <span class="badge history-item user-${safeUser}" style="display:${isInitial ? 'inline-flex' : 'none'}; ${badgeStyle} font-weight: 800; padding: 2px 7px; border-radius: var(--radius-md); font-size: 11px; flex-shrink: 0; margin-left: 5px; margin-right: 5px;">
                    ${earnedPoints > 0 ? `+${earnedPoints} b.` : '0 b.'}
                    </span>
                ` : '';

                return {
                    html: isSelected ? `<span class="history-item user-${safeUser}" data-td-class="${tdStatusClass}" style="display:none;"></span>` : '',
                    pointsBadgeHtml,
                    isSelected,
                    tdStatusClass
                };
            }

            if (type === 'score' && match.isPlayoff) {
                let content = 'Netipováno';
                if (selectedWinner) {
                    content = bo === 1 ? `${userTip?.scoreHome ?? 0} : ${userTip?.scoreAway ?? 0}` : `Série: ${userTip?.loserWins ?? 0} výher poraženého`;
                }

                let badgeStyle = "background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid #ef4444;";
                if (isCorrectTip) {
                    badgeStyle = "background: rgba(34, 197, 94, 0.15); color: #22c55e; border: 1px solid #22c55e;";
                }

                return {
                    html: `
            <div class="history-score-item user-${safeUser}" style="display:${isInitial ? 'flex' : 'none'}; align-items:center; justify-content:center; gap:12px; width:100%;">
                <span style="color: var(--text-muted); font-size: 13px;">Tip skóre: <strong style="color: #fff; font-size: 14px;">${content}</strong></span>
                <span class="badge" style="${badgeStyle} font-weight: 800; padding: 3px 10px; border-radius: var(--radius-md); font-size: 12px;">
                    ${earnedPoints > 0 ? `+${earnedPoints} b.` : '0 b.'}
                </span>
            </div>`
                };
            }

            return { html: '' };
        };

        for (const [dateKey, matchesOnDate] of Object.entries(groupedMatches)) {
            const dateValue = new Date(`${dateKey}T12:00:00`);
            const formattedDate = Number.isNaN(dateValue.getTime())
                ? dateKey
                : new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Europe/Prague' }).format(dateValue);

            html += `
            <div class="date-divider date-divider-subtle">
                <span class="date-badge">📅 ${formattedDate}</span>
                <div class="date-line"></div>
            </div>
            <table class="matches-table">
                <colgroup>
                    <col style="width: calc(45%);">
                    <col style="width: 5%;">
                    <col style="width: calc(45%);">
                </colgroup>
                <thead class="matches-table-header">
                    <tr><th colspan="3">Výsledky & Tipy</th></tr>
                </thead>
                <tbody>`;

            for (const match of matchesOnDate) {
                const homeTeamObj = teams.find(t => t.id === match.homeTeamId);
                const awayTeamObj = teams.find(t => t.id === match.awayTeamId);

                const homeTeamName = homeTeamObj?.name || '???';
                const awayTeamName = awayTeamObj?.name || '???';

                const homeLogoUrl = homeTeamObj?.logo ? `/logoteamu/${homeTeamObj.logo}` : '/images/logo.png';
                const awayLogoUrl = awayTeamObj?.logo ? `/logoteamu/${awayTeamObj.logo}` : '/images/logo.png';

                const matchTime = match.datetime ? match.datetime.slice(11, 16) : '';
                const isOvertimeOrShooting = match.result?.ot === true;

                let homeCellItems = "", awayCellItems = "", scoreCellHTML = "";
                let initHomeClass = "", initAwayClass = "";

                const tipsBreakdown = getMatchTipsBreakdown(match, allUsers, selectedSeason, selectedLiga, username, true);
                const homeTipsHtml = renderMatchTipsSide(tipsBreakdown.home, match.id, 'home', homeTeamName, true);
                const awayTipsHtml = renderMatchTipsSide(tipsBreakdown.away, match.id, 'away', awayTeamName, true);

                usersWithTips.forEach(u => {
                    const homeRes = renderUserTip(u, match, 'home');
                    const awayRes = renderUserTip(u, match, 'away');

                    // Přidáváme JAK skrytý element se stavem, TAK bodový badge pro VŠECHNY uživatele
                    homeCellItems += homeRes.html + homeRes.pointsBadgeHtml;
                    awayCellItems += awayRes.html + awayRes.pointsBadgeHtml;

                    if (match.isPlayoff) {
                        const scoreRes = renderUserTip(u, match, 'score');
                        scoreCellHTML += scoreRes.html;
                    }

                    if (u.username === initialUser) {
                        if (homeRes.isSelected) {
                            initHomeClass = homeRes.tdStatusClass;
                        }
                        if (awayRes.isSelected) {
                            initAwayClass = awayRes.tdStatusClass;
                        }
                    }
                });

                html += `
<tr class="match-row simple-match-row">
    <td style="width: calc(45%);">
        <div class="history-team-wrapper">
            <div class="team-link home-btn ${initHomeClass ? 'selected ' + initHomeClass : ''}" style="cursor: default;">
                <div class="team-info-row" style="display: flex; align-items: center; justify-content: space-between; width: 100%; min-width: 0;">
                    <!-- Levá strana: Logo a Název týmu -->
                    <div style="display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden;">
                        <div class="team-logo-small-wrap" style="flex-shrink: 0;"><img src="${homeLogoUrl}" alt=""></div>
                        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${homeTeamName}</span>
                    </div>
                    <!-- Pravá strana: Všechny připravené odznaky (drží v jedné řadě) -->
                    <div style="display: flex; align-items: center; gap: 5px; margin-left: auto; flex-shrink: 0; white-space: nowrap;">
                        ${homeCellItems}
                    </div>
                </div>
            </div>
            ${homeTipsHtml}
        </div>
    </td>
        <td class="vs">
        <div class="vs-inner vs-history">
            <span class="match-vs">${match.result?.scoreHome ?? 0}:${match.result?.scoreAway ?? 0}</span>
            ${isOvertimeOrShooting ? `<span class="vs-ot">pp/sn</span>` : ''}
            ${matchTime ? `<span class="match-time">${matchTime}</span>` : ''}
        </div>
    </td>
    <td style="width: calc(45%);">
        <div class="history-team-wrapper">
            <div class="team-link away-btn ${initAwayClass ? 'selected ' + initAwayClass : ''}" style="cursor: default;">
                <div class="team-info-row" style="display: flex; align-items: center; justify-content: space-between; width: 100%; min-width: 0;">
                    <!-- Levá strana u hostů: Všechny připravené odznaky -->
                    <div style="display: flex; align-items: center; gap: 5px; margin-right: auto; flex-shrink: 0; white-space: nowrap;">
                        ${awayCellItems}
                    </div>
                    <!-- Pravá strana u hostů: Název týmu a Logo -->
                    <div style="display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden;">
                        <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${awayTeamName}</span>
                        <div class="team-logo-small-wrap" style="flex-shrink: 0;"><img src="${awayLogoUrl}" alt=""></div>
                    </div>
                </div>
            </div>
            ${awayTipsHtml}
        </div>
    </td>
</tr>`;

                if (match.isPlayoff && match.bo > 1 && match.playedMatches && match.playedMatches.length > 0) {
                    let seriesHomeWins = 0;
                    let seriesAwayWins = 0;

                    const detailedRows = match.playedMatches.map((pm, idx) => {
                        const displayHome = pm.sideSwap ? awayTeamName : homeTeamName;
                        const displayAway = pm.sideSwap ? homeTeamName : awayTeamName;
                        const displayScoreH = pm.sideSwap ? pm.scoreAway : pm.scoreHome;
                        const displayScoreA = pm.sideSwap ? pm.scoreHome : pm.scoreAway;

                        const hWinner = pm.scoreHome > pm.scoreAway;
                        if (hWinner) seriesHomeWins++; else seriesAwayWins++;

                        return `
                        <div class="playoff-series-game">
                            <span class="playoff-series-game-number">${idx + 1}.</span>
                            <span class="playoff-series-game-team home ${hWinner ? 'winner' : ''}">${displayHome}</span>
                            <span class="playoff-series-game-score">
                                ${displayScoreH}:${displayScoreA}${pm.ot ? '<small>p</small>' : ''}
                            </span>
                            <span class="playoff-series-game-team away ${!hWinner ? 'winner' : ''}">${displayAway}</span>
                        </div>`;
                    }).join('');

                    html += `
                    <tr class="played-matches-row" style="background: transparent; border-top: none;">
                        <td colspan="3" style="padding: 0; border-top: none;">
                            <div class="playoff-series-progress">
                            <button type="button" class="playoff-series-header" onclick="toggleSeriesDetails(this)" aria-expanded="false" aria-controls="series-details-${match.id}" style="justify-content: center; gap: 15px;">
                                <span>Průběh série</span>
                                <span class="playoff-series-score" style="margin: 0;">${seriesHomeWins}:${seriesAwayWins}</span>
                                <span class="series-toggle-icon" aria-hidden="true">▾</span>
                            </button>
                            <div id="series-details-${match.id}" class="series-details playoff-series-matches" hidden>
                                ${detailedRows}
                            </div>
                            </div>
                        </td>
                    </tr>`;
                }

                // Tento řádek se teď vykresluje pro VŠECHNY ZÁPASY (ZČ i Playoff)
                html += `
                <tr class="match-row score-row">
                    <td colspan="3" style="padding: 8px 12px; background: var(--bg-card); border-top: none; text-align: center;">
                        <div class="history-score-wrapper">${scoreCellHTML}</div>
                    </td>
                </tr>`;
            }
            html += `</tbody></table>`;
        }

        html += `</section></main></body></html>`;
        res.send(html);
    } catch (err) {
        console.error('Chyba v /history/a:', err);
        res.status(500).send('Nastala chyba při načítání historie zápasů.');
    }
});

// =========================================================
// 4. HISTORIE TIPŮ TABULKY (/history/table)
// =========================================================
router.get('/history/table', requireLogin, async (req, res) => {
    try {
        if (!req.query.liga || !req.query.season) return res.redirect('/history');

        const data = await prepareDashboardData(req, true);
        const { username, selectedSeason, selectedLiga, sortedGroupKeys, groupedTeams, globalRealRankMap, allUsers, tableTips, isTipsLocked } = data;

        const { TransferLeagues } = require('../utils/mongoDataAccess');
        const transferLeaguesData = await TransferLeagues.findAll().catch(() => ({}));
        const hasTransferLeagues = Array.isArray(transferLeaguesData)
            ? transferLeaguesData.includes(selectedLiga)
            : (transferLeaguesData?.[selectedSeason]?.includes(selectedLiga) || false);

        const usersWithTableTips = allUsers.filter(u => tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username]).sort((a, b) => a.username.localeCompare(b.username));
        const initialUser = usersWithTableTips.find(u => u.username === username) ? username : (usersWithTableTips[0]?.username || "");

        let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<title>Tipovačka – Historie tabulky ${selectedLiga} ${selectedSeason}</title>
<link rel="stylesheet" href="/css/modern-design.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
${typeof renderNotificationScript === 'function' ? renderNotificationScript(req.session?.csrfToken || '') : ''}
<body class="usersite">
${await renderUserHeader({
            username: username,
            selectedLiga: selectedLiga,
            uniqueLeagues: [],
            activeTab: 'history',
            csrfToken: req.session?.csrfToken || '',
            timeWidgetHtml: typeof generateTimeWidget === 'function' ? await generateTimeWidget() : ''
        })}
<main class="main_page">
<div style="grid-column: 1 / -1; margin-bottom: 12px;">
    <div class="segmented-tabs">
        <a class="segmented-btn" href="/">Aktuální sezóna</a>
        <a class="segmented-btn" href="/history">← Zpět na výběr</a>
        <a class="segmented-btn" href="/history/a/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy zápasů</a>
        <a class="segmented-btn active" href="/history/table/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy tabulky</a>
        ${hasTransferLeagues
            ? `<a class="segmented-btn" href="/history/prestupy?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">📜 Přestupy</a>`
            : ''
        }
        <a class="segmented-btn" href="/history/roster?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">👥 Soupisky</a>
    </div>
</div>
`;
        html += await generateLeftPanel(data, true);
        html += `
        <script>
        function showUserTableHistory(username) {
            document.querySelectorAll('.user-history-table-container').forEach(el => el.style.display = 'none');
            const safeName = username.replace(/[^a-zA-Z0-9]/g, '_');
            document.querySelectorAll('.user-table-' + safeName).forEach(el => el.style.display = 'block');
        }

        fetch('/api/version')
            .then(res => res.json())
            .then(data => {
                const versionBadge = document.getElementById('current-version');
                if (versionBadge) versionBadge.textContent = data.version;
            })
            .catch(err => console.error('Nepodařilo se načíst verzi', err));
        </script>
        <section class="matches-container">
            <div class="section-header" style="justify-content: space-between; flex-wrap: wrap; gap: 10px;">
                <div class="section-title">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
                    Historie tipů tabulky
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label for="historyUserSelect" style="color: var(--text-muted); font-size: 13px; font-weight: 600;">Zobrazit tipéra:</label>
                    <select id="historyUserSelect" class="modern-select" onchange="showUserTableHistory(this.value)" style="width: auto; padding: 6px 12px; font-weight: 700;">`;

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
            html += `<div class="dashboard-section" style="text-align: center; color: var(--text-muted);">V této sezóně nikdo netipoval tabulku.</div>`;
        } else {
            usersWithTableTips.forEach(u => {
                const safeName = u.username.replace(/[^a-zA-Z0-9]/g, '_');
                const isVisible = u.username === initialUser ? 'block' : 'none';
                const userTipData = tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username] || {};

                html += `<div class="user-history-table-container user-table-${safeName}" style="display:${isVisible};">`;
                for (const gKey of sortedGroupKeys) {
                    const groupLabel = typeof getGroupDisplayLabel === 'function' ? getGroupDisplayLabel(gKey) : gKey;
                    const isGroupLocked = (isTipsLocked === true) || (Array.isArray(isTipsLocked) && isTipsLocked.includes(gKey));

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

                    html += `<div style="margin-top: 15px;">
                        ${groupLabel ? `<h3 style="border-bottom:1px solid var(--border-subtle); padding-bottom: 8px; font-size: 15px; margin-bottom: 12px;">${groupLabel}</h3>` : ''}
                        <ul class="sortable-list" style="margin-top: 0;">`;

                    teamsForTip.forEach((team, index) => {
                        const userRank = index + 1;
                        const realRank = globalRealRankMap[team.id] || '?';
                        const diff = userRank - realRank;
                        const isCorrect = (diff === 0);
                        const logoUrl = team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

                        let diffText;
                        let diffColor = "var(--text-dim)";

                        if (hasTip) {
                            if (isGroupLocked) {
                                if (isCorrect) {
                                    diffText = "✔ Trefa (+1)";
                                    diffColor = "var(--accent-green)";
                                } else {
                                    diffText = `Skutečnost: ${realRank}. (${Math.abs(diff)})`;
                                    diffColor = "var(--accent-amber)";
                                }
                            } else {
                                diffText = `Uloženo`;
                                diffColor = "var(--text-muted)";
                            }
                        } else {
                            diffText = "Netipováno";
                        }

                        html += `
                        <li class="sortable-item ${isCorrect && isGroupLocked ? 'is-correct' : ''}" style="cursor: default; opacity: 0.95;">
                            <span class="sortable-rank">${userRank}</span>
                            <div class="team-cell">
                                <img src="${logoUrl}" alt="" class="team-logo-small">
                                <span class="sortable-team-name">${team.name}</span>
                            </div>

                            <div style="display:flex; align-items:center; gap: 12px; margin-left: auto;">
                                <span style="color: ${diffColor}; font-weight: 700; font-size: 12px;">${diffText}</span>
                            </div>
                        </li>`;
                    });
                    html += `</ul></div>`;
                }
                html += `</div>`;
            });
        }

        html += `</section></main></body></html>`;
        res.send(html);
    } catch (err) {
        console.error('Chyba v /history/table:', err);
        res.status(500).send('Nastala chyba při načítání historie tabulky.');
    }
});

// =========================================================
// 5. HISTORIE SOUPISEK (/history/roster)
// =========================================================
router.get('/history/roster', requireLogin, async (req, res) => {
    try {
        if (!req.query.liga || !req.query.season) return res.redirect('/history');

        const data = await prepareDashboardData(req, true);
        const { username, selectedSeason, selectedLiga, teamsInSelectedLiga } = data;
        teamsInSelectedLiga.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));

        let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<title>Soupisky – ${selectedLiga} ${selectedSeason}</title>
<link rel="stylesheet" href="/css/modern-design.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
${typeof renderNotificationScript === 'function' ? renderNotificationScript(req.session?.csrfToken || '') : ''}
<body class="usersite">
${await renderUserHeader({
            username: username,
            selectedLiga: selectedLiga,
            uniqueLeagues: [],
            activeTab: 'history',
            csrfToken: req.session?.csrfToken || '',
            timeWidgetHtml: typeof generateTimeWidget === 'function' ? await generateTimeWidget() : ''
        })}
<main class="layout-single-column">
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom: 20px;">
        <div class="segmented-tabs">
            <a class="segmented-btn" href="/">Aktuální sezóna</a>
            <a class="segmented-btn" href="/history">← Zpět na výběr</a>
            <a class="segmented-btn" href="/history/a/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy zápasů</a>
            <a class="segmented-btn" href="/history/table/?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">Tipy tabulky</a>
            <a class="segmented-btn" href="/history/prestupy?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">📜 Přestupy</a>
            <a class="segmented-btn active" href="/history/roster?liga=${encodeURIComponent(selectedLiga)}&season=${encodeURIComponent(selectedSeason)}">👥 Soupisky</a>
        </div>
    </div>

    <div class="section-header">
        <div class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Soupisky – ${selectedLiga} (${selectedSeason})
        </div>
    </div>

    <div id="allRostersView" class="all-rosters-grid" data-team-ids='${JSON.stringify(teamsInSelectedLiga.map(t => t.id))}' data-teams='${JSON.stringify(teamsInSelectedLiga)}' data-season='${selectedSeason}'></div>

<script>
function escapeRosterHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]);
}

const rosterLogoColorCache = new Map();

function getRosterLogoColor(logoUrl) {
    if (rosterLogoColorCache.has(logoUrl)) return rosterLogoColorCache.get(logoUrl);

    const colorPromise = new Promise(resolve => {
        const image = new Image();
        image.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 40;
                canvas.height = 40;
                const context = canvas.getContext('2d', { willReadFrequently: true });
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                const colors = new Map();

                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index + 3] < 80) continue;
                    const red = pixels[index];
                    const green = pixels[index + 1];
                    const blue = pixels[index + 2];
                    const key = [red >> 3, green >> 3, blue >> 3].join(',');
                    const color = colors.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
                    color.red += red;
                    color.green += green;
                    color.blue += blue;
                    color.count += 1;
                    colors.set(key, color);
                }

                const toHex = value => Math.round(value).toString(16).padStart(2, '0');
                const rankedColors = [...colors.values()].sort((first, second) => second.count - first.count);
                if (!rankedColors.length) return resolve(['#53617a']);
                const isTeamColor = color => {
                    const red = color.red / color.count;
                    const green = color.green / color.count;
                    const blue = color.blue / color.count;
                    return Math.max(red, green, blue) - Math.min(red, green, blue) >= 40;
                };
                const teamColors = rankedColors.filter(isTeamColor);
                const candidates = teamColors.length ? teamColors : rankedColors;
                const primary = candidates[0];
                const secondary = candidates.slice(1).find(color => {
                    const red = primary.red / primary.count - color.red / color.count;
                    const green = primary.green / primary.count - color.green / color.count;
                    const blue = primary.blue / primary.count - color.blue / color.count;
                    return red * red + green * green + blue * blue >= 32 * 32;
                });
                const dominant = secondary ? [primary, secondary] : [primary];
                resolve(dominant.map(color =>
                    '#' + toHex(color.red / color.count) + toHex(color.green / color.count) + toHex(color.blue / color.count)
                ));
            } catch (error) {
                console.warn('Barvu dresu se nepodařilo určit z loga.', error);
                resolve(['#53617a']);
            }
        };
        image.onerror = () => resolve(['#53617a']);
        image.src = logoUrl;
    });

    rosterLogoColorCache.set(logoUrl, colorPromise);
    return colorPromise;
}

function isLightRosterColor(hexColor) {
    const match = /^#([0-9a-f]{6})$/i.exec(hexColor || '');
    if (!match) return false;
    const value = parseInt(match[1], 16);
    const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.55;
}

async function renderRosterContent(data) {
    const positionList = ['Brankář', 'Obránce', 'Útočník', 'Centr', 'Křídlo', 'Jiné'];
    const positions = Object.fromEntries(positionList.map(position => [position, []]));
    const defaultPosition = 'Jiné';
    const jerseyColors = await getRosterLogoColor(data.logoUrl);
    const jerseyPrimary = jerseyColors[0];
    const jerseySecondary = jerseyColors[1] || jerseyPrimary;

    (data.players || data.roster || []).forEach(player => {
        const position = positions[player.position] ? player.position : defaultPosition;
        positions[position].push(player);
    });

    const sections = positionList.map(position => {
        const players = positions[position].sort((a, b) => (a.number || 999) - (b.number || 999));
        if (!players.length) return '';

        const cards = players.map(player => {
            const statusColor = /^#[0-9a-f]{6}$/i.test(player.statusColor || '') ? player.statusColor : '#64748b';
            const number = escapeRosterHtml(player.number || '-');
            return '<article class="roster-player-card" style="--roster-status-color:' + statusColor + '">' +
                '<img class="roster-player-watermark" src="' + escapeRosterHtml(data.logoUrl) + '" alt="" aria-hidden="true">' +
                '<div class="roster-player-topline"><span class="roster-jersey-number" style="--roster-jersey-color:' + jerseyPrimary + ';--roster-jersey-secondary:' + jerseySecondary + ';--roster-jersey-text:' + (isLightRosterColor(jerseyPrimary) ? '#172033' : '#fff') + '">' +
                '<svg viewBox="0 0 80 80" aria-hidden="true" focusable="false"><path class="roster-jersey-shape" d="M27 8 36 14h8l9-6 11 5 14 18-11 10-8-8v39H21V33l-8 8L2 31l14-18z"/><path class="roster-jersey-sleeves" d="m16 13 11-5 8 5-9 22-11 5L2 31z M64 13 53 8l-8 5 9 22 11 5 13-9z"/><path class="roster-jersey-collar" d="M34 13q6 8 12 0"/></svg>' +
                '<span class="roster-jersey-number-label">' + number + '</span></span>' +
                '<span class="roster-player-status" style="--roster-status-color:' + statusColor + '">' +
                '<span aria-hidden="true">' + escapeRosterHtml(player.statusIcon || '') + '</span>' +
                escapeRosterHtml(player.statusLabel || player.status || 'Aktivní') + '</span></div>' +
                '<div class="roster-player-name">' + escapeRosterHtml(player.name) + '</div>' +
                (player.statusDetails ? '<div class="roster-player-details">' + escapeRosterHtml(player.statusDetails) + '</div>' : '') +
                '</article>';
        }).join('');

        return '<section class="roster-position-section">' +
            '<h3 class="roster-position-title"><span>' + players.length + '</span>' + escapeRosterHtml(position) + '</h3>' +
            '<div class="roster-player-grid">' + cards + '</div></section>';
    }).join('');

    return sections || '<div class="roster-empty-state">Žádní hráči v soupisce</div>';
}

async function showAllRostersModern() {
    const allRostersView = document.getElementById('allRostersView');
    if (!allRostersView) return;

    allRostersView.innerHTML = '<div class="roster-loading">Načítám všechny soupisky...</div>';
    try {
        const teamIds = JSON.parse(allRostersView.dataset.teamIds || '[]');
        const teams = JSON.parse(allRostersView.dataset.teams || '[]');
        const season = allRostersView.dataset.season;

        const cards = await Promise.all(teamIds.map(async teamId => {
            const response = await fetch('/api/players/' + encodeURIComponent(teamId) + '?season=' + encodeURIComponent(season));
            if (!response.ok) throw new Error('Nepodařilo se načíst soupisku týmu ' + teamId + '.');
            const data = await response.json();
            const team = teams.find(item => String(item.id) === String(teamId));
            const logoUrl = data.logoUrl || (team?.logo ? '/logoteamu/' + encodeURIComponent(team.logo) : '/images/logo.png');
            
            return '<section class="roster-team-card"><header class="roster-team-header">' +
                '<div class="roster-team-info"><img src="' + escapeRosterHtml(logoUrl) + '" alt="" class="roster-team-logo">' +
                '<h2 class="roster-team-title">' + escapeRosterHtml(team?.name || 'Tým') + '</h2></div></header>' +
                '<div class="roster-team-content">' + await renderRosterContent(data) + '</div></section>';
        }));
        allRostersView.innerHTML = '<div class="all-rosters-grid" style="display: grid; gap: 20px; width: 100%;">' + cards.join('') + '</div>';
    } catch (error) {
        console.error('Chyba při načítání soupisek:', error);
        allRostersView.innerHTML = '<div class="roster-empty-state is-error">Chyba při načítání soupisek.</div>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetch('/api/version')
        .then(res => res.json())
        .then(data => {
            const versionBadge = document.getElementById('current-version');
            if (versionBadge) versionBadge.textContent = data.version;
        })
        .catch(err => console.error('Nepodařilo se načíst verzi', err));

    showAllRostersModern();
});
</script>
</main>
</body>
</html>`;

        res.send(html);
    } catch (error) {
        console.error('Chyba v /history/roster route:', error);
        res.status(500).send('Chyba při načítání historických soupisek.');
    }
});

module.exports = router;

router.get("/prestupy", requireLogin, async (req, res) => {
    try {
        // Odstraněna podmínka kontroly veřejné ligy - přestupy jsou viditelné vždy
        
        // 1. ZAVOLÁME MOZEK, KTERÝ VŠE VYPOČÍTÁ BĚHEM MILISEKUNDY
        const data = await prepareDashboardData(req);

        // 2. VYBALÍME SI PROMĚNNÉ, KTERÉ POTŘEBUJE HTML (Destructuring)
        const {
            username, selectedLiga, selectedSeason, uniqueLeagues, teamsInSelectedLiga,
            activeTransferLeagues, currentTransfers,
        } = data;
        
        // Načtení nastavení
        const settingsData = await Settings.findAll();
// --- HTML START ---
    let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Přestupy – Tipovačka</title>
<link rel="stylesheet" href="/css/modern-design.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
${renderNotificationScript(req.session.csrfToken || '')}
<body class="usersite">
${await renderUserHeader({
    username: username,
    selectedLiga: selectedLiga,
    uniqueLeagues: uniqueLeagues,
    activeTab: 'prestupy',
    csrfToken: req.session.csrfToken || '',
    timeWidgetHtml: await generateTimeWidget()
})}
<main class="main_page">
`
html += await generateLeftPanel(data);

    html += `<section class="matches-container" style="flex: 1; padding: 10px;">`;
        // KONTROLA: Má tato liga zapnuté přestupy? (podpora obou formátů)
        const hasTransferLeagues = Array.isArray(activeTransferLeagues) 
            ? activeTransferLeagues.includes(selectedLiga) 
            : (activeTransferLeagues?.[selectedSeason]?.includes(selectedLiga) || false);
        
        if (!hasTransferLeagues) {
            // Pokud nejsou přestupy, zobrazit všechny soupisky
            html += `<div class="transfer-page-actions transfer-page-actions-rosters">
                <a href="/history/prestupy" class="transfer-history-link">📜 Historie přestupů</a>
            </div>
            <h2 style="margin-top: 0; text-align: center; border-bottom: 2px solid orangered; padding-bottom: 10px;">Soupisky - ${selectedLiga}</h2>
            <div id="allRostersView" style="margin-top: 15px;" data-team-ids='${JSON.stringify(teamsInSelectedLiga.map(t => t.id))}' data-teams='${JSON.stringify(teamsInSelectedLiga)}'></div>`;
        } else {
            // --- SEKCE PŘESTUPŮ ---
            html += `<div class="transfer-page-actions">
                <a href="/history/prestupy" class="transfer-history-link">📜 Historie přestupů</a>
                <button onclick="toggleView()" id="toggleViewBtn" class="transfer-view-toggle" type="button">👥 Zobrazit soupisky</button>
            </div>
            <h2 id="viewTitle" style="margin-top: 0; text-align: center; border-bottom: 2px solid orangered; padding-bottom: 10px;">Přestupy a Spekulace - ${selectedLiga}</h2>
            
            <div id="transfersContainer">
            <div id="individualTeamsView" style="display: grid; gap: 15px; margin-top: 15px;">`;

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
                else if (name.includes('(loan)')) { // Hostování
                    style = 'color: #9b59b6; font-weight: bold; text-shadow: 0 0 8px rgba(155, 89, 182, 0.4);';
                    icon = '🔄 ';
                    name = name.replace('(loan)', '');
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
                const tData = currentTransfers[tId] || { specIn: [], specOut: [], confIn: [], confOut: [] };
                const logoUrl = team.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

                html += `
    <div class="transfer-team-card">
        <div class="transfer-team-header">
            <div class="transfer-team-info">
                <img src="${logoUrl}" alt="${team.name}" class="transfer-team-logo">
                <div class="transfer-team-title">${team.name}</div>
            </div>
            <button onclick="toggleRosterModern(${team.id})" class="nav-pill active" style="padding: 6px 14px; font-size: 12px; cursor: pointer;">👥 Soupiska</button>
        </div>

        <div id="roster-${team.id}" style="display: none; background: var(--bg-card); padding: 20px; border-bottom: 1px solid var(--border-subtle);">
            <div style="text-align: center; color: var(--text-dim); font-size: 0.9em;">Načítám soupisku...</div>
        </div>

        <div id="transfers-${team.id}" class="transfer-cols-grid">
            <div class="transfer-watermark" style="background-image: url('${logoUrl}');"></div>
            
            <div class="transfer-col col-spec-in">
                <div class="transfer-col-header">⚡ Spekulace IN</div>
                ${renderList(tData.specIn)}
            </div>

            <div class="transfer-col col-spec-out">
                <div class="transfer-col-header">⚡ Spekulace OUT</div>
                ${renderList(tData.specOut)}
            </div>

            <div class="transfer-col col-conf-in">
                <div class="transfer-col-header">✓ Příchody</div>
                ${renderList(tData.confIn)}
            </div>

            <div class="transfer-col col-conf-out">
                <div class="transfer-col-header">✕ Odchody</div>
                ${renderList(tData.confOut)}
            </div>
        </div>
    </div>`;
            });

            html += `</div>`;
            html += `<div id="allRostersView" style="display: none; margin-top: 15px;" data-team-ids='${JSON.stringify(teamsInSelectedLiga.map(t => t.id))}' data-teams='${JSON.stringify(teamsInSelectedLiga)}'></div>`;
            html += `</div>`;
        }

        // JavaScript pro načítání soupisek
        html += `
<script>
let currentView = 'transfers'; // 'roster' nebo 'transfers'
let selectedLiga = '${selectedLiga}'; // Vybraná liga pro čtení defaultView

async function toggleView() {
    const allRostersView = document.getElementById('allRostersView');
    const individualTeamsView = document.getElementById('individualTeamsView');
    const toggleViewBtn = document.getElementById('toggleViewBtn');
    const viewTitle = document.getElementById('viewTitle');
    
    if (currentView === 'transfers') {
        // Přepnout na soupisky
        currentView = 'roster';
        individualTeamsView.style.display = 'none';
        allRostersView.style.display = 'block';
        toggleViewBtn.textContent = '🔄 Zobrazit přestupy';
        viewTitle.textContent = 'Soupisky - ${selectedLiga}';
        await showAllRostersModern();
    } else {
        // Přepnout na přestupy
        currentView = 'transfers';
        allRostersView.style.display = 'none';
        individualTeamsView.style.display = 'grid';
        toggleViewBtn.textContent = '👥 Zobrazit soupisky';
        viewTitle.textContent = 'Přestupy a Spekulace - ${selectedLiga}';
    }
}

function escapeRosterHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[char]);
}

const rosterLogoColorCache = new Map();

function getRosterLogoColor(logoUrl) {
    if (rosterLogoColorCache.has(logoUrl)) return rosterLogoColorCache.get(logoUrl);

    const colorPromise = new Promise(resolve => {
        const image = new Image();
        image.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 40;
                canvas.height = 40;
                const context = canvas.getContext('2d', { willReadFrequently: true });
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                const colors = new Map();

                for (let index = 0; index < pixels.length; index += 4) {
                    if (pixels[index + 3] < 80) continue;
                    const red = pixels[index];
                    const green = pixels[index + 1];
                    const blue = pixels[index + 2];
                    const key = [red >> 3, green >> 3, blue >> 3].join(',');
                    const color = colors.get(key) || { red: 0, green: 0, blue: 0, count: 0 };
                    color.red += red;
                    color.green += green;
                    color.blue += blue;
                    color.count += 1;
                    colors.set(key, color);
                }

                const toHex = value => Math.round(value).toString(16).padStart(2, '0');
                const rankedColors = [...colors.values()].sort((first, second) => second.count - first.count);
                if (!rankedColors.length) return resolve(['#53617a']);
                const isTeamColor = color => {
                    const red = color.red / color.count;
                    const green = color.green / color.count;
                    const blue = color.blue / color.count;
                    return Math.max(red, green, blue) - Math.min(red, green, blue) >= 40;
                };
                const teamColors = rankedColors.filter(isTeamColor);
                const candidates = teamColors.length ? teamColors : rankedColors;
                const primary = candidates[0];
                const secondary = candidates.slice(1).find(color => {
                    const red = primary.red / primary.count - color.red / color.count;
                    const green = primary.green / primary.count - color.green / color.count;
                    const blue = primary.blue / primary.count - color.blue / color.count;
                    return red * red + green * green + blue * blue >= 32 * 32;
                });
                const dominant = secondary ? [primary, secondary] : [primary];
                resolve(dominant.map(color =>
                    '#' + toHex(color.red / color.count) + toHex(color.green / color.count) + toHex(color.blue / color.count)
                ));
            } catch (error) {
                console.warn('Barvu dresu se nepodařilo určit z loga.', error);
                resolve(['#53617a']);
            }
        };
        image.onerror = () => resolve(['#53617a']);
        image.src = logoUrl;
    });

    rosterLogoColorCache.set(logoUrl, colorPromise);
    return colorPromise;
}

async function renderRosterContent(data) {
    const positionList = ['Brankář', 'Obránce', 'Útočník', 'Centr', 'Křídlo', 'Jiné'];
    const positions = Object.fromEntries(positionList.map(position => [position, []]));
    const defaultPosition = 'Jiné';
    const jerseyColors = await getRosterLogoColor(data.logoUrl);
    const jerseyPrimary = jerseyColors[0];
    const jerseySecondary = jerseyColors[1] || jerseyPrimary;

    (data.players || []).forEach(player => {
        const position = positions[player.position] ? player.position : defaultPosition;
        positions[position].push(player);
    });

    const sections = positionList.map(position => {
        const players = positions[position].sort((a, b) => (a.number || 999) - (b.number || 999));
        if (!players.length) return '';

        const cards = players.map(player => {
            const statusColor = /^#[0-9a-f]{6}$/i.test(player.statusColor || '') ? player.statusColor : '#64748b';
            const number = escapeRosterHtml(player.number || '-');
            return '<article class="roster-player-card" style="--roster-status-color:' + statusColor + '">' +
                '<img class="roster-player-watermark" src="' + escapeRosterHtml(data.logoUrl) + '" alt="" aria-hidden="true">' +
                '<div class="roster-player-topline"><span class="roster-jersey-number" style="--roster-jersey-color:' + jerseyPrimary + ';--roster-jersey-secondary:' + jerseySecondary + ';--roster-jersey-text:' + (isLightRosterColor(jerseyPrimary) ? '#172033' : '#fff') + '">' +
                '<svg viewBox="0 0 80 80" aria-hidden="true" focusable="false"><path class="roster-jersey-shape" d="M27 8 36 14h8l9-6 11 5 14 18-11 10-8-8v39H21V33l-8 8L2 31l14-18z"/><path class="roster-jersey-sleeves" d="m16 13 11-5 8 5-9 22-11 5L2 31z M64 13 53 8l-8 5 9 22 11 5 13-9z"/><path class="roster-jersey-collar" d="M34 13q6 8 12 0"/></svg>' +
                '<span class="roster-jersey-number-label">' + number + '</span></span>' +
                '<span class="roster-player-status" style="--roster-status-color:' + statusColor + '">' +
                '<span aria-hidden="true">' + escapeRosterHtml(player.statusIcon || '') + '</span>' +
                escapeRosterHtml(player.statusLabel || player.status || 'Aktivní') + '</span></div>' +
                '<div class="roster-player-name">' + escapeRosterHtml(player.name) + '</div>' +
                (player.statusDetails ? '<div class="roster-player-details">' + escapeRosterHtml(player.statusDetails) + '</div>' : '') +
                '</article>';
        }).join('');

        return '<section class="roster-position-section">' +
            '<h3 class="roster-position-title"><span>' + players.length + '</span>' + escapeRosterHtml(position) + '</h3>' +
            '<div class="roster-player-grid">' + cards + '</div></section>';
    }).join('');

    return sections || '<div class="roster-empty-state">Žádní hráči v soupisce</div>';
}

function isLightRosterColor(hexColor) {
    const match = /^#([0-9a-f]{6})$/i.exec(hexColor || '');
    if (!match) return false;
    const value = parseInt(match[1], 16);
    const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(channel => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.55;
}

async function toggleRosterModern(teamId) {
    const rosterDiv = document.getElementById('roster-' + teamId);
    const transfersDiv = document.getElementById('transfers-' + teamId);

    if (rosterDiv.style.display === 'none' || rosterDiv.style.display === '') {
        rosterDiv.style.display = 'block';
        transfersDiv.style.display = 'none';
        rosterDiv.innerHTML = '<div class="roster-loading">Načítám soupisku...</div>';

        try {
            const response = await fetch('/api/players/' + encodeURIComponent(teamId));
            if (!response.ok) throw new Error('Soupisku se nepodařilo načíst.');
            rosterDiv.innerHTML = await renderRosterContent(await response.json());
        } catch (error) {
            console.error('Chyba při načítání soupisky:', error);
            rosterDiv.innerHTML = '<div class="roster-empty-state is-error">Chyba při načítání soupisky</div>';
        }
    } else {
        rosterDiv.style.display = 'none';
        transfersDiv.style.display = 'grid';
    }
}

async function showAllRostersModern() {
    const allRostersView = document.getElementById('allRostersView');
    if (!allRostersView) return;

    allRostersView.innerHTML = '<div class="roster-loading">Načítám všechny soupisky...</div>';
    try {
        const teamIds = JSON.parse(allRostersView.dataset.teamIds || '[]');
        const teams = JSON.parse(allRostersView.dataset.teams || '[]');
        const cards = await Promise.all(teamIds.map(async teamId => {
            const response = await fetch('/api/players/' + encodeURIComponent(teamId));
            if (!response.ok) throw new Error('Nepodařilo se načíst soupisku týmu ' + teamId + '.');
            const data = await response.json();
            const team = teams.find(item => String(item.id) === String(teamId));
            const logoUrl = team?.logo ? '/logoteamu/' + encodeURIComponent(team.logo) : '/images/logo.png';
            return '<section class="roster-team-card"><header class="roster-team-header">' +
                '<div class="roster-team-info"><img src="' + escapeRosterHtml(logoUrl) + '" alt="" class="roster-team-logo">' +
                '<h2 class="roster-team-title">' + escapeRosterHtml(team?.name || 'Tým') + '</h2></div></header>' +
                '<div class="roster-team-content">' + await renderRosterContent(data) + '</div></section>';
        }));
        allRostersView.innerHTML = '<div class="all-rosters-grid">' + cards.join('') + '</div>';
    } catch (error) {
        console.error('Chyba při načítání soupisek:', error);
        allRostersView.innerHTML = '<div class="roster-empty-state is-error">Chyba při načítání soupisek.</div>';
    }
}

async function toggleRoster(teamId) {
    const rosterDiv = document.getElementById('roster-' + teamId);
    const transfersDiv = document.getElementById('transfers-' + teamId);
    
    if (rosterDiv.style.display === 'none' || rosterDiv.style.display === '') {
        // Zobrazit soupisku, skrýt přestupy
        rosterDiv.style.display = 'block';
        transfersDiv.style.display = 'none';
        rosterDiv.innerHTML = '<div style="text-align: center; color: #888; font-size: 0.9em;">Načítám soupisku...</div>';

        try {
            const res = await fetch('/api/players/' + teamId);
            const data = await res.json();

            if (data.players && data.players.length > 0) {
                // Rozdělení hráčů podle pozice
                const positionList = ['Brankář', 'Obránce', 'Útočník', 'Centr', 'Křídlo', 'Jiné'];
                const defaultPos = 'Jiné';
                const positions = {};
                positionList.forEach(pos => { positions[pos] = []; });
                
                data.players.forEach(p => {
                    const pos = p.position || defaultPos;
                    if (positions[pos]) {
                        positions[pos].push(p);
                    } else {
                        positions[defaultPos].push(p);
                    }
                });

                // Seřadit hráče v každé kategorii podle čísla dresu
                positionList.forEach(pos => {
                    positions[pos].sort((a, b) => (a.number || 999) - (b.number || 999));
                });

                let playersHtml = '';
                positionList.forEach(pos => {
                    const players = positions[pos];
                    if (players.length > 0) {
                        playersHtml += '<div style="margin-bottom: 25px;">';
                        playersHtml += '<h3 style="color: #00d4ff; font-size: 1.2em; margin: 0 0 12px 0; border-bottom: 2px solid #00d4ff; padding-bottom: 8px; display: flex; align-items: center; gap: 10px;">';
                        playersHtml += '<span style="background: linear-gradient(135deg, #00d4ff, #0099cc); color: #000; padding: 4px 12px; font-size: 0.9em; font-weight: bold;">' + players.length + '</span>';
                        playersHtml += pos + '</h3>';
                        playersHtml += '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px;">';
                        players.forEach(p => {
                            playersHtml += '<div style="background: linear-gradient(135deg, ' + p.statusColor + '22 0%, #1a1a1a 100%); padding: 15px; border-left: 4px solid ' + p.statusColor + '; box-shadow: 0 2px 8px rgba(0,0,0,0.3); transition: all 0.3s ease; cursor: default; position: relative; overflow: hidden;">';
                            playersHtml += '<div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-10deg); width: 80%; height: 400%; background-image: url(' + JSON.stringify(data.logoUrl) + '); background-size: contain; background-repeat: no-repeat; background-position: center; opacity: 0.30; filter: grayscale(50%); pointer-events: none; z-index: 1;"></div>';
                            playersHtml += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; position: relative; z-index: 2;">';
                            playersHtml += '<div style="position: relative; width: 64px; height: 64px; display: inline-flex; justify-content: center; align-items: center;">';
                            playersHtml += '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;">';
                            playersHtml += '<path d="M 32 12 C 40 8, 60 8, 68 12 L 86 16 A 8 8 0 0 1 92 24 L 92 65 L 78 65 L 78 78 L 78 92 L 22 92 L 22 78 L 22 65 L 8 65 L 8 24 A 8 8 0 0 1 14 16 Z" fill="url(#jerseyGradient-' + (p.number || '0') + ')" stroke="' + p.statusColor + '" stroke-width="3" stroke-linejoin="round"/>';
                            playersHtml += '<path d="M 32 12 C 35 24, 65 24, 68 12" fill="transparent" stroke="' + p.statusColor + '" stroke-width="3"/>';
                            playersHtml += '<path d="M 42 21 L 50 28 L 58 21" fill="transparent" stroke="' + p.statusColor + '" stroke-width="3"/>';
                            playersHtml += '<defs><linearGradient id="jerseyGradient-' + (p.number || '0') + '" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#333;stop-opacity:1"/><stop offset="100%" style="stop-color:#222;stop-opacity:1"/></linearGradient></defs>';
                            playersHtml += '</svg>';
                            playersHtml += '<span style="position: relative; z-index: 2; margin-top: 5px; font-size: 1.3rem; font-weight: bold; font-family: sans-serif; color: #fff; letter-spacing: 0; user-select: none;">' + (p.number || '-') + '</span>';
                            playersHtml += '</div>';
                            playersHtml += '<span style="background: ' + p.statusColor + '; color: #000; padding: 4px 10px; font-size: 0.8em; font-weight: bold; display: flex; align-items: center; gap: 4px;">';
                            playersHtml += '<span style="font-size: 1.1em;">' + p.statusIcon + '</span>';
                            playersHtml += '<span>' + p.statusLabel + '</span>';
                            playersHtml += '</span>';
                            playersHtml += '</div>';
                            playersHtml += '<div style="color: #fff; font-weight: bold; font-size: 1.1em; margin-bottom: 5px; position: relative; z-index: 2;">' + p.name + '</div>';
                            if (p.statusDetails) {
                                playersHtml += '<div style="color: #888; font-size: 0.8em; margin-top: 8px; padding-top: 8px; border-top: 1px solid #333; position: relative; z-index: 2;">' + p.statusDetails + '</div>';
                            }
                            playersHtml += '</div>';
                        });
                        playersHtml += '</div></div>';
                    }
                });
                rosterDiv.innerHTML = playersHtml;
            } else {
                rosterDiv.innerHTML = '<div style="text-align: center; color: #888; font-size: 0.9em;">Žádní hráči v soupisce</div>';
            }
        } catch (error) {
            console.error('Chyba při načítání soupisky:', error);
            rosterDiv.innerHTML = '<div style="text-align: center; color: #ff4444; font-size: 0.9em;">Chyba při načítání soupisky</div>';
        }
    } else {
        // Skrýt soupisku, zobrazit přestupy
        rosterDiv.style.display = 'none';
        transfersDiv.style.display = 'grid';
    }
}

async function showAllRosters() {
    const allRostersView = document.getElementById('allRostersView');
    
    if (allRostersView) {
        allRostersView.innerHTML = '<div style="text-align: center; color: #888; font-size: 0.9em;">Načítám všechny soupisky...</div>';
    }
    
    try {
        // Čtení dat z HTML atributů
        const teamIds = JSON.parse(allRostersView?.dataset.teamIds || '[]');
        const teams = JSON.parse(allRostersView?.dataset.teams || '[]');
        
        let allPlayersHtml = '<div style="display: grid; gap: 15px; margin-top: 15px;">';
        
        for (const teamId of teamIds) {
            const res = await fetch('/api/players/' + teamId);
            const data = await res.json();
            const teamData = teams.find(t => t.id === teamId);
            
            // Generovat stejnou strukturu jako v přestupech
            allPlayersHtml += '<div style="position: relative; background-color: #000; border: 2px solid #ff4500; overflow: hidden; display: flex; flex-direction: column; min-height: 250px; box-shadow: 0 4px 15px rgba(0,0,0,0.8);">';
            allPlayersHtml += '<div style="position: relative; z-index: 1; background: linear-gradient(to bottom, #222, #111); border-bottom: 3px solid #ff4500; display: flex; align-items: center; justify-content: space-between; padding: 10px;">';
            allPlayersHtml += '<div style="display: flex; align-items: center;">';
            allPlayersHtml += '<img src="/logoteamu/' + teamData?.logo + '" alt="' + teamData?.name + '" style="height: 45px; width: 45px; object-fit: contain; margin-right: 12px; filter: drop-shadow(0 0 5px rgba(255,255,255,0.2));">';
            allPlayersHtml += '<strong style="color: white; font-size: 1.3em; text-transform: uppercase; letter-spacing: 1px;">' + teamData?.name + '</strong>';
            allPlayersHtml += '</div></div>';
            allPlayersHtml += '<div id="roster-' + teamId + '" style="background: #1a1a1a; padding: 15px;">';
            
            if (data.players && data.players.length > 0) {
                // Rozdělení hráčů podle pozice
                const positionList = ['Brankář', 'Obránce', 'Útočník', 'Centr', 'Křídlo', 'Jiné'];
                const defaultPos = 'Jiné';
                const positions = {};
                positionList.forEach(pos => { positions[pos] = []; });
                
                data.players.forEach(p => {
                    const pos = p.position || defaultPos;
                    if (positions[pos]) {
                        positions[pos].push(p);
                    } else {
                        positions[defaultPos].push(p);
                    }
                });

                // Seřadit hráče v každé kategorii podle čísla dresu
                positionList.forEach(pos => {
                    positions[pos].sort((a, b) => (a.number || 999) - (b.number || 999));
                });

                positionList.forEach(pos => {
                    const players = positions[pos];
                    if (players.length > 0) {
                        allPlayersHtml += '<div style="margin-bottom: 25px;">';
                        allPlayersHtml += '<h3 style="color: #00d4ff; font-size: 1.2em; margin: 0 0 12px 0; border-bottom: 2px solid #00d4ff; padding-bottom: 8px; display: flex; align-items: center; gap: 10px;">';
                        allPlayersHtml += '<span style="background: linear-gradient(135deg, #00d4ff, #0099cc); color: #000; padding: 4px 12px; font-size: 0.9em; font-weight: bold;">' + players.length + '</span>';
                        allPlayersHtml += pos + '</h3>';
                        allPlayersHtml += '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px;">';
                        players.forEach(p => {
                            allPlayersHtml += '<div style="background: linear-gradient(135deg, ' + p.statusColor + '22 0%, #1a1a1a 100%); padding: 15px; border-left: 4px solid ' + p.statusColor + '; box-shadow: 0 2px 8px rgba(0,0,0,0.3); transition: all 0.3s ease; cursor: default; position: relative; overflow: hidden;">';
                            allPlayersHtml += '<div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-10deg); width: 80%; height: 400%; background-image: url(' + JSON.stringify(data.logoUrl) + '); background-size: contain; background-repeat: no-repeat; background-position: center; opacity: 0.30; filter: grayscale(50%); pointer-events: none; z-index: 1;"></div>';
                            allPlayersHtml += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; position: relative; z-index: 2;">';
                            allPlayersHtml += '<div style="position: relative; width: 64px; height: 64px; display: inline-flex; justify-content: center; align-items: center;">';
                            allPlayersHtml += '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;">';
                            allPlayersHtml += '<path d="M 32 12 C 40 8, 60 8, 68 12 L 86 16 A 8 8 0 0 1 92 24 L 92 65 L 78 65 L 78 78 L 78 92 L 22 92 L 22 78 L 22 65 L 8 65 L 8 24 A 8 8 0 0 1 14 16 Z" fill="url(#jerseyGradient-' + (p.number || '0') + ')" stroke="' + p.statusColor + '" stroke-width="3" stroke-linejoin="round"/>';
                            allPlayersHtml += '<path d="M 32 12 C 35 24, 65 24, 68 12" fill="transparent" stroke="' + p.statusColor + '" stroke-width="3"/>';
                            allPlayersHtml += '<path d="M 42 21 L 50 28 L 58 21" fill="transparent" stroke="' + p.statusColor + '" stroke-width="3"/>';
                            allPlayersHtml += '<defs><linearGradient id="jerseyGradient-' + (p.number || '0') + '" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" style="stop-color:#333;stop-opacity:1"/><stop offset="100%" style="stop-color:#222;stop-opacity:1"/></linearGradient></defs>';
                            allPlayersHtml += '</svg>';
                            allPlayersHtml += '<span style="position: relative; z-index: 2; margin-top: 5px; font-size: 1.3rem; font-weight: bold; font-family: sans-serif; color: #fff; letter-spacing: 0; user-select: none;">' + (p.number || '-') + '</span>';
                            allPlayersHtml += '</div>';
                            allPlayersHtml += '<span style="background: ' + p.statusColor + '; color: #000; padding: 4px 10px; font-size: 0.8em; font-weight: bold; display: flex; align-items: center; gap: 4px;">';
                            allPlayersHtml += '<span style="font-size: 1.1em;">' + p.statusIcon + '</span>';
                            allPlayersHtml += '<span>' + p.statusLabel + '</span>';
                            allPlayersHtml += '</span>';
                            allPlayersHtml += '</div>';
                            allPlayersHtml += '<div style="color: #fff; font-weight: bold; font-size: 1.1em; margin-bottom: 5px; position: relative; z-index: 2;">' + p.name + '</div>';
                            if (p.statusDetails) {
                                allPlayersHtml += '<div style="color: #888; font-size: 0.8em; margin-top: 8px; padding-top: 8px; border-top: 1px solid #333; position: relative; z-index: 2;">' + p.statusDetails + '</div>';
                            }
                            allPlayersHtml += '</div>';
                        });
                        allPlayersHtml += '</div></div>';
                    }
                });
            } else {
                allPlayersHtml += '<div style="text-align: center; color: #888; font-size: 0.9em;">Žádní hráči v soupisce</div>';
            }
            
            allPlayersHtml += '</div></div>';
        }
        
        allPlayersHtml += '</div>';
        
        if (allRostersView) {
            allRostersView.innerHTML = allPlayersHtml;
        }
    } catch (error) {
        console.error('Chyba při načítání soupisek:', error);
        if (allRostersView) {
            allRostersView.innerHTML = '<div style="text-align: center; color: #ff4444; font-size: 0.9em;">Chyba při načítání soupisek: ' + error.message + '</div>';
        }
    }
}

// Automatické načítání podle nastavení a stavu přestupů
document.addEventListener('DOMContentLoaded', async () => {
    const allRostersView = document.getElementById('allRostersView');
    const individualTeamsView = document.getElementById('individualTeamsView');
    const toggleViewBtn = document.getElementById('toggleViewBtn');
    const viewTitle = document.getElementById('viewTitle');
    
    // Pokud nejsou přestupy zapnuté, zobrazit soupisky
    if (allRostersView && !individualTeamsView) {
        await showAllRostersModern();
    } 
    // Pokud jsou přestupy zapnuté, respektovat nastavení defaultView
    else if (allRostersView && individualTeamsView && toggleViewBtn) {
        const settingsData = ${JSON.stringify(settingsData)};
        const defaultView = settingsData.defaultView && settingsData.defaultView[selectedLiga] ? settingsData.defaultView[selectedLiga] : 'transfers';
        
        if (defaultView === 'roster') {
            // Nastavíme currentView na transfers, aby toggleView fungoval správně
            currentView = 'transfers';
            // Přepneme na soupisky
            await toggleView();
        } else {
            // Výchozí jsou přestupy, nic neměníme
            currentView = 'transfers';
        }
    }
});
</script>
</main></body>`;
    res.send(html)
    } catch (error) {
        console.error('Chyba v /prestupy route:', error);
        await logUserAction(req.session?.user, "PRESTUPY_ERROR", `Chyba při načítání přestupů: ${error.message}`, 'prestupy', null, req, 'error', false);
        
        let errorHtml = `
<!DOCTYPE html>
<html lang="cs">
<head>
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Chyba - Tipovačka</title>
<link rel="stylesheet" href="/css/modern-design.css" />
<link rel="icon" href="/images/logo.png">
</head>
<body class="usersite">
${await renderUserHeader({
    username: req.session?.user,
    selectedLiga: '',
    uniqueLeagues: [],
    activeTab: 'prestupy',
    csrfToken: req.session?.csrfToken || '',
    timeWidgetHtml: await generateTimeWidget()
})}
<main class="layout-single-column">
<div class="dashboard-section" style="text-align: center; padding: 40px; border-color: rgba(239, 68, 68, 0.4); max-width: 600px; margin: 40px auto;">
<h2 style="color: var(--accent-red); margin-bottom: 12px; display:flex; align-items:center; justify-content:center; gap:8px;">❌ Došlo k chybě</h2>
<p style="color: var(--text-muted); margin-bottom: 20px;">Omlouváme se, ale došlo k chybě při načítání stránky. Chyba byla logována a bude opravena.</p>
<a href="/" class="nav-pill active" style="padding: 10px 20px;">← Zpět na hlavní stránku</a>
</div>
</main>
</body>
</html>`;
        res.status(500).send(errorHtml);
    }
});



router.get('/image-exporter/branding', requireLogin, async (req, res) => {
    try {
        const collection = await Settings.getCollection();
        const settings = await collection.findOne({});
        res.json(settings?.imageBranding || {});
    } catch (error) {
        console.error('Chyba při načítání společného brandingu exportu:', error);
        res.status(500).json({ error: 'Společný branding se nepodařilo načíst.' });
    }
});

router.post('/image-exporter/branding', requireLogin, express.json({ limit: '20mb' }), async (req, res) => {
    if (req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Společný branding může měnit pouze administrátor.' });
    }

    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

    try {
        const {
            bgColor, textColor, accentColor, watermarkColor,
            watermarkText, bgImage, watermarkLogo
        } = req.body;
        const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
        const validImage = value => !value || (
            typeof value === 'string' &&
            value.length <= 7 * 1024 * 1024 &&
            /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]+=*$/i.test(value)
        );

        if (![bgColor, textColor, accentColor, watermarkColor].every(validColor)) {
            return res.status(400).json({ error: 'Některá barva brandingu není platná.' });
        }
        if (!validImage(bgImage) || !validImage(watermarkLogo)) {
            return res.status(400).json({ error: 'Obrázek brandingu není platný nebo je příliš velký.' });
        }
        if (typeof watermarkText !== 'string' || watermarkText.length > 80) {
            return res.status(400).json({ error: 'Text watermarku může mít nejvýše 80 znaků.' });
        }

        const imageBranding = {
            bgColor,
            textColor,
            accentColor,
            watermarkColor,
            watermarkText,
            bgImage: bgImage || '',
            watermarkLogo: watermarkLogo || ''
        };
        const collection = await Settings.getCollection();
        const currentSettings = await collection.findOne({});
        if (currentSettings) {
            await collection.updateOne({ _id: currentSettings._id }, { $set: { imageBranding } });
        } else {
            await collection.insertOne({ imageBranding });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Chyba při ukládání společného brandingu exportu:', error);
        res.status(500).json({ error: 'Společný branding se nepodařilo uložit.' });
    }
});

// POST routa pro generování obrázků
router.post("/image-exporter/generate", requireLogin, express.json({ limit: '50mb' }), async (req, res) => {
    const { createTransferImage, createWinnerImage, createStandingsImage, createStatisticsImage, createPlayoffBracketImage } = require("../utils/fileUtils");
    const { createVersusImageForExport } = require("../routes/notificationService.js");
    const { getChosenSeason } = require('../utils/fileUtils');

    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

    try {
        const { type, homeTeamId, awayTeamId, fromTeamId, toTeamId, winnerTeamId, scoreHome, scoreAway, title, winnerTitle, playerName, playerPhoto, watermark, isPlayoff, seriesHomeWins, seriesAwayWins, customBgColor, customTextColor, customAccentColor, customWatermarkColor, customBgImage, customWatermarkText, customWatermarkLogo, customHomeLogo, customAwayLogo, customFromTeamName, customFromLeague, customToTeamName, customToLeague, customHomeTeamName, customHomeLeague, customAwayTeamName, customAwayLeague, customHomeLogoBase64, customAwayLogoBase64, customFromLogoBase64, customToLogoBase64 } = req.body;

        const validBrandingImage = image => !image || (
            typeof image === 'string' &&
            image.length <= 7 * 1024 * 1024 &&
            /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/]+=*$/i.test(image)
        );
        if (!validBrandingImage(customBgImage) || !validBrandingImage(customWatermarkLogo)) {
            return res.status(400).json({ error: 'Obrázek brandingu není platný nebo je příliš velký.' });
        }

        const { Teams } = require('../utils/mongoDataAccess');
        await getChosenSeason();
        const allTeams = await Teams.findAll();
        // EXPORTER: Načítáme VŠECHNY aktivní týmy (nejen podle sezóny) - exportér je odemčený
        const seasonTeams = allTeams.filter(t => t.active);

        // Custom nastavení pro všechny obrázky
        const customSettings = {
            bgColor: customBgColor || '#1a1a1a',
            textColor: customTextColor || '#ffffff',
            accentColor: customAccentColor || '#ff4500',
            watermarkColor: customWatermarkColor || '#888888',
            bgImage: customBgImage || null,
            watermarkText: customWatermarkText || null,
            watermarkLogo: customWatermarkLogo || null,
            withWatermark: watermark !== 'false',
            customHomeLogo: customHomeLogo || null,
            customAwayLogo: customAwayLogo || null
        };

        const outDir = path.join(__dirname, '../public/images/exports');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        let buffer;
        let filename;
        const timestamp = Date.now();

        switch (type) {
            case 'match': {
                let homeTeam, awayTeam;

                // Použít vlastní týmy pokud jsou zadány
                if (homeTeamId === 'custom' && customHomeTeamName) {
                    homeTeam = { name: customHomeTeamName, liga: customHomeLeague || 'Custom', isCustom: true };
                } else {
                    homeTeam = seasonTeams.find(t => t.id === parseInt(homeTeamId));
                }

                if (awayTeamId === 'custom' && customAwayTeamName) {
                    awayTeam = { name: customAwayTeamName, liga: customAwayLeague || 'Custom', isCustom: true };
                } else {
                    awayTeam = seasonTeams.find(t => t.id === parseInt(awayTeamId));
                }

                if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'Týmy nenalezeny' });

                // Nahrané logo přepíše výchozí logo týmu, pokud je k dispozici.
                if (customHomeLogoBase64) {
                    customSettings.customHomeLogo = customHomeLogoBase64;
                }
                if (customAwayLogoBase64) {
                    customSettings.customAwayLogo = customAwayLogoBase64;
                }

                buffer = await createVersusImageForExport(homeTeam, awayTeam, customSettings);
                const homeId = homeTeam.isCustom ? 'custom' : homeTeam.id;
                const awayId = awayTeam.isCustom ? 'custom' : awayTeam.id;
                filename = `match-${homeId}-vs-${awayId}-${timestamp}.png`;
                break;
            }
            case 'result': {
                const homeTeam = seasonTeams.find(t => t.id === parseInt(homeTeamId));
                const awayTeam = seasonTeams.find(t => t.id === parseInt(awayTeamId));
                if (!homeTeam || !awayTeam) return res.status(400).json({ error: 'Týmy nenalezeny' });

                const seriesData = (isPlayoff && seriesHomeWins !== undefined && seriesAwayWins !== undefined)
                    ? { homeWins: parseInt(seriesHomeWins), awayWins: parseInt(seriesAwayWins) }
                    : null;

                buffer = await createMatchImage(homeTeam, awayTeam, parseInt(scoreHome), parseInt(scoreAway), title || null, watermark !== 'false', seriesData, customSettings);
                filename = `result-${homeTeam.id}-${scoreHome}-${awayTeam.id}-${scoreAway}-${timestamp}.png`;
                break;
            }
            case 'transfer': {
                let fromTeam, toTeam;

                // Použít vlastní týmy pokud jsou zadány
                if (fromTeamId === 'custom' && customFromTeamName) {
                    fromTeam = { name: customFromTeamName, liga: customFromLeague || 'Custom', isCustom: true };
                } else {
                    fromTeam = seasonTeams.find(t => t.id === parseInt(fromTeamId));
                }

                if (toTeamId === 'custom' && customToTeamName) {
                    toTeam = { name: customToTeamName, liga: customToLeague || 'Custom', isCustom: true };
                } else {
                    toTeam = seasonTeams.find(t => t.id === parseInt(toTeamId));
                }

                if (!fromTeam || !toTeam) return res.status(400).json({ error: 'Týmy nenalezeny' });

                let playerPhotoPath = null;
                if (playerPhoto && playerPhoto.startsWith('data:image')) {
                    const base64Data = playerPhoto.replace(/^data:image\/\w+;base64,/, '');
                    const tempDir = path.join(__dirname, '../temp');
                    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
                    playerPhotoPath = path.join(tempDir, `player-${timestamp}.png`);
                    fs.writeFileSync(playerPhotoPath, Buffer.from(base64Data, 'base64'));
                }

                buffer = await createTransferImage(fromTeam, toTeam, playerName || null, watermark !== 'false', playerPhotoPath, customFromLogoBase64 || null, customToLogoBase64 || null, customSettings);

                if (playerPhotoPath && fs.existsSync(playerPhotoPath)) {
                    try { fs.unlinkSync(playerPhotoPath); } catch (e) {} // Ignorujeme chyby při mazání temp souboru
                }
                const playerSuffix = playerName ? `-${playerName.replace(/\s+/g, '-')}` : '';
                const fromId = fromTeam.isCustom ? 'custom' : fromTeam.id;
                const toId = toTeam.isCustom ? 'custom' : toTeam.id;
                filename = `transfer-${fromId}-to-${toId}${playerSuffix}-${timestamp}.png`;
                break;
            }
            case 'winner': {
                const { winnerColor, showTrophy } = req.body;
                const winnerTeam = seasonTeams.find(t => t.id === parseInt(winnerTeamId));
                if (!winnerTeam) return res.status(400).json({ error: 'Tým nenalezen' });

                const titleText = winnerTitle || `VÍTĚZ`;
                const winnerOptions = {
                    accentColor: winnerColor || customSettings.accentColor || '#ff4500',
                    showTrophy: showTrophy === 'true' || showTrophy === true
                };
                buffer = await createWinnerImage(winnerTeam, titleText, watermark !== 'false', winnerOptions, customSettings);
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
                    }, watermark !== 'false', customSettings);
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
                    buffer = await createStandingsImage(standingsData, title, watermark !== 'false', options, customSettings);
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
                buffer = await createStatisticsImage(usersStats, title, watermark !== 'false', customSettings);
                filename = `statistics-${selectedLiga}-${timestamp}.png`;
                break;
            }

            default:
                return res.status(400).json({ error: 'Neznámý typ obrázku' });
        }

        const outputScale = req.body.outputScale === '2' || req.body.outputScale === 2 ? 2 : 1;
        const outputFormat = ['square', 'portrait', 'story', 'landscape'].includes(req.body.outputFormat)
            ? req.body.outputFormat
            : 'original';
        const safeFilenameBase = String(filename || 'export')
            .replace(/\.png$/i, '')
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '') || 'export';
        filename = safeFilenameBase +
            (outputFormat !== 'original' ? `-${outputFormat}` : '') +
            (outputScale === 2 ? '@2x' : '') + '.png';
        const { loadImage } = require('canvas');
        const generatedImage = await loadImage(buffer);
        const outPath = path.join(outDir, filename);
        if (outputScale === 2 || outputFormat !== 'original') {
            const { createCanvas, loadImage } = require('canvas');
            const sourceImage = await loadImage(buffer);
            const dimensions = {
                square: [1080, 1080],
                portrait: [1080, 1350],
                story: [1080, 1920],
                landscape: [1920, 1080]
            }[outputFormat];
            const outputWidth = dimensions ? dimensions[0] * outputScale : sourceImage.width * outputScale;
            const outputHeight = dimensions ? dimensions[1] * outputScale : sourceImage.height * outputScale;
            const scaledCanvas = createCanvas(outputWidth, outputHeight);
            const scaledContext = scaledCanvas.getContext('2d');
            scaledContext.imageSmoothingEnabled = true;
            scaledContext.imageSmoothingQuality = 'high';
            if (dimensions) {
                const gradient = scaledContext.createLinearGradient(0, 0, 0, scaledCanvas.height);
                gradient.addColorStop(0, customSettings.bgColor);
                gradient.addColorStop(1, '#000000');
                scaledContext.fillStyle = gradient;
                scaledContext.fillRect(0, 0, scaledCanvas.width, scaledCanvas.height);
                let backgroundImage = sourceImage;
                if (customSettings.bgImage) {
                    try {
                        backgroundImage = await loadImage(Buffer.from(customSettings.bgImage.split(',')[1], 'base64'));
                    } catch (error) {
                        console.error('Vlastní pozadí formátu exportu se nepodařilo načíst:', error);
                    }
                }
                const coverScale = Math.max(scaledCanvas.width / backgroundImage.width, scaledCanvas.height / backgroundImage.height);
                const backgroundWidth = backgroundImage.width * coverScale;
                const backgroundHeight = backgroundImage.height * coverScale;
                scaledContext.drawImage(backgroundImage, (scaledCanvas.width - backgroundWidth) / 2, (scaledCanvas.height - backgroundHeight) / 2, backgroundWidth, backgroundHeight);
                scaledContext.fillStyle = 'rgba(0, 0, 0, 0.5)';
                scaledContext.fillRect(0, 0, scaledCanvas.width, scaledCanvas.height);
                const fitScale = Math.min(scaledCanvas.width / sourceImage.width, scaledCanvas.height / sourceImage.height);
                const imageWidth = sourceImage.width * fitScale;
                const imageHeight = sourceImage.height * fitScale;
                scaledContext.drawImage(sourceImage, (scaledCanvas.width - imageWidth) / 2, (scaledCanvas.height - imageHeight) / 2, imageWidth, imageHeight);
            } else {
                scaledContext.drawImage(sourceImage, 0, 0, scaledCanvas.width, scaledCanvas.height);
            }
            buffer = scaledCanvas.toBuffer('image/png');
        }
        fs.writeFileSync(outPath, buffer);

        await logUserAction(req.session.user, "IMAGE_EXPORT", `Generování obrázku typu: ${type}, soubor: ${filename}`, 'image_export', filename, req, 'info', true);

        res.json({
            url: `/images/exports/${filename}`,
            filename,
            width: generatedImage.width,
            height: generatedImage.height,
            sizeBytes: buffer.length
        });

    } catch (err) {
        console.error('Chyba při generování obrázku:', err);
        await logUserAction(req.session.user, "IMAGE_EXPORT", `Neúspěšné generování obrázku typu: ${req.body?.type || 'unknown'} - ${err.message}`, 'image_export', null, req, 'error', false);
        res.status(500).json({ error: 'Chyba při generování obrázku' });
    }
});

router.get("/image-exporter", requireLogin, async (req, res) => {
    const { getMatches, loadTeams, getAllowedLeagues, getLeaguesData } = require('../utils/fileUtils');
    
    // Načteme všechny ligy v sezóně (ne jen veřejné)
    const matches = await getMatches();
    const data = await prepareDashboardData(req, false, true);
    const { username, selectedSeason } = data;
    // EXPORTER: Načítáme VŠECHNY aktivní týmy ze VŠECH lig a sezón (odemčeno od ligy/sezóny)
    const teams = (await loadTeams()).filter(t => t.active);
    const allowedLeagues = await getAllowedLeagues(selectedSeason);
    const allSeasonData = await getLeaguesData();
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];
    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const leaguesFromLeagues = [...new Set(leagues.map(l => l.name))];
    // OPRAVA: Prioritizovat pořadí z definice lig - nejprve definice, pak doplnit z týmů a zápasů
    const uniqueLeagues = [...new Set([...leaguesFromLeagues, ...leaguesFromTeams, ...leaguesFromMatches])];
    
    // Získání všech sezón z týmů pro dropdown v exportéru
    const seasonsFromTeams = [...new Set(teams.map(t => t.season).filter(Boolean))].sort();
    
    // Zjistíme jest je vybraná liga veřejná
    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga)
        ? req.query.liga
        : (allowedLeagues.find(l => uniqueLeagues.includes(l)) || uniqueLeagues[0] || "Neurčeno");
    
    // EXPORTER: Filtrování týmů podle vybrané ligy/sezóny v dropdownu (default: všechny)
    const exporterLiga = req.query.exporterLiga || "all";
    const exporterSeason = req.query.exporterSeason || "all";
    
    let teamsList = teams || [];
    if (exporterLiga !== "all") {
        teamsList = teamsList.filter(t => t.liga === exporterLiga || t.liga.toLowerCase() === exporterLiga.toLowerCase());
    }
    if (exporterSeason !== "all") {
        teamsList = teamsList.filter(t => t.season === exporterSeason);
    }
    
    let html = `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<title>Image Exporter - Tipovačka</title>
<link rel="stylesheet" href="/css/modern-design.css" />
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
<script>
let activeExporterType = 'match';

function showImageType(type) {
    activeExporterType = type;
    document.querySelector('.exporter-config-heading .exporter-reset-btn').hidden = false;
    document.querySelectorAll('.image-type-btn').forEach(btn => {
        const selected = btn.dataset.type === type;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-selected', String(selected));
    });
    document.querySelectorAll('.form-section').forEach(section => section.classList.remove('active'));
    document.getElementById(type + '-section')?.classList.add('active');
    document.querySelectorAll('.exporter-tool-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-expanded', 'false');
    });
    document.getElementById('exporter-config-step').textContent = '02';
}

function showExporterTool(type, toggle = false) {
    if (toggle && document.getElementById(type + '-section')?.classList.contains('active')) {
        showImageType(activeExporterType);
        return;
    }
    document.querySelectorAll('.image-type-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.form-section').forEach(section => section.classList.remove('active'));
    document.getElementById(type + '-section')?.classList.add('active');
    document.querySelector('.exporter-config-heading .exporter-reset-btn').hidden = true;
    document.querySelectorAll('.exporter-tool-btn').forEach(btn => {
        const selected = btn.dataset.tool === type;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-expanded', String(selected));
    });
    document.getElementById('exporter-config-step').textContent = 'N';
}

function resetActiveExporterForm() {
    const activeSection = document.querySelector('.image-type-btn.active')?.dataset.type;
    if (!activeSection) return;
    const form = document.getElementById(activeSection + '-form');
    if (!form) return;
    form.reset();
    localStorage.removeItem('imageExporterDraft-' + activeSection);
    if (activeSection === 'match') {
        ['home', 'away'].forEach(toggleCustomTeam);
        ['home', 'away'].forEach(updateCustomLogoPreview);
        document.getElementById('match-logo-overrides').open = false;
    }
    if (activeSection === 'transfer') ['from', 'to'].forEach(toggleCustomTeam);
    if (activeSection === 'result') document.getElementById('series-row').style.display = 'none';
    if (activeSection === 'standings') document.getElementById('clinch-mode-row').style.display = 'block';
}

function swapTeams(type) {
    const pairs = type === 'match'
        ? [['homeTeamId', 'awayTeamId'], ['customHomeTeamName', 'customAwayTeamName'], ['customHomeLeague', 'customAwayLeague'], ['customHomeLogoBase64', 'customAwayLogoBase64'], ['customHomeLogo', 'customAwayLogo']]
        : [['fromTeamId', 'toTeamId'], ['customFromTeamName', 'customToTeamName'], ['customFromLeague', 'customToLeague'], ['customFromLogoBase64', 'customToLogoBase64']];
    const form = document.getElementById(type + '-form');
    pairs.forEach(([leftName, rightName]) => {
        const left = form.elements.namedItem(leftName);
        const right = form.elements.namedItem(rightName);
        if (!left || !right) return;
        const value = left.value;
        left.value = right.value;
        right.value = value;
    });
    if (type === 'match') {
        ['home', 'away'].forEach(toggleCustomTeam);
        ['home', 'away'].forEach(side => {
            const sideName = side.charAt(0).toUpperCase() + side.slice(1);
            const fileInput = document.getElementById('custom' + sideName + 'LogoInput');
            if (fileInput) fileInput.value = '';
        });
        ['home', 'away'].forEach(renderCustomLogoPreview);
    }
    else ['from', 'to'].forEach(toggleCustomTeam);
    saveExporterDrafts();
}

function validateExporterForm(type) {
    const form = document.getElementById(type + '-form');
    if (!form || !form.reportValidity()) return false;
    const names = type === 'match' ? ['homeTeamId', 'awayTeamId'] :
        type === 'transfer' ? ['fromTeamId', 'toTeamId'] :
        type === 'result' ? ['homeTeamId', 'awayTeamId'] : null;
    if (!names) return true;
    const [left, right] = names.map(name => form.elements.namedItem(name));
    if (left.value && left.value === right.value && left.value !== 'custom') {
        right.setCustomValidity('Vyber dva různé týmy.');
        right.reportValidity();
        right.setCustomValidity('');
        return false;
    }
    return true;
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

function handleCustomBg(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        alert("Obrázek je příliš velký. Maximum je 5MB.");
        input.value = "";
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById("customBgBase64").value = e.target.result;
        document.getElementById('use-custom-settings').checked = true;
        const select = document.getElementById('custom-bg-image-select');
        if (select) select.value = '';
        savedExporterBackgroundName = '';
        const preview = document.getElementById('exporter-bg-preview');
        if (preview) preview.replaceChildren();
        saveCustomSettings();
    };
    reader.readAsDataURL(file);
}

function handleWatermarkLogoUpload(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        alert('Logo watermarku je příliš velké. Maximum je 5MB.');
        input.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = function(event) {
        document.getElementById('customWatermarkLogoBase64').value = event.target.result;
        document.getElementById('use-custom-settings').checked = true;
        const preview = document.getElementById('exporter-watermark-logo-preview');
        preview.replaceChildren();
        const image = document.createElement('img');
        image.src = event.target.result;
        image.alt = 'Náhled loga watermarku';
        preview.appendChild(image);
        saveCustomSettings();
    };
    reader.readAsDataURL(file);
}

function saveCustomSettings() {
    const settings = {
        bgColor: document.querySelector('input[name="customBgColor"]').value,
        textColor: document.querySelector('input[name="customTextColor"]').value,
        accentColor: document.querySelector('input[name="customAccentColor"]').value,
        watermarkColor: document.querySelector('input[name="customWatermarkColor"]').value,
        bgImage: document.getElementById("customBgBase64").value,
        bgImageName: document.getElementById('custom-bg-image-select').value,
        watermarkText: document.querySelector('input[name="customWatermarkText"]').value,
        watermarkLogo: document.getElementById('customWatermarkLogoBase64').value,
        useCustom: document.getElementById("use-custom-settings").checked,
        outputScale: document.getElementById('export-output-scale').value,
        outputFormat: document.getElementById('export-output-format').value
    };
    const status = document.getElementById('exporter-settings-status');
    try {
        localStorage.setItem('imageExporterSettings', JSON.stringify(settings));
        if (status) status.textContent = 'Vzhled je uložený pro další návštěvu.';
    } catch (error) {
        console.error('Vzhled exportu se nepodařilo uložit.', error);
        if (status) status.textContent = 'Vzhled se nepodařilo uložit. Zkontroluj místo v úložišti prohlížeče.';
    }
}

function resetCustomSettings() {
    localStorage.removeItem('imageExporterSettings');
    document.querySelector('input[name="customBgColor"]').value = '#1a1a1a';
    document.querySelector('input[name="customTextColor"]').value = '#ffffff';
    document.querySelector('input[name="customAccentColor"]').value = '#ff4500';
    document.querySelector('input[name="customWatermarkColor"]').value = '#888888';
    document.getElementById("customBgBase64").value = '';
    document.getElementById('customWatermarkLogoBase64').value = '';
    document.getElementById('customWatermarkLogoInput').value = '';
    document.getElementById('exporter-watermark-logo-preview').replaceChildren();
    document.querySelector('input[name="customWatermarkText"]').value = '';
    document.getElementById("use-custom-settings").checked = false;
    document.getElementById("customBgInput").value = '';
    document.getElementById('export-output-scale').value = '1';
    document.getElementById('export-output-format').value = 'original';
    document.getElementById('custom-bg-image-select').value = '';
    savedExporterBackgroundName = '';
    document.getElementById('exporter-bg-preview').replaceChildren();
    document.querySelectorAll('.exporter-preset-btn').forEach(button => button.classList.remove('active'));
    saveCustomSettings();
    const status = document.getElementById('exporter-settings-status');
    if (status) status.textContent = 'Výchozí vzhled je obnovený.';
}

function applyExporterPreset(preset, event) {
    const presets = {
        arena: { bgColor: '#101820', textColor: '#ffffff', accentColor: '#ff6b35', watermarkColor: '#aeb9c4' },
        ice: { bgColor: '#0b2330', textColor: '#e8f8ff', accentColor: '#39b8e6', watermarkColor: '#9ab9c7' },
        night: { bgColor: '#111018', textColor: '#f5f1ff', accentColor: '#9a78ff', watermarkColor: '#aaa4b8' }
    };
    const colors = presets[preset];
    if (!colors) return;

    Object.entries(colors).forEach(([key, value]) => {
        document.querySelector('input[name="custom' + key.charAt(0).toUpperCase() + key.slice(1) + '"]').value = value;
    });
    const winnerColor = document.querySelector('input[name="winnerColor"]');
    if (winnerColor) winnerColor.value = colors.accentColor;
    document.getElementById('use-custom-settings').checked = true;
    document.querySelectorAll('.exporter-preset-btn').forEach(button => button.classList.toggle('active', button === event.currentTarget));
    saveCustomSettings();
}

function updateExportFormatDescription() {
    const format = document.getElementById('export-output-format').value;
    const descriptions = {
        original: 'Zachová se přirozený poměr stran dané grafiky.',
        square: 'Čtvercový výstup 1080 × 1080 px; původní grafika se neořízne.',
        portrait: 'Portrét 1080 × 1350 px; obsah zůstane celý a doplní se pozadí.',
        story: 'Stories 1080 × 1920 px; obsah zůstane celý a doplní se pozadí.',
        landscape: 'Krajina 1920 × 1080 px; obsah zůstane celý a doplní se pozadí.'
    };
    document.getElementById('export-format-description').textContent = descriptions[format] || descriptions.original;
}

async function loadGlobalExporterBranding() {
    try {
        const response = await fetch('/image-exporter/branding');
        if (!response.ok) {
            console.error('Společný branding se nepodařilo načíst.');
            return;
        }
        const settings = await response.json();
        if (!settings || Object.keys(settings).length === 0) return;

        document.querySelector('input[name="customBgColor"]').value = settings.bgColor || '#1a1a1a';
        document.querySelector('input[name="customTextColor"]').value = settings.textColor || '#ffffff';
        document.querySelector('input[name="customAccentColor"]').value = settings.accentColor || '#ff4500';
        document.querySelector('input[name="customWatermarkColor"]').value = settings.watermarkColor || '#888888';
        document.getElementById('customBgBase64').value = settings.bgImage || '';
        document.querySelector('input[name="customWatermarkText"]').value = settings.watermarkText || '';
        document.getElementById('customWatermarkLogoBase64').value = settings.watermarkLogo || '';
        if (settings.watermarkLogo) {
            const image = document.createElement('img');
            image.src = settings.watermarkLogo;
            image.alt = 'Náhled loga watermarku';
            document.getElementById('exporter-watermark-logo-preview').replaceChildren(image);
        }
        document.getElementById('use-custom-settings').checked = true;
        if (settings.bgImage) {
            const image = document.createElement('img');
            image.src = settings.bgImage;
            image.alt = 'Náhled vlastního pozadí';
            document.getElementById('exporter-bg-preview').replaceChildren(image);
        }
        const winnerColor = document.querySelector('input[name="winnerColor"]');
        if (winnerColor) winnerColor.value = settings.accentColor || '#ff4500';
    } catch (error) {
        console.error('Společný branding exportu se nepodařilo načíst.', error);
    }
}

async function saveGlobalExporterBranding() {
    const csrfToken = document.getElementById('globalCsrfToken')?.value || '';
    const settings = {
        bgColor: document.querySelector('input[name="customBgColor"]').value,
        textColor: document.querySelector('input[name="customTextColor"]').value,
        accentColor: document.querySelector('input[name="customAccentColor"]').value,
        watermarkColor: document.querySelector('input[name="customWatermarkColor"]').value,
        watermarkText: document.querySelector('input[name="customWatermarkText"]').value,
        bgImage: document.getElementById('customBgBase64').value,
        watermarkLogo: document.getElementById('customWatermarkLogoBase64').value
    };
    const status = document.getElementById('exporter-settings-status');
    try {
        const response = await fetch('/image-exporter/branding', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify(settings)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            console.error(result.error || 'Společný branding se nepodařilo uložit.');
            status.textContent = result.error || 'Společný branding se nepodařilo uložit.';
            return;
        }
        status.textContent = 'Branding exportů a automatických notifikací je uložený.';
    } catch (error) {
        console.error('Společný branding se nepodařilo uložit.', error);
        status.textContent = error.message || 'Společný branding se nepodařilo uložit.';
    }
}

// Načíst uložená nastavení při načtení stránky
document.addEventListener('DOMContentLoaded', function() {
    const savedSettings = localStorage.getItem('imageExporterSettings');
    let useLocalCustomAppearance = false;
    if (savedSettings) {
        try {
            const settings = JSON.parse(savedSettings);
            useLocalCustomAppearance = settings.useCustom === true;
            document.querySelector('input[name="customBgColor"]').value = settings.bgColor || '#1a1a1a';
            document.querySelector('input[name="customTextColor"]').value = settings.textColor || '#ffffff';
            document.querySelector('input[name="customAccentColor"]').value = settings.accentColor || '#ff4500';
            document.querySelector('input[name="customWatermarkColor"]').value = settings.watermarkColor || '#888888';
            document.getElementById("customBgBase64").value = settings.bgImage || '';
            savedExporterBackgroundName = settings.bgImageName || '';
            document.querySelector('input[name="customWatermarkText"]').value = settings.watermarkText || '';
            document.getElementById('customWatermarkLogoBase64').value = settings.watermarkLogo || '';
            if (settings.watermarkLogo) {
                const image = document.createElement('img');
                image.src = settings.watermarkLogo;
                image.alt = 'Náhled loga watermarku';
                document.getElementById('exporter-watermark-logo-preview').replaceChildren(image);
            }
            document.getElementById("use-custom-settings").checked = settings.useCustom === true;
            document.getElementById('export-output-scale').value = settings.outputScale === '2' ? '2' : '1';
            document.getElementById('export-output-format').value =
                ['square', 'portrait', 'story', 'landscape'].includes(settings.outputFormat) ? settings.outputFormat : 'original';
        } catch (error) {
            console.error('Uložené nastavení exportéru se nepodařilo načíst.', error);
        }
    }
    if (!useLocalCustomAppearance) loadGlobalExporterBranding();
    
    // Načíst custom obrázky
    loadCustomImages();
    restoreExporterDrafts();
    ['home', 'away'].forEach(renderCustomLogoPreview);
    document.getElementById('match-logo-overrides').open = Boolean(
        document.getElementById('custom-home-logo-select').value ||
        document.getElementById('custom-away-logo-select').value
    );
    applyCustomLogoSelection('from');
    applyCustomLogoSelection('to');
    ['home', 'away', 'from', 'to'].forEach(toggleCustomTeam);
    document.getElementById('series-row').style.display =
        document.getElementById('is-playoff').checked ? 'grid' : 'none';
    document.getElementById('clinch-mode-row').style.display =
        document.getElementById('standings-type').value === 'regular' ? 'block' : 'none';
    document.querySelectorAll('.image-type-btn').forEach(button => {
        const form = document.getElementById(button.dataset.type + '-form');
        if (!form) return;
        form.addEventListener('input', saveExporterDrafts);
        form.addEventListener('change', saveExporterDrafts);
    });
    document.getElementById('export-output-scale').addEventListener('change', saveCustomSettings);
    document.getElementById('export-output-format').addEventListener('change', () => {
        updateExportFormatDescription();
        saveCustomSettings();
    });
    updateExportFormatDescription();
    document.querySelectorAll('#custom-section input, #custom-section select').forEach(input => {
        const updateSettings = () => {
            if (input.id !== 'use-custom-settings' && input.type !== 'file') {
                document.getElementById('use-custom-settings').checked = true;
            }
            saveCustomSettings();
        };
        input.addEventListener('input', updateSettings);
        input.addEventListener('change', updateSettings);
    });
});

// Custom obrázky - proměnná pro uložený obrázek
let uploadedCustomImageBase64 = null;
let savedExporterBackgroundName = '';

function handleCustomImageUpload(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        alert("Obrázek je příliš velký. Maximum je 5MB.");
        input.value = "";
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        uploadedCustomImageBase64 = e.target.result;
    };
    reader.readAsDataURL(file);
}

function uploadCustomImage() {
    const name = document.getElementById('customImageName').value.trim();
    if (!name) {
        alert('Zadej název obrázku');
        return;
    }
    if (!uploadedCustomImageBase64) {
        alert('Nejprve vyber obrázek');
        return;
    }
    
    // Načíst existující obrázky
    let customImages = JSON.parse(localStorage.getItem('customExporterImages') || '{}');
    
    // Přidat nový obrázek
    customImages[name] = {
        data: uploadedCustomImageBase64,
        uploadedAt: new Date().toISOString()
    };
    
    // Uložit
    localStorage.setItem('customExporterImages', JSON.stringify(customImages));
    
    // Reset
    document.getElementById('customImageInput').value = '';
    document.getElementById('customImageName').value = '';
    uploadedCustomImageBase64 = null;
    
    // Znovu načíst
    loadCustomImages();
    
    alert('Obrázek nahrán!');
}

function loadCustomImages() {
    let customImages;
    const grid = document.getElementById('custom-images-grid');
    try {
        customImages = JSON.parse(localStorage.getItem('customExporterImages') || '{}');
    } catch (error) {
        console.error('Uložené vlastní obrázky mají neplatný formát.', error);
        customImages = {};
    }

    if (!customImages || typeof customImages !== 'object' || Array.isArray(customImages)) {
        customImages = {};
    }

    const validImages = Object.fromEntries(Object.entries(customImages).filter(([, image]) =>
        image && typeof image.data === 'string' && image.data.startsWith('data:image/')
    ));

    updateCustomLogoSelects(Object.keys(validImages));
    if (Object.keys(validImages).length === 0) {
        grid.innerHTML = '<p style="color: #888; grid-column: 1/-1;">Žádné uložené obrázky</p>';
        return;
    }
    
    grid.innerHTML = Object.entries(validImages).map(([, imgData]) => {
        return '<div style="background: #222; padding: 10px; border: 1px solid #444;">' +
        '<img src="' + imgData.data + '" alt="" style="width: 100%; height: 100px; object-fit: contain; margin-bottom: 8px;">' +
        '<div style="font-size: 0.85em; color: #aaa; word-break: break-all; margin-bottom: 8px;"></div>' +
        '<div style="display: flex; gap: 5px;">' +
            '<button type="button" style="flex: 1; padding: 5px; background: #00d4ff; color: #000; border: none; cursor: pointer; font-size: 0.8em;">Jako pozadí</button>' +
            '<button type="button" style="flex: 1; padding: 5px; background: #ff4444; color: white; border: none; cursor: pointer; font-size: 0.8em;">Smazat</button>' +
        '</div>' +
        '</div>';
    }).join('');

    Array.from(grid.children).forEach((card, index) => {
        const name = Object.keys(validImages)[index];
        card.querySelector('div').textContent = name;
        card.querySelectorAll('button')[0].addEventListener('click', () => useCustomImage(name));
        card.querySelectorAll('button')[1].addEventListener('click', () => deleteCustomImage(name));
    });
}

function updateCustomLogoSelects(imageNames) {
    const selects = [
        [document.getElementById('custom-home-logo-select'), 'Použít výchozí logo týmu'],
        [document.getElementById('custom-away-logo-select'), 'Použít výchozí logo týmu'],
        [document.getElementById('transfer-from-logo-select'), 'Použít logo z nahraného souboru'],
        [document.getElementById('transfer-to-logo-select'), 'Použít logo z nahraného souboru'],
        [document.getElementById('custom-bg-image-select'), 'Použít barevné pozadí']
    ];

    selects.filter(([select]) => select).forEach(([select, placeholder]) => {
        const previousValue = select.value;
        const emptyLabel = imageNames.length === 0 &&
            (select.id === 'custom-home-logo-select' || select.id === 'custom-away-logo-select')
            ? 'Výchozí logo (nebo nahraj vlastní níže)'
            : placeholder;
        select.replaceChildren(new Option(emptyLabel, ''));
        imageNames.forEach(name => select.add(new Option(name, name)));
        if (imageNames.includes(previousValue)) select.value = previousValue;
        else if (previousValue) {
            if (select.id === 'custom-bg-image-select') {
                document.getElementById('customBgBase64').value = '';
                savedExporterBackgroundName = '';
            }
            if (select.id === 'transfer-from-logo-select') document.getElementById('customFromLogoBase64').value = '';
            if (select.id === 'transfer-to-logo-select') document.getElementById('customToLogoBase64').value = '';
        }
    });
    const backgroundSelect = document.getElementById('custom-bg-image-select');
    if (backgroundSelect && imageNames.includes(savedExporterBackgroundName)) {
        backgroundSelect.value = savedExporterBackgroundName;
    } else if (savedExporterBackgroundName) {
        savedExporterBackgroundName = '';
    }
    renderCustomLogoPreview('home');
    renderCustomLogoPreview('away');
    applyCustomLogoSelection('from');
    applyCustomLogoSelection('to');
    applyCustomBackgroundSelection();
}

function applyCustomLogoSelection(side, clearWhenEmpty = false) {
    const select = document.getElementById('transfer-' + side + '-logo-select');
    const hidden = document.getElementById('custom' + side.charAt(0).toUpperCase() + side.slice(1) + 'LogoBase64');
    if (!select || !hidden) return;
    const imageName = select.value;
    if (!imageName) {
        const fileInput = document.getElementById('custom' + side.charAt(0).toUpperCase() + side.slice(1) + 'LogoInput');
        if (clearWhenEmpty && !fileInput?.files.length) hidden.value = '';
        return;
    }
    try {
        const images = JSON.parse(localStorage.getItem('customExporterImages') || '{}');
        hidden.value = images[imageName]?.data || '';
    } catch (error) {
        console.error('Vlastní logo týmu se nepodařilo načíst.', error);
        hidden.value = '';
    }
}

function applyCustomBackgroundSelection(clearWhenEmpty = false) {
    const select = document.getElementById('custom-bg-image-select');
    const preview = document.getElementById('exporter-bg-preview');
    if (!select) return;
    const imageName = select.value;
    if (!imageName) {
        savedExporterBackgroundName = '';
        if (clearWhenEmpty) document.getElementById('customBgBase64').value = '';
        if (preview) preview.replaceChildren();
        if (clearWhenEmpty) saveCustomSettings();
        return;
    }
    try {
        const images = JSON.parse(localStorage.getItem('customExporterImages') || '{}');
        const imageData = images[imageName]?.data;
        if (!imageData || !imageData.startsWith('data:image/')) return;
        document.getElementById('customBgBase64').value = imageData;
        savedExporterBackgroundName = imageName;
        if (clearWhenEmpty) document.getElementById('use-custom-settings').checked = true;
        if (preview) {
            preview.replaceChildren();
            const thumbnail = document.createElement('img');
            thumbnail.src = imageData;
            thumbnail.alt = '';
            const label = document.createElement('span');
            label.textContent = imageName;
            preview.append(thumbnail, label);
        }
        if (clearWhenEmpty) saveCustomSettings();
    } catch (error) {
        console.error('Vlastní pozadí se nepodařilo načíst.', error);
    }
}

function updateCustomLogoPreview(side) {
    const select = document.getElementById('custom-' + side + '-logo-select');
    const preview = document.getElementById('custom-' + side + '-logo-preview');
    if (!select || !preview) return;

    const sideName = side.charAt(0).toUpperCase() + side.slice(1);
    const base64Input = document.getElementById('custom' + sideName + 'LogoBase64');
    const fileInput = document.getElementById('custom' + sideName + 'LogoInput');
    if (base64Input) base64Input.value = '';
    if (fileInput) fileInput.value = '';
    renderCustomLogoPreview(side);
}

function renderCustomLogoPreview(side) {
    const select = document.getElementById('custom-' + side + '-logo-select');
    const preview = document.getElementById('custom-' + side + '-logo-preview');
    if (!select || !preview) return;

    const sideName = side.charAt(0).toUpperCase() + side.slice(1);
    const uploadedImage = document.getElementById('custom' + sideName + 'LogoBase64')?.value;
    let image = uploadedImage
        ? { data: uploadedImage }
        : null;
    const selectedName = select.value;
    if (!image && selectedName) {
        try {
            const customImages = JSON.parse(localStorage.getItem('customExporterImages') || '{}');
            image = customImages[selectedName];
        } catch (error) {
            console.error('Náhled vlastního loga se nepodařilo načíst.', error);
        }
    }

    preview.replaceChildren();
    if (!image || typeof image.data !== 'string' || !image.data.startsWith('data:image/')) return;
    const thumbnail = document.createElement('img');
    thumbnail.src = image.data;
    thumbnail.alt = '';
    const label = document.createElement('span');
    label.textContent = uploadedImage
        ? document.getElementById('custom' + sideName + 'LogoInput')?.files[0]?.name || 'Nahrané logo'
        : selectedName;
    preview.append(thumbnail, label);
}

function deleteCustomImage(name) {
    if (!confirm('Opravdu smazat obrázek "' + name + '"?')) return;
    
    let customImages = JSON.parse(localStorage.getItem('customExporterImages') || '{}');
    delete customImages[name];
    localStorage.setItem('customExporterImages', JSON.stringify(customImages));
    
    loadCustomImages();
}

function useCustomImage(name) {
    const select = document.getElementById('custom-bg-image-select');
    if (!select || !Array.from(select.options).some(option => option.value === name)) {
        alert('Nejprve vyber obrázek pozadí v nástroji Vzhled a branding.');
        return;
    }
    showExporterTool('custom');
    select.value = name;
    applyCustomBackgroundSelection(true);
    document.getElementById('custom-section').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function generateImage(type) {
    const btn = document.getElementById('generate-btn-' + type);
    if (!btn) return;
    if (!validateExporterForm(type)) return;
    const errorMessage = document.getElementById('exporter-error');
    errorMessage.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Generuji...';

    try {
        const form = document.getElementById(type + '-form');
        if (!form) {
            console.error('Formulář pro export nebyl nalezen.');
            return;
        }
        const formData = new FormData(form);
        const data = Object.fromEntries(formData);
        data.type = type;
        data.outputScale = document.getElementById('export-output-scale').value;
        data.outputFormat = document.getElementById('export-output-format').value;
        const watermarkInput = form.querySelector('input[name="watermark"]');
        if (watermarkInput) data.watermark = watermarkInput.checked ? 'true' : 'false';

        const useCustom = document.getElementById("use-custom-settings").checked;
        if (useCustom) {
            data.customBgColor = document.querySelector('input[name="customBgColor"]').value;
            data.customTextColor = document.querySelector('input[name="customTextColor"]').value;
            data.customAccentColor = document.querySelector('input[name="customAccentColor"]').value;
            data.customWatermarkColor = document.querySelector('input[name="customWatermarkColor"]').value;
            data.customBgImage = document.getElementById("customBgBase64").value;
            data.customWatermarkText = document.querySelector('input[name="customWatermarkText"]').value;
            data.customWatermarkLogo = document.getElementById('customWatermarkLogoBase64').value;
            if (type === 'winner') data.winnerColor = data.customAccentColor;
        }

        let customImages;
        try {
            customImages = JSON.parse(localStorage.getItem('customExporterImages') || '{}');
        } catch (error) {
            console.error('Uložené vlastní obrázky se nepodařilo načíst.', error);
            customImages = {};
        }
        ['customHomeLogo', 'customAwayLogo'].forEach(field => {
            const imageName = data[field];
            if (!imageName) return;
            const image = customImages[imageName];
            if (!image || typeof image.data !== 'string' || !image.data.startsWith('data:image/')) {
                throw new Error('Vybraný vlastní obrázek "' + imageName + '" už není dostupný. Obnov výběr loga.');
            }
            data[field] = image.data;
        });

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
            const typeLabel = document.querySelector('.image-type-btn[data-type="' + type + '"] span:not(.exporter-tab-icon)');

            img.onerror = () => {
                document.getElementById('preview-meta').textContent = 'Náhled se nepodařilo zobrazit.';
            };
            img.src = result.url + '?t=' + Date.now();
            downloadBtn.href = result.url;
            downloadBtn.download = result.filename;
            document.getElementById('open-preview-btn').href = result.url;
            document.getElementById('preview-generated-type').textContent =
                (typeLabel?.textContent || 'Export') + ' · ' + new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
            preview.classList.add('active');
            preview.classList.add('has-image');
            const dimensions = result.width && result.height ? result.width + ' × ' + result.height + ' px' : 'PNG';
            const size = result.sizeBytes ? ' · ' + (result.sizeBytes / 1024 / 1024).toFixed(2) + ' MB' : '';
            document.getElementById('preview-meta').textContent = dimensions + size;
            preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            const response = await res.json().catch(() => ({}));
            console.error(response.error || 'Obrázek se nepodařilo vygenerovat.');
            errorMessage.textContent = response.error || 'Obrázek se nepodařilo vygenerovat.';
            errorMessage.hidden = false;
        }
    } catch (error) {
        console.error('Chyba při generování obrázku:', error);
        errorMessage.textContent = error.message || 'Chyba při generování obrázku.';
        errorMessage.hidden = false;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Vygenerovat obrázek';
    }
}

function saveExporterDrafts() {
    document.querySelectorAll('.image-type-btn').forEach(button => {
        const type = button.dataset.type;
        const form = document.getElementById(type + '-form');
        if (!form) return;
        const values = {};
        form.querySelectorAll('input:not([type="file"]):not([type="hidden"]), select, textarea').forEach(field => {
            if (!field.name) return;
            values[field.name] = field.type === 'checkbox' ? field.checked : field.value;
        });
        try {
            localStorage.setItem('imageExporterDraft-' + type, JSON.stringify(values));
        } catch (error) {
            console.warn('Rozpracované nastavení exportu se nepodařilo uložit.', error);
        }
    });
}

function restoreExporterDrafts() {
    document.querySelectorAll('.image-type-btn').forEach(button => {
        const type = button.dataset.type;
        const form = document.getElementById(type + '-form');
        if (!form) return;
        try {
            const values = JSON.parse(localStorage.getItem('imageExporterDraft-' + type) || '{}');
            Object.entries(values).forEach(([name, value]) => {
                const field = form.elements.namedItem(name);
                if (!field || field instanceof RadioNodeList) return;
                if (field.type === 'checkbox') field.checked = Boolean(value);
                else if (Array.from(field.options || []).some(option => option.value === value) || field.tagName !== 'SELECT') {
                    field.value = value;
                }
            });
        } catch (error) {
            console.warn('Rozpracovaný export ' + type + ' se nepodařilo obnovit.', error);
        }
    });
}

function toggleCustomTeam(side) {
    const select = document.getElementById(side + 'TeamSelect');
    const customDiv = document.getElementById('custom' + side.charAt(0).toUpperCase() + side.slice(1) + 'Team');
    if (!select || !customDiv) return;
    
    if (select.value === 'custom') {
        customDiv.style.display = 'flex';
        const nameInput = customDiv.querySelector('input[type="text"]');
        if (nameInput) nameInput.required = true;
    } else {
        customDiv.style.display = 'none';
        const nameInput = customDiv.querySelector('input[type="text"]');
        if (nameInput) nameInput.required = false;
    }
}

function handleCustomLogoUpload(side, input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
        alert('Obrázek je příliš velký. Maximum je 5MB.');
        input.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        const sideName = side.charAt(0).toUpperCase() + side.slice(1);
        const base64Input = document.getElementById('custom' + sideName + 'LogoBase64');
        if (!base64Input) return;
        base64Input.value = e.target.result;
        const select = document.getElementById('custom-' + side + '-logo-select');
        if (select) select.value = '';
        renderCustomLogoPreview(side);
    };
    reader.readAsDataURL(file);
}

</script>
${renderNotificationScript(req.session.csrfToken || '')}
<body class="usersite">
${await renderUserHeader({
    username: username,
    selectedLiga: selectedLiga,
    uniqueLeagues: uniqueLeagues,
    activeTab: 'exporter',
    csrfToken: req.session.csrfToken || '',
    timeWidgetHtml: await generateTimeWidget()
})}
<main class="main_page image-exporter-layout">`;

html += await generateLeftPanel(data);

html += `<section class="matches-container image-exporter-page">
    <div class="section-header exporter-heading">
        <div class="section-title">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
            <span>Exportér obrázků a grafiky<small>Vytvoř si vlastní zápasovou grafiku během pár kliknutí.</small></span>
        </div>
    </div>
    
    <div class="exporter-filter-panel">
        <h4>🔧 Filtr týmů pro exportér</h4>
        <form method="GET" class="exporter-filter-form">
            <div style="flex: 1; min-width: 200px;">
                <label>Liga:</label>
                <select name="exporterLiga" onchange="this.form.submit()">
                    <option value="all" ${exporterLiga === "all" ? "selected" : ""}>Všechny ligy</option>
                    ${uniqueLeagues.map(l => `<option value="${l}" ${exporterLiga === l ? "selected" : ""}>${l}</option>`).join('')}
                </select>
            </div>
            <div style="flex: 1; min-width: 200px;">
                <label>Sezóna:</label>
                <select name="exporterSeason" onchange="this.form.submit()">
                    <option value="all" ${exporterSeason === "all" ? "selected" : ""}>Všechny sezóny</option>
                    ${seasonsFromTeams.map(s => `<option value="${s}" ${exporterSeason === s ? "selected" : ""}>${s}</option>`).join('')}
                </select>
            </div>
            <div class="exporter-team-count">
                ${teamsList.length} týmů k dispozici
            </div>
        </form>
    </div>
    
    <div class="image-exporter-container">
        <div class="exporter-step-heading">
            <span class="exporter-step-number">01</span>
            <div><h3>Vyber typ grafiky</h3><p>Každý typ má vlastní formulář. Textová nastavení se průběžně ukládají v tomto prohlížeči; nahrané soubory je potřeba po návratu vybrat znovu.</p></div>
        </div>
        <div class="image-type-selector" role="tablist" aria-label="Typ exportu">
            <button type="button" role="tab" data-type="match" aria-selected="true" aria-controls="match-section" class="image-type-btn active" onclick="showImageType('match', event)"><span class="exporter-tab-icon">🏒</span><span>Zápas</span><small>Grafika před utkáním</small></button>
            <button type="button" role="tab" data-type="result" aria-selected="false" aria-controls="result-section" class="image-type-btn" onclick="showImageType('result', event)"><span class="exporter-tab-icon">📊</span><span>Výsledek</span><small>Skóre i stav série</small></button>
            <button type="button" role="tab" data-type="transfer" aria-selected="false" aria-controls="transfer-section" class="image-type-btn" onclick="showImageType('transfer', event)"><span class="exporter-tab-icon">🔄</span><span>Přestup</span><small>Hráč mezi kluby</small></button>
            <button type="button" role="tab" data-type="winner" aria-selected="false" aria-controls="winner-section" class="image-type-btn" onclick="showImageType('winner', event)"><span class="exporter-tab-icon">🏆</span><span>Vítěz ligy</span><small>Oslava titulu</small></button>
            <button type="button" role="tab" data-type="standings" aria-selected="false" aria-controls="standings-section" class="image-type-btn" onclick="showImageType('standings', event)"><span class="exporter-tab-icon">📋</span><span>Tabulka</span><small>Základní část / playoff</small></button>
            <button type="button" role="tab" data-type="statistics" aria-selected="false" aria-controls="statistics-section" class="image-type-btn" onclick="showImageType('statistics', event)"><span class="exporter-tab-icon">📈</span><span>Statistiky</span><small>Výkony tipujících</small></button>
        </div>

        <div class="exporter-workspace">
          <div class="exporter-controls">
        <div class="exporter-step-heading exporter-config-heading">
            <span class="exporter-step-number" id="exporter-config-step">02</span>
            <div><h3>Nastav obsah</h3><p>Vyplň jen potřebné údaje; nepovinná pole můžeš nechat prázdná.</p></div>
            <button type="button" class="exporter-reset-btn" onclick="resetActiveExporterForm()">Vymazat formulář</button>
        </div>
        <div id="match-section" class="form-section active">
            <h3 style="color: #ff4500; margin-top: 0;">Obrázek zápasu (VS)</h3>
            <form id="match-form" onsubmit="event.preventDefault(); generateImage('match');">
                <div class="form-row">
                    <div class="form-group">
                        <label>Domácí tým</label>
                        <select name="homeTeamId" id="homeTeamSelect" required onchange="toggleCustomTeam('home')">
                            <option value="">Vyber tým</option>
                            <option value="custom">Vlastní tým</option>
                            ${teamsList.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name} (${t.liga} - ${t.season})</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Hostující tým</label>
                        <select name="awayTeamId" id="awayTeamSelect" required onchange="toggleCustomTeam('away')">
                            <option value="">Vyber tým</option>
                            <option value="custom">Vlastní tým</option>
                            ${teamsList.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name} (${t.liga} - ${t.season})</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="exporter-swap-row"><button type="button" class="exporter-swap-btn" onclick="swapTeams('match')">⇄ Prohodit domácí a hostující</button></div>
                <div class="form-row" id="customHomeTeam" style="display: none;">
                    <div class="form-group">
                        <label>Vlastní název týmu (domácí)</label>
                        <input type="text" name="customHomeTeamName" placeholder="např. Toronto Maple Leafs">
                    </div>
                    <div class="form-group">
                        <label>Liga (domácí)</label>
                        <input type="text" name="customHomeLeague" placeholder="např. NHL">
                    </div>
                </div>
                <div class="form-row" id="customAwayTeam" style="display: none;">
                    <div class="form-group">
                        <label>Vlastní název týmu (hostující)</label>
                        <input type="text" name="customAwayTeamName" placeholder="např. Edmonton Oilers">
                    </div>
                    <div class="form-group">
                        <label>Liga (hostující)</label>
                        <input type="text" name="customAwayLeague" placeholder="např. NHL">
                    </div>
                </div>
                <details class="exporter-logo-settings" id="match-logo-overrides">
                    <summary>
                        <span>Vlastní loga</span>
                        <small>Nepovinné · výchozí loga týmů se použijí automaticky</small>
                    </summary>
                    <div class="exporter-logo-overrides">
                        <div class="exporter-logo-card">
                            <div class="exporter-logo-card-heading">
                                <strong>Logo domácího týmu</strong>
                            </div>
                            <div class="form-group">
                                <label for="custom-home-logo-select">Logo z Knihovny obrázků</label>
                                <select name="customHomeLogo" id="custom-home-logo-select" onchange="updateCustomLogoPreview('home')">
                                    <option value="">Použít výchozí logo týmu</option>
                                </select>
                            </div>
                            <div class="exporter-logo-upload">
                                <label for="customHomeLogoInput">Nebo nahrát logo z počítače</label>
                                <input type="file" id="customHomeLogoInput" accept="image/*" onchange="handleCustomLogoUpload('home', this)">
                                <input type="hidden" name="customHomeLogoBase64" id="customHomeLogoBase64">
                                <small>Obrázek do 5 MB. Nahrané logo má přednost před výběrem z knihovny.</small>
                            </div>
                            <div id="custom-home-logo-preview" class="exporter-logo-preview" aria-live="polite"></div>
                        </div>
                        <div class="exporter-logo-card">
                            <div class="exporter-logo-card-heading">
                                <strong>Logo hostujícího týmu</strong>
                            </div>
                            <div class="form-group">
                                <label for="custom-away-logo-select">Logo z Knihovny obrázků</label>
                                <select name="customAwayLogo" id="custom-away-logo-select" onchange="updateCustomLogoPreview('away')">
                                    <option value="">Použít výchozí logo týmu</option>
                                </select>
                            </div>
                            <div class="exporter-logo-upload">
                                <label for="customAwayLogoInput">Nebo nahrát logo z počítače</label>
                                <input type="file" id="customAwayLogoInput" accept="image/*" onchange="handleCustomLogoUpload('away', this)">
                                <input type="hidden" name="customAwayLogoBase64" id="customAwayLogoBase64">
                                <small>Obrázek do 5 MB. Nahrané logo má přednost před výběrem z knihovny.</small>
                            </div>
                            <div id="custom-away-logo-preview" class="exporter-logo-preview" aria-live="polite"></div>
                        </div>
                    </div>
                </details>
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
                            ${teamsList.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name} (${t.liga} - ${t.season})</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Hostující tým</label>
                        <select name="awayTeamId" required>
                            <option value="">Vyber tým</option>
                            ${teamsList.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name} (${t.liga} - ${t.season})</option>`).join('')}
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
                    <input type="checkbox" name="isPlayoff" id="is-playoff" onchange="document.getElementById('series-row').style.display = this.checked ? 'grid' : 'none'">
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
                        <select name="fromTeamId" id="fromTeamSelect" required onchange="toggleCustomTeam('from')">
                            <option value="">Vyber tým</option>
                            <option value="custom">Vlastní tým</option>
                            ${teamsList.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name} (${t.liga} - ${t.season})</option>`).join('')}
                        </select>
                    </div>
                    <div class="form-group">
                        <label>Do týmu</label>
                        <select name="toTeamId" id="toTeamSelect" required onchange="toggleCustomTeam('to')">
                            <option value="">Vyber tým</option>
                            <option value="custom">Vlastní tým</option>
                            ${teamsList.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name} (${t.liga} - ${t.season})</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="exporter-swap-row"><button type="button" class="exporter-swap-btn" onclick="swapTeams('transfer')">⇄ Prohodit původní a nový tým</button></div>
                <div class="form-row" id="customFromTeam" style="display: none;">
                    <div class="form-group">
                        <label>Vlastní název týmu (z)</label>
                        <input type="text" name="customFromTeamName" placeholder="např. Toronto Maple Leafs">
                    </div>
                    <div class="form-group">
                        <label>Liga týmu (z)</label>
                        <input type="text" name="customFromLeague" placeholder="např. NHL">
                    </div>
                </div>
                <div class="form-group" id="customFromLogoUpload" style="display: none;">
                    <label>Vlastní logo týmu (z) (nepovinné)</label>
                    <select name="transferFromLogoSelection" id="transfer-from-logo-select" onchange="applyCustomLogoSelection('from', true)">
                        <option value="">Použít logo z nahraného souboru</option>
                    </select>
                    <input type="file" id="customFromLogoInput" accept="image/*,image/webp" onchange="handleCustomLogoUpload('from', this)">
                    <input type="hidden" name="customFromLogoBase64" id="customFromLogoBase64">
                    <small style="color: #888; display: block; margin-top: 5px;">Vyber uložené logo nebo nahraj soubor (max. 5MB).</small>
                </div>
                <div class="form-row" id="customToTeam" style="display: none;">
                    <div class="form-group">
                        <label>Vlastní název týmu (do)</label>
                        <input type="text" name="customToTeamName" placeholder="např. Edmonton Oilers">
                    </div>
                    <div class="form-group">
                        <label>Liga týmu (do)</label>
                        <input type="text" name="customToLeague" placeholder="např. NHL">
                    </div>
                </div>
                <div class="form-group" id="customToLogoUpload" style="display: none;">
                    <label>Vlastní logo týmu (do) (nepovinné)</label>
                    <select name="transferToLogoSelection" id="transfer-to-logo-select" onchange="applyCustomLogoSelection('to', true)">
                        <option value="">Použít logo z nahraného souboru</option>
                    </select>
                    <input type="file" id="customToLogoInput" accept="image/*,image/webp" onchange="handleCustomLogoUpload('to', this)">
                    <input type="hidden" name="customToLogoBase64" id="customToLogoBase64">
                    <small style="color: #888; display: block; margin-top: 5px;">Vyber uložené logo nebo nahraj soubor (max. 5MB).</small>
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
                        ${teamsList.sort((a, b) => a.id - b.id).map(t => `<option value="${t.id}">${t.name} (${t.liga} - ${t.season})</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Text nadpisu</label>
                    <input type="text" name="winnerTitle" value="VÍTĚZ ${selectedLiga}" placeholder="např. VÍTĚZ TELH 2024/25">
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Barva akcentu</label>
                        <input type="color" name="winnerColor" value="#ff4500" style="width: 60px; height: 40px; padding: 0; border: none; cursor: pointer;">
                        <small style="color: #888; display: block; margin-top: 5px;">Výchozí barva odpovídá společnému akcentu.</small>
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

        <div class="exporter-tools">
            <span>Další nástroje</span>
            <button type="button" class="exporter-tool-btn" data-tool="custom" aria-expanded="false" onclick="showExporterTool('custom', true)">🎨 Vzhled a branding</button>
            <button type="button" class="exporter-tool-btn" data-tool="custom-images" aria-expanded="false" onclick="showExporterTool('custom-images', true)">🖼️ Knihovna obrázků</button>
        </div>
        
        <div id="custom-images-section" class="form-section">
            <h3 style="color: #ff4500; margin-top: 0;">Knihovna vlastních obrázků</h3>
            <p style="color: #888; font-size: 0.9em; margin-bottom: 15px;">Obrázky se ukládají pouze v tomto prohlížeči a můžeš je použít jako týmová loga nebo pozadí.</p>
            
            <div class="form-group">
                <label>Nahrát nový obrázek</label>
                <input type="file" id="customImageInput" accept="image/*" onchange="handleCustomImageUpload(this)">
                <input type="text" id="customImageName" placeholder="Název obrázku (např. logo-tymu)" style="margin-top: 10px; width: 100%; padding: 8px; background: #222; color: white; border: 1px solid #444;">
                <button type="button" onclick="uploadCustomImage()" class="generate-btn">Nahrát do knihovny</button>
                <small style="color: #888; display: block; margin-top: 5px;">Max 5MB, uloží se do prohlížeče (localStorage)</small>
            </div>
            
            <div id="custom-images-list" style="margin-top: 20px;">
                <h4 style="color: #00d4ff; margin-bottom: 10px;">Uložené obrázky:</h4>
                <div id="custom-images-grid" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 15px;">
                    <!-- Obrázky se načtou dynamicky -->
                </div>
            </div>
        </div>
        
        <div id="custom-section" class="form-section">
            <h3 style="color: #ff4500; margin-top: 0;">Vzhled a branding</h3>
            <p style="color: #888; font-size: 0.9em; margin-bottom: 15px;">Jednotný vzhled všech šesti grafik. Administrátor může tento branding nastavit také pro automatické obrázky v notifikacích.</p>

            <div class="exporter-presets" aria-label="Předvolby vzhledu">
                <button type="button" class="exporter-preset-btn" onclick="applyExporterPreset('arena', event)"><span>🏟️</span><b>Aréna</b><small>Tmavá / oranžová</small></button>
                <button type="button" class="exporter-preset-btn" onclick="applyExporterPreset('ice', event)"><span>❄️</span><b>Led</b><small>Temná / ledově modrá</small></button>
                <button type="button" class="exporter-preset-btn" onclick="applyExporterPreset('night', event)"><span>🌙</span><b>Noční</b><small>Tmavá / fialová</small></button>
            </div>
            
            <div class="form-row">
                <div class="form-group">
                    <label>Barva pozadí</label>
                    <input type="color" name="customBgColor" value="#1a1a1a" style="width: 60px; height: 40px; padding: 0; border: none; cursor: pointer;">
                    <small style="color: #888; display: block; margin-top: 5px;">Výchozí: #1a1a1a (tmavě šedá)</small>
                </div>
                <div class="form-group">
                    <label>Barva textu</label>
                    <input type="color" name="customTextColor" value="#ffffff" style="width: 60px; height: 40px; padding: 0; border: none; cursor: pointer;">
                    <small style="color: #888; display: block; margin-top: 5px;">Výchozí: #ffffff (bílá)</small>
                </div>
            </div>
            
            <div class="form-row">
                <div class="form-group">
                    <label>Barva akcentu (nadpisy, zvýraznění)</label>
                    <input type="color" name="customAccentColor" value="#ff4500" style="width: 60px; height: 40px; padding: 0; border: none; cursor: pointer;">
                    <small style="color: #888; display: block; margin-top: 5px;">Výchozí: #ff4500 (oranžová)</small>
                </div>
                <div class="form-group">
                    <label>Barva watermarku</label>
                    <input type="color" name="customWatermarkColor" value="#888888" style="width: 60px; height: 40px; padding: 0; border: none; cursor: pointer;">
                    <small style="color: #888; display: block; margin-top: 5px;">Výchozí: #888888 (šedá)</small>
                </div>
            </div>
            
            <div class="form-group">
                <label>Custom pozadí (nepovinné)</label>
                <select id="custom-bg-image-select" onchange="applyCustomBackgroundSelection(true)">
                    <option value="">Použít barevné pozadí</option>
                </select>
                <div id="exporter-bg-preview" class="exporter-logo-preview" aria-live="polite"></div>
                <input type="file" id="customBgInput" accept="image/png,image/jpeg,image/webp,image/gif" onchange="handleCustomBg(this)">
                <input type="hidden" name="customBgImage" id="customBgBase64">
                <small style="color: #888; display: block; margin-top: 5px;">Max 5MB. Pozadí se použije u všech exportovaných grafik i obrázků v notifikacích.</small>
            </div>
            
            <div class="form-group">
                <label>Text brandingu / watermarku (nepovinný)</label>
                <input type="text" name="customWatermarkText" placeholder="např. @muj_tipovacka">
                <small style="color: #888; display: block; margin-top: 5px;">Zobrazí se ve všech grafikách, pokud je watermark zapnutý.</small>
            </div>

            <div class="form-group">
                <label>Logo watermarku (nepovinné)</label>
                <input type="file" id="customWatermarkLogoInput" accept="image/png,image/jpeg,image/webp,image/gif" onchange="handleWatermarkLogoUpload(this)">
                <input type="hidden" id="customWatermarkLogoBase64">
                <div id="exporter-watermark-logo-preview" class="exporter-logo-preview" aria-live="polite"></div>
                <small style="color: #888; display: block; margin-top: 5px;">Max 5MB. Nahradí výchozí logo značky ve watermarku.</small>
            </div>
            
            <div class="form-group watermark-option">
                <input type="checkbox" name="useCustomSettings" id="use-custom-settings">
                <label for="use-custom-settings" style="margin: 0;">Používat vlastní barvy při generování</label>
            </div>
            
            <div class="exporter-settings-actions">
                <button type="button" onclick="saveCustomSettings()" class="generate-btn">Uložit jako výchozí vzhled</button>
                ${req.session.role === 'admin' ? '<button type="button" onclick="saveGlobalExporterBranding()" class="generate-btn">Uložit branding pro všechny a notifikace</button>' : ''}
                <button type="button" onclick="resetCustomSettings()" class="exporter-reset-btn">Obnovit výchozí</button>
                <span id="exporter-settings-status" aria-live="polite"></span>
            </div>
        </div>
          </div>

          <aside class="exporter-preview-column" aria-label="Náhled exportu">
            <div class="exporter-step-heading">
                <span class="exporter-step-number">03</span>
                <div><h3>Vygeneruj a stáhni</h3><p>Náhled se vytvoří až po potvrzení formuláře.</p></div>
            </div>
            <div class="exporter-output-settings">
                <label for="export-output-format">Formát a poměr stran</label>
                <select id="export-output-format">
                    <option value="original">Původní poměr stran</option>
                    <option value="square">Čtverec · 1:1</option>
                    <option value="portrait">Portrét · 4:5</option>
                    <option value="story">Stories · 9:16</option>
                    <option value="landscape">Krajina · 16:9</option>
                </select>
                <small id="export-format-description"></small>
                <label for="export-output-scale">Rozlišení</label>
                <select id="export-output-scale">
                    <option value="1">Standardní</option>
                    <option value="2">Vysoké · 2× více pixelů</option>
                </select>
                <small>2× rozměry znamenají 4× tolik pixelů a delší generování.</small>
            </div>
            <div id="preview-container" class="preview-container active">
                <div id="preview-empty-state" class="preview-empty-state">
                    <span>🏒</span>
                    <strong>Grafika se objeví tady</strong>
                    <p>Vyber typ, doplň údaje a stiskni „Vygenerovat obrázek“.</p>
                </div>
                <div class="exporter-preview-result">
                    <div class="exporter-preview-title">
                        <h3>Náhled exportu</h3>
                        <span id="preview-meta" aria-live="polite"></span>
                    </div>
                    <div id="preview-generated-type" class="preview-generated-type"></div>
                    <img id="preview-img" src="" alt="Náhled vygenerovaného obrázku">
                    <div class="exporter-preview-actions">
                        <a id="download-btn" href="" download class="download-btn">Stáhnout PNG</a>
                        <a id="open-preview-btn" href="" target="_blank" rel="noopener" class="exporter-open-btn">Otevřít samostatně</a>
                    </div>
                </div>
            </div>
            <div id="exporter-error" class="exporter-error" role="alert" hidden></div>
          </aside>
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
            .catch(err => console.error('Nepodařilo se načíst verzi', err));
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
        const selectedSeason = req.query.season || chosenSeason || 'Neurčeno';

        const users = await Users.findAll();
        const leaguesData = await Leagues.findAll();
        const leagues = Array.isArray(leaguesData?.[selectedSeason]) ? leaguesData[selectedSeason] : [];
        const teamsList = await Teams.findAll();

        // Mapa pro rychlé zjištění názvu týmu podle ID
        const teamNameMap = {};
        if (Array.isArray(teamsList)) {
            teamsList.forEach(t => {
                if (t.id !== undefined && t.id !== null) {
                    teamNameMap[String(t.id)] = t.name;
                }
            });
        }

        const allSeasonsFromLeagues = new Set();
        Object.keys(leaguesData || {}).forEach(season => {
            if (!season.startsWith('_') && season !== 'leagues') {
                allSeasonsFromLeagues.add(season);
            }
        });
        const definedLeagues = new Set();
        if (leaguesData?.[selectedSeason]?.leagues) {
            leaguesData[selectedSeason].leagues.forEach(l => definedLeagues.add(l.name));
        }

        const matches = await Matches.findAll();

        const allLeaguesInStats = new Set();
        for (const user of users) {
            const stats = user.stats?.[selectedSeason] || {};
            for (const league of Object.keys(stats)) {
                if (definedLeagues.has(league)) {
                    allLeaguesInStats.add(league);
                }
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
                    maxPoints += 5;
                } else if (match.isPlayoff && Number(match.bo) > 1) {
                    maxPoints += 3;
                } else {
                    maxPoints += 1;
                }
            }
            leagueMaxPointsMap[league] = maxPoints;
        }

        // Výpočet statistik pro každého uživatele (včetně Srdcovky a Kata po ligách)
        const userStats = users
            .filter(u => u.username !== 'Admin')
            .map(user => {
                const stats = user.stats?.[selectedSeason] || {};

                let totalCorrect = 0;
                let totalRegular = 0;
                let totalPlayoff = 0;
                let totalTableCorrect = 0;
                let totalTableDeviation = 0;
                let leagueCount;

                const activeLeagues = [];
                let totalRegularCorrect = 0;
                let totalPlayoffBO1Correct = 0;
                let totalPlayoffBO1Tips = 0;
                let totalPlayoffBOSeriesCorrect = 0;
                let totalPlayoffBOSeriesTips = 0;

                let userTotalDeviationSum = 0;
                let userEvaluatedBO1Count = 0;

                let needsPlayoffCalculation = false;
                for (const league of Object.keys(stats)) {
                    const leagueStats = stats[league];
                    if (leagueStats.totalPlayoff > 0 &&
                        (leagueStats.playoffBO1Correct === undefined || leagueStats.playoffBOSeriesCorrect === undefined)) {
                        needsPlayoffCalculation = true;
                        break;
                    }
                }

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

                                userTotalDeviationSum += Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
                                userEvaluatedBO1Count++;
                            } else {
                                seriesTips++;
                                const realWinner = match.result.winner;
                                const tipWinner = tip.winner;

                                if (tipWinner === realWinner) {
                                    seriesCorrect++;
                                }
                            }
                        }

                        leagueStats.playoffBO1Correct = bo1Correct;
                        leagueStats.playoffBO1Tips = bo1Tips;
                        leagueStats.playoffBOSeriesCorrect = seriesCorrect;
                        leagueStats.playoffBOSeriesTips = seriesTips;
                    }
                } else {
                    const tips = user.tips?.[selectedSeason] || {};
                    for (const league of Object.keys(tips)) {
                        const leagueTips = tips[league] || [];
                        for (const tip of leagueTips) {
                            const match = matches.find(m => m.id === tip.matchId);
                            if (!match?.result || !match.result.winner) continue;
                            if (!match.isPlayoff || Number(match.bo) !== 1) continue;

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
                                userTotalDeviationSum += Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
                                userEvaluatedBO1Count++;
                            }
                        }
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

                        if (leagueStats.correctRegular !== undefined) {
                            totalRegularCorrect += leagueStats.correctRegular || 0;
                        } else {
                            if (leagueStats.totalRegular > 0) {
                                totalRegularCorrect += Math.min(leagueStats.correct || 0, leagueStats.totalRegular);
                            }
                        }

                        totalPlayoffBO1Correct += leagueStats.playoffBO1Correct || 0;
                        totalPlayoffBO1Tips += leagueStats.playoffBO1Tips || 0;
                        totalPlayoffBOSeriesCorrect += leagueStats.playoffBOSeriesCorrect || 0;
                        totalPlayoffBOSeriesTips += leagueStats.playoffBOSeriesTips || 0;

                        activeLeagues.push(league);
                    }
                }

                leagueCount = activeLeagues.length;

                let totalMaxPoints = 0;
                for (const league of activeLeagues) {
                    totalMaxPoints += leagueMaxPointsMap[league] || 0;
                }

                const totalTips = totalRegular + totalPlayoff;
                const successRate = totalMaxPoints > 0 ? ((totalCorrect / totalMaxPoints) * 100).toFixed(1) : 0;
                const regularSuccessRate = totalRegular > 0 ? ((totalRegularCorrect / totalRegular) * 100).toFixed(1) : 0;
                const playoffBO1SuccessRate = totalPlayoffBO1Tips > 0 ? ((totalPlayoffBO1Correct / totalPlayoffBO1Tips) * 100).toFixed(1) : 0;
                const playoffBOSeriesSuccessRate = totalPlayoffBOSeriesTips > 0 ? ((totalPlayoffBOSeriesCorrect / totalPlayoffBOSeriesTips) * 100).toFixed(1) : 0;
                const tableSuccessRate = leagueCount > 0 ? ((totalTableCorrect / (leagueCount * 10)) * 100).toFixed(1) : 0;
                const avgGoalDeviation = userEvaluatedBO1Count > 0 ? (userTotalDeviationSum / userEvaluatedBO1Count).toFixed(2) : null;

                // --- VÝPOČET SRDCOVKY A KATA PRO KAŽDOU LIGU ZVLÁŠŤ ---
                const leagueTeamStats = {};
                const userTipsObj = user.tips?.[selectedSeason] || {};

                for (const leagueKey of Object.keys(userTipsObj)) {
                    let leagueTipsArr = userTipsObj[leagueKey] || [];
                    if (!Array.isArray(leagueTipsArr) && typeof leagueTipsArr === 'object') {
                        leagueTipsArr = Object.values(leagueTipsArr);
                    }

                    const teamPerformance = {};

                    for (const tip of leagueTipsArr) {
                        const matchId = tip.matchId || tip.id;
                        const match = matches.find(m => String(m.id || m._id) === String(matchId));
                        if (!match) continue;

                        const res = match.result || match;
                        let realWinner = res.winner || match.winner;
                        const homeScore = res.scoreHome ?? res.score_home ?? res.homeScore ?? match.scoreHome;
                        const awayScore = res.scoreAway ?? res.score_away ?? res.awayScore ?? match.scoreAway;

                        if (!realWinner && homeScore !== undefined && awayScore !== undefined) {
                            const sh = Number(homeScore);
                            const sa = Number(awayScore);
                            if (sh > sa) realWinner = 'home';
                            else if (sa > sh) realWinner = 'away';
                        }

                        if (!realWinner) continue;

                        const hId = String(match.homeTeamId ?? match.home_team_id ?? match.homeId ?? '');
                        const aId = String(match.awayTeamId ?? match.away_team_id ?? match.awayId ?? '');

                        const homeTeamName = teamNameMap[hId] || match.homeTeam || match.home_team;
                        const awayTeamName = teamNameMap[aId] || match.awayTeam || match.away_team;

                        if (!homeTeamName || !awayTeamName) continue;

                        let isCorrect = false;
                        if (match.isPlayoff && Number(match.bo) === 1) {
                            let tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                            let tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);

                            if (res.sideSwap === true) {
                                const temp = tipHome; tipHome = tipAway; tipAway = temp;
                            }
                            if (!Number.isNaN(tipHome) && !Number.isNaN(tipAway)) {
                                isCorrect = Math.sign(Number(homeScore) - Number(awayScore)) === Math.sign(tipHome - tipAway);
                            }
                        } else {
                            let evaluatedWinner = tip.winner;
                            if (res.sideSwap === true) {
                                evaluatedWinner = tip.winner === 'home' ? 'away' : (tip.winner === 'away' ? 'home' : tip.winner);
                            }
                            isCorrect = evaluatedWinner === realWinner;
                        }

                        [homeTeamName, awayTeamName].forEach(tName => {
                            if (!teamPerformance[tName]) teamPerformance[tName] = { total: 0, correct: 0 };
                            teamPerformance[tName].total++;
                            if (isCorrect) teamPerformance[tName].correct++;
                        });
                    }

                    const qualifiedTeams = Object.keys(teamPerformance)
                        .filter(tName => teamPerformance[tName].total >= 2)
                        .map(tName => ({
                            name: tName,
                            rate: (teamPerformance[tName].correct / teamPerformance[tName].total) * 100,
                            correct: teamPerformance[tName].correct,
                            total: teamPerformance[tName].total
                        }));

                    if (qualifiedTeams.length >= 2) {
                        qualifiedTeams.sort((a, b) => b.rate - a.rate || b.total - a.total);
                        leagueTeamStats[leagueKey] = {
                            favorite: qualifiedTeams[0],
                            kat: qualifiedTeams[qualifiedTeams.length - 1]
                        };
                    }
                }

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
                    avgGoalDeviation: avgGoalDeviation ? parseFloat(avgGoalDeviation) : null,
                    bo1EvaluatedCount: userEvaluatedBO1Count,
                    leagueCount,
                    leagues: activeLeagues,
                    totalRegularCorrect,
                    totalPlayoffBO1Correct,
                    totalPlayoffBO1Tips,
                    totalPlayoffBOSeriesCorrect,
                    totalPlayoffBOSeriesTips,
                    leagueTeamStats
                };
            })
            .filter(u => u.totalTips > 0)
            .sort((a, b) => b.totalCorrect - a.totalCorrect);

        const currentUserStats = userStats.find(u => u.username === username);
        const currentUserRank = userStats.findIndex(u => u.username === username) + 1;

        // Žebříček nejpřesnějších střelců
        const sniperRankings = [...userStats]
            .filter(u => u.avgGoalDeviation !== null && u.bo1EvaluatedCount >= 0)
            .sort((a, b) => a.avgGoalDeviation - b.avgGoalDeviation);

        userStats.forEach(u => u.leagues.forEach(l => allLeaguesInStats.add(l)));

        const successRateDistribution = {};
        const bins = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        for (let i = 0; i < bins.length - 1; i++) {
            const min = bins[i];
            const max = bins[i + 1];
            const key = `${min}-${max}%`;
            successRateDistribution[key] = userStats.filter(u => u.successRate >= min && u.successRate < max).length;
        }

        const appStats = {
            totalUsers: users.filter(u => u.username !== 'Admin').length,
            activeUsers: userStats.length,
            totalLeagues: allLeaguesInStats.size,
            totalTips: userStats.reduce((sum, u) => sum + u.totalTips, 0),
            totalCorrect: userStats.reduce((sum, u) => sum + u.totalCorrect, 0),
            avgSuccessRate: userStats.length > 0 ? (userStats.reduce((sum, u) => sum + u.successRate, 0) / userStats.length).toFixed(1) : 0,
            successRateDistribution
        };

        const leagueStats = {};
        for (const league of allLeaguesInStats) {
            const leagueUsers = userStats.filter(u => u.leagues.includes(league));

            const leagueMatches = matches.filter(m =>
                m.liga === league &&
                m.season === selectedSeason &&
                m.result?.winner
            );

            let leagueMaxPoints = 0;
            for (const match of leagueMatches) {
                if (match.isPlayoff && Number(match.bo) === 1) {
                    leagueMaxPoints += 5;
                } else if (match.isPlayoff && Number(match.bo) > 1) {
                    leagueMaxPoints += 3;
                } else {
                    leagueMaxPoints += 1;
                }
            }

            let leagueTotalTips = 0;
            let leagueTotalCorrect = 0;

            const leagueUserStats = [];
            for (const user of users) {
                if (user.username === 'Admin') continue;
                const userStat = userStats.find(u => u.username === user.username);
                if (!userStat || !userStat.leagues.includes(league)) continue;

                const leagueStatsData = user.stats?.[selectedSeason]?.[league] || {};
                const userLeaguePoints = leagueStatsData.correct || 0;

                const userSuccessRate = leagueMaxPoints > 0 ? ((userLeaguePoints / leagueMaxPoints) * 100).toFixed(1) : 0;

                leagueTotalTips += (leagueStatsData.totalRegular || 0) + (leagueStatsData.totalPlayoff || 0);
                leagueTotalCorrect += userLeaguePoints;

                leagueUserStats.push({
                    username: user.username,
                    successRate: parseFloat(userSuccessRate),
                    totalCorrect: userLeaguePoints,
                    totalTips: (leagueStatsData.totalRegular || 0) + (leagueStatsData.totalPlayoff || 0)
                });
            }

            const eligibleUsers = leagueUserStats.filter(u => u.totalTips >= 5);
            eligibleUsers.sort((a, b) => b.successRate - a.successRate);

            leagueStats[league] = {
                users: leagueUsers.length,
                avgSuccessRate: (leagueMaxPoints > 0 && leagueUsers.length > 0) ? ((leagueTotalCorrect / (leagueMaxPoints * leagueUsers.length)) * 100).toFixed(1) : 0,
                totalTips: leagueTotalTips,
                totalCorrect: leagueTotalCorrect,
                bestUser: eligibleUsers.length > 0 ? eligibleUsers[0].username : null,
                worstUser: eligibleUsers.length > 0 ? eligibleUsers[eligibleUsers.length - 1].username : null
            };
        }

        const leagueHeatmapData = {};
        for (const user of users) {
            if (user.username === 'Admin') continue;
            leagueHeatmapData[user.username] = {};
            const userSeasonStats = user.stats?.[selectedSeason] || {};
            for (const league of Object.keys(userSeasonStats)) {
                const leagueStatsData = userSeasonStats[league] || {};
                const userLeaguePoints = leagueStatsData.correct || 0;
                const userLeagueTips = (leagueStatsData.totalRegular || 0) + (leagueStatsData.totalPlayoff || 0);
                const userLeagueMaxPoints = leagueMaxPointsMap[league] || 0;
                const userLeagueSuccessRate = userLeagueMaxPoints > 0 ? ((userLeaguePoints / userLeagueMaxPoints) * 100).toFixed(1) : 0;
                leagueHeatmapData[user.username][league] = {
                    successRate: parseFloat(userLeagueSuccessRate),
                    points: userLeaguePoints,
                    tips: userLeagueTips
                };
            }
        }

        // ---------------------------------------------------------
        // OPRAVENÝ VÝPOČET SÉRIÍ VÝHER A PROHER
        // ---------------------------------------------------------
        const streakStats = [];
        for (const user of users) {
            if (user.username === 'Admin') continue;

            const userStat = userStats.find(u => u.username === user.username);
            if (!userStat || userStat.totalTips === 0) continue;

            const userTipsObj = user.tips?.[selectedSeason] || {};
            const allEvaluatedTips = [];

            for (const leagueKey of Object.keys(userTipsObj)) {
                let leagueTipsArr = userTipsObj[leagueKey] || [];
                if (!Array.isArray(leagueTipsArr) && typeof leagueTipsArr === 'object') {
                    leagueTipsArr = Object.values(leagueTipsArr);
                }

                for (const tip of leagueTipsArr) {
                    const matchId = tip.matchId || tip.id;
                    const match = matches.find(m => String(m.id || m._id) === String(matchId));

                    // Započítáváme POUZE odehrané/vyhodnocené zápasy s vítězem
                    if (!match) continue;
                    const res = match.result || match;
                    let realWinner = res.winner || match.winner;
                    const homeScore = res.scoreHome ?? res.score_home ?? res.homeScore ?? match.scoreHome;
                    const awayScore = res.scoreAway ?? res.score_away ?? res.awayScore ?? match.scoreAway;

                    if (!realWinner && homeScore !== undefined && awayScore !== undefined) {
                        const sh = Number(homeScore);
                        const sa = Number(awayScore);
                        if (sh > sa) realWinner = 'home';
                        else if (sa > sh) realWinner = 'away';
                    }

                    if (!realWinner) continue; // Zápas ještě neskončil / není vyhodnocený

                    // Vyhodnocení správnosti tipu
                    let isCorrect = false;
                    if (match.isPlayoff && Number(match.bo) === 1) {
                        let tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                        let tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);

                        if (res.sideSwap === true) {
                            const temp = tipHome; tipHome = tipAway; tipAway = temp;
                        }
                        if (!Number.isNaN(tipHome) && !Number.isNaN(tipAway)) {
                            isCorrect = Math.sign(Number(homeScore) - Number(awayScore)) === Math.sign(tipHome - tipAway);
                        }
                    } else {
                        let evaluatedWinner = tip.winner;
                        if (res.sideSwap === true) {
                            evaluatedWinner = tip.winner === 'home' ? 'away' : (tip.winner === 'away' ? 'home' : tip.winner);
                        }
                        isCorrect = evaluatedWinner === realWinner;
                    }

                    // Určení přesného času zápasu pro chronologické řazení
                    const rawDate = match.datetime || match.date || match.timestamp;
                    const parsedTime = rawDate ? new Date(rawDate).getTime() : 0;

                    allEvaluatedTips.push({
                        matchId: String(match.id || match._id),
                        timestamp: Number.isNaN(parsedTime) ? 0 : parsedTime,
                        isCorrect
                    });
                }
            }

            // STRIKTNÍ CHRONOLOGICKÉ SEŘAZENÍ (od nejstaršího po nejnovější zápas)
            allEvaluatedTips.sort((a, b) => {
                if (a.timestamp !== b.timestamp) {
                    return a.timestamp - b.timestamp;
                }
                return a.matchId.localeCompare(b.matchId);
            });

            // Výpočet maximální sérií
            let longestWinStreak = 0;
            let longestLoseStreak = 0;
            let currentWinStreak = 0;
            let currentLoseStreak = 0;

            for (const item of allEvaluatedTips) {
                if (item.isCorrect) {
                    currentWinStreak++;
                    currentLoseStreak = 0;
                    if (currentWinStreak > longestWinStreak) {
                        longestWinStreak = currentWinStreak;
                    }
                } else {
                    currentLoseStreak++;
                    currentWinStreak = 0;
                    if (currentLoseStreak > longestLoseStreak) {
                        longestLoseStreak = currentLoseStreak;
                    }
                }
            }

            streakStats.push({
                username: user.username,
                longestWinStreak,
                longestLoseStreak
            });
        }

        // Seřazení žebříčku sérií (nejdřív podle výher, pak podle méně proher)
        streakStats.sort((a, b) => {
            if (b.longestWinStreak !== a.longestWinStreak) {
                return b.longestWinStreak - a.longestWinStreak;
            }
            if (a.longestLoseStreak !== b.longestLoseStreak) {
                return a.longestLoseStreak - b.longestLoseStreak;
            }
            return a.username.localeCompare(b.username);
        });

        const monthlyStats = {};
        for (const user of users) {
            if (user.username === 'Admin') continue;
            const userStat = userStats.find(u => u.username === user.username);
            if (!userStat || userStat.totalTips === 0) continue;
            const tips = user.tips?.[selectedSeason] || {};
            for (const league of Object.keys(tips)) {
                const leagueTips = tips[league] || [];
                for (const tip of leagueTips) {
                    const match = matches.find(m => m.id === tip.matchId);
                    if (!match?.result || !match.result.winner) continue;

                    const matchDate = match.date || match.datetime || match.timestamp;
                    if (!matchDate) continue;

                    const month = new Date(matchDate).toISOString().slice(0, 7);
                    if (!monthlyStats[month]) {
                        monthlyStats[month] = { total: 0, correct: 0 };
                    }

                    monthlyStats[month].total++;

                    let isCorrect = false;
                    if (match.isPlayoff && Number(match.bo) === 1) {
                        const realHome = Number(match.result.scoreHome ?? 0);
                        const realAway = Number(match.result.scoreAway ?? 0);
                        let tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                        let tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);
                        if (match.result?.sideSwap === true) {
                            const temp = tipHome; tipHome = tipAway; tipAway = temp;
                        }
                        if (!Number.isNaN(tipHome) && !Number.isNaN(tipAway)) {
                            isCorrect = Math.sign(realHome - realAway) === Math.sign(tipHome - tipAway);
                        }
                    } else if (match.isPlayoff && Number(match.bo) > 1) {
                        isCorrect = tip.winner === match.result.winner;
                    } else {
                        let evaluatedWinner = tip.winner;
                        if (match.result?.sideSwap === true) {
                            evaluatedWinner = tip.winner === 'home' ? 'away' : 'home';
                        }
                        isCorrect = evaluatedWinner === match.result.winner;
                    }

                    if (isCorrect) monthlyStats[month].correct++;
                }
            }
        }

        for (const month in monthlyStats) {
            monthlyStats[month].successRate = monthlyStats[month].total > 0
                ? ((monthlyStats[month].correct / monthlyStats[month].total) * 100).toFixed(1)
                : 0;
        }

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
                        const tipHome = tip.scoreHome !== undefined ? tip.scoreHome : tip.home;
                        const tipAway = tip.scoreAway !== undefined ? tip.scoreAway : tip.away;
                        const realHome = match.result.scoreHome ?? match.result.home;
                        const realAway = match.result.scoreAway ?? match.result.away;

                        if (tipHome === realHome && tipAway === realAway) {
                            isCorrect = true;
                        } else {
                            const delta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
                            if (delta <= 3) isCorrect = true;
                        }
                    } else if (match.isPlayoff && Number(match.bo) > 1) {
                        isCorrect = tip.winner === match.result.winner;
                    } else {
                        isCorrect = tip.winner === match.result.winner;
                    }

                    if (isCorrect) dayOfWeekStats[dayOfWeek].correct++;
                }
            }
        }

        for (const day in dayOfWeekStats) {
            dayOfWeekStats[day].successRate = dayOfWeekStats[day].total > 0
                ? ((dayOfWeekStats[day].correct / dayOfWeekStats[day].total) * 100).toFixed(1)
                : 0;
        }

        const tipAccuracyStats = { exact: 0, offBy1: 0, offBy2: 0, offBy3: 0, offByMore: 0, total: 0 };

        for (const user of users) {
            if (user.username === 'Admin') continue;
            const tips = user.tips?.[selectedSeason] || {};
            for (const league of Object.keys(tips)) {
                const leagueTips = tips[league] || [];
                for (const tip of leagueTips) {
                    const match = matches.find(m => m.id === tip.matchId);
                    if (!match?.result || !match.result.winner) continue;
                    if (!match.isPlayoff || Number(match.bo) !== 1) continue;

                    const tipHome = tip.scoreHome !== undefined ? tip.scoreHome : tip.home;
                    const tipAway = tip.scoreAway !== undefined ? tip.scoreAway : tip.away;
                    const realHome = match.result.scoreHome;
                    const realAway = match.result.scoreAway;

                    const totalDelta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
                    tipAccuracyStats.total++;

                    if (totalDelta === 0) tipAccuracyStats.exact++;
                    else if (totalDelta === 1) tipAccuracyStats.offBy1++;
                    else if (totalDelta === 2) tipAccuracyStats.offBy2++;
                    else if (totalDelta === 3) tipAccuracyStats.offBy3++;
                    else tipAccuracyStats.offByMore++;
                }
            }
        }

        const performanceTrend = [];
        const windowSize = 10;

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
                        const realHome = match.result.scoreHome ?? match.result.home;
                        const realAway = match.result.scoreAway ?? match.result.away;

                        if (tipHome === realHome && tipAway === realAway) {
                            isCorrect = true;
                        } else {
                            const delta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
                            if (delta <= 3) isCorrect = true;
                        }
                    } else if (match.isPlayoff && Number(match.bo) > 1) {
                        isCorrect = tip.winner === match.result.winner;
                    } else {
                        isCorrect = tip.winner === match.result.winner;
                    }

                    allTips.push({
                        date: match.datetime || match.date,
                        correct: isCorrect ? 1 : 0
                    });
                }
            }

            allTips.sort((a, b) => new Date(a.date) - new Date(b.date));

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

        performanceTrend.sort((a, b) => new Date(a.date) - new Date(b.date));

        const seasonComparison = {};
        const allSeasons = Array.from(allSeasonsFromLeagues).sort();

        for (const season of allSeasons) {
            const seasonStats = { totalTips: 0, totalCorrect: 0, users: {} };

            for (const user of users) {
                if (user.username === 'Admin') continue;

                let userTotalCorrect = 0;
                let userTotalTips = 0;

                if (user.stats?.[season]) {
                    const userSeasonStats = user.stats[season];
                    for (const league of Object.keys(userSeasonStats)) {
                        const leagueStatsData = userSeasonStats[league] || {};
                        userTotalCorrect += leagueStatsData.correct || 0;
                        userTotalTips += (leagueStatsData.totalRegular || 0) + (leagueStatsData.totalPlayoff || 0);
                    }
                } else {
                    const userTips = user.tips?.[season] || {};
                    for (const league of Object.keys(userTips)) {
                        const leagueTips = userTips[league] || [];
                        for (const tip of leagueTips) {
                            const match = matches.find(m => m.id === tip.matchId);
                            if (!match?.result || !match.result.winner) continue;

                            userTotalTips++;

                            let isCorrect = false;
                            if (match.isPlayoff && Number(match.bo) === 1) {
                                const realHome = Number(match.result.scoreHome ?? 0);
                                const realAway = Number(match.result.scoreAway ?? 0);
                                let tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                                let tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);
                                if (match.result?.sideSwap === true) {
                                    const temp = tipHome; tipHome = tipAway; tipAway = temp;
                                }
                                if (!Number.isNaN(tipHome) && !Number.isNaN(tipAway)) {
                                    isCorrect = Math.sign(realHome - realAway) === Math.sign(tipHome - tipAway);
                                }
                            } else if (match.isPlayoff && Number(match.bo) > 1) {
                                isCorrect = tip.winner === match.result.winner;
                            } else {
                                let evaluatedWinner = tip.winner;
                                if (match.result?.sideSwap === true) {
                                    evaluatedWinner = tip.winner === 'home' ? 'away' : 'home';
                                }
                                isCorrect = evaluatedWinner === match.result.winner;
                            }

                            if (isCorrect) userTotalCorrect++;
                        }
                    }
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

        // Úprava porovnání s průměrem pro přihlášeného uživatele
        let userComparison = null;
        if (currentUserStats) {
            const diff = currentUserStats.successRate - parseFloat(appStats.avgSuccessRate);
            let statusText = 'Na průměru';

            if (diff > 0.05) {
                statusText = 'Nad průměrem';
            } else if (diff < -0.05) {
                statusText = 'Pod průměrem';
            }

            // FÉROVÝ PERCENTIL: Kolik % hráčů má STŘITNĚ MÉNĚ bodů než přihlášený uživatel
            const playersWithFewerPoints = userStats.filter(u => u.totalCorrect < currentUserStats.totalCorrect).length;
            const totalOtherPlayers = userStats.length - 1;

            const rawPercentile = totalOtherPlayers > 0
                ? (playersWithFewerPoints / totalOtherPlayers) * 100
                : 100;

            userComparison = {
                successRateDiff: diff.toFixed(1),
                statusText,
                rankPercentile: Math.round(rawPercentile)
            };
        }

        const availableSeasons = Array.from(allSeasonsFromLeagues).sort().reverse();

        const allUsersForSeasonComparison = users
            .filter(u => u.username !== 'Admin')
            .map(u => ({ username: u.username }));

        const data = {
            username,
            selectedSeason,
            availableSeasons,
            userStats,
            sniperRankings,
            allUsersForSeasonComparison,
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
            leagues
        };

        if (req.headers.accept === 'application/json') {
            return res.json(data);
        }

        let html = `
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
<title>Statistiky – Tipovačka</title>
<link rel="stylesheet" href="/css/modern-design.css" />
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"></script>
<script src="/js/version-notification.js"></script>
<link rel="icon" href="/images/logo.png">
</head>
${renderNotificationScript(req.session.csrfToken || '')}
<body class="usersite">
${await renderUserHeader({
            username: username,
            selectedLiga: '',
            uniqueLeagues: [],
            activeTab: 'statistics',
            csrfToken: req.session.csrfToken || '',
            timeWidgetHtml: await generateTimeWidget()
        })}

<main class="layout-single-column">
    <!-- Podium Pro Top 3 -->
    ${userStats.length >= 3 ? `
    <div class="podium-container">
        <div class="podium-card silver">
            <div class="medal-icon">🥈</div>
            <div class="podium-user">${userStats[1].username}</div>
            <div class="podium-points">${userStats[1].totalCorrect} bodů</div>
            <span class="user-stat-pct" style="margin-top: 4px;">Úspěšnost ${userStats[1].successRate}%</span>
        </div>
        <div class="podium-card gold">
            <div class="medal-icon">👑</div>
            <div class="podium-user">${userStats[0].username}</div>
            <div class="podium-points">${userStats[0].totalCorrect} bodů</div>
            <span class="user-stat-pct" style="margin-top: 4px;">Úspěšnost ${userStats[0].successRate}%</span>
        </div>
        <div class="podium-card bronze">
            <div class="medal-icon">🥉</div>
            <div class="podium-user">${userStats[2].username}</div>
            <div class="podium-points">${userStats[2].totalCorrect} bodů</div>
            <span class="user-stat-pct" style="margin-top: 4px;">Úspěšnost ${userStats[2].successRate}%</span>
        </div>
    </div>
    ` : ''}

    <div class="stats-card">
        <div class="section-header">
            <div class="section-title">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
                Statistiky tipovačky – Sezóna ${selectedSeason}
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
                <label for="season-select" style="color: var(--text-dim); font-size:12px; font-weight:700;">Sezóna:</label>
                <select id="season-select" onchange="window.location.href='/statistics?season=' + this.value" class="modern-select" style="padding: 6px 12px; width:auto;">
                    ${availableSeasons.map(season => `
                        <option value="${season}" ${season === selectedSeason ? 'selected' : ''}>${season}</option>
                    `).join('')}
                </select>
            </div>
        </div>
        
        <div class="user-stats-grid" style="margin-bottom: 24px;">
            <div class="user-stat-box">
                <span class="user-stat-label">Celkem uživatelů</span>
                <span class="user-stat-val">${appStats.totalUsers}</span>
            </div>
            <div class="user-stat-box highlight">
                <span class="user-stat-label">Aktivní v sezóně</span>
                <span class="user-stat-val" style="color: var(--accent-green);">${appStats.activeUsers}</span>
            </div>
            <div class="user-stat-box">
                <span class="user-stat-label">Celkem lig</span>
                <span class="user-stat-val" style="color: var(--primary);">${appStats.totalLeagues}</span>
            </div>
            <div class="user-stat-box">
                <span class="user-stat-label">Odeslaných tipů</span>
                <span class="user-stat-val">${appStats.totalTips}</span>
            </div>
            <div class="user-stat-box">
                <span class="user-stat-label">Průměrná úspěšnost</span>
                <span class="user-stat-val" style="color: var(--accent-amber);">${appStats.avgSuccessRate}%</span>
            </div>
        </div>
    
        <div class="charts-grid" style="margin-bottom: 24px;">
            <div class="chart-container">
                <h3>Žebříček podle bodů</h3>
                <canvas id="rankingChart"></canvas>
            </div>
            <div class="chart-container">
                <h3>Úspěšnost tipování (%)</h3>
                <canvas id="successRateChart"></canvas>
            </div>
        </div>

        <div class="chart-container" style="margin-bottom: 24px; overflow-x: auto;">
            <h3>Podrobný žebříček uživatelů</h3>
            <table class="modern-table stats-overview-table">
                <thead>
                    <tr>
                        <th class="position">#</th>
                        <th>Uživatel</th>
                        <th>Celkem bodů</th>
                        <th>Základní část</th>
                        <th>Playoff BO1</th>
                        <th>Playoff série</th>
                        <th>Tabulka</th>
                        <th>Aktivní ligy</th>
                    </tr>
                </thead>
                <tbody>
                    ${userStats.map((u, index) => `
                        <tr class="${u.username === username ? 'current-user-row' : ''}">
                            <td class="rank-cell" style="padding-left: 14px !important;">
                                <span class="rank-badge ${index === 0 ? 'rank-1' : index === 1 ? 'rank-2' : index === 2 ? 'rank-3' : ''}" style="margin-left: 4px;">${index + 1}</span>
                            </td>
                            <td><strong>${u.username}</strong>${u.username === username ? ' <span style="color:var(--primary); font-size:11px;">(ty)</span>' : ''}</td>
                            <td><span class="points-pill">${u.totalCorrect}</span></td>
                            <td>${u.totalRegularCorrect}/${u.totalRegular} <small style="color:var(--text-dim)">(${u.regularSuccessRate}%)</small></td>
                            <td>${u.totalPlayoffBO1Correct}/${u.totalPlayoffBO1Tips} <small style="color:var(--text-dim)">(${u.playoffBO1SuccessRate}%)</small></td>
                            <td>${u.totalPlayoffBOSeriesCorrect}/${u.totalPlayoffBOSeriesTips} <small style="color:var(--text-dim)">(${u.playoffBOSeriesSuccessRate}%)</small></td>
                            <td>${u.totalTableCorrect} b</td>
                            <td>${u.leagueCount} lig</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <!-- Čistá a samostatná sekce pro Srdcovky a Kat týmy všech hráčů -->
        <div class="chart-container" style="margin-bottom: 24px;">
            <h3>❤️ Srdcovky a 🗡️ Kati podle lig</h3>
            <p style="color: var(--text-dim); font-size: 12px; margin-bottom: 16px;">Přehled týmů, na které mají jednotliví hráči v daných ligách nejlepší a nejhorší úspěšnost tipů.</p>
            
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px;">
                ${userStats.map(u => {
            const lKeys = Object.keys(u.leagueTeamStats || {});
            if (lKeys.length === 0) return '';

            return `
                    <div style="background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 8px; padding: 14px;">
                        <div style="font-weight: 700; font-size: 14px; margin-bottom: 10px; color: var(--text-main); display: flex; align-items: center; justify-content: space-between;">
                            <span>${u.username}</span>
                            ${u.username === username ? '<span style="font-size: 10px; background: var(--primary); color: #fff; padding: 2px 6px; border-radius: 4px;">TY</span>' : ''}
                        </div>
                        <div style="display: flex; flex-direction: column; gap: 8px;">
                            ${lKeys.map(lKey => {
                const st = u.leagueTeamStats[lKey];
                return `
                                <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; font-size: 13px;">
                                    <div style="font-weight: 700; color: var(--primary); margin-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px;">
                                        ${lKey}
                                    </div>
                                    <div style="display: flex; flex-direction: column; gap: 6px;">
                                        <div style="color: var(--accent-green); word-break: break-word; line-height: 1.3;">
                                            ❤️ <strong>Srdcovka:</strong> ${st.favorite.name} <span style="opacity:0.85; font-size:12px;">(${st.favorite.rate.toFixed(0)}%)</span>
                                        </div>
                                        <div style="color: var(--accent-red); word-break: break-word; line-height: 1.3;">
                                            🗡️ <strong>Kat:</strong> ${st.kat.name} <span style="opacity:0.85; font-size:12px;">(${st.kat.rate.toFixed(0)}%)</span>
                                        </div>
                                    </div>
                                </div>
                                `;
            }).join('')}
                        </div>
                    </div>
                    `;
        }).join('')}
            </div>
        </div>

        ${currentUserStats ? `
        <div class="modern-stats-card">
            <div class="stats-card-header">
                <div class="stats-card-title">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    Tvé statistiky (${username}) — ${currentUserRank}. místo
                </div>
            </div>
            <div class="user-stats-grid">
                <div class="user-stat-box highlight">
                    <span class="user-stat-label">Celkem bodů</span>
                    <span class="user-stat-val">${currentUserStats.totalCorrect}</span>
                    <span class="user-stat-sub">Z ${currentUserStats.totalTips} tipů</span>
                </div>
                <div class="user-stat-box">
                    <span class="user-stat-label">Základní část</span>
                    <span class="user-stat-val">${currentUserStats.totalRegularCorrect}/${currentUserStats.totalRegular}</span>
                    <span class="user-stat-pct">${currentUserStats.regularSuccessRate}%</span>
                </div>
                <div class="user-stat-box">
                    <span class="user-stat-label">Playoff BO1</span>
                    <span class="user-stat-val">${currentUserStats.totalPlayoffBO1Correct}/${currentUserStats.totalPlayoffBO1Tips}</span>
                    <span class="user-stat-pct">${currentUserStats.playoffBO1SuccessRate}%</span>
                </div>
                <div class="user-stat-box">
                    <span class="user-stat-label">Playoff Série</span>
                    <span class="user-stat-val">${currentUserStats.totalPlayoffBOSeriesCorrect}/${currentUserStats.totalPlayoffBOSeriesTips}</span>
                    <span class="user-stat-pct">${currentUserStats.playoffBOSeriesSuccessRate}%</span>
                </div>
            </div>

            ${Object.keys(currentUserStats.leagueTeamStats || {}).length > 0 ? `
            <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.08);">
                <h4 style="margin-bottom: 12px; font-size:14px; color:var(--text-main);">Tvoje Srdcovky a Kati podle lig:</h4>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px;">
                    ${Object.keys(currentUserStats.leagueTeamStats).map(lKey => {
            const st = currentUserStats.leagueTeamStats[lKey];
            return `
                        <div class="user-stat-box favorite-team" style="height: auto; min-height: 80px; padding: 12px;">
                            <span class="user-stat-label" style="font-weight:700; color:var(--primary); margin-bottom:4px;">${lKey}</span>
                            <span class="user-stat-val" style="color:var(--accent-green); font-size:14px; line-height: 1.3; word-break: break-word;">❤️ ${st.favorite.name}</span>
                            <span class="user-stat-sub" style="margin-top: 4px;">${st.favorite.rate.toFixed(0)}% (${st.favorite.correct}/${st.favorite.total})</span>
                        </div>
                        <div class="user-stat-box kat-team" style="height: auto; min-height: 80px; padding: 12px;">
                            <span class="user-stat-label" style="font-weight:700; color:var(--primary); margin-bottom:4px;">${lKey}</span>
                            <span class="user-stat-val" style="color:var(--accent-red); font-size:14px; line-height: 1.3; word-break: break-word;">🗡️ ${st.kat.name}</span>
                            <span class="user-stat-sub" style="margin-top: 4px;">${st.kat.rate.toFixed(0)}% (${st.kat.correct}/${st.kat.total})</span>
                        </div>
                        `;
        }).join('')}
                </div>
            </div>
            ` : ''}
        </div>
        ` : ''}

        ${sniperRankings.length > 0 ? `
        <div class="chart-container" style="margin-top: 24px;">
            <h3>🎯 Nejpřesnější střelec (Průměrná odchylka gólů u BO1)</h3>
            <p style="color: var(--text-dim); font-size:12px; margin-bottom: 12px;">Čím nižší číslo, tím přesnější tipy skóre uživatel dává.</p>
            <table class="modern-table">
                <thead>
                    <tr>
                        <th style="width:40px;">#</th>
                        <th>Uživatel</th>
                        <th>Průměrná odchylka na zápas</th>
                        <th>Hodnocených zápasů</th>
                    </tr>
                </thead>
                <tbody>
                    ${sniperRankings.map((u, i) => `
                        <tr class="${u.username === username ? 'current-user-row' : ''}">
                            <td style="text-align:center;">${i + 1}</td>
                            <td><strong>${u.username}</strong></td>
                            <td><span style="color: var(--accent-amber); font-weight:800;">± ${u.avgGoalDeviation} gólu</span></td>
                            <td>${u.bo1EvaluatedCount} tipů</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
        ` : ''}

        <div class="charts-grid" style="margin-top:24px;">
            <div class="chart-container">
                <h3>Nejdelší série tipů</h3>
                <table class="modern-table user-table">
                    <thead>
                        <tr>
                            <th style="width:40px;">#</th>
                            <th>Uživatel</th>
                            <th>Série výher</th>
                            <th>Série proher</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${streakStats.map((user, index) => `
                            <tr class="${user.username === username ? 'current-user-row' : ''}">
                                <td style="text-align:center;">${index + 1}</td>
                                <td><strong>${user.username}</strong></td>
                                <td><span style="color:var(--accent-green); font-weight:800;">🔥 ${user.longestWinStreak}</span></td>
                                <td><span style="color:var(--accent-red); font-weight:800;">❄️ ${user.longestLoseStreak}</span></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>

            ${userComparison ? `
            <div class="chart-container">
                <h3>Porovnání s průměrem</h3>
                <div class="user-stats-grid" style="grid-template-columns: 1fr 1fr; margin-top:20px;">
                    <div class="user-stat-box ${userComparison.statusText === 'Nad průměrem' ? 'highlight' : ''}">
                        <span class="user-stat-label">Úspěšnost vs průměr</span>
                        <span class="user-stat-val" style="color: ${userComparison.statusText === 'Nad průměrem' ? 'var(--accent-green)' : userComparison.statusText === 'Pod průměrem' ? 'var(--accent-red)' : 'var(--accent-amber)'}">
                            ${userComparison.successRateDiff > 0 ? '+' : ''}${userComparison.successRateDiff}%
                        </span>
                        <span class="user-stat-sub">${userComparison.statusText}</span>
                    </div>
                    <div class="user-stat-box">
                        <span class="user-stat-label">Percentilové pořadí</span>
                        <span class="user-stat-val" style="color:var(--primary);">${userComparison.rankPercentile}%</span>
                        <span class="user-stat-sub">Jsi lepší než ${userComparison.rankPercentile}% hráčů</span>
                    </div>
                </div>
            </div>
            ` : ''}
        </div>

        <div class="chart-container" style="margin-top: 24px; overflow-x: auto;">
            <h3>Statistiky podle lig</h3>
            <table class="modern-table">
                <thead>
                    <tr>
                        <th>Liga</th>
                        <th>Hráčů</th>
                        <th>Průměrná úspěšnost</th>
                        <th>Celkem tipů</th>
                        <th>Nejlepší tipér</th>
                        <th>Nejhorší tipér</th>
                    </tr>
                </thead>
                <tbody>
                    ${Object.keys(leagueStats).map(league => `
                        <tr>
                            <td><strong style="color:var(--primary);">${league}</strong></td>
                            <td>${leagueStats[league].users}</td>
                            <td><span class="user-stat-pct">${leagueStats[league].avgSuccessRate}%</span></td>
                            <td>${leagueStats[league].totalTips}</td>
                            <td><strong style="color:var(--accent-green);">${leagueStats[league].bestUser || '-'}</strong></td>
                            <td><span style="color:var(--text-dim);">${leagueStats[league].worstUser || '-'}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>

        <div class="charts-grid" style="margin-top: 24px;">
            <div class="chart-container">
                <h3>Statistiky podle dnů v týdnu</h3>
                <canvas id="dayOfWeekChart"></canvas>
            </div>

            <div class="chart-container">
                <h3>Statistiky podle typu zápasu</h3>
                <canvas id="matchTypeChart"></canvas>
            </div>

            <div class="chart-container">
                <h3>Přesnost skóre (Playoff BO1)</h3>
                <canvas id="tipAccuracyChart"></canvas>
            </div>

            <div class="chart-container">
                <h3>Distribuce úspěšnosti v komunitě</h3>
                <canvas id="distributionChart"></canvas>
            </div>
        </div>

        <div class="charts-grid" style="margin-top: 24px;">
            <div class="chart-container" style="grid-column: 1 / -1;">
                <h3>Heatmapa úspěšnosti v ligách</h3>
                <div style="overflow-x:auto;">
                    <table class="modern-table">
                        <thead>
                            <tr>
                                <th>Uživatel</th>
                                ${Array.from(allLeaguesInStats).map(league => `<th>${league}</th>`).join('')}
                            </tr>
                        </thead>
                        <tbody>
                            ${userStats.map(user => `
                                <tr class="${user.username === username ? 'current-user-row' : ''}">
                                    <td><strong>${user.username}</strong></td>
                                    ${Array.from(allLeaguesInStats).map(league => {
            const data = leagueHeatmapData[user.username]?.[league];
            if (!data) return '<td style="color:var(--text-dim);">-</td>';
            const opacity = Math.min(Math.max(data.successRate / 100, 0.15), 0.85);
            return `<td style="background-color: rgba(255, 85, 0, ${opacity}); font-weight:700;">${data.successRate}%</td>`;
        }).join('')}
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>

            <div class="chart-container">
                <h3>Trend výkonu (Klouzavý průměr 10 zápasů)</h3>
                <canvas id="performanceTrendChart"></canvas>
            </div>

            <div class="chart-container">
                <h3>Sezónní porovnání</h3>
                <canvas id="seasonComparisonChart"></canvas>
            </div>

            <div class="chart-container" style="grid-column: 1 / -1;">
                <h3>Trendy v čase (úspěšnost podle měsíce)</h3>
                <canvas id="monthlyTrendChart"></canvas>
            </div>
        </div>
    </div>
</main>

<script>
Chart.register(ChartDataLabels);

Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";

const userStats = ${JSON.stringify(userStats)};

// 1. Ranking Chart
new Chart(document.getElementById('rankingChart').getContext('2d'), {
    type: 'bar',
    data: {
        labels: userStats.map(u => u.username),
        datasets: [{
            label: 'Celkem bodů',
            data: userStats.map(u => u.totalCorrect),
            backgroundColor: userStats.map(u => u.username === '${username}' ? 'rgba(255, 85, 0, 0.85)' : 'rgba(59, 130, 246, 0.5)'),
            borderColor: userStats.map(u => u.username === '${username}' ? '#ff5500' : '#3b82f6'),
            borderWidth: 1,
            borderRadius: 4
        }]
    },
    options: {
        responsive: true,
        plugins: {
            legend: { display: false },
            datalabels: { display: false }
        },
        scales: {
            y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
            x: { grid: { display: false } }
        }
    }
});

// 2. Success Rate Chart
new Chart(document.getElementById('successRateChart').getContext('2d'), {
    type: 'line',
    data: {
        labels: userStats.map(u => u.username),
        datasets: [{
            label: 'Úspěšnost (%)',
            data: userStats.map(u => u.successRate),
            borderColor: '#ff5500',
            backgroundColor: 'rgba(255, 85, 0, 0.12)',
            fill: true,
            tension: 0.3,
            pointRadius: 4
        }]
    },
    options: {
        responsive: true,
        plugins: {
            legend: { display: false },
            datalabels: { display: false }
        },
        scales: {
            y: { beginAtZero: true, max: 100, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
            x: { grid: { display: false } }
        }
    }
});

// 3. Tip Accuracy
const tipAccuracyData = ${JSON.stringify(tipAccuracyStats)};
new Chart(document.getElementById('tipAccuracyChart').getContext('2d'), {
    type: 'doughnut',
    data: {
        labels: ['Přesně skóre', 'O 1 gól', 'O 2 góly', 'O 3 góly', 'O 4+ gólů'],
        datasets: [{
            data: [tipAccuracyData.exact, tipAccuracyData.offBy1, tipAccuracyData.offBy2, tipAccuracyData.offBy3, tipAccuracyData.offByMore],
            backgroundColor: ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#64748b'],
            borderWidth: 0
        }]
    },
    options: {
        responsive: true,
        plugins: {
            legend: { position: 'bottom', labels: { boxWidth: 12 } },
            datalabels: {
                color: '#fff',
                formatter: (val, ctx) => {
                    const sum = ctx.dataset.data.reduce((a, b) => a + b, 0);
                    return sum > 0 ? ((val / sum) * 100).toFixed(0) + '%' : '';
                }
            }
        }
    }
});

// 4. Distribution Chart
const distributionLabels = ${JSON.stringify(Object.keys(appStats.successRateDistribution))};
const distributionData = ${JSON.stringify(Object.values(appStats.successRateDistribution))};
new Chart(document.getElementById('distributionChart').getContext('2d'), {
    type: 'bar',
    data: {
        labels: distributionLabels,
        datasets: [{
            label: 'Počet hráčů',
            data: distributionData,
            backgroundColor: '#ff5500',
            borderRadius: 4
        }]
    },
    options: {
        responsive: true,
        plugins: { legend: { display: false }, datalabels: { display: false } },
        scales: {
            y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
            x: { grid: { display: false } }
        }
    }
});

// 5. Moving Average / Trend
const performanceTrendData = ${JSON.stringify(performanceTrend)};
const trendByDate = {};
performanceTrendData.forEach(p => {
    const d = new Date(p.date).toISOString().slice(0, 10);
    if (!trendByDate[d]) trendByDate[d] = { sum: 0, count: 0 };
    trendByDate[d].sum += parseFloat(p.movingAverage);
    trendByDate[d].count++;
});
const trendLabels = Object.keys(trendByDate).sort();
const trendValues = trendLabels.map(d => (trendByDate[d].sum / trendByDate[d].count).toFixed(1));

new Chart(document.getElementById('performanceTrendChart').getContext('2d'), {
    type: 'line',
    data: {
        labels: trendLabels,
        datasets: [{
            label: 'Průměrná úspěšnost (%)',
            data: trendValues,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.12)',
            fill: true,
            tension: 0.3
        }]
    },
    options: {
        responsive: true,
        plugins: { legend: { display: false }, datalabels: { display: false } },
        scales: {
            y: { beginAtZero: true, max: 100, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
            x: { grid: { display: false } }
        }
    }
});

// 6. Day of Week Chart
const dayOfWeekData = ${JSON.stringify(dayOfWeekStats)};
const dayOrder = [1, 2, 3, 4, 5, 6, 0];
new Chart(document.getElementById('dayOfWeekChart').getContext('2d'), {
    type: 'bar',
    data: {
        labels: dayOrder.map(i => dayOfWeekData[i].name),
        datasets: [{
            label: 'Úspěšnost (%)',
            data: dayOrder.map(i => parseFloat(dayOfWeekData[i].successRate)),
            backgroundColor: '#3b82f6',
            borderRadius: 4
        }]
    },
    options: {
        responsive: true,
        plugins: { legend: { display: false }, datalabels: { display: false } },
        scales: {
            y: { beginAtZero: true, max: 100, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
            x: { grid: { display: false } }
        }
    }
});

// 7. Radar Chart
new Chart(document.getElementById('matchTypeChart').getContext('2d'), {
    type: 'radar',
    data: {
        labels: ['Základní část', 'Playoff BO1', 'Playoff Série', 'Tabulka'],
        datasets: [{
            label: 'Úspěšnost (%)',
            data: [
                ${currentUserStats?.regularSuccessRate || 0},
                ${currentUserStats?.playoffBO1SuccessRate || 0},
                ${currentUserStats?.playoffBOSeriesSuccessRate || 0},
                ${currentUserStats?.tableSuccessRate || 0}
            ],
            backgroundColor: 'rgba(255, 85, 0, 0.25)',
            borderColor: '#ff5500',
            pointBackgroundColor: '#ff5500'
        }]
    },
    options: {
        responsive: true,
        plugins: { legend: { display: false }, datalabels: { display: false } },
        scales: {
            r: {
                beginAtZero: true,
                max: 100,
                grid: { color: 'rgba(255, 255, 255, 0.1)' },
                angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                ticks: {
                    color: '#94a3b8',
                    backdropColor: 'transparent'
                    },
                pointLabels: { color: '#94a3b8' }
            }
        }
    }
});

// 8. Season Comparison Chart
const seasonComparisonData = ${JSON.stringify(seasonComparison)};
const seasonLabels = Object.keys(seasonComparisonData).sort();
const colors = ['#ff5500', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899'];
const seasonDatasets = userStats.map((u, i) => ({
    label: u.username,
    data: seasonLabels.map(s => seasonComparisonData[s]?.users[u.username]?.successRate || 0),
    borderColor: colors[i % colors.length],
    tension: 0.3
}));

new Chart(document.getElementById('seasonComparisonChart').getContext('2d'), {
    type: 'line',
    data: { labels: seasonLabels, datasets: seasonDatasets },
    options: {
        responsive: true,
        plugins: { datalabels: { display: false } },
        scales: {
            y: { beginAtZero: true, max: 100, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
            x: { grid: { display: false } }
        }
    }
});

// 9. Monthly Trend Chart
const monthlyStatsData = ${JSON.stringify(monthlyStats)};
const monthLabels = Object.keys(monthlyStatsData).sort();
new Chart(document.getElementById('monthlyTrendChart').getContext('2d'), {
    type: 'line',
    data: {
        labels: monthLabels,
        datasets: [{
            label: 'Úspěšnost (%)',
            data: monthLabels.map(m => parseFloat(monthlyStatsData[m].successRate)),
            borderColor: '#f59e0b',
            backgroundColor: 'rgba(245, 158, 11, 0.12)',
            fill: true,
            tension: 0.3
        }]
    },
    options: {
        responsive: true,
        plugins: { legend: { display: false }, datalabels: { display: false } },
        scales: {
            y: { beginAtZero: true, max: 100, grid: { color: 'rgba(255, 255, 255, 0.05)' } },
            x: { grid: { display: false } }
        }
    }
});
</script>
</body>
</html>`;

        res.send(html);
    } catch (error) {
        console.error('Chyba při načítání statistik:', error);
        res.status(500).send('Došlo k chybě při načítání statistik.');
    }
});

// API endpoint pro získání soupisky týmu (pro uživatele)
router.get('/api/players/:teamId', requireLogin, async (req, res) => {
    try {
        const teamId = parseInt(req.params.teamId);
        const { getChosenSeason } = require('../utils/fileUtils');
        const { Teams } = require('../utils/mongoDataAccess');
        const chosenSeason = await getChosenSeason();
        
        // Použít sezónu z query param nebo aktuální sezónu
        const requestedSeason = req.query.season || chosenSeason;

        // Načtení hráčů týmu pro zadanou sezónu
        const allPlayers = await Players.findAll();
        const teamPlayers = allPlayers.filter(p =>
            p.teamId === teamId &&
            p.season === requestedSeason
        ).sort((a, b) => (a.number || 999) - (b.number || 999));

        // Načtení týmu pro logo
        const allTeams = await Teams.findAll();
        const team = allTeams.find(t => t.id === teamId);
        const logoUrl = team?.logo ? `/logoteamu/${team.logo}` : '/images/logo.png';

        // Stavy hráčů
        const statusColors = {
            'active': '#28a745',
            'injured': '#ffc107',
            'suspended': '#dc3545',
            'loan': '#fd7e14',
            'retired': '#6c757d'
        };

        const statusLabels = {
            'active': 'Aktivní',
            'injured': 'Zraněný',
            'suspended': 'Suspendován',
            'loan': 'Hostování',
            'retired': 'Konec kariéry'
        };

        const statusIcons = {
            'active': '✓',
            'injured': '🏥',
            'suspended': '⚠',
            'loan': '↔',
            'retired': '○'
        };

        res.json({
            logoUrl,
            players: teamPlayers.map(p => ({
                name: p.name,
                number: p.number,
                position: p.position,
                status: p.status,
                statusDetails: p.statusDetails,
                statusColor: statusColors[p.status] || '#888',
                statusLabel: statusLabels[p.status] || p.status,
                statusIcon: statusIcons[p.status] || '?'
            }))
        });
    } catch (error) {
        console.error('Chyba při načítání soupisky:', error);
        res.status(500).json({ error: 'Chyba serveru' });
    }
});


// =========================================================
// API: UŽIVATELSKÝ PROFIL & H2H DUEL (POPUP MODAL)
// =========================================================
router.get('/api/user-profile-h2h', requireLogin, async (req, res) => {
    try {
        const currentUsername = req.session.user;
        const targetUsername = req.query.targetUser || currentUsername;
        const chosenSeason = await ChosenSeason.findAll();
        const selectedSeason = req.query.season || chosenSeason;
        const allowedLeagues = await getAllowedLeagues(selectedSeason);
        const selectedLiga = req.query.liga || allowedLeagues[0] || '';

        const [allUsers, allMatches, allTeams] = await Promise.all([
            Users.findAll(),
            Matches.findAll(),
            Teams.findAll()
        ]);

        const currentUser = allUsers.find(u => u.username === currentUsername);
        const targetUser = allUsers.find(u => u.username === targetUsername);

        if (!targetUser) {
            return res.status(404).json({ error: 'Uživatel nebyl nalezen.' });
        }

        const isSelf = currentUsername === targetUsername;

        // Odehrané zápasy v této sezóně a lize s výsledkem
        const seasonMatches = allMatches.filter(m =>
            String(m.season) === String(selectedSeason) &&
            String(m.liga) === String(selectedLiga) &&
            m.result
        ).sort((a, b) => new Date(b.datetime || b.date) - new Date(a.datetime || a.date));

        // Výpočet bodů
        const calculatePoints = (tip, match) => {
            if (!tip || !match.result || tip.winner !== match.result.winner) return 0;
            if (!match.isPlayoff) return 1;
            const bo = match.bo || 1;
            if (bo === 1) {
                const tH = tip.scoreHome ?? 0;
                const tA = tip.scoreAway ?? 0;
                const diff = Math.abs(tH - (match.result.scoreHome || 0)) + Math.abs(tA - (match.result.scoreAway || 0));
                if (diff === 0) return 5;
                if (diff === 1) return 4;
                if (diff === 2) return 3;
                return 1;
            } else {
                const realLoserWins = match.result.winner === 'home' ? (match.result.scoreAway || 0) : (match.result.scoreHome || 0);
                return parseInt(tip.loserWins, 10) === realLoserWins ? 3 : 1;
            }
        };

        const targetTips = targetUser.tips?.[selectedSeason]?.[selectedLiga] || [];
        const currentTips = currentUser ? (currentUser.tips?.[selectedSeason]?.[selectedLiga] || []) : [];

        let targetPoints = 0;
        let targetCorrect = 0;

        // Spočítáme unikátní vyhodnocené zápasy, na které si cílový uživatel vsadil
        const tippedMatchIds = new Set(targetTips.map(t => String(t.matchId)));
        const targetTotalTipped = seasonMatches.filter(m => tippedMatchIds.has(String(m.id))).length;

        // Úspěšnost podle týmů
        const teamPerfMap = {};

        seasonMatches.forEach(m => {
            // BEZPEČNÉ POROVNÁNÍ ID (String - String)
            const tTip = targetTips.find(t => String(t.matchId) === String(m.id));
            if (tTip && tTip.winner) {
                const pts = calculatePoints(tTip, m);
                targetPoints += pts;
                if (pts > 0) targetCorrect++;

                const pickedTeamId = tTip.winner === 'home' ? m.homeTeamId : m.awayTeamId;
                if (pickedTeamId) {
                    const key = String(pickedTeamId);
                    if (!teamPerfMap[key]) teamPerfMap[key] = { teamId: pickedTeamId, correct: 0, total: 0, points: 0 };
                    teamPerfMap[key].total++;
                    teamPerfMap[key].points += pts;
                    if (pts > 0) teamPerfMap[key].correct++;
                }
            }
        });

        // Top týmy pro cílového uživatele
        const topTeams = Object.values(teamPerfMap)
            .map(perf => {
                const team = allTeams.find(t => String(t.id) === String(perf.teamId));
                const pct = perf.total > 0 ? Math.round((perf.correct / perf.total) * 100) : 0;
                return {
                    name: team?.name || 'Tým',
                    logo: team?.logo ? `/logoteamu/${team.logo}` : '/images/logo.png',
                    ...perf,
                    pct
                };
            })
            .filter(t => t.total >= 2)
            .sort((a, b) => (b.pct - a.pct) || (b.points - a.points))
            .slice(0, 3);

        // H2H duel s přihlášeným uživatelem
        let h2h = null;
        if (!isSelf && currentUser) {
            let myWins = 0;
            let targetWins = 0;
            let draws = 0;
            let agreedCount = 0;
            let disagreedCount = 0;
            const recentDuels = [];

            seasonMatches.forEach(m => {
                // BEZPEČNÉ POROVNÁNÍ ID
                const myTip = currentTips.find(t => String(t.matchId) === String(m.id));
                const targetTip = targetTips.find(t => String(t.matchId) === String(m.id));

                if (myTip && targetTip && myTip.winner && targetTip.winner) {
                    const myPts = calculatePoints(myTip, m);
                    const targetPts = calculatePoints(targetTip, m);

                    // 1. Shoda / odlišnost v typu tipu (vítěze)
                    if (myTip.winner === targetTip.winner) {
                        agreedCount++;
                    } else {
                        disagreedCount++;
                    }

                    // 2. Porovnání bodů na zápase (H2H výhra / prohra / remíza)
                    if (myPts > targetPts) {
                        myWins++;
                    } else if (targetPts > myPts) {
                        targetWins++;
                    } else {
                        draws++;
                    }

                    // 3. Posledních 5 odlišných soubojů pro detail
                    if (myTip.winner !== targetTip.winner && recentDuels.length < 5) {
                        const homeTeam = allTeams.find(t => String(t.id) === String(m.homeTeamId));
                        const awayTeam = allTeams.find(t => String(t.id) === String(m.awayTeamId));
                        recentDuels.push({
                            matchId: m.id,
                            homeName: homeTeam?.name || 'Domácí',
                            awayName: awayTeam?.name || 'Hosté',
                            score: `${m.result.scoreHome}:${m.result.scoreAway}${m.result.ot ? 'p' : ''}`,
                            myPick: myTip.winner === 'home' ? (homeTeam?.name || 'Domácí') : (awayTeam?.name || 'Hosté'),
                            targetPick: targetTip.winner === 'home' ? (homeTeam?.name || 'Domácí') : (awayTeam?.name || 'Hosté'),
                            myPts,
                            targetPts
                        });
                    }
                }
            });

            const totalCompared = agreedCount + disagreedCount;
            const agreementPct = totalCompared > 0 ? Math.round((agreedCount / totalCompared) * 100) : 0;

            h2h = {
                myWins,
                targetWins,
                draws,
                agreedCount,
                disagreedCount,
                agreementPct,
                recentDuels
            };
        }

        // Rank v lize
        const validUsers = allUsers.filter(u => u.username && u.username.toLowerCase() !== 'admin');
        const userScores = validUsers.map(u => {
            const uTips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
            let pts = 0;
            let corr = 0;
            seasonMatches.forEach(m => {
                const tip = uTips.find(t => String(t.matchId) === String(m.id));
                const p = calculatePoints(tip, m);
                pts += p;
                if (p > 0) corr++;
            });
            return { username: u.username, points: pts, correct: corr };
        }).sort((a, b) => (b.correct - a.correct) || (b.points - a.points));

        const targetRank = userScores.findIndex(u => u.username === targetUsername) + 1;

        res.json({
            currentUsername,
            targetUser: {
                username: targetUser.username,
                rank: targetRank || 1,
                points: targetPoints,
                correct: targetCorrect,
                totalTipped: targetTotalTipped,
                pct: targetTotalTipped > 0 ? ((targetCorrect / targetTotalTipped) * 100).toFixed(1) : '0.0'
            },
            isSelf,
            h2h,
            topTeams
        });
    } catch (err) {
        console.error('Chyba v /api/user-profile-h2h:', err);
        res.status(500).json({ error: 'Chyba serveru při načítání profilu.' });
    }
});

// =========================================================
// API: NEDÁVNÁ AKTIVITA & BODY (POPUP MODAL)
// =========================================================
router.get('/api/recent-activity', requireLogin, async (req, res) => {
    try {
        const username = req.session.user;
        const chosenSeason = await ChosenSeason.findAll();
        const selectedSeason = req.query.season || chosenSeason;
        const allowedLeagues = await getAllowedLeagues(selectedSeason);
        const selectedLiga = req.query.liga || allowedLeagues[0] || '';

        const [allUsers, allMatches, allTeams] = await Promise.all([
            Users.findAll(),
            Matches.findAll(),
            Teams.findAll()
        ]);

        const currentUser = allUsers.find(u => u.username === username);
        const userTips = currentUser?.tips?.[selectedSeason]?.[selectedLiga] || [];

        // Posledních až 8 dohraných zápasů
        const finishedMatches = allMatches.filter(m =>
            String(m.season) === String(selectedSeason) &&
            String(m.liga) === String(selectedLiga) &&
            m.result
        ).sort((a, b) => new Date(b.datetime || b.date) - new Date(a.datetime || a.date))
        .slice(0, 8);

        const calculatePoints = (tip, match) => {
            if (!tip || !match.result || tip.winner !== match.result.winner) return 0;
            if (!match.isPlayoff) return 1;
            const bo = match.bo || 1;
            if (bo === 1) {
                const tH = tip.scoreHome ?? 0;
                const tA = tip.scoreAway ?? 0;
                const diff = Math.abs(tH - (match.result.scoreHome || 0)) + Math.abs(tA - (match.result.scoreAway || 0));
                if (diff === 0) return 5;
                if (diff === 1) return 4;
                if (diff === 2) return 3;
                return 1;
            } else {
                const realLoserWins = match.result.winner === 'home' ? (match.result.scoreAway || 0) : (match.result.scoreHome || 0);
                return parseInt(tip.loserWins, 10) === realLoserWins ? 3 : 1;
            }
        };

        let totalEarned = 0;
        let totalPossible = finishedMatches.length;

        const results = finishedMatches.map(m => {
            const homeTeam = allTeams.find(t => String(t.id) === String(m.homeTeamId));
            const awayTeam = allTeams.find(t => String(t.id) === String(m.awayTeamId));
            const userTip = userTips.find(t => String(t.matchId) === String(m.id));
            const pts = calculatePoints(userTip, m);
            totalEarned += pts;

            let homeTipsCount = 0;
            let awayTipsCount = 0;
            allUsers.forEach(u => {
                const tip = u.tips?.[selectedSeason]?.[selectedLiga]?.find(t => String(t.matchId) === String(m.id));
                if (tip?.winner === 'home') homeTipsCount++;
                else if (tip?.winner === 'away') awayTipsCount++;
            });

            const pickedTeamName = userTip?.winner === 'home'
                ? homeTeam?.name
                : (userTip?.winner === 'away' ? awayTeam?.name : null);

            let dateFormatted = m.datetime ? m.datetime.slice(0, 10) : '';

            return {
                matchId: m.id,
                date: dateFormatted,
                homeName: homeTeam?.name || 'Domácí',
                awayName: awayTeam?.name || 'Hosté',
                homeLogo: homeTeam?.logo ? `/logoteamu/${teamLogoSanitize(homeTeam.logo)}` : '/images/logo.png',
                awayLogo: awayTeam?.logo ? `/logoteamu/${teamLogoSanitize(awayTeam.logo)}` : '/images/logo.png',
                score: `${m.result.scoreHome}:${m.result.scoreAway}`,
                ot: !!m.result.ot,
                winner: m.result.winner,
                userPicked: pickedTeamName,
                isCorrect: pts > 0,
                points: pts,
                community: { home: homeTipsCount, away: awayTipsCount }
            };
        });

        function teamLogoSanitize(logo) {
            return logo ? encodeURIComponent(logo) : '';
        }

        res.json({
            selectedLiga,
            selectedSeason,
            totalEarned,
            totalPossible,
            results
        });
    } catch (err) {
        console.error('Chyba v /api/recent-activity:', err);
        res.status(500).json({ error: 'Chyba serveru při načítání nedávných výsledků.' });
    }
});


module.exports = router;
