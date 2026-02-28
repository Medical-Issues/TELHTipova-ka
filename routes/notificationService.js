const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// --- NASTAVENÍ KLÍČŮ ---
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
    console.error("CHYBA: VAPID klíče nejsou nastaveny v souboru .env!");
}

webpush.setVapidDetails(
    'mailto:admin@tvoje-domena.cz', // Kontaktní email
    publicVapidKey,
    privateVapidKey
);

// --- POMOCNÉ FUNKCE PRO ČTENÍ DAT ---
// Používáme path.join a '..' pro vyskočení ze složky routes do rootu/data
const getUsers = () => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/users.json'), 'utf8')); }
    catch (e) { return []; }
};
const getMatches = () => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/matches.json'), 'utf8')); }
    catch (e) { return []; }
};
const getTeams = () => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, '../data/teams.json'), 'utf8')); }
    catch (e) { return []; }
};

// --- CORE FUNKCE PRO ODESÍLÁNÍ ---

// 1. Odeslání na jeden konkrétní endpoint (používá se pro admin test)
const sendDirectNotification = (subscription, payload) => {
    return webpush.sendNotification(subscription, JSON.stringify(payload));
};

// 2. Chytré odeslání uživateli (zvládne více zařízení i starý formát)
const sendToUserDevices = (user, payload) => {
    console.log(`Zkouším poslat notifikaci uživateli: ${user.username}`);
    const payloadString = JSON.stringify(payload);

    // A) Nový formát: Uživatel má pole 'subscriptions' (Mobil, PC, Tablet...)
    if (user.subscriptions && Array.isArray(user.subscriptions)) {
        user.subscriptions.forEach(sub => {
            webpush.sendNotification(sub, payloadString)
                .catch(err => {
                    // 410 Gone = Zařízení už neexistuje/odhlášeno
                    if (err.statusCode === 410) {
                        console.log(`Zařízení uživatele ${user.username} je nedostupné (410).`);
                    } else {
                        console.error(`Chyba notifikace pro ${user.username}:`, err.statusCode);
                    }
                });
        });
    }
    // B) Starý formát: Uživatel má jen jedno 'subscription'
    else if (user.subscription) {
        webpush.sendNotification(user.subscription, payloadString)
            .catch(err => console.error(`Chyba (single) pro ${user.username}:`, err));
    }
};

// 3. Broadcast - Pošle zprávu VŠEM uživatelům s notifikacemi
const broadcast = (title, body) => {
    const users = getUsers();
    users.forEach(u => {
        // Použijeme chytrou funkci, která si poradí s poli i objekty
        sendToUserDevices(u, { title, body, icon: '/images/logo.png' });
    });
};


// --- LOGIKA UDÁLOSTÍ ---

// A) NOVĚ VYPSANÝ ZÁPAS (S timerem 5 minut)
let newMatchTimer = null;

const notifyNewMatches = () => {
    // Reset timeru (debounce)
    if (newMatchTimer) {
        clearTimeout(newMatchTimer);
        console.log("Timer resetován, čekám dalších 5 minut...");
    } else {
        console.log("Timer spuštěn, za 5 minut odešlu notifikaci...");
    }

    // 5 minut = 300 000 ms
    newMatchTimer = setTimeout(() => {
        broadcast("Nové zápasy!", "Právě byly vypsány nové zápasy k tipování. Běž na to!");
        newMatchTimer = null;
        console.log("📢 Notifikace o nových zápasech odeslána.");
    }, 5 * 60 * 1000);
};

// B) VÝSLEDEK ZÁPASU
const notifyResult = (matchId, scoreHome, scoreAway) => {
    const users = getUsers();
    const matches = getMatches();
    const teams = getTeams();

    const match = matches.find(m => m.id === matchId);
    if (!match) return;

    // Zkusíme najít jména týmů podle ID, jinak použijeme '???'
    const homeTeamName = teams.find(t => t.id === match.homeTeamId)?.name || 'Domácí';
    const awayTeamName = teams.find(t => t.id === match.awayTeamId)?.name || 'Hosté';

    const title = "Výsledek zápasu";
    const body = `${homeTeamName} vs ${awayTeamName} - ${scoreHome}:${scoreAway}.`;

    users.forEach(u => {
        // Zde by šlo přidat logiku: poslat jen těm, co měli tipnuto
        // Prozatím posíláme všem, co mají odběr
        sendToUserDevices(u, { title, body, icon: '/images/logo.png' });
    });
};

// C) PŘESTUPY
const notifyTransfer = (text) => {
    broadcast("Přestupová bomba! 💣", text);
};

// D) VYHODNOCENÍ LIGY
const notifyLeagueEnd = (leagueName) => {
    broadcast("Liga vyhodnocena 🏆", `Liga ${leagueName} byla uzavřena. Podívej se, jak jsi dopadl!`);
};

// E) CRON: UPOZORNĚNÍ NA LOCK (Každou minutu)
// Kontroluje, jestli zápas začíná za 60 minut
cron.schedule('* * * * *', () => {
    const matches = getMatches();
    const users = getUsers();
    const teams = getTeams();
    const now = new Date();

    const oneHourMS = 60 * 60 * 1000;
    const fourHoursMS = 240 * 60 * 1000;
    const margin = 60 * 1000; // 1 minuta tolerance, aby se trefil CRON

    matches.forEach(match => {
        if (match.result) return; // Zápas už skončil

        const mDate = new Date(match.datetime);
        const diff = mDate.getTime() - now.getTime();

        let notificationType = null;

        // Kontrola 4 hodiny předem
        if (diff >= (fourHoursMS - margin) && diff <= fourHoursMS) {
            notificationType = "4h";
        }
        // Kontrola 1 hodinu předem
        else if (diff >= (oneHourMS - margin) && diff <= oneHourMS) {
            notificationType = "1h";
        }

        // Pokud jsme se trefili do jednoho z oken, jdeme na uživatele
        if (notificationType) {
            const homeName = teams.find(t => Number(t.id) === Number(match.homeTeamId))?.name || 'Domácí';
            const awayName = teams.find(t => Number(t.id) === Number(match.awayTeamId))?.name || 'Hosté';

            users.forEach(u => {
                const hasSub = (u.subscriptions && u.subscriptions.length > 0) || u.subscription;
                if (!hasSub) return;

                const userTipsForSeason = u.tips?.[match.season]?.[match.liga] || [];
                const hasTip = userTipsForSeason.find(t => Number(t.matchId) === Number(match.id));

                if (!hasTip) {
                    const timeText = notificationType === "4h" ? "4 hodiny" : "hodinu";

                    console.log(`[CRON] Posílám ${notificationType} upozornění: ${u.username} (${homeName} vs ${awayName})`);

                    sendToUserDevices(u, {
                        title: notificationType === "4h" ? "🔔 Nezapomeň si tipnout!" : "⏳ Poslední šance!",
                        body: `Za ${timeText} začíná zápas ${homeName} vs ${awayName}. Ještě nemáš tipnuto!`,
                        icon: '/images/logo.png'
                    });
                }
            });
        }
    });
});

module.exports = {
    notifyNewMatches,
    notifyResult,
    notifyTransfer,
    notifyLeagueEnd,
    publicVapidKey,
    sendNotification: sendDirectNotification,
    sendToUserDevices,
};