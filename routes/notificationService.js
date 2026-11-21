const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { Users, Matches, Teams } = require('../utils/mongoDataAccess');
const { Settings } = require('../utils/mongoDataAccess');
const brand = require('../utils/imageBranding');
const { drawBrandedBackground } = brand;
require('dotenv').config();

async function getNotificationImageBranding() {
    const collection = await Settings.getCollection();
    const settings = await collection.findOne({});
    return {
        bgColor: '#1a1a1a',
        accentColor: '#ff4500',
        textColor: '#ffffff',
        watermarkColor: '#888888',
        watermarkText: 'Tipovačka',
        ...(settings?.imageBranding || {})
    };
}

async function drawNotificationBranding(ctx, width, height, settings) {
    const { watermarkText, watermarkColor = '#888888', watermarkLogo } = settings;
    const padding = 14;
    let logo;
    try {
        logo = watermarkLogo && watermarkLogo.startsWith('data:image/')
            ? await loadImage(Buffer.from(watermarkLogo.split(',')[1], 'base64'))
            : await loadImage(path.join(__dirname, '../public/images/logo.png'));
    } catch (error) {
        console.error('[notificationService] Logo watermark se nepodařilo načíst:', error);
    }

    if (logo) {
        const size = 34;
        const scale = Math.min(size / logo.width, size / logo.height);
        const logoWidth = logo.width * scale;
        const logoHeight = logo.height * scale;
        ctx.drawImage(logo, width - logoWidth - padding, height - logoHeight - padding, logoWidth, logoHeight);
    }

    ctx.fillStyle = watermarkColor;
    ctx.font = '12px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(watermarkText || 'Tipovačka', padding, height - padding);
}

// --- NASTAVENÍ KLÍČŮ ---
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
    console.error("CHYBA: VAPID klíče nejsou nastaveny v souboru .env!");
}

const vapidSubject = process.env.SERVER_ORIGIN || 'mailto:veselsky.honza@gmail.com';
webpush.setVapidDetails(
    vapidSubject,
    publicVapidKey,
    privateVapidKey
);

// --- POMOCNÉ FUNKCE PRO ČTENÍ DAT ---
const getUsers = async () => {
    try { return await Users.findAll(); }
    catch (e) { return []; }
};
const getMatches = async () => {
    try { return await Matches.findAll(); }
    catch (e) { return []; }
};
const getTeams = async () => {
    try { return await Teams.findAll(); }
    catch (e) { return []; }
};

// --- CACHE ZÁPASŮ (30 s) pro výpočet badgeCount bez zbytečných DB dotazů ---
let matchesCache = { data: null, ts: 0 };
async function getMatchesCached() {
    if (matchesCache.data && Date.now() - matchesCache.ts < 30000) {
        return matchesCache.data;
    }
    const data = await getMatches();
    matchesCache = { data, ts: Date.now() };
    return data;
}

// Vrátí "YYYY-MM-DD" v Praze pro datetime zápasu (podporuje lokální i ISO formát)
function getMatchPragueDateKey(datetime) {
    if (!datetime) return null;
    const value = String(datetime);
    const localDateTime = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/);
    if (localDateTime) {
        return `${localDateTime[1]}-${localDateTime[2]}-${localDateTime[3]}`;
    }
    const matchDate = new Date(value);
    if (Number.isNaN(matchDate.getTime())) return null;
    const parts = getPragueDateParts(matchDate);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

// --- POČET NEOTIPOVANÝCH ZÁPASŮ (pro Badging API na ikoně PWA) ---
// Počítá jen zápasy z dneška a zítřka (evropský čas), aby odznak znamenal
// "dnes/zítra ti chybí tipy", ne "celá sezóna napříč všemi ligami".
async function getUnpredictedCountForUser(user) {
    const matches = await getMatchesCached();

    // Sbíráme ID všech tipů uživatele napříč sezónami a ligami
    const tippedIds = new Set();
    if (user.tips && typeof user.tips === 'object') {
        for (const seasonTips of Object.values(user.tips)) {
            if (!seasonTips || typeof seasonTips !== 'object') continue;
            for (const ligaTips of Object.values(seasonTips)) {
                if (!Array.isArray(ligaTips)) continue;
                for (const tip of ligaTips) {
                    if (tip && tip.matchId !== undefined && tip.matchId !== null) {
                        tippedIds.add(Number(tip.matchId));
                    }
                }
            }
        }
    }

    // Dnešní a zítřejší datum v Praze
    const todayParts = getPragueDateParts(new Date());
    const tomorrowParts = getPragueDateParts(new Date(Date.now() + 24 * 60 * 60 * 1000));
    const dateKeys = new Set([
        `${todayParts.year}-${todayParts.month}-${todayParts.day}`,
        `${tomorrowParts.year}-${tomorrowParts.month}-${tomorrowParts.day}`
    ]);

    return matches.filter(m => {
        if (m.result || m.postponed || m.locked) return false;
        if (tippedIds.has(Number(m.id))) return false;
        const dateKey = getMatchPragueDateKey(m.datetime);
        return dateKey !== null && dateKeys.has(dateKey);
    }).length;
}

// --- FUNKCE PRO ZPRACOVÁNÍ CUSTOM OBRÁZKŮ PRO NOTIFIKACE ---
// Custom obrázky (uploady/galerie) mohou mít jakýkoliv poměr stran
// Tato funkce přidá padding aby měly 2:1 poměr pro lepší zobrazení v notifikacích
async function processCustomImageForNotification(imageUrl) {
    try {
        // Získat cestu k souboru z URL
        let urlPath;
        if (imageUrl.startsWith('/images/exports/')) {
            // Exportované obrázky (např. přestupy)
            urlPath = 'public' + imageUrl;
        } else if (imageUrl.startsWith('/logoteamu/')) {
            // Loga týmů
            urlPath = imageUrl.replace('/logoteamu/', 'data/images/');
        } else if (imageUrl.startsWith('/images/notifications/')) {
            // Notifikační obrázky
            urlPath = imageUrl.replace('/images/notifications/', 'public/images/notifications/');
        } else {
            // Výchozí fallback
            urlPath = imageUrl;
        }
        const fullPath = path.join(process.cwd(), urlPath);
        
        // Kontrola WebP - canvas nepodporuje WebP, vrátit původní URL
        // (moderní prohlížeče WebP v notifikacích podporují)
        if (fullPath.toLowerCase().endsWith('.webp')) {
            return imageUrl;
        }
        
        // Načíst obrázek
        const img = await loadImage(fullPath);
        const imgWidth = img.width;
        const imgHeight = img.height;
        
        // Cílový poměr 2:1 (800x400) pro notifikace
        const targetRatio = 2;
        const currentRatio = imgWidth / imgHeight;
        
        let canvasWidth, canvasHeight, drawX, drawY;
        
        if (currentRatio > targetRatio) {
            // Obrázek je širší než 2:1 -> přidáme padding nahoře a dole
            canvasWidth = imgWidth;
            canvasHeight = imgWidth / targetRatio;
            drawX = 0;
            drawY = (canvasHeight - imgHeight) / 2;
        } else if (currentRatio < targetRatio) {
            // Obrázek je užší než 2:1 -> přidáme padding po stranách
            canvasHeight = imgHeight;
            canvasWidth = imgHeight * targetRatio;
            drawX = (canvasWidth - imgWidth) / 2;
            drawY = 0;
        } else {
            // Obrázek už má správný poměr 2:1
            return imageUrl;
        }
        
        // Vytvořit canvas s paddingem
        const canvas = createCanvas(canvasWidth, canvasHeight);
        const ctx = canvas.getContext('2d');
        const branding = await getNotificationImageBranding();
        await drawBrandedBackground(ctx, canvasWidth, canvasHeight, branding);
        
        // Vykreslit obrázek uprostřed
        ctx.drawImage(img, drawX, drawY, imgWidth, imgHeight);
        await drawNotificationBranding(ctx, canvasWidth, canvasHeight, branding);
        
        // Uložit výsledek
        const outDir = path.join(process.cwd(), 'public/images/notifications');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        
        const timestamp = Date.now();
        const filename = `custom-processed-${timestamp}.png`;
        const outPath = path.join(outDir, filename);
        
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(outPath, buffer);
        
        return `/images/notifications/${filename}`;
        
    } catch (err) {
        console.error('[processCustomImage] Chyba při zpracování obrázku:', err);
        // Vrátit původní URL v případě chyby
        return imageUrl;
    }
}

// --- FUNKCE PRO VYTVOŘENÍ "VERSUS" OBRÁZKU ---
async function createVersusImage(homeTeam, awayTeam, matchId, scoreHome = null, scoreAway = null, seriesMatches = null, ot = false) {
    if (!homeTeam || !awayTeam) {
        console.error('[createVersusImage] ERROR: Missing teams');
        return null;
    }

    const outDir = path.join(__dirname, '../public/images/notifications');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, `match-${matchId}.png`);
    const publicUrl = `/images/notifications/match-${matchId}.png`;

    const width = 800; const height = 500;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const branding = await getNotificationImageBranding();

    await drawBrandedBackground(ctx, width, height, branding);
    const theme = brand.resolveTheme(branding);
    const isResult = scoreHome !== null && scoreAway !== null;
    const bottomLines = [];
    if (seriesMatches && Array.isArray(seriesMatches) && seriesMatches.length > 0) {
        const seriesWinsH = seriesMatches.filter(m => m.sideSwap ? m.scoreAway > m.scoreHome : m.scoreHome > m.scoreAway).length;
        const seriesWinsA = seriesMatches.filter(m => m.sideSwap ? m.scoreHome > m.scoreAway : m.scoreAway > m.scoreHome).length;
        bottomLines.push({ text: `STAV SÉRIE  ${seriesWinsH} : ${seriesWinsA}`, color: theme.gold, size: 15 });
    }
    await brand.drawMatchupLayout(ctx, width, height, homeTeam, awayTeam, theme, {
        kicker: isResult ? 'KONEČNÝ VÝSLEDEK' : 'ZÁPAS',
        center: isResult ? { type: 'score', scoreHome, scoreAway, label: 'SKÓRE ZÁPASU', note: ot ? 'PO PRODLOUŽENÍ / NÁJEZDECH' : null } : { type: 'vs' },
        bottomLines
    });
    await drawNotificationBranding(ctx, width, height, branding);

    const notificationBuffer = canvas.toBuffer('image/png');
    if (matchId === null || matchId === undefined) {
        return notificationBuffer;
    }
    fs.writeFileSync(outPath, notificationBuffer);
    return publicUrl;
}

// --- KARTA JEDNOHO ZÁPASU V OBRÁZKU "KOLO" ---
async function drawRoundMatchCard(ctx, x, y, w, h, match, teamMap, theme) {
    brand.drawCard(ctx, x, y, w, h, { fill: theme.card, radius: 12, stripe: null });

    const homeTeam = teamMap.get(String(match.homeTeamId));
    const awayTeam = teamMap.get(String(match.awayTeamId));

    const logoSize = 40;
    const logoCy = y + 30;
    const nameY = y + 62;

    // Domácí tým (vlevo)
    const homeCx = x + w * 0.25;
    await brand.drawTeamLogo(ctx, homeTeam, homeCx, logoCy, logoSize, { color: theme.accentColor, textColor: theme.textColor });
    brand.drawText(ctx, homeTeam?.name || '???', homeCx, nameY, { size: 13, minSize: 10, color: theme.textColor, align: 'center', maxWidth: w * 0.42 });

    // Hosté (vpravo)
    const awayCx = x + w * 0.75;
    await brand.drawTeamLogo(ctx, awayTeam, awayCx, logoCy, logoSize, { color: theme.awayColor, textColor: theme.textColor });
    brand.drawText(ctx, awayTeam?.name || '???', awayCx, nameY, { size: 13, minSize: 10, color: theme.textColor, align: 'center', maxWidth: w * 0.42 });

    // VS uprostřed mezi logy
    brand.drawText(ctx, 'VS', x + w / 2, logoCy, { size: 14, color: theme.muted, align: 'center' });
}

// --- FUNKCE PRO VYTVOŘENÍ OBRÁZKU "KOLO" (všechny zápasy najednou, stejný styl jako versus) ---
async function createRoundImage(matches, teams, { kicker = 'KOLO', title = null, meta = null } = {}) {
    if (!matches || matches.length === 0) return null;

    const outDir = path.join(__dirname, '../public/images/notifications');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const branding = await getNotificationImageBranding();
    const theme = brand.resolveTheme(branding);

    const width = 800;
    const margin = 24;
    const gap = 14;
    const headerH = 104;
    const footerH = 42;
    const cardH = 84;
    const cols = matches.length > 12 ? 3 : 2;
    const rows = Math.ceil(matches.length / cols);
    const gridW = width - margin * 2;
    const cardW = (gridW - gap * (cols - 1)) / cols;
    const height = headerH + rows * cardH + (rows - 1) * gap + footerH;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    await drawBrandedBackground(ctx, width, height, branding);
    brand.drawFrame(ctx, width, height, theme, 14);

    brand.drawHeader(ctx, theme, {
        x: margin + 8,
        y: 26,
        kicker,
        title,
        align: 'left',
        maxWidth: gridW - 16,
        titleSize: 30,
        meta,
        metaX: width - margin - 8
    });

    const teamMap = new Map((teams || []).map(t => [String(t.id), t]));

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = margin + col * (cardW + gap);
        const y = headerH + row * (cardH + gap);
        await drawRoundMatchCard(ctx, x, y, cardW, cardH, match, teamMap, theme);
    }

    await drawNotificationBranding(ctx, width, height, branding);

    const timestamp = Date.now();
    const outPath = path.join(outDir, `round-${timestamp}.png`);
    const publicUrl = `/images/notifications/round-${timestamp}.png`;

    try {
        fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
        return publicUrl;
    } catch (err) {
        console.error('[createRoundImage] ERROR při ukládání souboru:', err);
        return null;
    }
}

// --- FUNKCE PRO VYTVOŘENÍ "VERSUS" OBRÁZKU PRO EXPORTER ---
async function createVersusImageForExport(homeTeam, awayTeam, customSettings = {}) {
    if (!homeTeam || !awayTeam) {
        console.error('[createVersusImageForExport] ERROR: Missing teams');
        return null;
    }

    const width = 800;
    const height = 500;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const theme = brand.resolveTheme(customSettings);
    await drawBrandedBackground(ctx, width, height, customSettings);
    await brand.drawMatchupLayout(ctx, width, height, homeTeam, awayTeam, theme, {
        kicker: 'ZÁPAS',
        customHomeLogo: customSettings.customHomeLogo,
        customAwayLogo: customSettings.customAwayLogo
    });

    if (customSettings.withWatermark !== false) {
        await brand.drawWatermark(ctx, width, height, customSettings);
    }

    let buffer;
    try {
        buffer = canvas.toBuffer('image/png');
    } catch (err) {
        console.error('[createVersusImageForExport] ERROR při vytváření bufferu:', err);
        return null;
    }
    
    if (!buffer) {
        console.error('[createVersusImageForExport] ERROR: canvas.toBuffer vrátil undefined!');
        return null;
    }
    
    return buffer;
}

// ... TVOJE ODESÍLACÍ FUNKCE A NOTIFY FUNKCE TADY ZŮSTÁVAJÍ (nechal jsem je beze změny) ...

// --- FUNKCE PRO VYTVOŘENÍ OBRÁZKU VÍTĚZE LIGY ---
async function createLeagueWinnerImage(winnerTeam, liga, branding = {}) {
    if (!winnerTeam) return null;
    
    const outDir = path.join(__dirname, '../public/images/notifications');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const timestamp = Date.now();
    const outPath = path.join(outDir, `winner-${liga}-${timestamp}.png`);
    const publicUrl = `/images/notifications/winner-${liga}-${timestamp}.png`;

    const width = 800; const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageBranding = { ...(await getNotificationImageBranding()), ...branding };
    const theme = brand.resolveTheme(imageBranding);

    await drawBrandedBackground(ctx, width, height, imageBranding);
    await brand.drawWinnerLayout(ctx, width, height, winnerTeam, theme, {
        title: `VÍTĚZ · ${liga}`
    });
    await drawNotificationBranding(ctx, width, height, imageBranding);

    let buffer;
    try {
        buffer = canvas.toBuffer('image/png');
    } catch (err) {
        console.error('[createLeagueWinnerImage] ERROR při vytváření bufferu:', err);
        return null;
    }
    
    if (!buffer) {
        console.error('[createLeagueWinnerImage] ERROR: canvas.toBuffer vrátil undefined!');
        return null;
    }
    
    try {
        fs.writeFileSync(outPath, buffer);
        return publicUrl;
    } catch (err) {
        console.error('[createLeagueWinnerImage] ERROR při ukládání souboru:', err);
        return null;
    }
}

const sendToUserDevices = async (user, payload) => {
    // Přidáme server origin do payloadu pro identifikaci zdroje (bez trailing slash)
    payload.serverOrigin = (process.env.SERVER_ORIGIN || 'unknown').replace(/\/$/, '');

    // BADGING API: pokud payload neobsahuje badgeCount, dopočítáme počet neotipovaných zápasů
    // (0 = vymazat odznak, kladné číslo = počet na ikoně aplikace)
    let userPayload = payload;
    if (payload.badgeCount === undefined) {
        try {
            const badgeCount = await getUnpredictedCountForUser(user);
            userPayload = { ...payload, badgeCount };
        } catch (badgeErr) {
            console.error(`[Push] Chyba při výpočtu badgeCount pro ${user.username}:`, badgeErr);
        }
    }

    let hasChanges = false;
    let activeSubscriptions = [];

    // 1. Podpora pro starý formát (jeden objekt)
    if (user.subscription && !user.subscriptions) {
        user.subscriptions = [user.subscription];
        delete user.subscription;
        hasChanges = true;
    }

    if (!user.subscriptions || user.subscriptions.length === 0) return;
    const options = {
        // Pokud payload obsahuje ttl (v sekundách), použijeme ho. Jinak dáme default 24 hodin (86400)
        TTL: payload.ttl || 86400,
        // Urgency 'high' zajistí okamzite doruceni i pri uspornem rezimu na Androidu
        urgency: 'high'
    };
    // 2. Projdeme všechna zařízení uživatele a odešleme notifikaci
    const promises = user.subscriptions.map(sub => {
        return webpush.sendNotification(sub, JSON.stringify(userPayload), options)
            .then(() => {
                activeSubscriptions.push(sub); // Odeslání úspěšné, ponecháme
            })
            .catch(err => {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    hasChanges = true;
                } else {
                    console.error(`[Push] Chyba při odesílání pro ${user.username}:`, err);
                    activeSubscriptions.push(sub); // Pro jiné chyby zatím ponecháme
                }
            });
    });

    // 3. Počkáme na odeslání na všechna zařízení a případně promažeme neplatné
    Promise.all(promises).then(async () => {
        if (hasChanges) {
            user.subscriptions = activeSubscriptions;
            const users = await getUsers();
            const userIndex = users.findIndex(u => u.username === user.username);
            if (userIndex !== -1) {
                users[userIndex].subscriptions = activeSubscriptions;
                // Úklid starého klíče, pokud existoval
                delete users[userIndex].subscription;
                await Users.updateAll(users);
            }
        }
    }).catch(err => {
        console.error(`[Push] Chyba při finálním zpracování pro ${user.username}:`, err);
    });
};

// --- NOTIFIKAČNÍ FUNKCE PRO RŮZNÉ UDÁLOSTI ---

const notifyNewMatches = async () => {
    const payload = {
        title: "🏒 Nové zápasy k tipování!",
        body: "Byly vypsány nové zápasy nebo série. Nezapomeň si tipnout co nejdříve!",
        icon: '/images/logo.png',
        vibrate: [100, 100, 250, 500, 100, 100, 250],
        url: '/',
        requireInteraction: false,
        actions: [
            { action: 'open_match', title: 'Jdu tipnout! 🚀' },
            { action: 'close', title: 'Zavřít' }
        ]
    };
    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

const notifyResult = async (matchId, scoreHome, scoreAway) => {
    const matches = await getMatches();
    const match = matches.find(m => m.id === parseInt(matchId));
    if (!match) return;

    const teams = await getTeams();
    const homeTeam = teams.find(t => t.id === match.homeTeamId);
    const awayTeam = teams.find(t => t.id === match.awayTeamId);
    if (!homeTeam || !awayTeam) return;

    const isSeries = match.isPlayoff && match.bo > 1;

    let title, body;
    if (isSeries) {
        title = "🏆 Konec série!";
        body = `Série ${homeTeam.name} vs ${awayTeam.name} skončila. Konečný stav: ${scoreHome}:${scoreAway}`;
    } else {
        title = "🏒 Zápas vyhodnocen!";
        const otText = match.result && match.result.ot ? " (pp/sn)" : "";
        body = `Výsledek: ${homeTeam.name} ${scoreHome}:${scoreAway}${otText} ${awayTeam.name}`;
    }

    // VYGENEROVÁNÍ DYNAMICKÉHO OBRÁZKU
    let heroImageUrl = null;
    try {
        // Pro série načteme všechny zápasy série pro zobrazení v obrázku
        let seriesMatches = null;
        if (isSeries && match.playedMatches) {
            seriesMatches = match.playedMatches;
        }
        const isOt = match.result && match.result.ot;
        heroImageUrl = await createVersusImage(homeTeam, awayTeam, match.id, scoreHome, scoreAway, seriesMatches, isOt);
    } catch (err) {
        console.error("Chyba při generování Versus obrázku:", err);
    }

    const payload = {
        title,
        body,
        icon: '/images/logo.png',
        image: heroImageUrl,
        vibrate: [200, 200, 200, 400, 100, 100, 100, 100, 100],
        url: `/?liga=${encodeURIComponent(match.liga)}`,
        matchId: match.id,
        tag: `vyhodnoceni-${match.id}`,
        requireInteraction: false,
        actions: [
            { action: 'open_match', title: 'Kouknout na tabulku' },
            { action: 'close', title: 'Zavřít' }
        ]
    };

    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

// PRŮBĚŽNÝ STAV SÉRIE - přijímá buď matchId nebo celý match objekt
const notifySeriesProgress = async (matchOrId, matchIndex, scoreHome, scoreAway, ot, seriesScoreH, seriesScoreA, seriesMatches = null) => {
    let match;
    if (typeof matchOrId === 'object' && matchOrId !== null) {
        match = matchOrId;
    } else {
        const matchId = matchOrId;
        const matches = await getMatches();
        match = matches.find(m => m.id === parseInt(matchId));
    }
    
    if (!match) {
        console.error(`[notifySeriesProgress] ERROR: Match not found`);
        return;
    }

    const teams = await getTeams();
    const homeTeam = teams.find(t => t.id === match.homeTeamId);
    const awayTeam = teams.find(t => t.id === match.awayTeamId);
    if (!homeTeam || !awayTeam) return;

    // VYGENEROVÁNÍ DYNAMICKÉHO OBRÁZKU
    let heroImageUrl = null;
    try {
        heroImageUrl = await createVersusImage(homeTeam, awayTeam, match.id, scoreHome, scoreAway, seriesMatches, ot);
    } catch (err) {
        console.error("Chyba při generování Versus obrázku:", err);
    }

    const otText = ot ? " pp" : "";
    const payload = {
        title: `🏒 Playoff: ${homeTeam.name} vs ${awayTeam.name}`,
        body: `${matchIndex}. zápas: ${scoreHome}:${scoreAway}${otText} | Průběžný stav série: ${seriesScoreH}:${seriesScoreA}`,
        icon: '/images/logo.png',
        image: heroImageUrl, // PŘIDANÝ OBRÁZEK
        vibrate: [200, 200, 200, 400, 100, 100, 100, 100, 100],
        url: `/?liga=${encodeURIComponent(match.liga)}`,
        matchId: match.id,
        tag: `serie-progress-${match.id}`,
        actions: [
            { action: 'open_match', title: 'Zobrazit pavouka' },
            { action: 'close', title: 'Zavřít' }
        ]
    };

    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

const notifyMatchUpdate = async (matchId, details) => {
    const matches = await getMatches();
    const match = matches.find(m => m.id === parseInt(matchId));
    if (!match) return;

    const teams = await getTeams();
    const homeTeam = teams.find(t => t.id === match.homeTeamId);
    const awayTeam = teams.find(t => t.id === match.awayTeamId);

    if (!homeTeam || !awayTeam) return;

    // VYGENEROVÁNÍ DYNAMICKÉHO OBRÁZKU
    let heroImageUrl = null;
    try {
        heroImageUrl = await createVersusImage(homeTeam, awayTeam, match.id);
    } catch (err) {
        console.error("Chyba při generování Versus obrázku:", err);
    }

    const matchTypeStr = (match.isPlayoff && match.bo > 1) ? "série" : "zápasu";

    const payload = {
        title: `⚠️ Změna u ${matchTypeStr}!`,
        body: `${homeTeam.name} vs ${awayTeam.name}\nDetaily: ${details}`,
        icon: '/images/logo.png',
        image: heroImageUrl, // PŘIDANÝ OBRÁZEK
        vibrate: [50, 50, 50, 50, 50, 50], // Rychlý poplach
        url: `/?liga=${encodeURIComponent(match.liga)}`,
        matchId: match.id,
        tag: `update-${match.id}`
    };

    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

// ZMĚNA: Přidáno async a parametr involvedTeams + customImageUrl
const notifyTransfer = async (message, involvedTeams = [], customImageUrl = null) => {
    let heroImageUrl = null;
    
    // Pokud je předán vlastní obrázek, zpracujeme ho pro notifikace
    if (customImageUrl) {
        // Custom obrázky (upload/galerie) upravíme aby byly viditelné v notifikacích
        heroImageUrl = await processCustomImageForNotification(customImageUrl);
    }
    // Pokud se měnil jen 1 tým, použijeme jeho logo a zpracujeme pro notifikace
    else if (involvedTeams.length === 1 && involvedTeams[0].logo) {
        const logoUrl = `/logoteamu/${encodeURIComponent(involvedTeams[0].logo)}`;
        heroImageUrl = await processCustomImageForNotification(logoUrl);
    }
    // Pokud se měnily přesně 2 týmy, zobrazíme jen logo prvního týmu
    else if (involvedTeams.length === 2) {
        // Pro přestup mezi dvěma týmy zobrazíme jen logo prvního ovlivněného týmu
        if (involvedTeams[0].logo) {
            const logoUrl = `/logoteamu/${encodeURIComponent(involvedTeams[0].logo)}`;
            heroImageUrl = await processCustomImageForNotification(logoUrl);
        }
    }
    // Pokud je týmů více (např. jsi uložil změny u 5 týmů najednou), obrázek necháme null
    // (Případně sem později můžeš dopsat: heroImageUrl = '/images/notifications/general-transfer.jpg';)

    const payload = {
        title: "🔄 Nové pohyby v kádru!",
        body: message,
        icon: '/images/logo.png',
        image: heroImageUrl, // PŘIDÁNO LOKÁLNÍ LOGO / VYGENEROVANÝ OBRÁZEK
        vibrate: [200, 100, 200, 100, 200], // Speciální "dvojité" vrnění
        url: '/prestupy',
        requireInteraction: false,
        actions: [
            { action: 'open_transfers', title: 'Kouknout na tabulku přestupů 👀' },
            { action: 'close', title: 'Zavřít' }
        ]
    };
    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

const notifyLeagueEnd = async (liga, winnerTeam = null) => {
    // VYGENEROVÁNÍ OBRÁZKU VÍTĚZE (pokud je předán)
    let heroImageUrl = null;
    if (winnerTeam) {
        try {
            heroImageUrl = await createLeagueWinnerImage(winnerTeam, liga, await getNotificationImageBranding());
        } catch (err) {
            console.error("Chyba při generování obrázku vítěze:", err);
        }
    }

    const payload = {
        title: `🏁 Základní část ${liga} skončila!`,
        body: winnerTeam 
            ? `🏆 Vítěz: ${winnerTeam.name}! Základní část ligy ${liga} byla ukončena. Běž se podívat na konečné pořadí!`
            : `Základní část ligy ${liga} byla právě ukončena. Běž se podívat na konečné pořadí a zkontroluj, kolik bodů jsi získal za svůj tip tabulky! 🏆`,
        icon: '/images/logo.png',
        image: heroImageUrl, // OBRÁZEK VÍTĚZE

        vibrate: [300, 100, 300, 100, 300, 400, 200, 200, 200], // Slavnostní dlouhé vibrace (fanfára/skandování)

        // Chování
        url: `/history/table/?liga=${encodeURIComponent(liga)}`,
        tag: `konec-ligy-${liga}`,
        requireInteraction: true, // Tohle nesmí uživatel minout, zpráva nezmizí sama

        // Tlačítka
        actions: [
            { action: 'open_table', title: 'Ukázat konečnou tabulku 🏆' },
            { action: 'close', title: 'Zavřít' }
        ]
    };

    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

// --- AUTOMATICKÉ NOTIFIKACE (CRON) ---
function getPragueDateParts(date) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Prague',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

// Český počet zápasů: 1 zápas, 2-4 zápasy, 5+ zápasů
function matchCountWord(n) {
    if (n === 1) return 'zápas';
    if (n >= 2 && n <= 4) return 'zápasy';
    return 'zápasů';
}

function matchesPragueMinute(datetime, targetParts) {
    if (!datetime) return false;

    const value = String(datetime);
    const localDateTime = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/);
    let matchParts;
    if (localDateTime) {
        matchParts = { year: localDateTime[1], month: localDateTime[2], day: localDateTime[3], hour: localDateTime[4], minute: localDateTime[5] };
    } else {
        const matchDate = new Date(value);
        if (Number.isNaN(matchDate.getTime())) return false;
        matchParts = getPragueDateParts(matchDate);
    }

    return ['year', 'month', 'day', 'hour', 'minute']
        .every(part => matchParts[part] === targetParts[part]);
}

cron.schedule('* * * * *', async () => {
    const now = new Date();
    const matches = await getMatches();
    const users = await getUsers();

    if (!users || users.length === 0) return;

    const targetTimes = [
        { minutes: 240, type: "4h" },
        { minutes: 60, type: "1h" }
    ];

    for (const { minutes, type } of targetTimes) {
        const targetParts = getPragueDateParts(new Date(now.getTime() + minutes * 60 * 1000));

        const upcomingMatches = matches.filter(m => {
            if (m.result || m.postponed || m.locked) return false;
            return matchesPragueMinute(m.datetime, targetParts);
        });

        if (upcomingMatches.length === 0) continue;

        const teams = await getTeams();

        // AGREGOVANÁ PŘIPOMÍNKA: místo jedné notifikace na každý zápas posíláme
        // každému uživateli JEDNU souhrnnou notifikaci na celé kolo/čas
        const matchInfos = upcomingMatches.map(match => {
            const homeTeam = teams.find(t => t.id === match.homeTeamId);
            const awayTeam = teams.find(t => t.id === match.awayTeamId);
            return {
                match,
                homeName: homeTeam?.name || 'Neznámý tým',
                awayName: awayTeam?.name || 'Neznámý tým'
            };
        });

        const timeText = type === "4h" ? "4 hodiny" : "hodinu";
        // Unikátní tag pro dané kolo a typ připomínky - notifikace se přepíše, nesčítá se
        const roundTag = `tip-reminder-${type}-${targetParts.year}-${targetParts.month}-${targetParts.day}-${targetParts.hour}-${targetParts.minute}`;

        // Obrázek celého kola - generuje se JEDNOU pro všechny uživatele (ne per-user)
        let roundImageUrl = null;
        try {
            roundImageUrl = await createRoundImage(upcomingMatches, teams, {
                kicker: 'KOLO',
                title: `${targetParts.hour}:${targetParts.minute}`,
                meta: `${Number(targetParts.day)}. ${Number(targetParts.month)}. ${targetParts.year}`
            });
        } catch (err) {
            console.error('Chyba při generování obrázku kola:', err);
        }

        users.forEach(u => {
            if (!u.subscriptions || u.subscriptions.length === 0) return;

            const untipped = matchInfos.filter(info => {
                const userTipsForSeason = u.tips?.[info.match.season]?.[info.match.liga] || [];
                return !userTipsForSeason.find(t => Number(t.matchId) === Number(info.match.id));
            });

            if (untipped.length > 0) {
                const names = untipped.slice(0, 3).map(i => `${i.homeName} vs ${i.awayName}`).join(', ');
                const moreText = untipped.length > 3 ? ` a dalších ${untipped.length - 3}` : '';
                sendToUserDevices(u, {
                    title: type === "4h" ? "🔔 Nezapomeň si tipnout!" : "⏳ Poslední šance!",
                    TTL: type === "4h" ? 14400 : 3600,
                    body: `Za ${timeText} začíná ${untipped.length} ${matchCountWord(untipped.length)}: ${names}${moreText}. Ještě nemáš tipnuto!`,
                    icon: '/images/logo.png',
                    image: roundImageUrl,
                    vibrate: [50, 50, 50, 50, 50, 50, 50, 50],
                    url: '/',
                    matchIds: untipped.map(i => i.match.id),
                    tag: roundTag,
                    requireInteraction: false,
                    actions: [
                        { action: 'open_match', title: 'Jdu tipnout! 🚀' },
                        { action: 'snooze', title: '⏰ Za 15 min' }
                    ]
                });
            } else if (type === "1h") {
                // Všechny tipy na toto kolo má uživatel hotové - jen krátká info notifikace
                sendToUserDevices(u, {
                    title: "✅ Všechno máš natipované!",
                    body: `Za hodinu začíná ${matchInfos.length} ${matchCountWord(matchInfos.length)} a všechny tipy máš hotové. Hodně štěstí!`,
                    icon: '/images/logo.png',
                    image: roundImageUrl,
                    vibrate: [100, 100, 250, 500, 100, 100, 250],
                    url: '/',
                    tag: roundTag,
                    requireInteraction: false,
                    actions: [
                        { action: 'open_match', title: 'Kouknout na tabulku' },
                        { action: 'close', title: 'Zavřít' }
                    ]
                });
            }
        });
    }

    // --- ZPRACOVÁNÍ ODLOŽENÝCH PŘIPOMÍNEK (snooze z notifikace) ---
    // Uživatelé si mohou z notifikace "Ještě nemáš tipnuto" odložit připomínku o 15 minut.
    // Endpoint /api/push/snooze uloží { matchId, remindAt } do user.snoozedReminders.
    let snoozeChanged = false;
    const snoozeTeams = users.some(u => Array.isArray(u.snoozedReminders) && u.snoozedReminders.length > 0)
        ? await getTeams()
        : null;

    for (const u of users) {
        const reminders = Array.isArray(u.snoozedReminders) ? u.snoozedReminders : [];
        if (reminders.length === 0) continue;

        const nowMs = now.getTime();
        const due = reminders.filter(r => r && r.remindAt <= nowMs);
        if (due.length === 0) continue;

        const remaining = reminders.filter(r => !(r && r.remindAt <= nowMs));

        // AGREGOVANÁ SNOOZE PŘIPOMÍNKA: sesbíráme všechny zápasy, na které uživatel
        // po odložení stále nemá tip, a pošleme JEDNU souhrnnou notifikaci
        const dueMatches = [];
        for (const r of due) {
            const match = matches.find(m => Number(m.id) === Number(r.matchId));
            // Zápas už je vyhodnocený / odložený / uzamčený -> připomínka už netřeba
            if (!match || match.result || match.postponed || match.locked) continue;

            // Uživatel si mezitím tip už doplnil -> připomínka netřeba
            const userTipsForSeason = u.tips?.[match.season]?.[match.liga] || [];
            const hasTip = userTipsForSeason.find(t => Number(t.matchId) === Number(match.id));
            if (hasTip) continue;

            const homeTeam = snoozeTeams?.find(t => t.id === match.homeTeamId);
            const awayTeam = snoozeTeams?.find(t => t.id === match.awayTeamId);
            dueMatches.push({
                match,
                homeName: homeTeam?.name || 'Neznámý tým',
                awayName: awayTeam?.name || 'Neznámý tým'
            });
        }

        if (dueMatches.length > 0) {
            const names = dueMatches.slice(0, 3).map(i => `${i.homeName} vs ${i.awayName}`).join(', ');
            const moreText = dueMatches.length > 3 ? ` a dalších ${dueMatches.length - 3}` : '';
            sendToUserDevices(u, {
                title: "⏰ Po odložení stále nemáš tipy!",
                TTL: 1800,
                body: `Už je to 15 minut od připomínky a ${dueMatches.length} ${matchCountWord(dueMatches.length)} stále nemáš natipovaný: ${names}${moreText}.`,
                icon: '/images/logo.png',
                vibrate: [50, 50, 50, 50, 50, 50, 50, 50],
                url: '/',
                matchIds: dueMatches.map(i => i.match.id),
                tag: 'snooze-reminder',
                requireInteraction: false,
                actions: [
                    { action: 'open_match', title: 'Jdu tipnout! 🚀' },
                    { action: 'snooze', title: '⏰ Za 15 min' }
                ]
            });
        }

        u.snoozedReminders = remaining;
        snoozeChanged = true;
    }

    if (snoozeChanged) {
        try {
            await Users.updateAll(users);
        } catch (err) {
            console.error('[Snooze] Chyba při ukládání snoozedReminders:', err);
        }
    }
});

// ==========================================
// AUTOMATICKÝ ÚKLID STARÝCH OBRÁZKŮ
// ==========================================
cron.schedule('0 3 * * *', () => { // Spustí se každý den ve 3:00 ráno
    const dir = path.join(__dirname, '../public/images/notifications');
    if (!fs.existsSync(dir)) return;

    fs.readdir(dir, (err, files) => {
        if (err) {
            console.error("[ÚKLID] Chyba při čtení složky notifikací:", err);
            return;
        }

        const now = Date.now();
        const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 dny v milisekundách

        files.forEach(file => {
            // Chceme mazat JEN dynamicky generované soubory (zápasy, kola a přestupy)
            if (file.startsWith('match-') || file.startsWith('transfer-') || file.startsWith('round-')) {
                const filePath = path.join(dir, file);

                fs.stat(filePath, (err, stats) => {
                    if (err) return;

                    // Pokud je soubor starší než 3 dny, smažeme ho
                    if (now - stats.mtimeMs > MAX_AGE_MS) {
                        fs.unlink(filePath, () => {});
                    }
                });
            }
        });
    });
});

// ==========================================
// CRITICAL EVENT NOTIFICATION
// ==========================================
const notifyCriticalEvent = async (username, action, entity, entityId, details, ip) => {
    const { Users } = require('../utils/mongoDataAccess');
    const users = await Users.findAll();

    // Filtrujeme jen adminy
    const admins = users.filter(u => u.role === 'admin');

    const payload = {
        title: "🚨 KRITICKÁ UDÁLOST",
        body: `Uživatel: ${username} | Akce: ${action} | Entity: ${entity}${entityId ? ` | ID: ${entityId}` : ''}${ip ? ` | IP: ${ip}` : ''}`,
        icon: '/images/logo.png',
        vibrate: [200, 100, 200, 100, 200, 100, 500],
        url: '/admin/audit-log',
        requireInteraction: true,
        urgency: 'high',
        ttl: 3600, // 1 hodina
        actions: [
            { action: 'open_audit', title: 'Zobrazit audit log' },
            { action: 'close', title: 'Zavřít' }
        ]
    };

    admins.forEach(admin => sendToUserDevices(admin, payload));
    console.log(`[CRITICAL] Odeslána notifikace pro ${admins.length} adminů: ${action} od ${username}`);
};

module.exports = {
    notifyNewMatches,
    notifyResult,
    notifySeriesProgress,
    notifyMatchUpdate,
    notifyTransfer,
    notifyLeagueEnd,
    sendToUserDevices,
    getUnpredictedCountForUser,
    createRoundImage,
    createVersusImageForExport,
    createVersusImage,
    createLeagueWinnerImage,
    processCustomImageForNotification,
    notifyCriticalEvent
};
