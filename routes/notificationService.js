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
    const outPath = path.join(outDir, `winner-${liga}-${timestamp}.webp`);
    const publicUrl = `/images/notifications/winner-${liga}-${timestamp}.webp`;

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

const sendToUserDevices = (user, payload) => {
    // Přidáme server origin do payloadu pro identifikaci zdroje (bez trailing slash)
    payload.serverOrigin = (process.env.SERVER_ORIGIN || 'unknown').replace(/\/$/, '');

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
        return webpush.sendNotification(sub, JSON.stringify(payload), options)
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
        requireInteraction: true,
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
        tag: `vyhodnoceni-${match.id}`,
        requireInteraction: true,
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
        requireInteraction: true,
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

        // Změna: Používáme for...of místo forEach, abychom mohli počkat na obrázek
        for (const match of upcomingMatches) {
            const homeTeam = teams.find(t => t.id === match.homeTeamId);
            const awayTeam = teams.find(t => t.id === match.awayTeamId);

            const homeName = homeTeam?.name || 'Neznámý tým';
            const awayName = awayTeam?.name || 'Neznámý tým';

            const isSeries = match.isPlayoff && match.bo > 1;
            const matchTypeStr = isSeries ? "sérii" : "zápas";
            const matchTypeSubj = isSeries ? "série" : "zápas";

            // VYGENERUJEME OBRÁZEK PRO TENTO ZÁPAS
            let heroImageUrl = null;
            try {
                heroImageUrl = await createVersusImage(homeTeam, awayTeam, match.id);
            } catch (err) {
                console.error("Chyba při generování Versus obrázku:", err);
            }

            users.forEach(u => {
                if (!u.subscriptions || u.subscriptions.length === 0) return;

                const userTipsForSeason = u.tips?.[match.season]?.[match.liga] || [];
                const hasTip = userTipsForSeason.find(t => Number(t.matchId) === Number(match.id));

                if (!hasTip) {
                    const timeText = type === "4h" ? "4 hodiny" : "hodinu";
                    sendToUserDevices(u, {
                        title: type === "4h" ? "🔔 Nezapomeň si tipnout!" : "⏳ Poslední šance!",
                        TTL: type === "4h" ? 14400 : 3600,
                        body: `Za ${timeText} začíná ${matchTypeSubj} ${homeName} vs ${awayName}. Ještě nemáš tipnuto na tuto ${matchTypeStr}!`,
                        icon: '/images/logo.png',
                        image: heroImageUrl, // PŘIDANÝ VYGENEROVANÝ OBRÁZEK
                        vibrate: [50, 50, 50, 50, 50, 50, 50, 50],
                        url: `/?liga=${encodeURIComponent(match.liga)}`,
                        tag: `zapas-${match.id}`,
                        requireInteraction: true,
                        actions: [
                            { action: 'open_match', title: 'Jdu tipnout! 🚀' },
                            { action: 'close', title: 'Zavřít' }
                        ]
                    });
                } else if (hasTip && type === "1h") {
                    sendToUserDevices(u, {
                        title: "⏳ Za hodinu už si nezměníš tip!",
                        body: `Za hodinu začíná ${matchTypeSubj} ${homeName} vs ${awayName}.`,
                        icon: '/images/logo.png',
                        image: heroImageUrl, // PŘIDANÝ VYGENEROVANÝ OBRÁZEK
                        vibrate: [100, 100, 250, 500, 100, 100, 250],
                        url: `/?liga=${encodeURIComponent(match.liga)}`,
                        tag: `zapas-${match.id}`,
                        requireInteraction: false,
                        actions: [
                            { action: 'open_match', title: 'Kouknout na tabulku' },
                            { action: 'close', title: 'Zavřít' }
                        ]
                    });
                }
            }, { timezone: 'Europe/Prague' });
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
            // Chceme mazat JEN dynamicky generované soubory (zápasy a přestupy)
            if (file.startsWith('match-') || file.startsWith('transfer-')) {
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
    createVersusImageForExport,
    createVersusImage,
    createLeagueWinnerImage,
    processCustomImageForNotification,
    notifyCriticalEvent
};
