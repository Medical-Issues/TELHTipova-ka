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

const sendDirectNotification = (subscription, payload) => {
    return webpush.sendNotification(subscription, JSON.stringify(payload));
};

// --- PŘIDANÁ FUNKCE PRO ÚKLID MRTVÝCH ODBĚRŮ (Chyba 410) ---
const removeInvalidSubscription = (username, endpointToRemove) => {
    const usersPath = path.join(__dirname, '../data/users.json');
    try {
        let users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        const userIndex = users.findIndex(u => u.username === username);

        if (userIndex > -1) {
            let changed = false;
            const user = users[userIndex];

            // Kontrola pro starý formát (single subscription)
            if (user.subscription && user.subscription.endpoint === endpointToRemove) {
                delete user.subscription;
                changed = true;
            }

            // Kontrola pro nový formát (pole subscriptions)
            if (user.subscriptions && Array.isArray(user.subscriptions)) {
                const originalLength = user.subscriptions.length;
                user.subscriptions = user.subscriptions.filter(s => s.endpoint !== endpointToRemove);
                if (user.subscriptions.length < originalLength) changed = true;
            }

            if (changed) {
                fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
                console.log(`🗑️ Mrtvý odběr (410) pro uživatele ${username} byl smazán z databáze.`);
            }
        }
    } catch (e) {
        console.error("Chyba při mazání neplatného odběru:", e);
    }
};

const sendToUserDevices = (user, payload) => {
    console.log(`Zkouším poslat notifikaci uživateli: ${user.username}`);
    const payloadString = JSON.stringify(payload);

    // A) Nový formát: Uživatel má pole 'subscriptions'
    if (user.subscriptions && Array.isArray(user.subscriptions)) {
        user.subscriptions.forEach(sub => {
            webpush.sendNotification(sub, payloadString)
                .catch(err => {
                    if (err.statusCode === 410) {
                        removeInvalidSubscription(user.username, sub.endpoint);
                    } else {
                        console.error(`Chyba notifikace pro ${user.username}:`, err.statusCode);
                    }
                });
        });
    }
    // B) Starý formát: Uživatel má jen jedno 'subscription'
    else if (user.subscription) {
        webpush.sendNotification(user.subscription, payloadString)
            .catch(err => {
                if (err.statusCode === 410) {
                    removeInvalidSubscription(user.username, user.subscription.endpoint);
                } else {
                    console.error(`Chyba (single) pro ${user.username}:`, err.statusCode || err);
                }
            });
    }
};

const broadcast = (title, body) => {
    const users = getUsers();
    users.forEach(u => {
        sendToUserDevices(u, { title, body, icon: '/images/logo.png' });
    });
};

// --- LOGIKA UDÁLOSTÍ ---

let newMatchTimer = null;
const notifyNewMatches = () => {
    if (newMatchTimer) {
        clearTimeout(newMatchTimer);
        console.log("Timer resetován, čekám dalších 5 minut...");
    } else {
        console.log("Timer spuštěn, za 5 minut odešlu notifikaci...");
    }

    newMatchTimer = setTimeout(() => {
        broadcast("Nové zápasy!", "Právě byly vypsány nové zápasy k tipování. Běž na to!");
        newMatchTimer = null;
        console.log("📢 Notifikace o nových zápasech odeslána.");
    }, 5 * 60 * 1000);
};

const notifyResult = (matchId, scoreHome, scoreAway) => {
    const users = getUsers();
    const matches = getMatches();
    const teams = getTeams();

    const match = matches.find(m => m.id === matchId);
    if (!match) return;

    const homeTeamName = teams.find(t => t.id === match.homeTeamId)?.name || 'Domácí';
    const awayTeamName = teams.find(t => t.id === match.awayTeamId)?.name || 'Hosté';

    const title = "Výsledek zápasu";
    const body = `${homeTeamName} vs ${awayTeamName} - ${scoreHome}:${scoreAway}.`;

    users.forEach(u => {
        sendToUserDevices(u, { title, body, icon: '/images/logo.png' });
    });
};

const notifyMatchUpdate = (matchId, changesText) => {
    const users = getUsers();
    const matches = getMatches();
    const teams = getTeams();

    const match = matches.find(m => Number(m.id) === Number(matchId));
    if (!match) return;

    const homeTeamName = teams.find(t => Number(t.id) === Number(match.homeTeamId))?.name || 'Domácí';
    const awayTeamName = teams.find(t => Number(t.id) === Number(match.awayTeamId))?.name || 'Hosté';

    const title = "Úprava zápasu ✏️";
    // Do těla zprávy dáme název zápasu a pod to text s tím, co se změnilo
    const body = `${homeTeamName} vs ${awayTeamName}\nZměna: ${changesText}`;

    users.forEach(u => {
        sendToUserDevices(u, { title, body, icon: '/images/logo.png' });
    });
};

const notifyTransfer = (text) => {
    broadcast("Přestupová bomba! 💣", text);
};

const notifyLeagueEnd = (leagueName) => {
    broadcast("Liga vyhodnocena 🏆", `Liga ${leagueName} byla uzavřena. Podívej se, jak jsi dopadl!`);
};

// E) CRON: UPOZORNĚNÍ NA LOCK (Každou minutu)
cron.schedule('* * * * *', () => {
    const matches = getMatches();
    const users = getUsers();
    const teams = getTeams();

    // 1. Získáme naprosto přesný aktuální čas v Praze ve formátu YYYY-MM-DDTHH:mm:ss
    const currentPragueTimeISO = new Date().toLocaleString('sv-SE', {timeZone: 'Europe/Prague'}).replace(' ', 'T');

    // 2. Převedeme ho na milisekundy tak, že k němu uměle přidáme "Z" (aby ho Node.js načetl konzistentně kdekoli)
    const nowMs = new Date(currentPragueTimeISO + "Z").getTime();

    const oneHourMS = 60 * 60 * 1000;
    const fourHoursMS = 240 * 60 * 1000;
    const margin = 60 * 1000; // 1 minuta tolerance

    matches.forEach(match => {
        // Pokud je zápas odložený nebo manuálně zamčený, neposíláme upozornění (uživatel stejně nemůže tipovat)
        if (match.postponed || match.locked) {
            return; // Přeskočí tento zápas a jde na další
        }
        if (match.result) return; // Zápas už skončil
        if (!match.datetime) return; // Chybí čas

        // 3. I k času zápasu (který ukládáš v pražském čase z administrace) přidáme "Z"
        // Takto spočítáme čistý matematický rozdíl a nezajímá nás, v jakém pásmu server hostingu běží.
        const matchMs = new Date(match.datetime + "Z").getTime();

        const diff = matchMs - nowMs;

        let notificationType = null;

        // Kontrola 4 hodiny předem
        if (diff >= (fourHoursMS - margin) && diff <= fourHoursMS) {
            notificationType = "4h";
        }
        // Kontrola 1 hodinu předem
        else if (diff >= (oneHourMS - margin) && diff <= oneHourMS) {
            notificationType = "1h";
        }

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
                    console.log(`[CRON] Posílám ${notificationType} upozornění že nemá tip: ${u.username} (${homeName} vs ${awayName})`);
                    sendToUserDevices(u, {
                        title: notificationType === "4h" ? "🔔 Nezapomeň si tipnout!" : "⏳ Poslední šance!",
                        body: `Za ${timeText} začíná zápas ${homeName} vs ${awayName}. Ještě nemáš tipnuto!`,
                        icon: '/images/logo.png'
                    });
                } else if (hasTip && notificationType === "1h") {
                    console.log(`[CRON] Posílám ${notificationType} upozornění že začíná zápas: ${u.username} (${homeName} vs ${awayName})`);
                    sendToUserDevices(u, {
                        title: "⏳ Za hodinu už si nezměníš tip!",
                        body: `Za hodinu začíná zápas ${homeName} vs ${awayName}.`,
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
    notifyMatchUpdate,
    notifyTransfer,
    notifyLeagueEnd,
    publicVapidKey,
    sendNotification: sendDirectNotification,
    sendToUserDevices,
    removeInvalidSubscription,
};