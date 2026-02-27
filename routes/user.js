const fs = require("fs");
const express = require("express");
const router = express.Router();
const path = require('path');
const {
    loadTeams, requireLogin, calculateTeamScores, getLeagueZones, getTeamZone
} = require("../utils/fileUtils");

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
    // --- NAČTENÍ NASTAVENÍ VIZUÁLU (STRICT vs CASCADE) ---
    let clinchMode = 'strict'; // Výchozí hard-kódovaný stav

    // 1. Zkusíme načíst globální výchozí nastavení z Adminu
    try {
        const settingsData = JSON.parse(fs.readFileSync('./data/settings.json', 'utf8'));
        if (settingsData.clinchMode) clinchMode = settingsData.clinchMode;
    } catch (e) {}

    // 2. Pokud uživatel kliknul na přepínač na stránce, uložíme mu to do jeho relace
    if (req.query.mode === 'strict' || req.query.mode === 'cascade') {
        req.session.userClinchMode = req.query.mode;
    }

    // 3. Pokud má uživatel ve své relaci už něco vybráno, přebije to to globální nastavení
    if (req.session && req.session.userClinchMode) {
        clinchMode = req.session.userClinchMode;
    }

    const leagueObj = leagues.find(l => l.name === selectedLiga) || {
        name: selectedLiga || "Neznámá liga",
        maxMatches: 0,
        quarterfinal: 0,
        playin: 0,
        relegation: 0,
        isMultigroup: false
    };

    // Načtení tipů
    let tableTips;
    try {
        tableTips = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8'));
    } catch (e) {
        tableTips = {};
    }
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
    const sortedGroupKeys = Object.keys(groupedTeams).sort((a, b) => {
        if (a === 'default') return -1;
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
            const hasRawTableTip = tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username];
            return tips.length > 0 || tableStats !== undefined || !!hasRawTableTip;
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
    } catch (err) {
    }
    const currentUserStats = userStats.find(u => u.username === username);

    // Playoff data
    const playoffPath = path.join(__dirname, '../data/playoff.json');
    let playoffData = [];
    try {
        const raw = fs.readFileSync(playoffPath, 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) playoffData = allPlayoffs[selectedSeason][selectedLiga];
    } catch (e) {
    }

    let isTipsLocked = false;
    let isRegularSeasonFinished = false;
    try {
        const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
        isRegularSeasonFinished = statusData?.[selectedSeason]?.[selectedLiga]?.regularSeasonFinished || false;
        isTipsLocked = statusData?.[selectedSeason]?.[selectedLiga]?.tableTipsLocked || false;
    } catch (e) {
    }

    let teamBonusData = {};
    try {
        teamBonusData = JSON.parse(fs.readFileSync('./data/teamBonuses.json', 'utf8'));
    } catch (e) {
        teamBonusData = {};
    }

    teamsInSelectedLiga.forEach(t => {
        // Inicializace, pokud neexistuje
        if (!t.stats) t.stats = {};
        if (!t.stats[selectedSeason]) t.stats[selectedSeason] = {points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0};

        // Získání reálných bodů ze zápasů
        let naturalPoints = t.stats[selectedSeason].points || 0;

        // Načtení dat z JSONu (ošetření starého formátu vs. nového objektu)
        let bonusEntry = teamBonusData[selectedSeason]?.[selectedLiga]?.[t.id] || {points: 0, games: 0};
        if (typeof bonusEntry === 'number') bonusEntry = {points: bonusEntry, games: 0};

        // Aplikace bodů (přičteme k existujícím)
        t.stats[selectedSeason].points = naturalPoints + (bonusEntry.points || 0);

        // Uložení manuálních zápasů do dočasné proměnné (použijeme později u played a progress baru)
        t.stats[selectedSeason].manualGames = bonusEntry.games || 0;
    });
    // =================================================================

    const teamsByGroup = {};

    teamsInSelectedLiga.forEach(team => {
        const group = team.group ? String.fromCharCode(team.group + 64) : 'X';
        if (!teamsByGroup[group]) teamsByGroup[group] = [];
        teamsByGroup[group].push(team);
    });

    const sortedGroups = Object.keys(teamsByGroup).sort();
    // =========================================================
    // === CENTRALIZOVANÉ IIHF SORTING PRO OBĚ STRANY ===
    // =========================================================
    for (const group of sortedGroups) {
        teamsByGroup[group].sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;

            // 1. Kritérium: BODY
            if (pB !== pA) return pB - pA;

            // --- MINITABULKA ---
            const tiedTeamIds = teamsByGroup[group]
                .filter(t => (t.stats?.[selectedSeason]?.points || 0) === pA)
                .map(t => Number(t.id));

            const getMiniStats = (teamId) => {
                let mPts = 0, mDiff = 0, mGF = 0;
                const groupMatches = matches.filter(m =>
                    m.season === selectedSeason &&
                    m.result &&
                    !m.isPlayoff &&
                    tiedTeamIds.includes(Number(m.homeTeamId)) &&
                    tiedTeamIds.includes(Number(m.awayTeamId)) &&
                    (Number(m.homeTeamId) === teamId || Number(m.awayTeamId) === teamId)
                );

                groupMatches.forEach(m => {
                    const isHome = Number(m.homeTeamId) === teamId;
                    let sH = m.result?.scoreHome !== undefined ? Number(m.result.scoreHome) : (m.scoreHome !== undefined ? Number(m.scoreHome) : 0);
                    let sA = m.result?.scoreAway !== undefined ? Number(m.result.scoreAway) : (m.scoreAway !== undefined ? Number(m.scoreAway) : 0);
                    const isOt = m.result?.ot || m.ot;

                    let hPts, aPts;
                    if (sH > sA) { hPts = isOt ? 2 : 3; aPts = isOt ? 1 : 0; }
                    else if (sA > sH) { aPts = isOt ? 2 : 3; hPts = isOt ? 1 : 0; }
                    else { hPts = 1; aPts = 1; }

                    let pts, gf, ga;
                    if (isHome) { pts = hPts; gf = sH; ga = sA; }
                    else { pts = aPts; gf = sA; ga = sH; }

                    mPts += pts;
                    mDiff += (gf - ga);
                    mGF += gf;
                });
                return {pts: mPts, diff: mDiff, gf: mGF};
            };

            const msA = getMiniStats(Number(a.id));
            const msB = getMiniStats(Number(b.id));

            // 2. Kritérium: BODY V MINITABULCE
            if (msB.pts !== msA.pts) return msB.pts - msA.pts;

            // 3. Kritérium: ROZDÍL SKÓRE V MINITABULCE
            if (msB.diff !== msA.diff) return msB.diff - msA.diff;

            // 4. Kritérium: GÓLY V MINITABULCE
            if (msB.gf !== msA.gf) return msB.gf - msA.gf;

            // 5. Kritérium: PŘÍMÝ VZÁJEMNÝ ZÁPAS
            const directMatch = matches.find(m =>
                m.season === selectedSeason &&
                m.result &&
                !m.isPlayoff &&
                ((Number(m.homeTeamId) === Number(a.id) && Number(m.awayTeamId) === Number(b.id)) ||
                    (Number(m.homeTeamId) === Number(b.id) && Number(m.awayTeamId) === Number(a.id)))
            );

            if (directMatch) {
                const isAHome = Number(directMatch.homeTeamId) === Number(a.id);
                let sH = directMatch.result?.scoreHome ?? directMatch.scoreHome ?? 0;
                let sA = directMatch.result?.scoreAway ?? directMatch.scoreAway ?? 0;

                if (isAHome) {
                    if (sH > sA) return -1;
                    if (sA > sH) return 1;
                } else {
                    if (sA > sH) return -1;
                    if (sH > sA) return 1;
                }
            }

            // 6. Kritérium: CELKOVÉ SKÓRE
            const sA = scores[a.id] || {gf: 0, ga: 0};
            const sB = scores[b.id] || {gf: 0, ga: 0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;

            return 0;
        });
    }
    const statusStyle = isRegularSeasonFinished ? "color: lightgrey; font-weight: bold;" : "color: white; opacity: 0.7; background-color: black";

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

    const crossGroupTeams = [];

    html += `
    <div style="display: flex; justify-content: flex-start; align-items: center; margin-bottom: 10px; gap: 10px;">
        <span style="color: gray; font-size: 0.85em;">Logika obarvování:</span>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=strict" 
           style="${clinchMode === 'strict' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Striktní (Jistá meta)
        </a>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=cascade" 
           style="${clinchMode === 'cascade' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Kaskádová (Minimální meta)
        </a>
    </div>
    `;

    // --- ZPRACOVÁNÍ TABULEK ---
    for (const group of sortedGroups) {
        const teamsInGroup = teamsByGroup[group];
        const zoneConfig = getLeagueZones(leagueObj);

        // =========================================================
        // === IIHF SORTING (FIX: IGNOROVAT PLAYOFF) ===
        // =========================================================
        teamsInGroup.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;

            // 1. Kritérium: BODY
            if (pB !== pA) return pB - pA;

            // --- MINITABULKA ---
            // Najdeme týmy se stejným počtem bodů
            const tiedTeamIds = teamsInGroup
                .filter(t => (t.stats?.[selectedSeason]?.points || 0) === pA)
                .map(t => Number(t.id));

            // Funkce pro minitabulku
            const getMiniStats = (teamId) => {
                let mPts = 0, mDiff = 0, mGF = 0;

                // FILTR: Jen tato sezóna, výsledek existuje, tým hraje A HLAVNĚ !isPlayoff
                const groupMatches = matches.filter(m =>
                    m.season === selectedSeason &&
                    m.result &&
                    !m.isPlayoff && // <--- TOTO JE TA OPRAVA!
                    tiedTeamIds.includes(Number(m.homeTeamId)) &&
                    tiedTeamIds.includes(Number(m.awayTeamId)) &&
                    (Number(m.homeTeamId) === teamId || Number(m.awayTeamId) === teamId)
                );

                groupMatches.forEach(m => {
                    const isHome = Number(m.homeTeamId) === teamId;

                    let sH = m.result?.scoreHome !== undefined ? Number(m.result.scoreHome) : (m.scoreHome !== undefined ? Number(m.scoreHome) : 0);
                    let sA = m.result?.scoreAway !== undefined ? Number(m.result.scoreAway) : (m.scoreAway !== undefined ? Number(m.scoreAway) : 0);
                    const isOt = m.result?.ot || m.ot;

                    let hPts, aPts;
                    if (sH > sA) {
                        hPts = isOt ? 2 : 3;
                        aPts = isOt ? 1 : 0;
                    } else if (sA > sH) {
                        aPts = isOt ? 2 : 3;
                        hPts = isOt ? 1 : 0;
                    } else {
                        hPts = 1;
                        aPts = 1;
                    }

                    let pts, gf, ga;
                    if (isHome) {
                        pts = hPts;
                        gf = sH;
                        ga = sA;
                    } else {
                        pts = aPts;
                        gf = sA;
                        ga = sH;
                    }

                    mPts += pts;
                    mDiff += (gf - ga);
                    mGF += gf;
                });

                return {pts: mPts, diff: mDiff, gf: mGF};
            };

            const msA = getMiniStats(Number(a.id));
            const msB = getMiniStats(Number(b.id));

            // 2. Kritérium: BODY V MINITABULCE
            if (msB.pts !== msA.pts) return msB.pts - msA.pts;

            // 3. Kritérium: ROZDÍL SKÓRE V MINITABULCE
            if (msB.diff !== msA.diff) return msB.diff - msA.diff;

            // 4. Kritérium: GÓLY V MINITABULCE
            if (msB.gf !== msA.gf) return msB.gf - msA.gf;

            // 5. Kritérium: PŘÍMÝ VZÁJEMNÝ ZÁPAS (Head-to-Head)
            const directMatch = matches.find(m =>
                m.season === selectedSeason &&
                m.result &&
                !m.isPlayoff && // <--- TOTO JE TA OPRAVA!
                ((Number(m.homeTeamId) === Number(a.id) && Number(m.awayTeamId) === Number(b.id)) ||
                    (Number(m.homeTeamId) === Number(b.id) && Number(m.awayTeamId) === Number(a.id)))
            );

            if (directMatch) {
                const isAHome = Number(directMatch.homeTeamId) === Number(a.id);
                let sH = directMatch.result?.scoreHome ?? directMatch.scoreHome ?? 0;
                let sA = directMatch.result?.scoreAway ?? directMatch.scoreAway ?? 0;

                if (isAHome) {
                    if (sH > sA) return -1;
                    if (sA > sH) return 1;
                } else {
                    if (sA > sH) return -1;
                    if (sH > sA) return 1;
                }
            }

            // 6. Kritérium: CELKOVÉ SKÓRE
            const sA = scores[a.id] || {gf: 0, ga: 0};
            const sB = scores[b.id] || {gf: 0, ga: 0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;

            return 0;
        });

        // --- ULOŽENÍ TÝMU DO CROSS-TABLE (POKUD JE ZAPNUTO) ---
        if (leagueObj.crossGroupTable && leagueObj.crossGroupPosition > 0) {
            const targetIndex = leagueObj.crossGroupPosition - 1;
            if (teamsInGroup[targetIndex]) {
                crossGroupTeams.push(teamsInGroup[targetIndex]);
            }
        }

        html += `
<table class="points-table">
<thead>
<tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část ${leagueObj?.isMultigroup ? `(Skupina ${group})` : ''}</h2></th></tr>
<tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
</thead>
<tbody>`;

        const sorted = teamsInGroup;

        // --- VÝPOČET ZÁPASŮ ---
        let matchesPerTeam;
        if (leagueObj.isMultigroup) {
            matchesPerTeam = Math.max(1, teamsInGroup.length - 1);
        } else {
            matchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInGroup.length);
        }

        //console.log(`\n=== DEBUG SKUPINA ${group} ===`);
        //console.log(`MatchesPerTeam vypočteno jako: ${matchesPerTeam}`);

        // --- ZÓNY A LIMITY ---
        const qfLimit = leagueObj.quarterfinal || 0;
        const playinLimit = leagueObj.playin || 0;
        const relegationLimit = leagueObj.relegation || 0;

        // Celkový počet postupujících (QF + Předkolo dohromady)
        const totalAdvancing = playinLimit;

        // Index, od kterého začíná sestupová zóna
        const safeZoneIndex = sorted.length - relegationLimit - 1;

        // Funkce pro zjištění maxima bodů, které může získat kdokoliv OD určité pozice dolů
        const getMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            // Pokud index je mimo tabulku, vracíme 0
            if (fromIndex >= sorted.length) return 0;

            for (let i = fromIndex; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const played = (s.wins || 0) + (s.otWins || 0) + (s.otLosses || 0) + (s.losses || 0) + (s.manualGames || 0);
                const remaining = Math.max(0, matchesPerTeam - played);
                const potential = (s.points || 0) + (remaining * 3);
                if (potential > globalMax) globalMax = potential;
            }
            return globalMax;
        };

        // 1. Práh pro QF: Kolik bodů může max. získat ten nejlepší tým, co by skončil POD čarou QF?
        const thresholdQF = getMaxPotentialOfZone(qfLimit);

        // 2. Práh pro Postup (Předkolo): Kolik bodů může max. získat ten nejlepší tým, co by nepostoupil VŮBEC?
        const thresholdPlayin = getMaxPotentialOfZone(totalAdvancing);

        //console.log(`Thresholds: QF > ${thresholdQF}, Playin > ${thresholdPlayin}`);

        let safetyPoints = 0;
        if (relegationLimit > 0 && safeZoneIndex >= 0 && sorted.length > safeZoneIndex) {
            safetyPoints = sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0;
            //console.log(`SafetyPoints (Relegation threshold): ${safetyPoints} (Tým na indexu ${safeZoneIndex})`);
        }

        teamsInGroup.forEach((team, index) => {
            const currentZone = getTeamZone(index, teamsInGroup.length, zoneConfig);
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0) + (stats.manualGames || 0);
            const remaining = Math.max(0, matchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);

            //console.log(`--- TEAM: ${team.name} (${index + 1}.) ---`);
            //console.log(`   Pts: ${myPoints}, Played: ${played}, Remaining: ${remaining}, MaxPts: ${myMaxPoints}`);

            // --- STRICT LOCK LOGIKA (Tvoje verze - funguje správně) ---
            let canDrop = false;
            for (let i = index + 1; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const p = (s.wins || 0) + (s.otWins || 0) + (s.otLosses || 0) + (s.losses || 0) + (s.manualGames || 0);
                const rem = Math.max(0, matchesPerTeam - p);
                const chaserMax = (s.points || 0) + (rem * 3);

                // 1. Pokud mě může předběhnout na ČISTÉ BODY -> nejsem Locked
                if (chaserMax > myPoints) {
                    canDrop = true;
                    break;
                }

                // 2. Pokud mě může DOROVNAT na body a ještě se hraje
                if (chaserMax === myPoints) {
                    if (rem > 0 || remaining > 0) {
                        canDrop = true;
                        break;
                    }
                }
            }

            let canRise = false;
            if (index > 0) {
                const leader = sorted[index - 1];
                const leaderStats = leader.stats?.[selectedSeason] || {};
                const leaderPoints = leaderStats.points || 0;
                const pL = (leaderStats.wins || 0) + (leaderStats.otWins || 0) + (leaderStats.otLosses || 0) + (leaderStats.losses || 0);
                const remL = Math.max(0, matchesPerTeam - pL);

                if (myMaxPoints > leaderPoints) {
                    canRise = true;
                } else if (myMaxPoints === leaderPoints) {
                    if (remaining > 0 || remL > 0) {
                        canRise = true;
                    }
                }
            }

            const locked = !canDrop && !canRise;
            //console.log(`   Logic: CanDrop=${canDrop}, CanRise=${canRise} => LOCKED=${locked}`);

            // Společné proměnné pro obě logiky
            let thresholdRelegation = 0;
            if (relegationLimit > 0 && safeZoneIndex >= 0 && safeZoneIndex + 1 < sorted.length) {
                thresholdRelegation = getMaxPotentialOfZone(safeZoneIndex + 1);
            }

            let clinchedQF = false;
            let clinchedPlayin = false;
            let clinchedRelegation = false;
            let clinchedNeutral = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                // =========================================================
                // LOGIKA 1: STRIKTNÍ ZAMYKÁNÍ (Uvěznění v daném patře)
                // =========================================================
                const ptsGatekeeperQF = (qfLimit > 0 && sorted[qfLimit - 1]) ? (sorted[qfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperPlayin = (totalAdvancing > 0 && sorted[totalAdvancing - 1]) ? (sorted[totalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperSafe = (safeZoneIndex >= 0 && sorted[safeZoneIndex]) ? (sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;

                    if (totalAdvancing > 0 && (myPoints > thresholdPlayin || totalAdvancing >= sorted.length)) {
                        if (qfLimit === 0 || myMaxPoints < ptsGatekeeperQF) clinchedPlayin = true;
                    }

                    if (relegationLimit === 0 || myPoints > thresholdRelegation) {
                        if (totalAdvancing === 0 || myMaxPoints < ptsGatekeeperPlayin) clinchedNeutral = true;
                    }

                    if (relegationLimit > 0 && myMaxPoints < ptsGatekeeperSafe) clinchedRelegation = true;
                }

                // Třídy pro Strict
                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';

            } else {
                // =========================================================
                // LOGIKA 2: KASKÁDA (Nejvyšší dosažená meta)
                // =========================================================
                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;
                    if (totalAdvancing > 0 && myPoints > thresholdPlayin || totalAdvancing >= sorted.length) clinchedPlayin = true;

                    if (relegationLimit > 0 && myPoints > thresholdRelegation) clinchedNeutral = true;
                    else if (relegationLimit === 0) clinchedNeutral = true;

                    if (relegationLimit > 0 && index > safeZoneIndex && myMaxPoints < safetyPoints) clinchedRelegation = true;
                }

                // Třídy pro Kaskádu
                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
            }

            // Aplikace Cross-table a Locked
            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition && locked) {
                rowClass = 'clinched-crosstable';
            }
            if (locked) rowClass += ' locked';

            //console.log(`   Final Class: ${rowClass}`);

            let rankClass = currentZone;
            const teamStats = scores[team.id] || {gf: 0, ga: 0};
            const goalDiff = teamStats.gf - teamStats.ga;

            // --- SPECIÁLNÍ PODBARVENÍ PRO CROSS-TABLE RANK ---

            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition) {
                rankClass = 'crosstable';
            }

            html += `<tr class="${rowClass}">
<td class="rank-cell ${rankClass}">${index + 1}.</td>
<td>${team.name}</td>
<td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td>
<td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
<td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
<td class="numbers">${played}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td>
</tr>`;
        });
        html += `</tbody></table><br>`;
    }

    // =========================================================
    // === TABULKA X-TÝCH TÝMŮ (S OPRAVENÝM LOCKOVÁNÍM) ===
    // =========================================================
    if (leagueObj.crossGroupTable && crossGroupTeams.length > 0) {

        const crossConfig = leagueObj.crossGroupConfig || {quarterfinal: 0, playin: 0, relegation: 0};

        html += `<h2 style="text-align: center; margin-top: 30px; border-top: 2px solid #444; padding-top: 20px;">Tabulka týmů na ${leagueObj.crossGroupPosition}. místě</h2>`;

        // 1. Seřazení týmů
        crossGroupTeams.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;
            if (pB !== pA) return pB - pA;

            const sA = scores[a.id] || {gf: 0, ga: 0};
            const sB = scores[b.id] || {gf: 0, ga: 0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;
            if (sA.gf !== sB.gf) return sB.gf - sA.gf;
            return 0;
        });

        html += `
        <table class="points-table">
        <thead>
        <tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
        </thead>
        <tbody>`;

        // 2. Limity pro Cross-Table
        const cQfLimit = crossConfig.quarterfinal || 0;
        const cPlayinLimit = crossConfig.playin || 0;
        const cRelLimit = crossConfig.relegation || 0;

        let cTotalAdvancing = 0;
        if (cPlayinLimit > 0) cTotalAdvancing = cPlayinLimit;
        else cTotalAdvancing = cQfLimit;
        cTotalAdvancing = Math.min(cTotalAdvancing, crossGroupTeams.length);

        const cSafeZoneIndex = crossGroupTeams.length - cRelLimit - 1;

        // 3. SPRÁVNÝ VÝPOČET ZÁPASŮ (Stejný jako v horních tabulkách)
        // Toto zajistí, že systém ví, že po 2 zápasech je konec a má zamknout.
        let cMatchesPerTeam = 52;
        if (leagueObj.isMultigroup) {
            // Pokud je to multigroup bez rounds, bývá to "každý s každým" ve skupině
            const estimatedGroupSize = teamsInSelectedLiga.length / (leagueObj.groupCount || 1);
            cMatchesPerTeam = Math.max(1, Math.ceil(estimatedGroupSize) - 1);
        } else if (leagueObj.maxMatches) {
            // Pokud je natvrdo nastaven maxMatches
            if (leagueObj.maxMatches > 100) {
                cMatchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInSelectedLiga.length);
            } else {
                cMatchesPerTeam = leagueObj.maxMatches;
            }
        }

        // 4. Pomocné funkce pro potenciál (s opraveným počtem zápasů)
        const getCrossTeamPotential = (idx) => {
            if (idx >= crossGroupTeams.length) return 0;
            const t = crossGroupTeams[idx];
            const s = t.stats?.[selectedSeason] || {};
            const played = (s.wins || 0) + (s.otWins || 0) + (s.otLosses || 0) + (s.losses || 0) + (s.manualGames || 0);

            if (isRegularSeasonFinished) return s.points || 0;

            const remaining = Math.max(0, cMatchesPerTeam - played);
            return (s.points || 0) + (remaining * 3);
        };

        const getCrossMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            if (fromIndex >= crossGroupTeams.length) return 0;
            for (let i = fromIndex; i < crossGroupTeams.length; i++) {
                globalMax = Math.max(globalMax, getCrossTeamPotential(i));
            }
            return globalMax;
        };

        // Thresholdy
        let cThresholdQF = 0;
        if (cQfLimit > 0 && cQfLimit < crossGroupTeams.length) {
            cThresholdQF = getCrossMaxPotentialOfZone(cQfLimit);
        }

        let cThresholdPlayin = 0;
        if (cTotalAdvancing > 0 && cTotalAdvancing < crossGroupTeams.length) {
            cThresholdPlayin = getCrossMaxPotentialOfZone(cTotalAdvancing);
        }

        // 5. Hlavní cyklus
        crossGroupTeams.forEach((team, index) => {
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0) + (stats.manualGames || 0);

            // Určení základní Zóny
            let currentZone = "neutral";
            if (cRelLimit > 0 && index > cSafeZoneIndex) currentZone = "relegation";
            else if (cQfLimit > 0 && index < cQfLimit) currentZone = "quarterfinal";
            else if (cTotalAdvancing > 0 && index < cTotalAdvancing) currentZone = "playin";

            const remaining = Math.max(0, cMatchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);
            const teamStats = scores[team.id] || {gf: 0, ga: 0};
            const goalDiff = teamStats.gf - teamStats.ga;

            // --- STRICT LOCK LOGIKA ---
            let canDrop = false;
            for (let i = index + 1; i < crossGroupTeams.length; i++) {
                const chaserMax = getCrossTeamPotential(i);
                if (chaserMax > myPoints) {
                    canDrop = true;
                    break;
                }
                const chaserPlayed = (crossGroupTeams[i].stats?.[selectedSeason]?.wins || 0) + (crossGroupTeams[i].stats?.[selectedSeason]?.losses || 0);

                // Opravená podmínka pro konec zápasů
                if (chaserMax === myPoints && !isRegularSeasonFinished && (remaining > 0 || chaserPlayed < cMatchesPerTeam)) {
                    canDrop = true;
                    break;
                }
            }

            let canRise = false;
            if (index > 0) {
                const prevTeamCurrentPoints = crossGroupTeams[index - 1].stats?.[selectedSeason]?.points || 0;
                if (myMaxPoints > prevTeamCurrentPoints) canRise = true;
                if (myMaxPoints === prevTeamCurrentPoints && !isRegularSeasonFinished && remaining > 0) {
                    canRise = true;
                }
            }

            const cLocked = !canDrop && !canRise;

            // Společné pro Cross-table
            let cThresholdRelegation = 0;
            if (cRelLimit > 0 && cSafeZoneIndex >= 0 && cSafeZoneIndex + 1 < crossGroupTeams.length) {
                cThresholdRelegation = getCrossMaxPotentialOfZone(cSafeZoneIndex + 1);
            }

            let cSafeQF = false;
            let cSafePlayin = false;
            let cRelegated = false;
            let cNeutralLocked = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                // --- STRICT LOGIKA CROSS-TABLE ---
                const cPtsGatekeeperQF = (cQfLimit > 0 && crossGroupTeams[cQfLimit - 1]) ? (crossGroupTeams[cQfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperPlayin = (cTotalAdvancing > 0 && crossGroupTeams[cTotalAdvancing - 1]) ? (crossGroupTeams[cTotalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperSafe = (cSafeZoneIndex >= 0 && crossGroupTeams[cSafeZoneIndex]) ? (crossGroupTeams[cSafeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;

                    if (cTotalAdvancing > 0 && (myPoints > cThresholdPlayin || cTotalAdvancing >= crossGroupTeams.length)) {
                        if (cQfLimit === 0 || myMaxPoints < cPtsGatekeeperQF) cSafePlayin = true;
                    }

                    if (cRelLimit === 0 || myPoints > cThresholdRelegation) {
                        if (cTotalAdvancing === 0 || myMaxPoints < cPtsGatekeeperPlayin) cNeutralLocked = true;
                    }

                    if (cRelLimit > 0 && myMaxPoints < cPtsGatekeeperSafe) cRelegated = true;
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";

            } else {
                // --- KASKÁDOVÁ LOGIKA CROSS-TABLE ---
                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;
                    if (cTotalAdvancing > 0 && myPoints > cThresholdPlayin) cSafePlayin = true;

                    if (cRelLimit > 0 && myPoints > cThresholdRelegation) cNeutralLocked = true;
                    else if (cRelLimit === 0) cNeutralLocked = true;

                    if (cRelLimit > 0 && index > cSafeZoneIndex) {
                        const safetyTarget = crossGroupTeams[cSafeZoneIndex]?.stats?.[selectedSeason]?.points || 0;
                        if (myMaxPoints < safetyTarget) cRelegated = true;
                    }
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
            }

            if (cLocked) rowClass += " locked";

            html += `<tr class="${rowClass}">
                <td class="rank-cell ${currentZone}">${index + 1}.</td>
                <td>${team.name}</td>
                <td class="points numbers">${myPoints}</td>
                <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
                <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
                <td class="numbers">${played}</td>
                <td class="numbers">${stats.wins || 0}</td>
                <td class="numbers">${stats.otWins || 0}</td>
                <td class="numbers">${stats.otLosses || 0}</td>
                <td class="numbers">${stats.losses || 0}</td>
            </tr>`;
        });

        html += `</tbody></table><br>`;
    }
    html += `
    </div>
    <div id="playoffTablePreview" style="display:none; overflow:auto; max-width:100%;">
        <table class="points-table">
            <tr>
                <th scope="col" id="points-table-header" colSpan="20"><h2>Týmy - ${selectedLiga} ${selectedSeason} -
                    Playoff</h2></th>
            </tr>
            `;
            playoffData.forEach((row) => {
            html += '<tr>';
            row.forEach(cell => {
            const bg = cell.bgColor || '';
            const textColor = cell.textColor || '';
            const styleParts = [];
            if (bg) styleParts.push(`background-color:${bg}`);
            if (textColor) styleParts.push(`color:${textColor}`);
            const styleAttr = styleParts.length ? ` style="${styleParts.join(';')}"` : '';
            html += `<td${styleAttr}>${cell.text || ''}</td>`;
        });
            html += '</tr>';
        });

            const totalMatches = leagueObj.maxMatches; // Celkový počet zápasů v lize (dle nastavení)

            // 1. Zápasy z databáze (matches.json)
            let filledMatches = matches.filter(m => m.result && m.isPlayoff === false && m.liga === selectedLiga &&
            m.season === selectedSeason).length;

            // 2. NOVÉ: Připočítat manuální zápasy
            // (Sečteme manuální zápasy všech týmů a vydělíme 2, protože jeden zápas hrají dva týmy)
            const totalManualGames = teamsInSelectedLiga.reduce((sum, t) => sum +
            (t.stats?.[selectedSeason]?.manualGames || 0), 0);
            filledMatches += Math.floor(totalManualGames / 2);

            // Výpočet procenta
            const percentage = totalMatches > 0 ? Math.round((filledMatches / totalMatches) * 100) : 0;

            html += `
        </table>
    </div>
</table>

<section class="progress-section">
<h3>Odehráno zápasů v základní části</h3>
<div class="progress-container">
<div class="progress-bar" style="width:${percentage}%;">${percentage}%</div>
</div>
<p id="progress-text"></p>
</section>
     
        </div></div>`;

    // --- STATISTIKY (OBNOVENO V PLNÉ PARÁDĚ) ---
    if (username) {
        html += `
        <section class="user_stats">
            <h2>Tvoje statistiky</h2>
             ${currentUserStats ? `
                <p>Správně tipnuto z maximálního počtu všech vyhodnocených zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.total}</strong> 
                    (${(currentUserStats.total > 0 ? (currentUserStats.correct / currentUserStats.total * 100).toFixed(2) : '0.00')} %)
                </p>
                ${currentUserStats.total !== currentUserStats.maxFromTips ? `
                <p>Správně tipnuto z tipovaných zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.maxFromTips}</strong> 
                    (${(currentUserStats.maxFromTips > 0 ? (currentUserStats.correct / currentUserStats.maxFromTips * 100).toFixed(2) : '0.00')} %)
                </p>` : ''}
            ` : `<p>Nemáš pro tuto sezónu/ligu žádná data.</p>`}
            
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

    // =========================================================
    // 1. ZÍSKÁNÍ SKUTEČNÉHO POŘADÍ Z LEVÉ TABULKY
    // =========================================================
    // Levá tabulka už pole v teamsByGroup správně seřadila podle IIHF,
    // takže si jen uložíme výsledné pozice každého týmu, abychom je vpravo nemuseli složitě počítat.
    const globalRealRankMap = {};
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
    // --- 1. NAČTENÍ DAT ---
    const username = req.session.user;
    const teams = loadTeams().filter(t => t.active);

    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf-8'));
    const allowedLeagues = JSON.parse(fs.readFileSync('./data/allowedLeagues.json', 'utf-8'));
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];

    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];
    const uniqueLeagues = allLeagues.filter(l => allowedLeagues.includes(l));

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga) ? req.query.liga : uniqueLeagues[0];
    const teamsInSelectedLiga = teams.filter(t => t.liga === selectedLiga);

    const scores = calculateTeamScores(matches, selectedSeason, selectedLiga);
    // --- NAČTENÍ NASTAVENÍ VIZUÁLU (STRICT vs CASCADE) ---
    // --- NAČTENÍ NASTAVENÍ VIZUÁLU (STRICT vs CASCADE) ---
    let clinchMode = 'strict'; // Výchozí hard-kódovaný stav

    // 1. Zkusíme načíst globální výchozí nastavení z Adminu
    try {
        const settingsData = JSON.parse(fs.readFileSync('./data/settings.json', 'utf8'));
        if (settingsData.clinchMode) clinchMode = settingsData.clinchMode;
    } catch (e) {}

    // 2. Pokud uživatel kliknul na přepínač na stránce, uložíme mu to do jeho relace
    if (req.query.mode === 'strict' || req.query.mode === 'cascade') {
        req.session.userClinchMode = req.query.mode;
    }

    // 3. Pokud má uživatel ve své relaci už něco vybráno, přebije to to globální nastavení
    if (req.session && req.session.userClinchMode) {
        clinchMode = req.session.userClinchMode;
    }

    // --- 2. DEFINICE statusStyle ---
    let isRegularSeasonFinished = false;
    try {
        const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
        isRegularSeasonFinished = statusData?.[selectedSeason]?.[selectedLiga]?.regularSeasonFinished || false;
    } catch (e) {
    }
    const statusStyle = isRegularSeasonFinished ? "color: lightgrey; font-weight: bold;" : "color: white; opacity: 0.7; background-color: black";

    // --- 3. STATISTIKY UŽIVATELŮ ---
    let userStats = [];
    try {
        const usersData = fs.readFileSync('./data/users.json', 'utf-8');
        const allUsers = JSON.parse(usersData);
        const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);

        let tableTips = {};
        try {
            tableTips = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8'));
        } catch (e) {
            tableTips = {};
        }

        userStats = allUsers.filter(u => {
            const tips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
            const tableStats = u.stats?.[selectedSeason]?.[selectedLiga]?.tableCorrect;
            const hasRawTableTip = tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username];
            return tips.length > 0 || tableStats !== undefined || !!hasRawTableTip;
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
    } catch (err) {
        console.error(err);
    }

    const currentUserStats = userStats.find(u => u.username === username);

    const playoffPath = path.join(__dirname, '../data/playoff.json');
    let playoffData = [];
    try {
        const raw = fs.readFileSync(playoffPath, 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) playoffData = allPlayoffs[selectedSeason][selectedLiga];
    } catch (e) {
    }


    let teamBonusData = {};
    try {
        teamBonusData = JSON.parse(fs.readFileSync('./data/teamBonuses.json', 'utf8'));
    } catch (e) { teamBonusData = {}; }

    teamsInSelectedLiga.forEach(t => {
        // Inicializace, pokud neexistuje
        if (!t.stats) t.stats = {};
        if (!t.stats[selectedSeason]) t.stats[selectedSeason] = { points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0 };

        // Získání reálných bodů ze zápasů
        let naturalPoints = t.stats[selectedSeason].points || 0;

        // Načtení dat z JSONu (ošetření starého formátu vs. nového objektu)
        let bonusEntry = teamBonusData[selectedSeason]?.[selectedLiga]?.[t.id] || { points: 0, games: 0 };
        if (typeof bonusEntry === 'number') bonusEntry = { points: bonusEntry, games: 0 };

        // Aplikace bodů (přičteme k existujícím)
        t.stats[selectedSeason].points = naturalPoints + (bonusEntry.points || 0);

        // Uložení manuálních zápasů do dočasné proměnné (použijeme později u played a progress baru)
        t.stats[selectedSeason].manualGames = bonusEntry.games || 0;
    });
    // =================================================================

    const teamsByGroup = {};
    teamsInSelectedLiga.forEach(team => {
        const group = team.group ? String.fromCharCode(team.group + 64) : 'X';
        if (!teamsByGroup[group]) teamsByGroup[group] = [];
        teamsByGroup[group].push(team);
    });

    const leagueObj = leagues.find(l => l.name === selectedLiga) || {
        name: selectedLiga || "Neznámá liga",
        maxMatches: 0, quarterfinal: 0, playin: 0, relegation: 0, isMultigroup: false
    };
    const sortedGroups = Object.keys(teamsByGroup).sort();

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

    html += `
    <div style="display: flex; justify-content: flex-start; align-items: center; margin-bottom: 10px; gap: 10px;">
        <span style="color: gray; font-size: 0.85em;">Logika obarvování:</span>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=strict" 
           style="${clinchMode === 'strict' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Striktní (Jistá meta)
        </a>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=cascade" 
           style="${clinchMode === 'cascade' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Kaskádová (Minimální meta)
        </a>
    </div>
    `;

    const crossGroupTeams = [];

    // --- ZPRACOVÁNÍ TABULEK ---
    for (const group of sortedGroups) {
        const teamsInGroup = teamsByGroup[group];
        const zoneConfig = getLeagueZones(leagueObj);

        // =========================================================
        // === IIHF SORTING (FIX: IGNOROVAT PLAYOFF) ===
        // =========================================================
        teamsInGroup.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;

            // 1. Kritérium: BODY
            if (pB !== pA) return pB - pA;

            // --- MINITABULKA ---
            // Najdeme týmy se stejným počtem bodů
            const tiedTeamIds = teamsInGroup
                .filter(t => (t.stats?.[selectedSeason]?.points || 0) === pA)
                .map(t => Number(t.id));

            // Funkce pro minitabulku
            const getMiniStats = (teamId) => {
                let mPts = 0, mDiff = 0, mGF = 0;

                // FILTR: Jen tato sezóna, výsledek existuje, tým hraje A HLAVNĚ !isPlayoff
                const groupMatches = matches.filter(m =>
                    m.season === selectedSeason &&
                    m.result &&
                    !m.isPlayoff && // <--- TOTO JE TA OPRAVA!
                    tiedTeamIds.includes(Number(m.homeTeamId)) &&
                    tiedTeamIds.includes(Number(m.awayTeamId)) &&
                    (Number(m.homeTeamId) === teamId || Number(m.awayTeamId) === teamId)
                );

                groupMatches.forEach(m => {
                    const isHome = Number(m.homeTeamId) === teamId;

                    let sH = m.result?.scoreHome !== undefined ? Number(m.result.scoreHome) : (m.scoreHome !== undefined ? Number(m.scoreHome) : 0);
                    let sA = m.result?.scoreAway !== undefined ? Number(m.result.scoreAway) : (m.scoreAway !== undefined ? Number(m.scoreAway) : 0);
                    const isOt = m.result?.ot || m.ot;

                    let hPts, aPts;
                    if (sH > sA) { hPts = isOt ? 2 : 3; aPts = isOt ? 1 : 0; }
                    else if (sA > sH) { aPts = isOt ? 2 : 3; hPts = isOt ? 1 : 0; }
                    else { hPts=1; aPts=1; }

                    let pts, gf, ga;
                    if (isHome) { pts = hPts; gf = sH; ga = sA; }
                    else { pts = aPts; gf = sA; ga = sH; }

                    mPts += pts;
                    mDiff += (gf - ga);
                    mGF += gf;
                });

                return { pts: mPts, diff: mDiff, gf: mGF };
            };

            const msA = getMiniStats(Number(a.id));
            const msB = getMiniStats(Number(b.id));

            // 2. Kritérium: BODY V MINITABULCE
            if (msB.pts !== msA.pts) return msB.pts - msA.pts;

            // 3. Kritérium: ROZDÍL SKÓRE V MINITABULCE
            if (msB.diff !== msA.diff) return msB.diff - msA.diff;

            // 4. Kritérium: GÓLY V MINITABULCE
            if (msB.gf !== msA.gf) return msB.gf - msA.gf;

            // 5. Kritérium: PŘÍMÝ VZÁJEMNÝ ZÁPAS (Head-to-Head)
            const directMatch = matches.find(m =>
                m.season === selectedSeason &&
                m.result &&
                !m.isPlayoff && // <--- TOTO JE TA OPRAVA!
                ((Number(m.homeTeamId) === Number(a.id) && Number(m.awayTeamId) === Number(b.id)) ||
                    (Number(m.homeTeamId) === Number(b.id) && Number(m.awayTeamId) === Number(a.id)))
            );

            if (directMatch) {
                const isAHome = Number(directMatch.homeTeamId) === Number(a.id);
                let sH = directMatch.result?.scoreHome ?? directMatch.scoreHome ?? 0;
                let sA = directMatch.result?.scoreAway ?? directMatch.scoreAway ?? 0;

                if (isAHome) {
                    if (sH > sA) return -1;
                    if (sA > sH) return 1;
                } else {
                    if (sA > sH) return -1;
                    if (sH > sA) return 1;
                }
            }

            // 6. Kritérium: CELKOVÉ SKÓRE
            const sA = scores[a.id] || {gf:0, ga:0};
            const sB = scores[b.id] || {gf:0, ga:0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;

            return 0;
        });

        // --- ULOŽENÍ TÝMU DO CROSS-TABLE (POKUD JE ZAPNUTO) ---
        if (leagueObj.crossGroupTable && leagueObj.crossGroupPosition > 0) {
            const targetIndex = leagueObj.crossGroupPosition - 1;
            if (teamsInGroup[targetIndex]) {
                crossGroupTeams.push(teamsInGroup[targetIndex]);
            }
        }

        html += `
<table class="points-table">
<thead>
<tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část ${leagueObj?.isMultigroup ? `(Skupina ${group})` : ''}</h2></th></tr>
<tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
</thead>
<tbody>`;

        const sorted = teamsInGroup;

        // --- VÝPOČET ZÁPASŮ ---
        let matchesPerTeam;
        if (leagueObj.isMultigroup) {
            matchesPerTeam = Math.max(1, teamsInGroup.length - 1);
        } else {
            matchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInGroup.length);
        }

        //console.log(`\n=== DEBUG SKUPINA ${group} ===`);
        //console.log(`MatchesPerTeam vypočteno jako: ${matchesPerTeam}`);

        // --- ZÓNY A LIMITY ---
        const qfLimit = leagueObj.quarterfinal || 0;
        const playinLimit = leagueObj.playin || 0;
        const relegationLimit = leagueObj.relegation || 0;

        // Celkový počet postupujících (QF + Předkolo dohromady)
        const totalAdvancing = playinLimit;

        // Index, od kterého začíná sestupová zóna
        const safeZoneIndex = sorted.length - relegationLimit - 1;

        // Funkce pro zjištění maxima bodů, které může získat kdokoliv OD určité pozice dolů
        const getMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            // Pokud index je mimo tabulku, vracíme 0
            if (fromIndex >= sorted.length) return 0;

            for (let i = fromIndex; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const played = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
                const remaining = Math.max(0, matchesPerTeam - played);
                const potential = (s.points || 0) + (remaining * 3);
                if (potential > globalMax) globalMax = potential;
            }
            return globalMax;
        };

        // 1. Práh pro QF: Kolik bodů může max. získat ten nejlepší tým, co by skončil POD čarou QF?
        const thresholdQF = getMaxPotentialOfZone(qfLimit);

        // 2. Práh pro Postup (Předkolo): Kolik bodů může max. získat ten nejlepší tým, co by nepostoupil VŮBEC?
        const thresholdPlayin = getMaxPotentialOfZone(totalAdvancing);

        //console.log(`Thresholds: QF > ${thresholdQF}, Playin > ${thresholdPlayin}`);

        let safetyPoints = 0;
        if (relegationLimit > 0 && safeZoneIndex >= 0 && sorted.length > safeZoneIndex) {
            safetyPoints = sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0;
            //console.log(`SafetyPoints (Relegation threshold): ${safetyPoints} (Tým na indexu ${safeZoneIndex})`);
        }

        teamsInGroup.forEach((team, index) => {
            const currentZone = getTeamZone(index, teamsInGroup.length, zoneConfig);
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins||0) + (stats.otWins||0) + (stats.otLosses||0) + (stats.losses||0) + (stats.manualGames || 0);
            const remaining = Math.max(0, matchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);

            //console.log(`--- TEAM: ${team.name} (${index + 1}.) ---`);
            //console.log(`   Pts: ${myPoints}, Played: ${played}, Remaining: ${remaining}, MaxPts: ${myMaxPoints}`);

            // --- STRICT LOCK LOGIKA (Tvoje verze - funguje správně) ---
            let canDrop = false;
            for (let i = index + 1; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const p = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
                const rem = Math.max(0, matchesPerTeam - p);
                const chaserMax = (s.points || 0) + (rem * 3);

                // 1. Pokud mě může předběhnout na ČISTÉ BODY -> nejsem Locked
                if (chaserMax > myPoints) {
                    canDrop = true;
                    break;
                }

                // 2. Pokud mě může DOROVNAT na body a ještě se hraje
                if (chaserMax === myPoints) {
                    if (rem > 0 || remaining > 0) {
                        canDrop = true;
                        break;
                    }
                }
            }

            let canRise = false;
            if (index > 0) {
                const leader = sorted[index - 1];
                const leaderStats = leader.stats?.[selectedSeason] || {};
                const leaderPoints = leaderStats.points || 0;
                const pL = (leaderStats.wins||0)+(leaderStats.otWins||0)+(leaderStats.otLosses||0)+(leaderStats.losses||0);
                const remL = Math.max(0, matchesPerTeam - pL);

                if (myMaxPoints > leaderPoints) {
                    canRise = true;
                }
                else if (myMaxPoints === leaderPoints) {
                    if (remaining > 0 || remL > 0) {
                        canRise = true;
                    }
                }
            }

            const locked = !canDrop && !canRise;
            //console.log(`   Logic: CanDrop=${canDrop}, CanRise=${canRise} => LOCKED=${locked}`);

            // Společné proměnné pro obě logiky
            let thresholdRelegation = 0;
            if (relegationLimit > 0 && safeZoneIndex >= 0 && safeZoneIndex + 1 < sorted.length) {
                thresholdRelegation = getMaxPotentialOfZone(safeZoneIndex + 1);
            }

            let clinchedQF = false;
            let clinchedPlayin = false;
            let clinchedRelegation = false;
            let clinchedNeutral = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                // =========================================================
                // LOGIKA 1: STRIKTNÍ ZAMYKÁNÍ (Uvěznění v daném patře)
                // =========================================================
                const ptsGatekeeperQF = (qfLimit > 0 && sorted[qfLimit - 1]) ? (sorted[qfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperPlayin = (totalAdvancing > 0 && sorted[totalAdvancing - 1]) ? (sorted[totalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperSafe = (safeZoneIndex >= 0 && sorted[safeZoneIndex]) ? (sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;

                    if (totalAdvancing > 0 && (myPoints > thresholdPlayin || totalAdvancing >= sorted.length)) {
                        if (qfLimit === 0 || myMaxPoints < ptsGatekeeperQF) clinchedPlayin = true;
                    }

                    if (relegationLimit === 0 || myPoints > thresholdRelegation) {
                        if (totalAdvancing === 0 || myMaxPoints < ptsGatekeeperPlayin) clinchedNeutral = true;
                    }

                    if (relegationLimit > 0 && myMaxPoints < ptsGatekeeperSafe) clinchedRelegation = true;
                }

                // Třídy pro Strict
                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';

            } else {
                // =========================================================
                // LOGIKA 2: KASKÁDA (Nejvyšší dosažená meta)
                // =========================================================
                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;
                    if (totalAdvancing > 0 && myPoints > thresholdPlayin || totalAdvancing >= sorted.length) clinchedPlayin = true;

                    if (relegationLimit > 0 && myPoints > thresholdRelegation) clinchedNeutral = true;
                    else if (relegationLimit === 0) clinchedNeutral = true;

                    if (relegationLimit > 0 && index > safeZoneIndex && myMaxPoints < safetyPoints) clinchedRelegation = true;
                }

                // Třídy pro Kaskádu
                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
            }

            // Aplikace Cross-table a Locked
            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition && locked) {
                rowClass = 'clinched-crosstable';
            }
            if (locked) rowClass += ' locked';

            //console.log(`   Final Class: ${rowClass}`);

            let rankClass = currentZone;
            const teamStats = scores[team.id] || {gf: 0, ga: 0};
            const goalDiff = teamStats.gf - teamStats.ga;

            // --- SPECIÁLNÍ PODBARVENÍ PRO CROSS-TABLE RANK ---

            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition) {
                rankClass = 'crosstable';
            }

            html += `<tr class="${rowClass}">
<td class="rank-cell ${rankClass}">${index + 1}.</td>
<td>${team.name}</td>
<td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td>
<td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
<td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
<td class="numbers">${played}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td>
</tr>`;
        });
        html += `</tbody></table><br>`;
    }

    // =========================================================
    // === TABULKA X-TÝCH TÝMŮ (S OPRAVENÝM LOCKOVÁNÍM) ===
    // =========================================================
    if (leagueObj.crossGroupTable && crossGroupTeams.length > 0) {

        const crossConfig = leagueObj.crossGroupConfig || { quarterfinal: 0, playin: 0, relegation: 0 };

        html += `<h2 style="text-align: center; margin-top: 30px; border-top: 2px solid #444; padding-top: 20px;">Tabulka týmů na ${leagueObj.crossGroupPosition}. místě</h2>`;

        // 1. Seřazení týmů
        crossGroupTeams.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;
            if (pB !== pA) return pB - pA;

            const sA = scores[a.id] || {gf:0, ga:0};
            const sB = scores[b.id] || {gf:0, ga:0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;
            if (sA.gf !== sB.gf) return sB.gf - sA.gf;
            return 0;
        });

        html += `
        <table class="points-table">
        <thead>
        <tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
        </thead>
        <tbody>`;

        // 2. Limity pro Cross-Table
        const cQfLimit = crossConfig.quarterfinal || 0;
        const cPlayinLimit = crossConfig.playin || 0;
        const cRelLimit = crossConfig.relegation || 0;

        let cTotalAdvancing = 0;
        if (cPlayinLimit > 0) cTotalAdvancing = cPlayinLimit;
        else cTotalAdvancing = cQfLimit;
        cTotalAdvancing = Math.min(cTotalAdvancing, crossGroupTeams.length);

        const cSafeZoneIndex = crossGroupTeams.length - cRelLimit - 1;

        // 3. SPRÁVNÝ VÝPOČET ZÁPASŮ (Stejný jako v horních tabulkách)
        // Toto zajistí, že systém ví, že po 2 zápasech je konec a má zamknout.
        let cMatchesPerTeam = 52;
        if (leagueObj.isMultigroup) {
            // Pokud je to multigroup bez rounds, bývá to "každý s každým" ve skupině
            const estimatedGroupSize = teamsInSelectedLiga.length / (leagueObj.groupCount || 1);
            cMatchesPerTeam = Math.max(1, Math.ceil(estimatedGroupSize) - 1);
        } else if (leagueObj.maxMatches) {
            // Pokud je natvrdo nastaven maxMatches
            if (leagueObj.maxMatches > 100) {
                cMatchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInSelectedLiga.length);
            } else {
                cMatchesPerTeam = leagueObj.maxMatches;
            }
        }

        // 4. Pomocné funkce pro potenciál (s opraveným počtem zápasů)
        const getCrossTeamPotential = (idx) => {
            if (idx >= crossGroupTeams.length) return 0;
            const t = crossGroupTeams[idx];
            const s = t.stats?.[selectedSeason] || {};
            const played = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);

            if (isRegularSeasonFinished) return s.points || 0;

            const remaining = Math.max(0, cMatchesPerTeam - played);
            return (s.points || 0) + (remaining * 3);
        };

        const getCrossMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            if (fromIndex >= crossGroupTeams.length) return 0;
            for (let i = fromIndex; i < crossGroupTeams.length; i++) {
                globalMax = Math.max(globalMax, getCrossTeamPotential(i));
            }
            return globalMax;
        };

        // Thresholdy
        let cThresholdQF = 0;
        if (cQfLimit > 0 && cQfLimit < crossGroupTeams.length) {
            cThresholdQF = getCrossMaxPotentialOfZone(cQfLimit);
        }

        let cThresholdPlayin = 0;
        if (cTotalAdvancing > 0 && cTotalAdvancing < crossGroupTeams.length) {
            cThresholdPlayin = getCrossMaxPotentialOfZone(cTotalAdvancing);
        }

        // 5. Hlavní cyklus
        crossGroupTeams.forEach((team, index) => {
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins||0) + (stats.otWins||0) + (stats.otLosses||0) + (stats.losses||0) + (stats.manualGames || 0);

            // Určení základní Zóny
            let currentZone = "neutral";
            if (cRelLimit > 0 && index > cSafeZoneIndex) currentZone = "relegation";
            else if (cQfLimit > 0 && index < cQfLimit) currentZone = "quarterfinal";
            else if (cTotalAdvancing > 0 && index < cTotalAdvancing) currentZone = "playin";

            const remaining = Math.max(0, cMatchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);
            const teamStats = scores[team.id] || {gf:0, ga:0};
            const goalDiff = teamStats.gf - teamStats.ga;

            // --- STRICT LOCK LOGIKA ---
            let canDrop = false;
            for (let i = index + 1; i < crossGroupTeams.length; i++) {
                const chaserMax = getCrossTeamPotential(i);
                if (chaserMax > myPoints) { canDrop = true; break; }
                const chaserPlayed = (crossGroupTeams[i].stats?.[selectedSeason]?.wins||0) + (crossGroupTeams[i].stats?.[selectedSeason]?.losses||0);

                // Opravená podmínka pro konec zápasů
                if (chaserMax === myPoints && !isRegularSeasonFinished && (remaining > 0 || chaserPlayed < cMatchesPerTeam)) {
                    canDrop = true; break;
                }
            }

            let canRise = false;
            if (index > 0) {
                const prevTeamCurrentPoints = crossGroupTeams[index - 1].stats?.[selectedSeason]?.points || 0;
                if (myMaxPoints > prevTeamCurrentPoints) canRise = true;
                if (myMaxPoints === prevTeamCurrentPoints && !isRegularSeasonFinished && remaining > 0) {
                    canRise = true;
                }
            }

            const cLocked = !canDrop && !canRise;

            // Společné pro Cross-table
            let cThresholdRelegation = 0;
            if (cRelLimit > 0 && cSafeZoneIndex >= 0 && cSafeZoneIndex + 1 < crossGroupTeams.length) {
                cThresholdRelegation = getCrossMaxPotentialOfZone(cSafeZoneIndex + 1);
            }

            let cSafeQF = false;
            let cSafePlayin = false;
            let cRelegated = false;
            let cNeutralLocked = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                // --- STRICT LOGIKA CROSS-TABLE ---
                const cPtsGatekeeperQF = (cQfLimit > 0 && crossGroupTeams[cQfLimit - 1]) ? (crossGroupTeams[cQfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperPlayin = (cTotalAdvancing > 0 && crossGroupTeams[cTotalAdvancing - 1]) ? (crossGroupTeams[cTotalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperSafe = (cSafeZoneIndex >= 0 && crossGroupTeams[cSafeZoneIndex]) ? (crossGroupTeams[cSafeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;

                    if (cTotalAdvancing > 0 && (myPoints > cThresholdPlayin || cTotalAdvancing >= crossGroupTeams.length)) {
                        if (cQfLimit === 0 || myMaxPoints < cPtsGatekeeperQF) cSafePlayin = true;
                    }

                    if (cRelLimit === 0 || myPoints > cThresholdRelegation) {
                        if (cTotalAdvancing === 0 || myMaxPoints < cPtsGatekeeperPlayin) cNeutralLocked = true;
                    }

                    if (cRelLimit > 0 && myMaxPoints < cPtsGatekeeperSafe) cRelegated = true;
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";

            } else {
                // --- KASKÁDOVÁ LOGIKA CROSS-TABLE ---
                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;
                    if (cTotalAdvancing > 0 && myPoints > cThresholdPlayin) cSafePlayin = true;

                    if (cRelLimit > 0 && myPoints > cThresholdRelegation) cNeutralLocked = true;
                    else if (cRelLimit === 0) cNeutralLocked = true;

                    if (cRelLimit > 0 && index > cSafeZoneIndex) {
                        const safetyTarget = crossGroupTeams[cSafeZoneIndex]?.stats?.[selectedSeason]?.points || 0;
                        if (myMaxPoints < safetyTarget) cRelegated = true;
                    }
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
            }

            if (cLocked) rowClass += " locked";

            html += `<tr class="${rowClass}">
                <td class="rank-cell ${currentZone}">${index + 1}.</td>
                <td>${team.name}</td>
                <td class="points numbers">${myPoints}</td>
                <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
                <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
                <td class="numbers">${played}</td>
                <td class="numbers">${stats.wins || 0}</td>
                <td class="numbers">${stats.otWins || 0}</td>
                <td class="numbers">${stats.otLosses || 0}</td>
                <td class="numbers">${stats.losses || 0}</td>
            </tr>`;
        });

        html += `</tbody></table><br>`;
    }

    // --- ZBYTEK STRÁNKY ---
    html += `
</div>
<div id="playoffTablePreview" style="display:none; overflow:auto; max-width:100%;">
<table class="points-table"><tr><th scope="col" id="points-table-header" colspan="20"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Playoff</h2></th></tr>`;
    playoffData.forEach((row) => {
        html += '<tr>';
        row.forEach(cell => {
            const bg = cell.bgColor || '';
            const textColor = cell.textColor || '';
            const styleParts = [];
            if (bg) styleParts.push(`background-color:${bg}`);
            if (textColor) styleParts.push(`color:${textColor}`);
            const styleAttr = styleParts.length ? ` style="${styleParts.join(';')}"` : '';
            html += `<td${styleAttr}>${cell.text || ''}</td>`;
        });
        html += '</tr>';
    });

    const totalMatches = leagueObj.maxMatches; // Celkový počet zápasů v lize (dle nastavení)

    // 1. Zápasy z databáze (matches.json)
    let filledMatches = matches.filter(m => m.result && m.isPlayoff === false && m.liga === selectedLiga && m.season === selectedSeason).length;

    // 2. NOVÉ: Připočítat manuální zápasy
    // (Sečteme manuální zápasy všech týmů a vydělíme 2, protože jeden zápas hrají dva týmy)
    const totalManualGames = teamsInSelectedLiga.reduce((sum, t) => sum + (t.stats?.[selectedSeason]?.manualGames || 0), 0);
    filledMatches += Math.floor(totalManualGames / 2);

    // Výpočet procenta
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
</div>
`;

    if (username) {
        html += `
<section class="user_stats">
<h2>Tvoje statistiky</h2>
 ${currentUserStats ? `
                <p>Správně tipnuto z maximálního počtu všech vyhodnocených zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.total}</strong> 
                    (${(currentUserStats.total > 0 ? (currentUserStats.correct / currentUserStats.total * 100).toFixed(2) : '0.00')} %)
                </p>
                ${currentUserStats.total !== currentUserStats.maxFromTips ? `
                <p>Správně tipnuto z tipovaných zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.maxFromTips}</strong> 
                    (${(currentUserStats.maxFromTips > 0 ? (currentUserStats.correct / currentUserStats.maxFromTips * 100).toFixed(2) : '0.00')} %)
                </p>` : ''}
            ` : `<p>Nemáš pro tuto sezónu/ligu žádná data.</p>`}
${currentUserStats?.tableCorrect > 0 || currentUserStats?.tableDeviation > 0 ? `
<hr>
<h3>Výsledek tipovačky tabulky</h3>
<p>Správně trefených pozic: <strong>${currentUserStats?.tableCorrect}</strong> (bodů)</p>
<p>Celková odchylka v umístění: <strong>${currentUserStats?.tableDeviation}</strong> (menší je lepší)</p>
` : `<p><em>Tipovačka tabulky zatím nebyla vyhodnocena (nebo nemáš žádné body).</em></p>`}
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
                if (b.correct !== a.correct) return b.correct - a.correct;
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
<table style="color: black; font-size: 12px" class="points-table">
<tr style="background-color: #00FF00"><td colspan="3">Za správný tip zápasu v základní části</td><td colspan="3">1 bod</td></tr>
<tr style="background-color: #FF0000"><td colspan="3">Za správný tip vítěze dané série v playoff ale špatný tip počtu vyhraných zápasů</td><td colspan="3">1 bod</td></tr>
<tr style="background-color: #00FF00"><td colspan="3">Za správný tip vítěze dané série v playoff + počet vyhraných zápasů</td><td colspan="3">3 body</td></tr>
<tr style="background-color: #00FF00"><td colspan="3">Za správný tip vítěze zápasu v playoff + správné skóre</td><td colspan="3">5 bodů</td></tr>
<tr style="background-color: #FFFF00"><td colspan="3">Za správný tip vítěze zápasu v playoff + chyba o 1 gól</td><td colspan="3">4 body</td></tr>
<tr style="background-color: #FF6600"><td colspan="3">Za správný tip vítěze zápasu v playoff + chyba o 2 góly</td><td colspan="3">3 body</td></tr>
<tr style="background-color: #FF0000"><td colspan="3">Za správný tip vítěze zápasu v playoff + chyba o 3+ gólů</td><td colspan="3">1 bod</td></tr>
<tr style="background-color: #00FF00"><td colspan="3">Za přesné trefení pozice v konečné tabulce</td><td colspan="3">1 bod</td></tr>
<tr style="background-color: orangered"><td colspan="3">Odchylka tipu tabulky</td><td colspan="3">Sčítá se</td></tr>
</table>
</section>
</section>
</section>
<section class="matches-container">
<h2>Aktuální zápasy k tipování</h2>
<table class="points-table">
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
                const homeTeam = teams.find(t => t.id === match.homeTeamId)?.name || '???';
                const awayTeam = teams.find(t => t.id === match.awayTeamId)?.name || '???';
                const existingTip = userTips.find(t => t.matchId === match.id);
                const selectedWinner = existingTip?.winner;
                const matchStarted = match.postponed ? true : (match.datetime <= currentPragueTimeISO);
                const isPlayoff = match.isPlayoff;

                if (match.postponed) {
                    html += `<tr class="match-row postponed"><td colspan="3"><strong>${homeTeam} vs ${awayTeam}</strong></td></tr>`;
                } else if (!isPlayoff) {
                    html += `<tr class="match-row simple-match-row" data-match-id="${match.id}"><td><button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" data-winner="home" ${matchStarted ? 'disabled' : ''}>${homeTeam}</button></td><td class="vs">vs</td><td><button type="button" class="team-link away-btn ${selectedWinner === "away" ? "selected" : ""}" data-winner="away" ${matchStarted ? 'disabled' : ''}>${awayTeam}</button></td></tr>`;
                } else {
                    const existingLoserWins = existingTip?.loserWins || 0;
                    const bo = match.bo || 7;
                    const maxLoserWins = Math.floor(bo / 2);
                    html += `<tr class="match-row playoff-parent-row" data-match-id="${match.id}"><td><button type="button" class="team-link home-btn ${selectedWinner === "home" ? "selected" : ""}" data-winner="home" ${matchStarted ? 'disabled' : ''}>${homeTeam}</button></td><td class="vs">vs</td><td><button type="button" class="team-link away-btn ${selectedWinner === "away" ? "selected" : ""}" data-winner="away" ${matchStarted ? 'disabled' : ''}>${awayTeam}</button></td></tr>
                    <tr class="match-row loser-row" style="display:${existingTip ? 'table-row' : 'none'}"><td colspan="3"><form class="loserwins-form" onsubmit="return false;" data-bo="${match.bo}"><input type="hidden" name="matchId" value="${match.id}"><input type="hidden" name="winner" value="${existingTip?.winner ?? ''}">${match.bo === 1 ? `Skóre: <input type="number" name="scoreHome" value="${existingTip?.scoreHome ?? ''}" min="0" style="width:50px"> : <input type="number" name="scoreAway" value="${existingTip?.scoreAway ?? ''}" min="0" style="width:50px">` : `Kolik zápasů vyhrál poražený: <select name="loserWins">${Array.from({length: maxLoserWins + 1}, (_, i) => `<option value="${i}" ${i === existingLoserWins ? 'selected' : ''}>${i}</option>`).join('')}</select>`}</form></td></tr>`;
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
btn.addEventListener('click', (e) => { e.preventDefault();
const row = btn.closest('tr'); const matchId = row.dataset.matchId; const winner = btn.dataset.winner;
const homeBtn = row.querySelector('.home-btn'); const awayBtn = row.querySelector('.away-btn');
const nextRow = row.nextElementSibling; let loserRow = null; let loserForm = null;
if (nextRow && nextRow.classList.contains('loser-row')) { loserRow = nextRow; loserForm = loserRow.querySelector('form'); }
if (loserForm) { const wInput = loserForm.querySelector('input[name="winner"]'); if (wInput) wInput.value = winner; }
const formData = new URLSearchParams(); formData.append('matchId', matchId); formData.append('winner', winner);
sendTip(formData, homeBtn, awayBtn, loserRow);
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
    }
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
    const username = req.session.user;
    const selectedLiga = req.query.liga;
    const selectedSeason = req.query.season;

    if (!selectedLiga || !selectedSeason) return res.redirect('/history');

    // 1. NAČTENÍ DAT
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf-8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const teams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf-8'));

    let tableTips = {};
    try {
        tableTips = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8'));
    } catch (e) {
    }
    let allUsers = [];
    try {
        allUsers = JSON.parse(fs.readFileSync('./data/users.json', 'utf-8'));
    } catch (e) {
    }

    // 2. FILTRACE TÝMŮ (Opraveno: Filtruje podle příslušnosti k lize, ne podle zápasů)
    const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);

    // Tady je ta změna: Nebereme ID ze zápasů, ale přímo z definice týmu.
    // Díky tomu se zobrazí i týmy v lize, která nemá žádné zápasy v matches.json (např. MAXA).
    const teamsInSelectedLiga = teams.filter(t => t.liga === selectedLiga && t.active);


    let teamBonusData = {};
    try {
        teamBonusData = JSON.parse(fs.readFileSync('./data/teamBonuses.json', 'utf8'));
    } catch (e) { teamBonusData = {}; }

    teamsInSelectedLiga.forEach(t => {
        // Inicializace, pokud neexistuje
        if (!t.stats) t.stats = {};
        if (!t.stats[selectedSeason]) t.stats[selectedSeason] = { points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0 };

        // Získání reálných bodů ze zápasů
        let naturalPoints = t.stats[selectedSeason].points || 0;

        // Načtení dat z JSONu (ošetření starého formátu vs. nového objektu)
        let bonusEntry = teamBonusData[selectedSeason]?.[selectedLiga]?.[t.id] || { points: 0, games: 0 };
        if (typeof bonusEntry === 'number') bonusEntry = { points: bonusEntry, games: 0 };

        // Aplikace bodů (přičteme k existujícím)
        t.stats[selectedSeason].points = naturalPoints + (bonusEntry.points || 0);

        // Uložení manuálních zápasů do dočasné proměnné (použijeme později u played a progress baru)
        t.stats[selectedSeason].manualGames = bonusEntry.games || 0;
    });
    // =================================================================


    // 3. VÝPOČET REÁLNÉ TABULKY (Potřeba pro statistiky)
    const scores = {};
    // --- NAČTENÍ NASTAVENÍ VIZUÁLU (STRICT vs CASCADE) ---
    // --- NAČTENÍ NASTAVENÍ VIZUÁLU (STRICT vs CASCADE) ---
    let clinchMode = 'strict'; // Výchozí hard-kódovaný stav

    // 1. Zkusíme načíst globální výchozí nastavení z Adminu
    try {
        const settingsData = JSON.parse(fs.readFileSync('./data/settings.json', 'utf8'));
        if (settingsData.clinchMode) clinchMode = settingsData.clinchMode;
    } catch (e) {}

    // 2. Pokud uživatel kliknul na přepínač na stránce, uložíme mu to do jeho relace
    if (req.query.mode === 'strict' || req.query.mode === 'cascade') {
        req.session.userClinchMode = req.query.mode;
    }

    // 3. Pokud má uživatel ve své relaci už něco vybráno, přebije to to globální nastavení
    if (req.session && req.session.userClinchMode) {
        clinchMode = req.session.userClinchMode;
    }

    teamsInSelectedLiga.forEach(t => scores[t.id] = {points: 0, gf: 0, ga: 0});
    matchesInLiga.forEach(m => {
        if (m.result) {
            const sH = parseInt(m.result.scoreHome);
            const sA = parseInt(m.result.scoreAway);
            scores[m.homeTeamId].gf += sH;
            scores[m.homeTeamId].ga += sA;
            scores[m.awayTeamId].gf += sA;
            scores[m.awayTeamId].ga += sH;
            if (m.result.ot) {
                if (sH > sA) {
                    scores[m.homeTeamId].points += 2;
                    scores[m.awayTeamId].points += 1;
                } else {
                    scores[m.awayTeamId].points += 2;
                    scores[m.homeTeamId].points += 1;
                }
            } else {
                if (sH > sA) scores[m.homeTeamId].points += 3; else if (sA > sH) scores[m.awayTeamId].points += 3; else {
                    scores[m.homeTeamId].points += 1;
                    scores[m.awayTeamId].points += 1;
                }
            }
        }
    });

    const leagueObj = (allSeasonData[selectedSeason]?.leagues || []).find(l => l.name === selectedLiga) || {isMultigroup: false};
    const teamsByGroup = {};
    teamsInSelectedLiga.forEach(team => {
        const group = team.group ? String.fromCharCode(team.group + 64) : 'X';
        if (!teamsByGroup[group]) teamsByGroup[group] = [];
        teamsByGroup[group].push(team);
    });
    const sortedGroupKeys = Object.keys(teamsByGroup).sort((a, b) => (a === 'default' ? -1 : parseInt(a) - parseInt(b)));

    const realRankMaps = {};
    for (const gKey of sortedGroupKeys) {
        const groupTeams = [...teamsByGroup[gKey]];
        groupTeams.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points !== undefined ? aStats.points : scores[a.id].points;
            const pB = bStats.points !== undefined ? bStats.points : scores[b.id].points;
            if (pB !== pA) return pB - pA;
            const sA = scores[a.id];
            const sB = scores[b.id];
            return (sB.gf - sB.ga) - (sA.gf - sA.ga);
        });
        realRankMaps[gKey] = {};
        groupTeams.forEach((t, i) => {
            realRankMaps[gKey][t.id] = i + 1;
        });
    }

    // 4. VÝPOČET STATISTIK (Abychom měli data pro ten vzhled)
    const userStats = allUsers
        .filter(u => {
            const stats = u.stats?.[selectedSeason]?.[selectedLiga];
            const tips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
            return (stats && (stats.totalRegular > 0 || stats.totalPlayoff > 0 || stats.tableCorrect !== undefined)) || tips.length > 0;
        })
        .map(u => {
            const stats = u.stats?.[selectedSeason]?.[selectedLiga] || {};
            const userTips = u.tips?.[selectedSeason]?.[selectedLiga] || [];

            // Výpočet tabulky (pokud chybí v DB)
            let tCorrect = stats.tableCorrect || 0;
            let tDeviation = stats.tableDeviation || 0;
            if (tCorrect === 0 && tDeviation === 0) {
                const userTableTip = tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username];
                if (userTableTip) {
                    for (const gKey of sortedGroupKeys) {
                        let tipIds = Array.isArray(userTableTip) ? userTableTip : (userTableTip[gKey] || []);
                        tipIds.forEach((tid, idx) => {
                            const realRank = realRankMaps[gKey][tid];
                            if (realRank) {
                                const diff = Math.abs((idx + 1) - realRank);
                                tDeviation += diff;
                                if (diff === 0) tCorrect++;
                            }
                        });
                    }
                }
            }

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
                tableCorrect: tCorrect,
                tableDeviation: tDeviation
            };
        });

    const usersWithTips = allUsers.filter(u => u.tips?.[selectedSeason]?.[selectedLiga]?.length > 0).sort((a, b) => a.username.localeCompare(b.username));
    const initialUser = usersWithTips.find(u => u.username === username) ? username : (usersWithTips[0]?.username || "");
    const currentUserStats = userStats.find(u => u.username === username); // Používáme přihlášeného pro "Tvoje statistiky"

    let playoffData = [];
    try {
        const raw = fs.readFileSync(path.join(__dirname, '../data/playoff.json'), 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) playoffData = allPlayoffs[selectedSeason][selectedLiga];
    } catch (e) {
    }

    const sortedGroups = Object.keys(teamsByGroup).sort();

    let isRegularSeasonFinished = false;
    try {
        const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
        isRegularSeasonFinished = statusData?.[selectedSeason]?.[selectedLiga]?.regularSeasonFinished || false;
    } catch (e) {
    }
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
<main class="main_page">
<section class="stats-container">
<div class="left-panel">
<div style="display: flex; flex-direction: row; justify-content: space-around; margin:20px 0; text-align:center;">
<button style="cursor: pointer; border: none; color: orangered; background-color: black" class="history-btn" onclick="showTable('regular')">Základní část</button>
<button style="cursor: pointer; border: none; color: orangered; background-color: black" class="history-btn" onclick="showTable('playoff')">Playoff</button>
</div>
<div id="regularTable">
`;

    html += `
    <div style="display: flex; justify-content: flex-start; align-items: center; margin-bottom: 10px; gap: 10px;">
        <span style="color: gray; font-size: 0.85em;">Logika obarvování:</span>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=strict" 
           style="${clinchMode === 'strict' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Striktní (Jistá meta)
        </a>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=cascade" 
           style="${clinchMode === 'cascade' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Kaskádová (Minimální meta)
        </a>
    </div>
    `;

    const crossGroupTeams = [];

    // --- ZPRACOVÁNÍ TABULEK ---
    for (const group of sortedGroups) {
        const teamsInGroup = teamsByGroup[group];
        const zoneConfig = getLeagueZones(leagueObj);

        // =========================================================
        // === IIHF SORTING (FIX: IGNOROVAT PLAYOFF) ===
        // =========================================================
        teamsInGroup.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;

            // 1. Kritérium: BODY
            if (pB !== pA) return pB - pA;

            // --- MINITABULKA ---
            // Najdeme týmy se stejným počtem bodů
            const tiedTeamIds = teamsInGroup
                .filter(t => (t.stats?.[selectedSeason]?.points || 0) === pA)
                .map(t => Number(t.id));

            // Funkce pro minitabulku
            const getMiniStats = (teamId) => {
                let mPts = 0, mDiff = 0, mGF = 0;

                // FILTR: Jen tato sezóna, výsledek existuje, tým hraje A HLAVNĚ !isPlayoff
                const groupMatches = matches.filter(m =>
                    m.season === selectedSeason &&
                    m.result &&
                    !m.isPlayoff && // <--- TOTO JE TA OPRAVA!
                    tiedTeamIds.includes(Number(m.homeTeamId)) &&
                    tiedTeamIds.includes(Number(m.awayTeamId)) &&
                    (Number(m.homeTeamId) === teamId || Number(m.awayTeamId) === teamId)
                );

                groupMatches.forEach(m => {
                    const isHome = Number(m.homeTeamId) === teamId;

                    let sH = m.result?.scoreHome !== undefined ? Number(m.result.scoreHome) : (m.scoreHome !== undefined ? Number(m.scoreHome) : 0);
                    let sA = m.result?.scoreAway !== undefined ? Number(m.result.scoreAway) : (m.scoreAway !== undefined ? Number(m.scoreAway) : 0);
                    const isOt = m.result?.ot || m.ot;

                    let hPts, aPts;
                    if (sH > sA) { hPts = isOt ? 2 : 3; aPts = isOt ? 1 : 0; }
                    else if (sA > sH) { aPts = isOt ? 2 : 3; hPts = isOt ? 1 : 0; }
                    else { hPts=1; aPts=1; }

                    let pts, gf, ga;
                    if (isHome) { pts = hPts; gf = sH; ga = sA; }
                    else { pts = aPts; gf = sA; ga = sH; }

                    mPts += pts;
                    mDiff += (gf - ga);
                    mGF += gf;
                });

                return { pts: mPts, diff: mDiff, gf: mGF };
            };

            const msA = getMiniStats(Number(a.id));
            const msB = getMiniStats(Number(b.id));

            // 2. Kritérium: BODY V MINITABULCE
            if (msB.pts !== msA.pts) return msB.pts - msA.pts;

            // 3. Kritérium: ROZDÍL SKÓRE V MINITABULCE
            if (msB.diff !== msA.diff) return msB.diff - msA.diff;

            // 4. Kritérium: GÓLY V MINITABULCE
            if (msB.gf !== msA.gf) return msB.gf - msA.gf;

            // 5. Kritérium: PŘÍMÝ VZÁJEMNÝ ZÁPAS (Head-to-Head)
            const directMatch = matches.find(m =>
                m.season === selectedSeason &&
                m.result &&
                !m.isPlayoff && // <--- TOTO JE TA OPRAVA!
                ((Number(m.homeTeamId) === Number(a.id) && Number(m.awayTeamId) === Number(b.id)) ||
                    (Number(m.homeTeamId) === Number(b.id) && Number(m.awayTeamId) === Number(a.id)))
            );

            if (directMatch) {
                const isAHome = Number(directMatch.homeTeamId) === Number(a.id);
                let sH = directMatch.result?.scoreHome ?? directMatch.scoreHome ?? 0;
                let sA = directMatch.result?.scoreAway ?? directMatch.scoreAway ?? 0;

                if (isAHome) {
                    if (sH > sA) return -1;
                    if (sA > sH) return 1;
                } else {
                    if (sA > sH) return -1;
                    if (sH > sA) return 1;
                }
            }

            // 6. Kritérium: CELKOVÉ SKÓRE
            const sA = scores[a.id] || {gf:0, ga:0};
            const sB = scores[b.id] || {gf:0, ga:0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;

            return 0;
        });

        // --- ULOŽENÍ TÝMU DO CROSS-TABLE (POKUD JE ZAPNUTO) ---
        if (leagueObj.crossGroupTable && leagueObj.crossGroupPosition > 0) {
            const targetIndex = leagueObj.crossGroupPosition - 1;
            if (teamsInGroup[targetIndex]) {
                crossGroupTeams.push(teamsInGroup[targetIndex]);
            }
        }

        html += `
<table class="points-table">
<thead>
<tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část ${leagueObj?.isMultigroup ? `(Skupina ${group})` : ''}</h2></th></tr>
<tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
</thead>
<tbody>`;

        const sorted = teamsInGroup;

        // --- VÝPOČET ZÁPASŮ ---
        let matchesPerTeam;
        if (leagueObj.isMultigroup) {
            matchesPerTeam = Math.max(1, teamsInGroup.length - 1);
        } else {
            matchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInGroup.length);
        }

        //console.log(`\n=== DEBUG SKUPINA ${group} ===`);
        //console.log(`MatchesPerTeam vypočteno jako: ${matchesPerTeam}`);

        // --- ZÓNY A LIMITY ---
        const qfLimit = leagueObj.quarterfinal || 0;
        const playinLimit = leagueObj.playin || 0;
        const relegationLimit = leagueObj.relegation || 0;

        // Celkový počet postupujících (QF + Předkolo dohromady)
        const totalAdvancing = playinLimit;

        // Index, od kterého začíná sestupová zóna
        const safeZoneIndex = sorted.length - relegationLimit - 1;

        // Funkce pro zjištění maxima bodů, které může získat kdokoliv OD určité pozice dolů
        const getMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            // Pokud index je mimo tabulku, vracíme 0
            if (fromIndex >= sorted.length) return 0;

            for (let i = fromIndex; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const played = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
                const remaining = Math.max(0, matchesPerTeam - played);
                const potential = (s.points || 0) + (remaining * 3);
                if (potential > globalMax) globalMax = potential;
            }
            return globalMax;
        };

        // 1. Práh pro QF: Kolik bodů může max. získat ten nejlepší tým, co by skončil POD čarou QF?
        const thresholdQF = getMaxPotentialOfZone(qfLimit);

        // 2. Práh pro Postup (Předkolo): Kolik bodů může max. získat ten nejlepší tým, co by nepostoupil VŮBEC?
        const thresholdPlayin = getMaxPotentialOfZone(totalAdvancing);

        //console.log(`Thresholds: QF > ${thresholdQF}, Playin > ${thresholdPlayin}`);

        let safetyPoints = 0;
        if (relegationLimit > 0 && safeZoneIndex >= 0 && sorted.length > safeZoneIndex) {
            safetyPoints = sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0;
            //console.log(`SafetyPoints (Relegation threshold): ${safetyPoints} (Tým na indexu ${safeZoneIndex})`);
        }

        teamsInGroup.forEach((team, index) => {
            const currentZone = getTeamZone(index, teamsInGroup.length, zoneConfig);
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins||0) + (stats.otWins||0) + (stats.otLosses||0) + (stats.losses||0) + (stats.manualGames || 0);
            const remaining = Math.max(0, matchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);

            //console.log(`--- TEAM: ${team.name} (${index + 1}.) ---`);
            //console.log(`   Pts: ${myPoints}, Played: ${played}, Remaining: ${remaining}, MaxPts: ${myMaxPoints}`);

            // --- STRICT LOCK LOGIKA (Tvoje verze - funguje správně) ---
            let canDrop = false;
            for (let i = index + 1; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const p = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
                const rem = Math.max(0, matchesPerTeam - p);
                const chaserMax = (s.points || 0) + (rem * 3);

                // 1. Pokud mě může předběhnout na ČISTÉ BODY -> nejsem Locked
                if (chaserMax > myPoints) {
                    canDrop = true;
                    break;
                }

                // 2. Pokud mě může DOROVNAT na body a ještě se hraje
                if (chaserMax === myPoints) {
                    if (rem > 0 || remaining > 0) {
                        canDrop = true;
                        break;
                    }
                }
            }

            let canRise = false;
            if (index > 0) {
                const leader = sorted[index - 1];
                const leaderStats = leader.stats?.[selectedSeason] || {};
                const leaderPoints = leaderStats.points || 0;
                const pL = (leaderStats.wins||0)+(leaderStats.otWins||0)+(leaderStats.otLosses||0)+(leaderStats.losses||0);
                const remL = Math.max(0, matchesPerTeam - pL);

                if (myMaxPoints > leaderPoints) {
                    canRise = true;
                }
                else if (myMaxPoints === leaderPoints) {
                    if (remaining > 0 || remL > 0) {
                        canRise = true;
                    }
                }
            }

            const locked = !canDrop && !canRise;
            //console.log(`   Logic: CanDrop=${canDrop}, CanRise=${canRise} => LOCKED=${locked}`);

            // Společné proměnné pro obě logiky
            let thresholdRelegation = 0;
            if (relegationLimit > 0 && safeZoneIndex >= 0 && safeZoneIndex + 1 < sorted.length) {
                thresholdRelegation = getMaxPotentialOfZone(safeZoneIndex + 1);
            }

            let clinchedQF = false;
            let clinchedPlayin = false;
            let clinchedRelegation = false;
            let clinchedNeutral = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                // =========================================================
                // LOGIKA 1: STRIKTNÍ ZAMYKÁNÍ (Uvěznění v daném patře)
                // =========================================================
                const ptsGatekeeperQF = (qfLimit > 0 && sorted[qfLimit - 1]) ? (sorted[qfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperPlayin = (totalAdvancing > 0 && sorted[totalAdvancing - 1]) ? (sorted[totalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperSafe = (safeZoneIndex >= 0 && sorted[safeZoneIndex]) ? (sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;

                    if (totalAdvancing > 0 && (myPoints > thresholdPlayin || totalAdvancing >= sorted.length)) {
                        if (qfLimit === 0 || myMaxPoints < ptsGatekeeperQF) clinchedPlayin = true;
                    }

                    if (relegationLimit === 0 || myPoints > thresholdRelegation) {
                        if (totalAdvancing === 0 || myMaxPoints < ptsGatekeeperPlayin) clinchedNeutral = true;
                    }

                    if (relegationLimit > 0 && myMaxPoints < ptsGatekeeperSafe) clinchedRelegation = true;
                }

                // Třídy pro Strict
                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';

            } else {
                // =========================================================
                // LOGIKA 2: KASKÁDA (Nejvyšší dosažená meta)
                // =========================================================
                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;
                    if (totalAdvancing > 0 && myPoints > thresholdPlayin || totalAdvancing >= sorted.length) clinchedPlayin = true;

                    if (relegationLimit > 0 && myPoints > thresholdRelegation) clinchedNeutral = true;
                    else if (relegationLimit === 0) clinchedNeutral = true;

                    if (relegationLimit > 0 && index > safeZoneIndex && myMaxPoints < safetyPoints) clinchedRelegation = true;
                }

                // Třídy pro Kaskádu
                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
            }

            // Aplikace Cross-table a Locked
            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition && locked) {
                rowClass = 'clinched-crosstable';
            }
            if (locked) rowClass += ' locked';

            //console.log(`   Final Class: ${rowClass}`);

            let rankClass = currentZone;
            const teamStats = scores[team.id] || {gf: 0, ga: 0};
            const goalDiff = teamStats.gf - teamStats.ga;

            // --- SPECIÁLNÍ PODBARVENÍ PRO CROSS-TABLE RANK ---

            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition) {
                rankClass = 'crosstable';
            }

            html += `<tr class="${rowClass}">
<td class="rank-cell ${rankClass}">${index + 1}.</td>
<td>${team.name}</td>
<td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td>
<td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
<td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
<td class="numbers">${played}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td>
</tr>`;
        });
        html += `</tbody></table><br>`;
    }

    // =========================================================
    // === TABULKA X-TÝCH TÝMŮ (S OPRAVENÝM LOCKOVÁNÍM) ===
    // =========================================================
    if (leagueObj.crossGroupTable && crossGroupTeams.length > 0) {

        const crossConfig = leagueObj.crossGroupConfig || { quarterfinal: 0, playin: 0, relegation: 0 };

        html += `<h2 style="text-align: center; margin-top: 30px; border-top: 2px solid #444; padding-top: 20px;">Tabulka týmů na ${leagueObj.crossGroupPosition}. místě</h2>`;

        // 1. Seřazení týmů
        crossGroupTeams.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;
            if (pB !== pA) return pB - pA;

            const sA = scores[a.id] || {gf:0, ga:0};
            const sB = scores[b.id] || {gf:0, ga:0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;
            if (sA.gf !== sB.gf) return sB.gf - sA.gf;
            return 0;
        });

        html += `
        <table class="points-table">
        <thead>
        <tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
        </thead>
        <tbody>`;

        // 2. Limity pro Cross-Table
        const cQfLimit = crossConfig.quarterfinal || 0;
        const cPlayinLimit = crossConfig.playin || 0;
        const cRelLimit = crossConfig.relegation || 0;

        let cTotalAdvancing = 0;
        if (cPlayinLimit > 0) cTotalAdvancing = cPlayinLimit;
        else cTotalAdvancing = cQfLimit;
        cTotalAdvancing = Math.min(cTotalAdvancing, crossGroupTeams.length);

        const cSafeZoneIndex = crossGroupTeams.length - cRelLimit - 1;

        // 3. SPRÁVNÝ VÝPOČET ZÁPASŮ (Stejný jako v horních tabulkách)
        // Toto zajistí, že systém ví, že po 2 zápasech je konec a má zamknout.
        let cMatchesPerTeam = 52;
        if (leagueObj.isMultigroup) {
            // Pokud je to multigroup bez rounds, bývá to "každý s každým" ve skupině
            const estimatedGroupSize = teamsInSelectedLiga.length / (leagueObj.groupCount || 1);
            cMatchesPerTeam = Math.max(1, Math.ceil(estimatedGroupSize) - 1);
        } else if (leagueObj.maxMatches) {
            // Pokud je natvrdo nastaven maxMatches
            if (leagueObj.maxMatches > 100) {
                cMatchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInSelectedLiga.length);
            } else {
                cMatchesPerTeam = leagueObj.maxMatches;
            }
        }

        // 4. Pomocné funkce pro potenciál (s opraveným počtem zápasů)
        const getCrossTeamPotential = (idx) => {
            if (idx >= crossGroupTeams.length) return 0;
            const t = crossGroupTeams[idx];
            const s = t.stats?.[selectedSeason] || {};
            const played = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);

            if (isRegularSeasonFinished) return s.points || 0;

            const remaining = Math.max(0, cMatchesPerTeam - played);
            return (s.points || 0) + (remaining * 3);
        };

        const getCrossMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            if (fromIndex >= crossGroupTeams.length) return 0;
            for (let i = fromIndex; i < crossGroupTeams.length; i++) {
                globalMax = Math.max(globalMax, getCrossTeamPotential(i));
            }
            return globalMax;
        };

        // Thresholdy
        let cThresholdQF = 0;
        if (cQfLimit > 0 && cQfLimit < crossGroupTeams.length) {
            cThresholdQF = getCrossMaxPotentialOfZone(cQfLimit);
        }

        let cThresholdPlayin = 0;
        if (cTotalAdvancing > 0 && cTotalAdvancing < crossGroupTeams.length) {
            cThresholdPlayin = getCrossMaxPotentialOfZone(cTotalAdvancing);
        }

        // 5. Hlavní cyklus
        crossGroupTeams.forEach((team, index) => {
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins||0) + (stats.otWins||0) + (stats.otLosses||0) + (stats.losses||0) + (stats.manualGames || 0);

            // Určení základní Zóny
            let currentZone = "neutral";
            if (cRelLimit > 0 && index > cSafeZoneIndex) currentZone = "relegation";
            else if (cQfLimit > 0 && index < cQfLimit) currentZone = "quarterfinal";
            else if (cTotalAdvancing > 0 && index < cTotalAdvancing) currentZone = "playin";

            const remaining = Math.max(0, cMatchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);
            const teamStats = scores[team.id] || {gf:0, ga:0};
            const goalDiff = teamStats.gf - teamStats.ga;

            // --- STRICT LOCK LOGIKA ---
            let canDrop = false;
            for (let i = index + 1; i < crossGroupTeams.length; i++) {
                const chaserMax = getCrossTeamPotential(i);
                if (chaserMax > myPoints) { canDrop = true; break; }
                const chaserPlayed = (crossGroupTeams[i].stats?.[selectedSeason]?.wins||0) + (crossGroupTeams[i].stats?.[selectedSeason]?.losses||0);

                // Opravená podmínka pro konec zápasů
                if (chaserMax === myPoints && !isRegularSeasonFinished && (remaining > 0 || chaserPlayed < cMatchesPerTeam)) {
                    canDrop = true; break;
                }
            }

            let canRise = false;
            if (index > 0) {
                const prevTeamCurrentPoints = crossGroupTeams[index - 1].stats?.[selectedSeason]?.points || 0;
                if (myMaxPoints > prevTeamCurrentPoints) canRise = true;
                if (myMaxPoints === prevTeamCurrentPoints && !isRegularSeasonFinished && remaining > 0) {
                    canRise = true;
                }
            }

            const cLocked = !canDrop && !canRise;

            // Společné pro Cross-table
            let cThresholdRelegation = 0;
            if (cRelLimit > 0 && cSafeZoneIndex >= 0 && cSafeZoneIndex + 1 < crossGroupTeams.length) {
                cThresholdRelegation = getCrossMaxPotentialOfZone(cSafeZoneIndex + 1);
            }

            let cSafeQF = false;
            let cSafePlayin = false;
            let cRelegated = false;
            let cNeutralLocked = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                // --- STRICT LOGIKA CROSS-TABLE ---
                const cPtsGatekeeperQF = (cQfLimit > 0 && crossGroupTeams[cQfLimit - 1]) ? (crossGroupTeams[cQfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperPlayin = (cTotalAdvancing > 0 && crossGroupTeams[cTotalAdvancing - 1]) ? (crossGroupTeams[cTotalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperSafe = (cSafeZoneIndex >= 0 && crossGroupTeams[cSafeZoneIndex]) ? (crossGroupTeams[cSafeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;

                    if (cTotalAdvancing > 0 && (myPoints > cThresholdPlayin || cTotalAdvancing >= crossGroupTeams.length)) {
                        if (cQfLimit === 0 || myMaxPoints < cPtsGatekeeperQF) cSafePlayin = true;
                    }

                    if (cRelLimit === 0 || myPoints > cThresholdRelegation) {
                        if (cTotalAdvancing === 0 || myMaxPoints < cPtsGatekeeperPlayin) cNeutralLocked = true;
                    }

                    if (cRelLimit > 0 && myMaxPoints < cPtsGatekeeperSafe) cRelegated = true;
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";

            } else {
                // --- KASKÁDOVÁ LOGIKA CROSS-TABLE ---
                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;
                    if (cTotalAdvancing > 0 && myPoints > cThresholdPlayin) cSafePlayin = true;

                    if (cRelLimit > 0 && myPoints > cThresholdRelegation) cNeutralLocked = true;
                    else if (cRelLimit === 0) cNeutralLocked = true;

                    if (cRelLimit > 0 && index > cSafeZoneIndex) {
                        const safetyTarget = crossGroupTeams[cSafeZoneIndex]?.stats?.[selectedSeason]?.points || 0;
                        if (myMaxPoints < safetyTarget) cRelegated = true;
                    }
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
            }

            if (cLocked) rowClass += " locked";

            html += `<tr class="${rowClass}">
                <td class="rank-cell ${currentZone}">${index + 1}.</td>
                <td>${team.name}</td>
                <td class="points numbers">${myPoints}</td>
                <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
                <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
                <td class="numbers">${played}</td>
                <td class="numbers">${stats.wins || 0}</td>
                <td class="numbers">${stats.otWins || 0}</td>
                <td class="numbers">${stats.otLosses || 0}</td>
                <td class="numbers">${stats.losses || 0}</td>
            </tr>`;
        });

        html += `</tbody></table><br>`;
    }
    html += `</div><div id="playoffTablePreview" style="display:none; overflow:auto; max-width:100%;"><table class="points-table"><tr><th scope="col" id="points-table-header" colspan="20"><h2>Týmy - Playoff</h2></th></tr>`;
    playoffData.forEach((row) => {
        html += '<tr>';
        row.forEach(cell => {
            const bg = cell.bgColor ? ` style="background-color:${cell.bgColor}; color:${cell.textColor}"` : '';
            const txt = cell.text || '';
            html += `<td${bg}>${txt}</td>`;
        });
        html += '</tr>';
    });
    html += `</table></div>
<script>
    function showTable(which) { 
        document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none'; 
        const p = document.getElementById('playoffTablePreview'); p.style.display = which === 'playoff' ? 'block' : 'none'; 
    }
</script>`;

    // --- ZDE JE TA VLOŽENÁ LEVÁ STRANA Z ROUTY / ---
    if (username) {
        html += `
        <section class="user_stats">
            <h2>Tvoje statistiky</h2>
            ${currentUserStats ? `
                <p>Správně tipnuto z maximálního počtu všech vyhodnocených zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.total}</strong> 
                    (${(currentUserStats.total > 0 ? (currentUserStats.correct / currentUserStats.total * 100).toFixed(2) : '0.00')} %)
                </p>
                ${currentUserStats.total !== currentUserStats.maxFromTips ? `
                <p>Správně tipnuto z tipovaných zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.maxFromTips}</strong> 
                    (${(currentUserStats.maxFromTips > 0 ? (currentUserStats.correct / currentUserStats.maxFromTips * 100).toFixed(2) : '0.00')} %)
                </p>` : ''}
            ` : `<p>Nemáš pro tuto sezónu/ligu žádná data.</p>`}
            
            ${(currentUserStats && (currentUserStats.tableCorrect > 0 || currentUserStats.tableDeviation > 0)) ? `
            <hr>
            <h3>Výsledek tipovačky tabulky</h3>
            <p>Správně trefených pozic: <strong>${currentUserStats.tableCorrect}</strong> (bodů)</p>
            <p>Celková odchylka v umístění: <strong>${currentUserStats.tableDeviation}</strong> (menší je lepší)</p>
            ` : `<p><em>Tipovačka tabulky nebyla pro tebe vyhodnocena.</em></p>`}
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
        let isRegularSeasonFinished = false;
        try {
            const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
            isRegularSeasonFinished = statusData?.[selectedSeason]?.[selectedLiga]?.regularSeasonFinished || false;
        } catch (e) {
        }
        const statusStyle = isRegularSeasonFinished ? "color: lightgrey; font-weight: bold;" : "color: white; opacity: 0.7; background-color: black";
        userStats.sort((a, b) => {
            if (b.correct !== a.correct) return b.correct - a.correct;
            return a.maxFromTips - b.maxFromTips;
        }).forEach((user, index) => {
            const successRate = user.total > 0 ? ((user.correct / user.total) * 100).toFixed(2) : '0.00';
            const successRateOverall = user.maxFromTips > 0 ? ((user.correct / user.maxFromTips) * 100).toFixed(2) : '0.00';
            html += `<tr>
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
        html += `</tbody></table><br>
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
        </section></section>`;
    }
    html += `</div>`; // KONEC LEVÉ STRANY

    // --- PRAVÁ STRANA: ZÁPASY ---
    html += `
        <script>
        const globalStatsData = ${JSON.stringify(userStats)};
        function showUserHistory(username) {
            document.querySelectorAll('.history-item').forEach(el => el.style.display = 'none');
            const safeName = username.replace(/[^a-zA-Z0-9]/g, '_');
            document.querySelectorAll('.user-' + safeName).forEach(el => el.style.display = 'flex');
        }
        </script>
        <section class="matches-container">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                <h2 style="margin: 0;">Historie tipů</h2>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label for="historyUserSelect" style="color: lightgrey;">Zobrazit:</label>
                    <select id="historyUserSelect" onchange="showUserHistory(this.value)" style="background-color: black; color: orangered; border: 1px solid orangered; padding: 5px; border-radius: 5px;">`;

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

    // (ZBYTEK KÓDU PRO ZÁPASY ZŮSTÁVÁ)
    const groupedMatches = matches
        .filter(m => m.liga === selectedLiga && m.result && m.season === selectedSeason)
        .sort((a, b) => new Date(b.datetime) - new Date(a.datetime))
        .reduce((groups, match) => {
            const dateTime = match.datetime || match.date || "Neznámý čas";
            if (!groups[dateTime]) groups[dateTime] = [];
            groups[dateTime].push(match);
            return groups;
        }, {});

    const renderUserTip = (u, match, type) => {
        const userTip = u.tips?.[selectedSeason]?.[selectedLiga]?.find(t => t.matchId === match.id);
        const selectedWinner = userTip?.winner;
        const bo = match.bo || 5;
        const visibilityStyle = u.username === initialUser ? '' : 'display:none;';
        const userClass = `history-item user-${u.username.replace(/[^a-zA-Z0-9]/g, '_')}`;

        if (type === 'home' || type === 'away') {
            const teamName = type === 'home' ? (teams.find(t => t.id === match.homeTeamId)?.name || '???') : (teams.find(t => t.id === match.awayTeamId)?.name || '???');
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
                    const totalDiff = Math.abs(tH - match.result.scoreHome) + Math.abs(tA - match.result.scoreAway);
                    let sc;
                    if (totalDiff === 0) {
                        sc = 'exact-score';    // Přesný výsledek (zelená)
                    } else if (totalDiff === 1) {
                        sc = 'diff-1';         // Chyba o 1 gól (žlutá)
                    } else if (totalDiff === 2) {
                        sc = 'diff-2';         // Chyba o 2 góly (oranžová)
                    } else {
                        sc = 'diff-3plus';     // Chyba o 3 a více gólů (červená)
                    }
                    return `<div class="${userClass} team-link-history ${sc}" style="${visibilityStyle}">${tH} : ${tA}</div>`;
                } else {
                    return `<div class="${userClass} team-link-history right-selected" style="${visibilityStyle}">${userTip?.loserWins ?? '-'}</div>`;
                }
            }
            return `<div class="${userClass}" style="${visibilityStyle}">-</div>`;
        }
        return '';
    };

    for (const [dateTime, matchesAtSameTime] of Object.entries(groupedMatches)) {
        const formattedDateTime = new Date(dateTime).toLocaleString('cs-CZ', {
            day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        html += `<h3>${formattedDateTime}</h3><table class="matches-table"><thead class="matches-table-header"><tr><th colSpan="6">Zápasy</th></tr></thead><tbody>`;
        for (const match of matchesAtSameTime) {
            let homeCellHTML = "", awayCellHTML = "", scoreCellHTML = "";
            usersWithTips.forEach(u => {
                homeCellHTML += renderUserTip(u, match, 'home');
                awayCellHTML += renderUserTip(u, match, 'away');
                if (match.isPlayoff) scoreCellHTML += renderUserTip(u, match, 'score');
            });
            if (!match.isPlayoff) {
                html += `<tr class="match-row"><td class="match-row">${homeCellHTML}</td><td class="vs">${match.result.scoreHome}</td><td class="vs">${match.result.ot === true ? "pp/sn" : ":"}</td><td class="vs">${match.result.scoreAway}</td><td class="match-row">${awayCellHTML}</td></tr>`;
            } else {
                html += `<tr class="match-row"><td>${homeCellHTML}</td><td class="vs">${match.result.scoreHome}</td><td class="vs">vs</td><td class="vs">${match.result.scoreAway}</td><td>${awayCellHTML}</td></tr><tr class="match-row"><td style="color: black" colspan="5">${scoreCellHTML}</td></tr>`;
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
router.get('/history/table', requireLogin, (req, res) => {
    const username = req.session.user;
    const selectedLiga = req.query.liga;
    const selectedSeason = req.query.season;

    if (!selectedLiga || !selectedSeason) return res.redirect('/history');

    // 1. NAČTENÍ DAT
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf-8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const teams = JSON.parse(fs.readFileSync('./data/teams.json', 'utf-8'));
    let tableTips = {};
    try {
        tableTips = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8'));
    } catch (e) {
    }
    let allUsers = [];
    try {
        allUsers = JSON.parse(fs.readFileSync('./data/users.json', 'utf-8'));
    } catch (e) {
    }

    // 2. FILTRACE TÝMŮ A ZÁPASŮ
    const teamsInSelectedLiga = teams.filter(t => t.liga === selectedLiga && t.active);
    const matchesInLiga = matches.filter(m => m.season === selectedSeason && m.liga === selectedLiga);

    let teamBonusData = {};
    try {
        teamBonusData = JSON.parse(fs.readFileSync('./data/teamBonuses.json', 'utf8'));
    } catch (e) { teamBonusData = {}; }

    teamsInSelectedLiga.forEach(t => {
        if (!t.stats) t.stats = {};
        if (!t.stats[selectedSeason]) t.stats[selectedSeason] = { points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0 };

        let naturalPoints = t.stats[selectedSeason].points || 0;
        let bonusEntry = teamBonusData[selectedSeason]?.[selectedLiga]?.[t.id] || { points: 0, games: 0 };
        if (typeof bonusEntry === 'number') bonusEntry = { points: bonusEntry, games: 0 };

        t.stats[selectedSeason].points = naturalPoints + (bonusEntry.points || 0);
        t.stats[selectedSeason].manualGames = bonusEntry.games || 0;
    });

    // 3. VÝPOČET REÁLNÉ TABULKY
    const scores = {};
    // --- NAČTENÍ NASTAVENÍ VIZUÁLU (STRICT vs CASCADE) ---
    let clinchMode = 'strict'; // Výchozí hard-kódovaný stav

    // 1. Zkusíme načíst globální výchozí nastavení z Adminu
    try {
        const settingsData = JSON.parse(fs.readFileSync('./data/settings.json', 'utf8'));
        if (settingsData.clinchMode) clinchMode = settingsData.clinchMode;
    } catch (e) {}

    // 2. Pokud uživatel kliknul na přepínač na stránce, uložíme mu to do jeho relace
    if (req.query.mode === 'strict' || req.query.mode === 'cascade') {
        req.session.userClinchMode = req.query.mode;
    }

    // 3. Pokud má uživatel ve své relaci už něco vybráno, přebije to to globální nastavení
    if (req.session && req.session.userClinchMode) {
        clinchMode = req.session.userClinchMode;
    }

    teamsInSelectedLiga.forEach(t => scores[t.id] = {points: 0, gf: 0, ga: 0});
    matchesInLiga.forEach(m => {
        if (m.result) {
            const sH = parseInt(m.result.scoreHome);
            const sA = parseInt(m.result.scoreAway);
            scores[m.homeTeamId].gf += sH;
            scores[m.homeTeamId].ga += sA;
            scores[m.awayTeamId].gf += sA;
            scores[m.awayTeamId].ga += sH;
            if (m.result.ot) {
                if (sH > sA) {
                    scores[m.homeTeamId].points += 2;
                    scores[m.awayTeamId].points += 1;
                } else {
                    scores[m.awayTeamId].points += 2;
                    scores[m.homeTeamId].points += 1;
                }
            } else {
                if (sH > sA) scores[m.homeTeamId].points += 3; else if (sA > sH) scores[m.awayTeamId].points += 3; else {
                    scores[m.homeTeamId].points += 1;
                    scores[m.awayTeamId].points += 1;
                }
            }
        }
    });

    const leagueObj = (allSeasonData[selectedSeason]?.leagues || []).find(l => l.name === selectedLiga) || {
        name: selectedLiga,
        isMultigroup: false,
        maxMatches: 0,
        quarterfinal: 0,
        playin: 0,
        relegation: 0
    };

    // --- DVĚ STRUKTURY PRO SKUPINY (Levá vs Pravá strana) ---
    const teamsByGroup = {}; // Pro levou stranu ('A', 'B', 'C')
    const groupedTeams = {}; // Pro pravou stranu ('1', '2', '3')

    teamsInSelectedLiga.forEach(team => {
        // Levá strana (Tabulka)
        const groupLetter = team.group ? String.fromCharCode(team.group + 64) : 'X';
        if (!teamsByGroup[groupLetter]) teamsByGroup[groupLetter] = [];
        teamsByGroup[groupLetter].push(team);

        // Pravá strana (Tipy uživatelů)
        let gKey = "default";
        if (leagueObj.isMultigroup) {
            gKey = String(team.group || 1);
        }
        if (!groupedTeams[gKey]) groupedTeams[gKey] = [];
        groupedTeams[gKey].push(team);
    });

    const sortedGroups = Object.keys(teamsByGroup).sort();
    const sortedGroupKeys = Object.keys(groupedTeams).sort((a, b) => {
        if (a === 'default') return -1;
        return parseInt(a) - parseInt(b);
    });

    const getGroupDisplayLabel = (gKey) => {
        if (gKey === 'default') return '';
        const num = parseInt(gKey);
        return `Skupina ${String.fromCharCode(64 + num)}`;
    };

    // =========================================================
    // === CENTRALIZOVANÉ IIHF SORTING (JEDNOU PRO VŽDY) ===
    // =========================================================
    const globalRealRankMap = {};

    for (const group of sortedGroups) {
        teamsByGroup[group].sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points !== undefined ? aStats.points : scores[a.id].points;
            const pB = bStats.points !== undefined ? bStats.points : scores[b.id].points;

            if (pB !== pA) return pB - pA;

            const tiedTeamIds = teamsByGroup[group]
                .filter(t => {
                    const tPts = t.stats?.[selectedSeason]?.points !== undefined ? t.stats[selectedSeason].points : scores[t.id].points;
                    return tPts === pA;
                })
                .map(t => Number(t.id));

            const getMiniStats = (teamId) => {
                let mPts = 0, mDiff = 0, mGF = 0;
                const groupMatches = matchesInLiga.filter(m =>
                    m.result &&
                    !m.isPlayoff &&
                    tiedTeamIds.includes(Number(m.homeTeamId)) &&
                    tiedTeamIds.includes(Number(m.awayTeamId)) &&
                    (Number(m.homeTeamId) === teamId || Number(m.awayTeamId) === teamId)
                );

                groupMatches.forEach(m => {
                    const isHome = Number(m.homeTeamId) === teamId;
                    let sH = m.result?.scoreHome !== undefined ? Number(m.result.scoreHome) : (m.scoreHome !== undefined ? Number(m.scoreHome) : 0);
                    let sA = m.result?.scoreAway !== undefined ? Number(m.result.scoreAway) : (m.scoreAway !== undefined ? Number(m.scoreAway) : 0);
                    const isOt = m.result?.ot || m.ot;

                    let hPts, aPts;
                    if (sH > sA) { hPts = isOt ? 2 : 3; aPts = isOt ? 1 : 0; }
                    else if (sA > sH) { aPts = isOt ? 2 : 3; hPts = isOt ? 1 : 0; }
                    else { hPts = 1; aPts = 1; }

                    let pts, gf, ga;
                    if (isHome) { pts = hPts; gf = sH; ga = sA; }
                    else { pts = aPts; gf = sA; ga = sH; }

                    mPts += pts;
                    mDiff += (gf - ga);
                    mGF += gf;
                });
                return {pts: mPts, diff: mDiff, gf: mGF};
            };

            const msA = getMiniStats(Number(a.id));
            const msB = getMiniStats(Number(b.id));

            if (msB.pts !== msA.pts) return msB.pts - msA.pts;
            if (msB.diff !== msA.diff) return msB.diff - msA.diff;
            if (msB.gf !== msA.gf) return msB.gf - msA.gf;

            const directMatch = matchesInLiga.find(m =>
                m.result &&
                !m.isPlayoff &&
                ((Number(m.homeTeamId) === Number(a.id) && Number(m.awayTeamId) === Number(b.id)) ||
                    (Number(m.homeTeamId) === Number(b.id) && Number(m.awayTeamId) === Number(a.id)))
            );

            if (directMatch) {
                const isAHome = Number(directMatch.homeTeamId) === Number(a.id);
                let sH = directMatch.result?.scoreHome ?? directMatch.scoreHome ?? 0;
                let sA = directMatch.result?.scoreAway ?? directMatch.scoreAway ?? 0;

                if (isAHome) {
                    if (sH > sA) return -1;
                    if (sA > sH) return 1;
                } else {
                    if (sA > sH) return -1;
                    if (sH > sA) return 1;
                }
            }

            const sA = scores[a.id] || {gf: 0, ga: 0};
            const sB = scores[b.id] || {gf: 0, ga: 0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;

            return 0;
        });

        // MAPOVÁNÍ SKUTEČNÉHO POŘADÍ PRO OSTATNÍ VÝPOČTY
        teamsByGroup[group].forEach((t, i) => {
            globalRealRankMap[t.id] = i + 1;
        });
    }

    // 4. VÝPOČET STATISTIK UŽIVATELŮ
    const userStats = allUsers
        .filter(u => {
            const stats = u.stats?.[selectedSeason]?.[selectedLiga];
            const tips = u.tips?.[selectedSeason]?.[selectedLiga] || [];
            return (stats && (stats.totalRegular > 0 || stats.totalPlayoff > 0 || stats.tableCorrect !== undefined)) || tips.length > 0;
        })
        .map(u => {
            const stats = u.stats?.[selectedSeason]?.[selectedLiga] || {};
            const userTips = u.tips?.[selectedSeason]?.[selectedLiga] || [];

            let tCorrect = stats.tableCorrect || 0;
            let tDeviation = stats.tableDeviation || 0;

            // Ošetření počítání naživo
            if (tCorrect === 0 && tDeviation === 0) {
                const userTableTip = tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username];
                if (userTableTip) {
                    for (const gKey of sortedGroupKeys) {
                        let tipIds = Array.isArray(userTableTip) ? userTableTip : (userTableTip[gKey] || []);
                        tipIds.forEach((tid, idx) => {
                            const realRank = globalRealRankMap[tid];
                            if (realRank) {
                                const diff = Math.abs((idx + 1) - realRank);
                                tDeviation += diff;
                                if (diff === 0) tCorrect++;
                            }
                        });
                    }
                }
            }

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
                tableCorrect: tCorrect,
                tableDeviation: tDeviation
            };
        });

    const usersWithTableTips = allUsers.filter(u => tableTips?.[selectedSeason]?.[selectedLiga]?.[u.username]).sort((a, b) => a.username.localeCompare(b.username));
    const initialUser = usersWithTableTips.find(u => u.username === username) ? username : (usersWithTableTips[0]?.username || "");
    const currentUserStats = userStats.find(u => u.username === username);

    let playoffData = [];
    try {
        const raw = fs.readFileSync(path.join(__dirname, '../data/playoff.json'), 'utf8');
        const allPlayoffs = JSON.parse(raw);
        if (allPlayoffs[selectedSeason] && allPlayoffs[selectedSeason][selectedLiga]) {
            playoffData = allPlayoffs[selectedSeason][selectedLiga];
        }
    } catch (e) {
    }

    let isRegularSeasonFinished = false;
    try {
        const statusData = JSON.parse(fs.readFileSync('./data/leagueStatus.json', 'utf8'));
        isRegularSeasonFinished = statusData?.[selectedSeason]?.[selectedLiga]?.regularSeasonFinished || false;
    } catch (e) {
    }

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
</script>;
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
<main class="main_page">
<section class="stats-container">
<div class="left-panel">
<div style="display: flex; flex-direction: row; justify-content: space-around; margin:20px 0; text-align:center;">
<button style="cursor: pointer; border: none; color: orangered; background-color: black" class="history-btn" onclick="showTable('regular')">Základní část</button>
<button style="cursor: pointer; border: none; color: orangered; background-color: black" class="history-btn" onclick="showTable('playoff')">Playoff</button>
</div>
<div id="regularTable">
`;

    html += `
    <div style="display: flex; justify-content: flex-start; align-items: center; margin-bottom: 10px; gap: 10px;">
        <span style="color: gray; font-size: 0.85em;">Logika obarvování:</span>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=strict" 
           style="${clinchMode === 'strict' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Striktní (Jistá meta)
        </a>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=cascade" 
           style="${clinchMode === 'cascade' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Kaskádová (Minimální meta)
        </a>
    </div>
    `;

    const crossGroupTeams = [];

    // --- ZPRACOVÁNÍ TABULEK ---
    for (const group of sortedGroups) {
        const teamsInGroup = teamsByGroup[group];
        const zoneConfig = getLeagueZones(leagueObj);

        // ULOŽENÍ TÝMU DO CROSS-TABLE
        if (leagueObj.crossGroupTable && leagueObj.crossGroupPosition > 0) {
            const targetIndex = leagueObj.crossGroupPosition - 1;
            if (teamsInGroup[targetIndex]) {
                crossGroupTeams.push(teamsInGroup[targetIndex]);
            }
        }

        html += `
<table class="points-table">
<thead>
<tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část ${leagueObj?.isMultigroup ? `(Skupina ${group})` : ''}</h2></th></tr>
<tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
</thead>
<tbody>`;

        const sorted = teamsInGroup;

        // --- VÝPOČET ZÁPASŮ ---
        let matchesPerTeam;
        if (leagueObj.isMultigroup) {
            matchesPerTeam = Math.max(1, teamsInGroup.length - 1);
        } else {
            matchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInGroup.length);
        }

        // --- ZÓNY A LIMITY ---
        const qfLimit = leagueObj.quarterfinal || 0;
        const playinLimit = leagueObj.playin || 0;
        const relegationLimit = leagueObj.relegation || 0;

        const totalAdvancing = playinLimit;
        const safeZoneIndex = sorted.length - relegationLimit - 1;

        const getMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            if (fromIndex >= sorted.length) return 0;

            for (let i = fromIndex; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const played = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
                const remaining = Math.max(0, matchesPerTeam - played);
                const potential = (s.points || 0) + (remaining * 3);
                if (potential > globalMax) globalMax = potential;
            }
            return globalMax;
        };

        const thresholdQF = getMaxPotentialOfZone(qfLimit);
        const thresholdPlayin = getMaxPotentialOfZone(totalAdvancing);

        let safetyPoints = 0;
        if (relegationLimit > 0 && safeZoneIndex >= 0 && sorted.length > safeZoneIndex) {
            safetyPoints = sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0;
        }

        teamsInGroup.forEach((team, index) => {
            const currentZone = getTeamZone(index, teamsInGroup.length, zoneConfig);
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins||0) + (stats.otWins||0) + (stats.otLosses||0) + (stats.losses||0) + (stats.manualGames || 0);
            const remaining = Math.max(0, matchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);

            let canDrop = false;
            for (let i = index + 1; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const p = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
                const rem = Math.max(0, matchesPerTeam - p);
                const chaserMax = (s.points || 0) + (rem * 3);

                if (chaserMax > myPoints) { canDrop = true; break; }
                if (chaserMax === myPoints) {
                    if (rem > 0 || remaining > 0) { canDrop = true; break; }
                }
            }

            let canRise = false;
            if (index > 0) {
                const leader = sorted[index - 1];
                const leaderStats = leader.stats?.[selectedSeason] || {};
                const leaderPoints = leaderStats.points || 0;
                const pL = (leaderStats.wins||0)+(leaderStats.otWins||0)+(leaderStats.otLosses||0)+(leaderStats.losses||0);
                const remL = Math.max(0, matchesPerTeam - pL);

                if (myMaxPoints > leaderPoints) canRise = true;
                else if (myMaxPoints === leaderPoints) {
                    if (remaining > 0 || remL > 0) canRise = true;
                }
            }

            const locked = !canDrop && !canRise;

            let thresholdRelegation = 0;
            if (relegationLimit > 0 && safeZoneIndex >= 0 && safeZoneIndex + 1 < sorted.length) {
                thresholdRelegation = getMaxPotentialOfZone(safeZoneIndex + 1);
            }

            let clinchedQF = false;
            let clinchedPlayin = false;
            let clinchedRelegation = false;
            let clinchedNeutral = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                const ptsGatekeeperQF = (qfLimit > 0 && sorted[qfLimit - 1]) ? (sorted[qfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperPlayin = (totalAdvancing > 0 && sorted[totalAdvancing - 1]) ? (sorted[totalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperSafe = (safeZoneIndex >= 0 && sorted[safeZoneIndex]) ? (sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;

                    if (totalAdvancing > 0 && (myPoints > thresholdPlayin || totalAdvancing >= sorted.length)) {
                        if (qfLimit === 0 || myMaxPoints < ptsGatekeeperQF) clinchedPlayin = true;
                    }

                    if (relegationLimit === 0 || myPoints > thresholdRelegation) {
                        if (totalAdvancing === 0 || myMaxPoints < ptsGatekeeperPlayin) clinchedNeutral = true;
                    }

                    if (relegationLimit > 0 && myMaxPoints < ptsGatekeeperSafe) clinchedRelegation = true;
                }

                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';

            } else {
                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;
                    if (totalAdvancing > 0 && myPoints > thresholdPlayin || totalAdvancing >= sorted.length) clinchedPlayin = true;

                    if (relegationLimit > 0 && myPoints > thresholdRelegation) clinchedNeutral = true;
                    else if (relegationLimit === 0) clinchedNeutral = true;

                    if (relegationLimit > 0 && index > safeZoneIndex && myMaxPoints < safetyPoints) clinchedRelegation = true;
                }

                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
            }

            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition && locked) {
                rowClass = 'clinched-crosstable';
            }
            if (locked) rowClass += ' locked';

            let rankClass = currentZone;
            const teamStats = scores[team.id] || {gf:0, ga:0};
            const goalDiff = teamStats.gf - teamStats.ga;

            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition) {
                rankClass = 'crosstable';
            }

            html += `<tr class="${rowClass}">
<td class="rank-cell ${rankClass}">${index + 1}.</td>
<td>${team.name}</td>
<td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td>
<td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
<td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
<td class="numbers">${played}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td>
</tr>`;
        });
        html += `</tbody></table><br>`;
    }

    // =========================================================
    // === TABULKA X-TÝCH TÝMŮ ===
    // =========================================================
    if (leagueObj.crossGroupTable && crossGroupTeams.length > 0) {
        const crossConfig = leagueObj.crossGroupConfig || { quarterfinal: 0, playin: 0, relegation: 0 };
        html += `<h2 style="text-align: center; margin-top: 30px; border-top: 2px solid #444; padding-top: 20px;">Tabulka týmů na ${leagueObj.crossGroupPosition}. místě</h2>`;

        crossGroupTeams.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;
            if (pB !== pA) return pB - pA;

            const sA = scores[a.id] || {gf:0, ga:0};
            const sB = scores[b.id] || {gf:0, ga:0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;
            if (sA.gf !== sB.gf) return sB.gf - sA.gf;
            return 0;
        });

        html += `<table class="points-table">
        <thead>
        <tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
        </thead>
        <tbody>`;

        const cQfLimit = crossConfig.quarterfinal || 0;
        const cPlayinLimit = crossConfig.playin || 0;
        const cRelLimit = crossConfig.relegation || 0;

        let cTotalAdvancing = 0;
        if (cPlayinLimit > 0) cTotalAdvancing = cPlayinLimit;
        else cTotalAdvancing = cQfLimit;
        cTotalAdvancing = Math.min(cTotalAdvancing, crossGroupTeams.length);

        const cSafeZoneIndex = crossGroupTeams.length - cRelLimit - 1;

        let cMatchesPerTeam = 52;
        if (leagueObj.isMultigroup) {
            const estimatedGroupSize = teamsInSelectedLiga.length / (leagueObj.groupCount || 1);
            cMatchesPerTeam = Math.max(1, Math.ceil(estimatedGroupSize) - 1);
        } else if (leagueObj.maxMatches) {
            if (leagueObj.maxMatches > 100) {
                cMatchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInSelectedLiga.length);
            } else {
                cMatchesPerTeam = leagueObj.maxMatches;
            }
        }

        const getCrossTeamPotential = (idx) => {
            if (idx >= crossGroupTeams.length) return 0;
            const t = crossGroupTeams[idx];
            const s = t.stats?.[selectedSeason] || {};
            const played = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
            if (isRegularSeasonFinished) return s.points || 0;
            const remaining = Math.max(0, cMatchesPerTeam - played);
            return (s.points || 0) + (remaining * 3);
        };

        const getCrossMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            if (fromIndex >= crossGroupTeams.length) return 0;
            for (let i = fromIndex; i < crossGroupTeams.length; i++) {
                globalMax = Math.max(globalMax, getCrossTeamPotential(i));
            }
            return globalMax;
        };

        let cThresholdQF = 0;
        if (cQfLimit > 0 && cQfLimit < crossGroupTeams.length) {
            cThresholdQF = getCrossMaxPotentialOfZone(cQfLimit);
        }

        let cThresholdPlayin = 0;
        if (cTotalAdvancing > 0 && cTotalAdvancing < crossGroupTeams.length) {
            cThresholdPlayin = getCrossMaxPotentialOfZone(cTotalAdvancing);
        }

        crossGroupTeams.forEach((team, index) => {
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins||0) + (stats.otWins||0) + (stats.otLosses||0) + (stats.losses||0) + (stats.manualGames || 0);

            let currentZone = "neutral";
            if (cRelLimit > 0 && index > cSafeZoneIndex) currentZone = "relegation";
            else if (cQfLimit > 0 && index < cQfLimit) currentZone = "quarterfinal";
            else if (cTotalAdvancing > 0 && index < cTotalAdvancing) currentZone = "playin";

            const remaining = Math.max(0, cMatchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);
            const teamStats = scores[team.id] || {gf:0, ga:0};
            const goalDiff = teamStats.gf - teamStats.ga;

            let canDrop = false;
            for (let i = index + 1; i < crossGroupTeams.length; i++) {
                const chaserMax = getCrossTeamPotential(i);
                if (chaserMax > myPoints) { canDrop = true; break; }
                const chaserPlayed = (crossGroupTeams[i].stats?.[selectedSeason]?.wins||0) + (crossGroupTeams[i].stats?.[selectedSeason]?.losses||0);
                if (chaserMax === myPoints && !isRegularSeasonFinished && (remaining > 0 || chaserPlayed < cMatchesPerTeam)) {
                    canDrop = true; break;
                }
            }

            let canRise = false;
            if (index > 0) {
                const prevTeamCurrentPoints = crossGroupTeams[index - 1].stats?.[selectedSeason]?.points || 0;
                if (myMaxPoints > prevTeamCurrentPoints) canRise = true;
                if (myMaxPoints === prevTeamCurrentPoints && !isRegularSeasonFinished && remaining > 0) {
                    canRise = true;
                }
            }

            const cLocked = !canDrop && !canRise;

            let cThresholdRelegation = 0;
            if (cRelLimit > 0 && cSafeZoneIndex >= 0 && cSafeZoneIndex + 1 < crossGroupTeams.length) {
                cThresholdRelegation = getCrossMaxPotentialOfZone(cSafeZoneIndex + 1);
            }

            let cSafeQF = false;
            let cSafePlayin = false;
            let cRelegated = false;
            let cNeutralLocked = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                const cPtsGatekeeperQF = (cQfLimit > 0 && crossGroupTeams[cQfLimit - 1]) ? (crossGroupTeams[cQfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperPlayin = (cTotalAdvancing > 0 && crossGroupTeams[cTotalAdvancing - 1]) ? (crossGroupTeams[cTotalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperSafe = (cSafeZoneIndex >= 0 && crossGroupTeams[cSafeZoneIndex]) ? (crossGroupTeams[cSafeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;

                    if (cTotalAdvancing > 0 && (myPoints > cThresholdPlayin || cTotalAdvancing >= crossGroupTeams.length)) {
                        if (cQfLimit === 0 || myMaxPoints < cPtsGatekeeperQF) cSafePlayin = true;
                    }

                    if (cRelLimit === 0 || myPoints > cThresholdRelegation) {
                        if (cTotalAdvancing === 0 || myMaxPoints < cPtsGatekeeperPlayin) cNeutralLocked = true;
                    }

                    if (cRelLimit > 0 && myMaxPoints < cPtsGatekeeperSafe) cRelegated = true;
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";

            } else {
                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;
                    if (cTotalAdvancing > 0 && myPoints > cThresholdPlayin) cSafePlayin = true;

                    if (cRelLimit > 0 && myPoints > cThresholdRelegation) cNeutralLocked = true;
                    else if (cRelLimit === 0) cNeutralLocked = true;

                    if (cRelLimit > 0 && index > cSafeZoneIndex) {
                        const safetyTarget = crossGroupTeams[cSafeZoneIndex]?.stats?.[selectedSeason]?.points || 0;
                        if (myMaxPoints < safetyTarget) cRelegated = true;
                    }
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
            }

            if (cLocked) rowClass += " locked";

            html += `<tr class="${rowClass}">
                <td class="rank-cell ${currentZone}">${index + 1}.</td>
                <td>${team.name}</td>
                <td class="points numbers">${myPoints}</td>
                <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
                <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
                <td class="numbers">${played}</td>
                <td class="numbers">${stats.wins || 0}</td>
                <td class="numbers">${stats.otWins || 0}</td>
                <td class="numbers">${stats.otLosses || 0}</td>
                <td class="numbers">${stats.losses || 0}</td>
            </tr>`;
        });

        html += `</tbody></table><br>`;
    }
    html += `</div><div id="playoffTablePreview" style="display:none; overflow:auto; max-width:100%;"><table class="points-table"><tr><th scope="col" id="points-table-header" colspan="20"><h2>Týmy - Playoff</h2></th></tr>`;
    playoffData.forEach((row) => {
        html += '<tr>';
        row.forEach(cell => {
            const bg = cell.bgColor ? ` style="background-color:${cell.bgColor}; color:${cell.textColor}"` : '';
            const txt = cell.text || '';
            html += `<td${bg}>${txt}</td>`;
        });
        html += '</tr>';
    });
    html += `</table></div>
<script>
function showTable(which) { 
    document.getElementById('regularTable').style.display = which === 'regular' ? 'block' : 'none'; 
    const p = document.getElementById('playoffTablePreview'); p.style.display = which === 'playoff' ? 'block' : 'none'; 
}
</script>`;

    // --- TVOJE STATISTIKY ---
    if (username) {
        html += `
        <section class="user_stats">
            <h2>Tvoje statistiky</h2>
            ${currentUserStats ? `
                <p>Správně tipnuto z maximálního počtu všech vyhodnocených zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.total}</strong> 
                    (${(currentUserStats.total > 0 ? (currentUserStats.correct / currentUserStats.total * 100).toFixed(2) : '0.00')} %)
                </p>
                ${currentUserStats.total !== currentUserStats.maxFromTips ? `
                <p>Správně tipnuto z tipovaných zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.maxFromTips}</strong> 
                    (${(currentUserStats.maxFromTips > 0 ? (currentUserStats.correct / currentUserStats.maxFromTips * 100).toFixed(2) : '0.00')} %)
                </p>` : ''}
            ` : `<p>Nemáš pro tuto sezónu/ligu žádná data.</p>`}
            
            ${(currentUserStats && (currentUserStats.tableCorrect > 0 || currentUserStats.tableDeviation > 0)) ? `
            <hr>
            <h3>Výsledek tipovačky tabulky</h3>
            <p>Správně trefených pozic: <strong>${currentUserStats.tableCorrect}</strong> (bodů)</p>
            <p>Celková odchylka v umístění: <strong>${currentUserStats.tableDeviation}</strong> (menší je lepší)</p>
            ` : `<p><em>Tipovačka tabulky nebyla pro tebe vyhodnocena.</em></p>`}
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
            return a.tableDeviation - b.tableDeviation;
        }).forEach((user, index) => {
            const successRateOverall = user.maxFromTips > 0 ? ((user.correct / user.maxFromTips) * 100).toFixed(2) : '0.00';
            const successRate = user.total > 0 ? ((user.correct / user.total) * 100).toFixed(2) : '0.00';
            const statusStyle = isRegularSeasonFinished ? "color: lightgrey; font-weight: bold;" : "color: white; opacity: 0.7; background-color: black";

            html += `<tr>
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
        html += `</tbody></table><br>
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
        </section></section>`;
    }
    html += `</div>`; // KONEC LEVÉ STRANY

    // --- PRAVÁ STRANA: TABULKA TIPŮ ---
    html += `
        <script>
        function showUserTableHistory(username) {
            document.querySelectorAll('.user-history-table-container').forEach(el => el.style.display = 'none');
            const safeName = username.replace(/[^a-zA-Z0-9]/g, '_');
            document.querySelectorAll('.user-table-' + safeName).forEach(el => el.style.display = 'block');
        }
        </script>
        <section class="matches-container">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px;">
                <h2 style="margin: 0;">Historie tipu tabulky</h2>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <label for="historyUserSelect" style="color: lightgrey;">Zobrazit:</label>
                    <select id="historyUserSelect" onchange="showUserTableHistory(this.value)" style="background-color: black; color: orangered; border: 1px solid orangered; padding: 5px; border-radius: 5px;">`;

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

                    html += `<li style="${bgStyle} display: flex; align-items: center; justify-content: space-between; margin: 5px 0; padding: 15px; color: #fff;">
                        <div style="display:flex; align-items:center;">
                            <span class="rank-number" style="font-weight: bold; color: orangered; margin-right: 15px; width: 30px;">${userRank}.</span>
                            <span class="team-name" style="font-weight: bold;">${team.name}</span>
                        </div>
                        <div style="display:flex; align-items:center; gap: 15px;">
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
    const username = req.session.user;
    const teams = loadTeams().filter(t => t.active);
    const matches = JSON.parse(fs.readFileSync('./data/matches.json', 'utf-8'));
    const allowedLeagues = JSON.parse(fs.readFileSync('./data/allowedLeagues.json', 'utf-8'));
    const selectedSeason = JSON.parse(fs.readFileSync('./data/chosenSeason.json', 'utf8'));
    const allSeasonData = JSON.parse(fs.readFileSync('./data/leagues.json', 'utf-8'));
    const leagues = (allSeasonData[selectedSeason] && allSeasonData[selectedSeason].leagues) ? allSeasonData[selectedSeason].leagues : [];

    const leaguesFromTeams = [...new Set(teams.map(t => t.liga))];
    const leaguesFromMatches = [...new Set(matches.map(m => m.liga))];
    const allLeagues = [...new Set([...leaguesFromTeams, ...leaguesFromMatches])];
    const uniqueLeagues = allLeagues.filter(l => allowedLeagues.includes(l));

    const selectedLiga = req.query.liga && uniqueLeagues.includes(req.query.liga) ? req.query.liga : uniqueLeagues[0];
    const teamsInSelectedLiga = teams.filter(t => t.liga === selectedLiga);

    const scores = calculateTeamScores(matches, selectedSeason, selectedLiga);
    // --- NAČTENÍ NASTAVENÍ VIZUÁLU (STRICT vs CASCADE) ---
    // --- NAČTENÍ NASTAVENÍ VIZUÁLU (STRICT vs CASCADE) ---
    let clinchMode = 'strict'; // Výchozí hard-kódovaný stav

    // 1. Zkusíme načíst globální výchozí nastavení z Adminu
    try {
        const settingsData = JSON.parse(fs.readFileSync('./data/settings.json', 'utf8'));
        if (settingsData.clinchMode) clinchMode = settingsData.clinchMode;
    } catch (e) {}

    // 2. Pokud uživatel kliknul na přepínač na stránce, uložíme mu to do jeho relace
    if (req.query.mode === 'strict' || req.query.mode === 'cascade') {
        req.session.userClinchMode = req.query.mode;
    }

    // 3. Pokud má uživatel ve své relaci už něco vybráno, přebije to to globální nastavení
    if (req.session && req.session.userClinchMode) {
        clinchMode = req.session.userClinchMode;
    }

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
                    totalPlayoff: stats.totalPlayoff || 0, // NOVÉ STATISTIKY PRO TABULKU
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



    let teamBonusData = {};
    try {
        teamBonusData = JSON.parse(fs.readFileSync('./data/teamBonuses.json', 'utf8'));
    } catch (e) { teamBonusData = {}; }

    teamsInSelectedLiga.forEach(t => {
        // Inicializace, pokud neexistuje
        if (!t.stats) t.stats = {};
        if (!t.stats[selectedSeason]) t.stats[selectedSeason] = { points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0 };

        // Získání reálných bodů ze zápasů
        let naturalPoints = t.stats[selectedSeason].points || 0;

        // Načtení dat z JSONu (ošetření starého formátu vs. nového objektu)
        let bonusEntry = teamBonusData[selectedSeason]?.[selectedLiga]?.[t.id] || { points: 0, games: 0 };
        if (typeof bonusEntry === 'number') bonusEntry = { points: bonusEntry, games: 0 };

        // Aplikace bodů (přičteme k existujícím)
        t.stats[selectedSeason].points = naturalPoints + (bonusEntry.points || 0);

        // Uložení manuálních zápasů do dočasné proměnné (použijeme později u played a progress baru)
        t.stats[selectedSeason].manualGames = bonusEntry.games || 0;
    });
    // =================================================================

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
    } catch (e) {
    }
    const statusStyle = isRegularSeasonFinished ? "color: lightgrey; font-weight: bold;" : "color: white; opacity: 0.7; background-color: black";

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
</script>;
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

    html += `
    <div style="display: flex; justify-content: flex-start; align-items: center; margin-bottom: 10px; gap: 10px;">
        <span style="color: gray; font-size: 0.85em;">Logika obarvování:</span>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=strict" 
           style="${clinchMode === 'strict' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Striktní (Jistá meta)
        </a>
        <a href="?liga=${encodeURIComponent(selectedLiga)}&mode=cascade" 
           style="${clinchMode === 'cascade' ? 'background-color: orangered; color: black;' : 'background-color: black; color: orangered; border: 1px solid orangered;'} padding: 4px 10px; border-radius: 4px; text-decoration: none; font-size: 0.85em;">
           Kaskádová (Minimální meta)
        </a>
    </div>
    `;

    const crossGroupTeams = [];

    // --- ZPRACOVÁNÍ TABULEK ---
    for (const group of sortedGroups) {
        const teamsInGroup = teamsByGroup[group];
        const zoneConfig = getLeagueZones(leagueObj);

        // =========================================================
        // === IIHF SORTING (FIX: IGNOROVAT PLAYOFF) ===
        // =========================================================
        teamsInGroup.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;

            // 1. Kritérium: BODY
            if (pB !== pA) return pB - pA;

            // --- MINITABULKA ---
            // Najdeme týmy se stejným počtem bodů
            const tiedTeamIds = teamsInGroup
                .filter(t => (t.stats?.[selectedSeason]?.points || 0) === pA)
                .map(t => Number(t.id));

            // Funkce pro minitabulku
            const getMiniStats = (teamId) => {
                let mPts = 0, mDiff = 0, mGF = 0;

                // FILTR: Jen tato sezóna, výsledek existuje, tým hraje A HLAVNĚ !isPlayoff
                const groupMatches = matches.filter(m =>
                    m.season === selectedSeason &&
                    m.result &&
                    !m.isPlayoff && // <--- TOTO JE TA OPRAVA!
                    tiedTeamIds.includes(Number(m.homeTeamId)) &&
                    tiedTeamIds.includes(Number(m.awayTeamId)) &&
                    (Number(m.homeTeamId) === teamId || Number(m.awayTeamId) === teamId)
                );

                groupMatches.forEach(m => {
                    const isHome = Number(m.homeTeamId) === teamId;

                    let sH = m.result?.scoreHome !== undefined ? Number(m.result.scoreHome) : (m.scoreHome !== undefined ? Number(m.scoreHome) : 0);
                    let sA = m.result?.scoreAway !== undefined ? Number(m.result.scoreAway) : (m.scoreAway !== undefined ? Number(m.scoreAway) : 0);
                    const isOt = m.result?.ot || m.ot;

                    let hPts, aPts;
                    if (sH > sA) { hPts = isOt ? 2 : 3; aPts = isOt ? 1 : 0; }
                    else if (sA > sH) { aPts = isOt ? 2 : 3; hPts = isOt ? 1 : 0; }
                    else { hPts=1; aPts=1; }

                    let pts, gf, ga;
                    if (isHome) { pts = hPts; gf = sH; ga = sA; }
                    else { pts = aPts; gf = sA; ga = sH; }

                    mPts += pts;
                    mDiff += (gf - ga);
                    mGF += gf;
                });

                return { pts: mPts, diff: mDiff, gf: mGF };
            };

            const msA = getMiniStats(Number(a.id));
            const msB = getMiniStats(Number(b.id));

            // 2. Kritérium: BODY V MINITABULCE
            if (msB.pts !== msA.pts) return msB.pts - msA.pts;

            // 3. Kritérium: ROZDÍL SKÓRE V MINITABULCE
            if (msB.diff !== msA.diff) return msB.diff - msA.diff;

            // 4. Kritérium: GÓLY V MINITABULCE
            if (msB.gf !== msA.gf) return msB.gf - msA.gf;

            // 5. Kritérium: PŘÍMÝ VZÁJEMNÝ ZÁPAS (Head-to-Head)
            const directMatch = matches.find(m =>
                m.season === selectedSeason &&
                m.result &&
                !m.isPlayoff && // <--- TOTO JE TA OPRAVA!
                ((Number(m.homeTeamId) === Number(a.id) && Number(m.awayTeamId) === Number(b.id)) ||
                    (Number(m.homeTeamId) === Number(b.id) && Number(m.awayTeamId) === Number(a.id)))
            );

            if (directMatch) {
                const isAHome = Number(directMatch.homeTeamId) === Number(a.id);
                let sH = directMatch.result?.scoreHome ?? directMatch.scoreHome ?? 0;
                let sA = directMatch.result?.scoreAway ?? directMatch.scoreAway ?? 0;

                if (isAHome) {
                    if (sH > sA) return -1;
                    if (sA > sH) return 1;
                } else {
                    if (sA > sH) return -1;
                    if (sH > sA) return 1;
                }
            }

            // 6. Kritérium: CELKOVÉ SKÓRE
            const sA = scores[a.id] || {gf:0, ga:0};
            const sB = scores[b.id] || {gf:0, ga:0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;

            return 0;
        });

        // --- ULOŽENÍ TÝMU DO CROSS-TABLE (POKUD JE ZAPNUTO) ---
        if (leagueObj.crossGroupTable && leagueObj.crossGroupPosition > 0) {
            const targetIndex = leagueObj.crossGroupPosition - 1;
            if (teamsInGroup[targetIndex]) {
                crossGroupTeams.push(teamsInGroup[targetIndex]);
            }
        }

        html += `
<table class="points-table">
<thead>
<tr><th scope="col" id="points-table-header" colspan="10"><h2>Týmy - ${selectedLiga} ${selectedSeason} - Základní část ${leagueObj?.isMultigroup ? `(Skupina ${group})` : ''}</h2></th></tr>
<tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
</thead>
<tbody>`;

        const sorted = teamsInGroup;

        // --- VÝPOČET ZÁPASŮ ---
        let matchesPerTeam;
        if (leagueObj.isMultigroup) {
            matchesPerTeam = Math.max(1, teamsInGroup.length - 1);
        } else {
            matchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInGroup.length);
        }

        //console.log(`\n=== DEBUG SKUPINA ${group} ===`);
        //console.log(`MatchesPerTeam vypočteno jako: ${matchesPerTeam}`);

        // --- ZÓNY A LIMITY ---
        const qfLimit = leagueObj.quarterfinal || 0;
        const playinLimit = leagueObj.playin || 0;
        const relegationLimit = leagueObj.relegation || 0;

        // Celkový počet postupujících (QF + Předkolo dohromady)
        const totalAdvancing = playinLimit;

        // Index, od kterého začíná sestupová zóna
        const safeZoneIndex = sorted.length - relegationLimit - 1;

        // Funkce pro zjištění maxima bodů, které může získat kdokoliv OD určité pozice dolů
        const getMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            // Pokud index je mimo tabulku, vracíme 0
            if (fromIndex >= sorted.length) return 0;

            for (let i = fromIndex; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const played = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
                const remaining = Math.max(0, matchesPerTeam - played);
                const potential = (s.points || 0) + (remaining * 3);
                if (potential > globalMax) globalMax = potential;
            }
            return globalMax;
        };

        // 1. Práh pro QF: Kolik bodů může max. získat ten nejlepší tým, co by skončil POD čarou QF?
        const thresholdQF = getMaxPotentialOfZone(qfLimit);

        // 2. Práh pro Postup (Předkolo): Kolik bodů může max. získat ten nejlepší tým, co by nepostoupil VŮBEC?
        const thresholdPlayin = getMaxPotentialOfZone(totalAdvancing);

        //console.log(`Thresholds: QF > ${thresholdQF}, Playin > ${thresholdPlayin}`);

        let safetyPoints = 0;
        if (relegationLimit > 0 && safeZoneIndex >= 0 && sorted.length > safeZoneIndex) {
            safetyPoints = sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0;
            //console.log(`SafetyPoints (Relegation threshold): ${safetyPoints} (Tým na indexu ${safeZoneIndex})`);
        }

        teamsInGroup.forEach((team, index) => {
            const currentZone = getTeamZone(index, teamsInGroup.length, zoneConfig);
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins||0) + (stats.otWins||0) + (stats.otLosses||0) + (stats.losses||0) + (stats.manualGames || 0);
            const remaining = Math.max(0, matchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);

            //console.log(`--- TEAM: ${team.name} (${index + 1}.) ---`);
            //console.log(`   Pts: ${myPoints}, Played: ${played}, Remaining: ${remaining}, MaxPts: ${myMaxPoints}`);

            // --- STRICT LOCK LOGIKA (Tvoje verze - funguje správně) ---
            let canDrop = false;
            for (let i = index + 1; i < sorted.length; i++) {
                const chaser = sorted[i];
                const s = chaser.stats?.[selectedSeason] || {};
                const p = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);
                const rem = Math.max(0, matchesPerTeam - p);
                const chaserMax = (s.points || 0) + (rem * 3);

                // 1. Pokud mě může předběhnout na ČISTÉ BODY -> nejsem Locked
                if (chaserMax > myPoints) {
                    canDrop = true;
                    break;
                }

                // 2. Pokud mě může DOROVNAT na body a ještě se hraje
                if (chaserMax === myPoints) {
                    if (rem > 0 || remaining > 0) {
                        canDrop = true;
                        break;
                    }
                }
            }

            let canRise = false;
            if (index > 0) {
                const leader = sorted[index - 1];
                const leaderStats = leader.stats?.[selectedSeason] || {};
                const leaderPoints = leaderStats.points || 0;
                const pL = (leaderStats.wins||0)+(leaderStats.otWins||0)+(leaderStats.otLosses||0)+(leaderStats.losses||0);
                const remL = Math.max(0, matchesPerTeam - pL);

                if (myMaxPoints > leaderPoints) {
                    canRise = true;
                }
                else if (myMaxPoints === leaderPoints) {
                    if (remaining > 0 || remL > 0) {
                        canRise = true;
                    }
                }
            }

            const locked = !canDrop && !canRise;
            //console.log(`   Logic: CanDrop=${canDrop}, CanRise=${canRise} => LOCKED=${locked}`);

            // Společné proměnné pro obě logiky
            let thresholdRelegation = 0;
            if (relegationLimit > 0 && safeZoneIndex >= 0 && safeZoneIndex + 1 < sorted.length) {
                thresholdRelegation = getMaxPotentialOfZone(safeZoneIndex + 1);
            }

            let clinchedQF = false;
            let clinchedPlayin = false;
            let clinchedRelegation = false;
            let clinchedNeutral = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                // =========================================================
                // LOGIKA 1: STRIKTNÍ ZAMYKÁNÍ (Uvěznění v daném patře)
                // =========================================================
                const ptsGatekeeperQF = (qfLimit > 0 && sorted[qfLimit - 1]) ? (sorted[qfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperPlayin = (totalAdvancing > 0 && sorted[totalAdvancing - 1]) ? (sorted[totalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const ptsGatekeeperSafe = (safeZoneIndex >= 0 && sorted[safeZoneIndex]) ? (sorted[safeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;

                    if (totalAdvancing > 0 && (myPoints > thresholdPlayin || totalAdvancing >= sorted.length)) {
                        if (qfLimit === 0 || myMaxPoints < ptsGatekeeperQF) clinchedPlayin = true;
                    }

                    if (relegationLimit === 0 || myPoints > thresholdRelegation) {
                        if (totalAdvancing === 0 || myMaxPoints < ptsGatekeeperPlayin) clinchedNeutral = true;
                    }

                    if (relegationLimit > 0 && myMaxPoints < ptsGatekeeperSafe) clinchedRelegation = true;
                }

                // Třídy pro Strict
                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';

            } else {
                // =========================================================
                // LOGIKA 2: KASKÁDA (Nejvyšší dosažená meta)
                // =========================================================
                if (locked) {
                    if (qfLimit > 0 && index < qfLimit) clinchedQF = true;
                    else if (totalAdvancing > 0 && index < totalAdvancing) clinchedPlayin = true;
                    else if (relegationLimit > 0 && index > safeZoneIndex) clinchedRelegation = true;
                    else clinchedNeutral = true;
                } else {
                    if (qfLimit > 0 && myPoints > thresholdQF) clinchedQF = true;
                    if (totalAdvancing > 0 && myPoints > thresholdPlayin || totalAdvancing >= sorted.length) clinchedPlayin = true;

                    if (relegationLimit > 0 && myPoints > thresholdRelegation) clinchedNeutral = true;
                    else if (relegationLimit === 0) clinchedNeutral = true;

                    if (relegationLimit > 0 && index > safeZoneIndex && myMaxPoints < safetyPoints) clinchedRelegation = true;
                }

                // Třídy pro Kaskádu
                if (clinchedRelegation) rowClass = 'clinched-relegation';
                else if (clinchedQF) rowClass = 'clinched-quarterfinal';
                else if (clinchedPlayin) rowClass = 'clinched-playin';
                else if (clinchedNeutral) rowClass = 'clinched-neutral';
            }

            // Aplikace Cross-table a Locked
            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition && locked) {
                rowClass = 'clinched-crosstable';
            }
            if (locked) rowClass += ' locked';

            //console.log(`   Final Class: ${rowClass}`);

            let rankClass = currentZone;
            const teamStats = scores[team.id] || {gf: 0, ga: 0};
            const goalDiff = teamStats.gf - teamStats.ga;

            // --- SPECIÁLNÍ PODBARVENÍ PRO CROSS-TABLE RANK ---

            if (leagueObj.crossGroupTable && (index + 1) === leagueObj.crossGroupPosition) {
                rankClass = 'crosstable';
            }

            html += `<tr class="${rowClass}">
<td class="rank-cell ${rankClass}">${index + 1}.</td>
<td>${team.name}</td>
<td class="points numbers">${team.stats?.[selectedSeason]?.points || 0}</td>
<td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
<td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
<td class="numbers">${played}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.wins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otWins || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.otLosses || 0}</td>
<td class="numbers">${team.stats?.[selectedSeason]?.losses || 0}</td>
</tr>`;
        });
        html += `</tbody></table><br>`;
    }

    // =========================================================
    // === TABULKA X-TÝCH TÝMŮ (S OPRAVENÝM LOCKOVÁNÍM) ===
    // =========================================================
    if (leagueObj.crossGroupTable && crossGroupTeams.length > 0) {

        const crossConfig = leagueObj.crossGroupConfig || { quarterfinal: 0, playin: 0, relegation: 0 };

        html += `<h2 style="text-align: center; margin-top: 30px; border-top: 2px solid #444; padding-top: 20px;">Tabulka týmů na ${leagueObj.crossGroupPosition}. místě</h2>`;

        // 1. Seřazení týmů
        crossGroupTeams.sort((a, b) => {
            const aStats = a.stats?.[selectedSeason] || {};
            const bStats = b.stats?.[selectedSeason] || {};
            const pA = aStats.points || 0;
            const pB = bStats.points || 0;
            if (pB !== pA) return pB - pA;

            const sA = scores[a.id] || {gf:0, ga:0};
            const sB = scores[b.id] || {gf:0, ga:0};
            const diffA = sA.gf - sA.ga;
            const diffB = sB.gf - sB.ga;
            if (diffA !== diffB) return diffB - diffA;
            if (sA.gf !== sB.gf) return sB.gf - sA.gf;
            return 0;
        });

        html += `
        <table class="points-table">
        <thead>
        <tr><th class="position">Místo</th><th>Tým</th><th class="points">Body</th><th>Skóre</th><th>Rozdíl</th><th>Z</th><th>V</th><th>Vpp</th><th>Ppp</th><th>P</th></tr>
        </thead>
        <tbody>`;

        // 2. Limity pro Cross-Table
        const cQfLimit = crossConfig.quarterfinal || 0;
        const cPlayinLimit = crossConfig.playin || 0;
        const cRelLimit = crossConfig.relegation || 0;

        let cTotalAdvancing = 0;
        if (cPlayinLimit > 0) cTotalAdvancing = cPlayinLimit;
        else cTotalAdvancing = cQfLimit;
        cTotalAdvancing = Math.min(cTotalAdvancing, crossGroupTeams.length);

        const cSafeZoneIndex = crossGroupTeams.length - cRelLimit - 1;

        // 3. SPRÁVNÝ VÝPOČET ZÁPASŮ (Stejný jako v horních tabulkách)
        // Toto zajistí, že systém ví, že po 2 zápasech je konec a má zamknout.
        let cMatchesPerTeam = 52;
        if (leagueObj.isMultigroup) {
            // Pokud je to multigroup bez rounds, bývá to "každý s každým" ve skupině
            const estimatedGroupSize = teamsInSelectedLiga.length / (leagueObj.groupCount || 1);
            cMatchesPerTeam = Math.max(1, Math.ceil(estimatedGroupSize) - 1);
        } else if (leagueObj.maxMatches) {
            // Pokud je natvrdo nastaven maxMatches
            if (leagueObj.maxMatches > 100) {
                cMatchesPerTeam = Math.ceil((leagueObj.maxMatches * 2) / teamsInSelectedLiga.length);
            } else {
                cMatchesPerTeam = leagueObj.maxMatches;
            }
        }

        // 4. Pomocné funkce pro potenciál (s opraveným počtem zápasů)
        const getCrossTeamPotential = (idx) => {
            if (idx >= crossGroupTeams.length) return 0;
            const t = crossGroupTeams[idx];
            const s = t.stats?.[selectedSeason] || {};
            const played = (s.wins||0) + (s.otWins||0) + (s.otLosses||0) + (s.losses||0) + (s.manualGames || 0);

            if (isRegularSeasonFinished) return s.points || 0;

            const remaining = Math.max(0, cMatchesPerTeam - played);
            return (s.points || 0) + (remaining * 3);
        };

        const getCrossMaxPotentialOfZone = (fromIndex) => {
            let globalMax = 0;
            if (fromIndex >= crossGroupTeams.length) return 0;
            for (let i = fromIndex; i < crossGroupTeams.length; i++) {
                globalMax = Math.max(globalMax, getCrossTeamPotential(i));
            }
            return globalMax;
        };

        // Thresholdy
        let cThresholdQF = 0;
        if (cQfLimit > 0 && cQfLimit < crossGroupTeams.length) {
            cThresholdQF = getCrossMaxPotentialOfZone(cQfLimit);
        }

        let cThresholdPlayin = 0;
        if (cTotalAdvancing > 0 && cTotalAdvancing < crossGroupTeams.length) {
            cThresholdPlayin = getCrossMaxPotentialOfZone(cTotalAdvancing);
        }

        // 5. Hlavní cyklus
        crossGroupTeams.forEach((team, index) => {
            const stats = team.stats?.[selectedSeason] || {};
            const myPoints = stats.points || 0;
            const played = (stats.wins||0) + (stats.otWins||0) + (stats.otLosses||0) + (stats.losses||0) + (stats.manualGames || 0);

            // Určení základní Zóny
            let currentZone = "neutral";
            if (cRelLimit > 0 && index > cSafeZoneIndex) currentZone = "relegation";
            else if (cQfLimit > 0 && index < cQfLimit) currentZone = "quarterfinal";
            else if (cTotalAdvancing > 0 && index < cTotalAdvancing) currentZone = "playin";

            const remaining = Math.max(0, cMatchesPerTeam - played);
            const myMaxPoints = myPoints + (remaining * 3);
            const teamStats = scores[team.id] || {gf:0, ga:0};
            const goalDiff = teamStats.gf - teamStats.ga;

            // --- STRICT LOCK LOGIKA ---
            let canDrop = false;
            for (let i = index + 1; i < crossGroupTeams.length; i++) {
                const chaserMax = getCrossTeamPotential(i);
                if (chaserMax > myPoints) { canDrop = true; break; }
                const chaserPlayed = (crossGroupTeams[i].stats?.[selectedSeason]?.wins||0) + (crossGroupTeams[i].stats?.[selectedSeason]?.losses||0);

                // Opravená podmínka pro konec zápasů
                if (chaserMax === myPoints && !isRegularSeasonFinished && (remaining > 0 || chaserPlayed < cMatchesPerTeam)) {
                    canDrop = true; break;
                }
            }

            let canRise = false;
            if (index > 0) {
                const prevTeamCurrentPoints = crossGroupTeams[index - 1].stats?.[selectedSeason]?.points || 0;
                if (myMaxPoints > prevTeamCurrentPoints) canRise = true;
                if (myMaxPoints === prevTeamCurrentPoints && !isRegularSeasonFinished && remaining > 0) {
                    canRise = true;
                }
            }

            const cLocked = !canDrop && !canRise;


            // Společné pro Cross-table
            let cThresholdRelegation = 0;
            if (cRelLimit > 0 && cSafeZoneIndex >= 0 && cSafeZoneIndex + 1 < crossGroupTeams.length) {
                cThresholdRelegation = getCrossMaxPotentialOfZone(cSafeZoneIndex + 1);
            }

            let cSafeQF = false;
            let cSafePlayin = false;
            let cRelegated = false;
            let cNeutralLocked = false;
            let rowClass = currentZone;

            if (clinchMode === 'strict') {
                // --- STRICT LOGIKA CROSS-TABLE ---
                const cPtsGatekeeperQF = (cQfLimit > 0 && crossGroupTeams[cQfLimit - 1]) ? (crossGroupTeams[cQfLimit - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperPlayin = (cTotalAdvancing > 0 && crossGroupTeams[cTotalAdvancing - 1]) ? (crossGroupTeams[cTotalAdvancing - 1].stats?.[selectedSeason]?.points || 0) : 0;
                const cPtsGatekeeperSafe = (cSafeZoneIndex >= 0 && crossGroupTeams[cSafeZoneIndex]) ? (crossGroupTeams[cSafeZoneIndex].stats?.[selectedSeason]?.points || 0) : 0;

                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;

                    if (cTotalAdvancing > 0 && (myPoints > cThresholdPlayin || cTotalAdvancing >= crossGroupTeams.length)) {
                        if (cQfLimit === 0 || myMaxPoints < cPtsGatekeeperQF) cSafePlayin = true;
                    }

                    if (cRelLimit === 0 || myPoints > cThresholdRelegation) {
                        if (cTotalAdvancing === 0 || myMaxPoints < cPtsGatekeeperPlayin) cNeutralLocked = true;
                    }

                    if (cRelLimit > 0 && myMaxPoints < cPtsGatekeeperSafe) cRelegated = true;
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";

            } else {
                // --- KASKÁDOVÁ LOGIKA CROSS-TABLE ---
                if (cLocked) {
                    if (cQfLimit > 0 && index < cQfLimit) cSafeQF = true;
                    else if (cTotalAdvancing > 0 && index < cTotalAdvancing) cSafePlayin = true;
                    else if (cRelLimit > 0 && index > cSafeZoneIndex) cRelegated = true;
                    else cNeutralLocked = true;
                } else {
                    if (cQfLimit > 0 && myPoints > cThresholdQF) cSafeQF = true;
                    if (cTotalAdvancing > 0 && myPoints > cThresholdPlayin) cSafePlayin = true;

                    if (cRelLimit > 0 && myPoints > cThresholdRelegation) cNeutralLocked = true;
                    else if (cRelLimit === 0) cNeutralLocked = true;

                    if (cRelLimit > 0 && index > cSafeZoneIndex) {
                        const safetyTarget = crossGroupTeams[cSafeZoneIndex]?.stats?.[selectedSeason]?.points || 0;
                        if (myMaxPoints < safetyTarget) cRelegated = true;
                    }
                }

                if (cRelegated) rowClass = "clinched-relegation";
                else if (cSafeQF) rowClass = "clinched-quarterfinal";
                else if (cSafePlayin) rowClass = "clinched-playin";
                else if (cNeutralLocked) rowClass = "clinched-neutral";
            }

            if (cLocked) rowClass += " locked";

            html += `<tr class="${rowClass}">
                <td class="rank-cell ${currentZone}">${index + 1}.</td>
                <td>${team.name}</td>
                <td class="points numbers">${myPoints}</td>
                <td class="numbers">${teamStats.gf}:${teamStats.ga}</td>
                <td class="numbers">${goalDiff > 0 ? '+' + goalDiff : goalDiff}</td>
                <td class="numbers">${played}</td>
                <td class="numbers">${stats.wins || 0}</td>
                <td class="numbers">${stats.otWins || 0}</td>
                <td class="numbers">${stats.otLosses || 0}</td>
                <td class="numbers">${stats.losses || 0}</td>
            </tr>`;
        });

        html += `</tbody></table><br>`;
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
    const totalMatches = leagueObj.maxMatches; // Celkový počet zápasů v lize (dle nastavení)

    // 1. Zápasy z databáze (matches.json)
    let filledMatches = matches.filter(m => m.result && m.isPlayoff === false && m.liga === selectedLiga && m.season === selectedSeason).length;

    // 2. NOVÉ: Připočítat manuální zápasy
    // (Sečteme manuální zápasy všech týmů a vydělíme 2, protože jeden zápas hrají dva týmy)
    const totalManualGames = teamsInSelectedLiga.reduce((sum, t) => sum + (t.stats?.[selectedSeason]?.manualGames || 0), 0);
    filledMatches += Math.floor(totalManualGames / 2);

    // Výpočet procenta
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
    const bar = document.getElementById("progress-bar");
    const text = document.getElementById("progress-text");
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
        </div>
`;
    if (username) {
        html += `
<section class="user_stats">
    <h2>Tvoje statistiky</h2>
     ${currentUserStats ? `
                <p>Správně tipnuto z maximálního počtu všech vyhodnocených zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.total}</strong> 
                    (${(currentUserStats.total > 0 ? (currentUserStats.correct / currentUserStats.total * 100).toFixed(2) : '0.00')} %)
                </p>
                ${currentUserStats.total !== currentUserStats.maxFromTips ? `
                <p>Správně tipnuto z tipovaných zápasů: 
                    <strong>${currentUserStats.correct}</strong> z <strong>${currentUserStats.maxFromTips}</strong> 
                    (${(currentUserStats.maxFromTips > 0 ? (currentUserStats.correct / currentUserStats.maxFromTips * 100).toFixed(2) : '0.00')} %)
                </p>` : ''}
            ` : `<p>Nemáš pro tuto sezónu/ligu žádná data.</p>`}
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
`
    }
    res.send(html)
});
module.exports = router;