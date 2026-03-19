const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { Users, Matches, Teams } = require('../utils/mongoDataAccess');
require('dotenv').config();

// --- NASTAVENÍ KLÍČŮ ---
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
    console.error("CHYBA: VAPID klíče nejsou nastaveny v souboru .env!");
}

webpush.setVapidDetails(
    'mailto:veselsky.honza@gmail.com',
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

// --- FUNKCE PRO VYTVOŘENÍ "VERSUS" OBRÁZKU ---
async function createVersusImage(homeTeam, awayTeam, matchId, scoreHome = null, scoreAway = null) {
    if (!homeTeam || !awayTeam) return null;

    const outDir = path.join(__dirname, '../public/images/notifications');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, `match-${matchId}.png`);
    const publicUrl = `/images/notifications/match-${matchId}.png`;

    const width = 800; const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. POZADÍ - Moderní tmavý gradient
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#1a1a1a');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // 2. DEKORACE - Oranžové dynamické linky
    ctx.strokeStyle = 'rgba(255, 69, 0, 0.15)';
    ctx.lineWidth = 3;
    for (let i = -100; i < width; i += 40) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 200, height);
        ctx.stroke();
    }

    // 3. FUNKCE PRO VYKRESLENÍ LOGA SE STÍNEM
    const drawLogo = async (logoName, x) => {
        try {
            const imgPath = path.join(__dirname, '../data/images', logoName);
            const img = await loadImage(imgPath);

            // Stín pod logem
            ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
            ctx.shadowBlur = 20;
            ctx.shadowOffsetX = 5;
            ctx.shadowOffsetY = 10;

            const size = 260;
            const ratio = Math.min(size / img.width, size / img.height);
            const nw = img.width * ratio;
            const nh = img.height * ratio;

            ctx.drawImage(img, x + (size - nw) / 2, 70 + (size - nh) / 2, nw, nh);
            ctx.shadowBlur = 0; // Reset stínu
        } catch (e) { console.error("Chyba loga:", e.message); }
    };

    await drawLogo(homeTeam.logo, 50);  // Domácí vlevo
    await drawLogo(awayTeam.logo, 490); // Hosté vpravo

    // 4. PROSTŘEDNÍ PANEL (Score nebo VS)
    const isResult = scoreHome !== null && scoreAway !== null;

    // Skleněný efekt pod textem
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.beginPath();
    ctx.roundRect(width/2 - 100, height/2 - 60, 200, 120, 20);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 69, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(255, 69, 0, 0.5)';
    ctx.shadowBlur = 10;

    if (isResult) {
        // Vykreslení SKÓRE
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 90px Arial';
        ctx.fillText(`${scoreHome}:${scoreAway}`, width / 2, height / 2);

        ctx.fillStyle = '#ff4500';
        ctx.font = 'bold 20px Arial';
        ctx.fillText('KONEČNÝ VÝSLEDEK', width / 2, height / 2 + 80);
    } else {
        // Vykreslení VS
        ctx.fillStyle = '#ff4500';
        ctx.font = 'bold 100px Arial';
        ctx.fillText('VS', width / 2, height / 2);
    }

    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outPath, buffer);
    return publicUrl;
}

// ... TVOJE ODESÍLACÍ FUNKCE A NOTIFY FUNKCE TADY ZŮSTÁVAJÍ (nechal jsem je beze změny) ...

// --- FUNKCE PRO VYTVOŘENÍ OBRÁZKU VÝMĚNY (TRADE) ---
async function createTransferImage(team1, team2) {
    if (!team1 || !team2) return null;
    const outDir = path.join(__dirname, '../public/images/notifications');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, `transfer-${team1.id}-${team2.id}.png`);
    const publicUrl = `/images/notifications/transfer-${team1.id}-${team2.id}.png`;

    const width = 800; const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Tmavě modré grad pozadí
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#001a33');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // Modré technické čáry
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.1)';
    ctx.lineWidth = 2;
    for (let i = 0; i < width; i += 30) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, height); ctx.stroke();
    }

    const drawLogo = async (logoName, x) => {
        if (!logoName) return;
        try {
            const img = await loadImage(path.join(__dirname, '../data/images', logoName));
            ctx.shadowColor = 'rgba(0, 212, 255, 0.3)';
            ctx.shadowBlur = 15;
            const size = 240;
            const ratio = Math.min(size / img.width, size / img.height);
            ctx.drawImage(img, x + (size - img.width*ratio)/2, 80 + (size - img.height*ratio)/2, img.width*ratio, img.height*ratio);
            ctx.shadowBlur = 0;
        } catch (e) {}
    };

    await drawLogo(team1.logo, 60);
    await drawLogo(team2.logo, 500);

    // Šipka přestupu uprostřed
    ctx.fillStyle = '#00d4ff';
    ctx.font = 'bold 80px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('➡', width / 2, height / 2 + 20);

    ctx.font = 'bold 40px Arial';
    ctx.fillText('PŘESTUP', width / 2, height / 2 - 60);

    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outPath, buffer);
    return publicUrl;
}

// --- ODESÍLACÍ FUNKCE PRO JEDNOHO UŽIVATELE (ZVLÁDNE VÍCE ZAŘÍZENÍ) ---
const sendToUserDevices = (user, payload) => {
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
        TTL: payload.ttl || 86400
    };
    // 2. Projdeme všechna zařízení uživatele a odešleme notifikaci
    const promises = user.subscriptions.map(sub => {
        return webpush.sendNotification(sub, JSON.stringify(payload), options)
            .then(() => {
                activeSubscriptions.push(sub); // Odeslání úspěšné, ponecháme
            })
            .catch(err => {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    console.log(`[Push] Odběr expiroval pro uživatele ${user.username}, mažu jej.`);
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
        // PŘIDÁVÁME scoreHome a scoreAway do volání
        heroImageUrl = await createVersusImage(homeTeam, awayTeam, match.id, scoreHome, scoreAway);
    } catch (err) {
        console.error("Chyba při generování Versus obrázku:", err);
    }

    const payload = {
        title,
        body,
        icon: '/images/logo.png',
        image: heroImageUrl, // PŘIDANÝ OBRÁZEK
        vibrate: [200, 200, 200, 400, 100, 100, 100, 100, 100], // Oslavné skandování
        url: `/?liga=${encodeURIComponent(match.liga)}`,
        tag: `vyhodnoceni-${match.id}`, // Aby to nepřekrývalo zbytečně všechno
        requireInteraction: true,
        actions: [
            { action: 'open_match', title: 'Kouknout na tabulku' },
            { action: 'close', title: 'Zavřít' }
        ]
    };

    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

// PRŮBĚŽNÝ STAV SÉRIE (Nová smysluplná funkce pro jednotlivé zápasy série)
const notifySeriesProgress = async (matchId, matchIndex, scoreHome, scoreAway, ot, seriesScoreH, seriesScoreA) => {
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

// ZMĚNA: Přidáno async a parametr involvedTeams
const notifyTransfer = async (message, involvedTeams = []) => {
    let heroImageUrl = null;

    // Pokud se měnil jen 1 tým, použijeme rovnou jeho logo na celou šířku
    if (involvedTeams.length === 1 && involvedTeams[0].logo) {
        heroImageUrl = `/logoteamu/${encodeURIComponent(involvedTeams[0].logo)}`;
    }
    // Pokud se měnily přesně 2 týmy, vygenerujeme koláž z plátna
    else if (involvedTeams.length === 2) {
        try {
            heroImageUrl = await createTransferImage(involvedTeams[0], involvedTeams[1]);
        } catch (err) {
            console.error("Chyba při tvorbě obrázku přestupu:", err);
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

const notifyLeagueEnd = async (liga) => {
    const payload = {
        title: `🏁 Základní část ${liga} skončila!`,
        body: `Základní část ligy ${liga} byla právě ukončena. Běž se podívat na konečné pořadí a zkontroluj, kolik bodů jsi získal za svůj tip tabulky! 🏆`,
        icon: '/images/logo.png',

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
// Změna: přidali jsme 'async' před callback funkci
cron.schedule('0 * * * *', async () => {
    const now = new Date();
    const matches = await getMatches();
    const users = await getUsers();

    if (!users || users.length === 0) return;

    const targetTimes = [
        { diffMs: 4 * 60 * 60 * 1000, type: "4h" },
        { diffMs: 60 * 60 * 1000, type: "1h" }
    ];

    for (const { diffMs, type } of targetTimes) {
        const targetTime = new Date(now.getTime() + diffMs);

        const upcomingMatches = matches.filter(m => {
            if (m.result || m.postponed || m.locked) return false;
            const matchDate = new Date(m.datetime);
            return (
                matchDate.getFullYear() === targetTime.getFullYear() &&
                matchDate.getMonth() === targetTime.getMonth() &&
                matchDate.getDate() === targetTime.getDate() &&
                matchDate.getHours() === targetTime.getHours()
            );
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
                    console.log(`[CRON] Posílám ${type} upozornění že nemá tip: ${u.username} (${homeName} vs ${awayName})`);
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
                    console.log(`[CRON] Posílám ${type} upozornění že začíná zápas: ${u.username} (${homeName} vs ${awayName})`);
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
            });
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
                        fs.unlink(filePath, err => {
                            if (!err) console.log(`[ÚKLID] Smazán starý notifikační obrázek: ${file}`);
                        });
                    }
                });
            }
        });
    });
});

module.exports = {
    notifyNewMatches,
    notifyResult,
    notifySeriesProgress,
    notifyMatchUpdate,
    notifyTransfer,
    notifyLeagueEnd,
    sendToUserDevices
};
