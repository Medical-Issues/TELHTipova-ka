const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// --- NASTAVENÍ (Doplň své vygenerované klíče) ---
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

webpush.setVapidDetails(
    'mailto:admin@tvoje-domena.cz', // Kontaktní email pro službu
    publicVapidKey,
    privateVapidKey
);

// Pomocné funkce pro čtení dat (aby byly vždy aktuální)
const getUsers = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../data/users.json'), 'utf8'));
const getMatches = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../data/matches.json'), 'utf8'));

// Funkce pro odeslání jedné notifikace
const sendNotification = (subscription, payload) => {
    webpush.sendNotification(subscription, JSON.stringify(payload))
        .catch(err => console.error("Chyba odeslání notifikace:", err));
};

// Funkce pro odeslání všem, co mají odběr
const broadcast = (title, body) => {
    const users = getUsers();
    users.forEach(u => {
        if (u.subscription) {
            sendNotification(u.subscription, { title, body });
        }
    });
};

// --- A) NOVĚ VYPSANÝ ZÁPAS (S timerem 5 minut) ---
let newMatchTimer = null;

const notifyNewMatches = () => {
    // Pokud už běží odpočet, zrušíme ho a začneme znova (debounce)
    if (newMatchTimer) {
        clearTimeout(newMatchTimer);
        console.log("Timer resetován, čekám dalších 5 minut...");
    } else {
        console.log("Timer spuštěn, za 5 minut odešlu notifikaci...");
    }

    // Nastavíme nový odpočet na 5 minut (300 000 ms)
    newMatchTimer = setTimeout(() => {
        broadcast("Nové zápasy!", "Byli vypsány nové zápasy k tipování. Běž na to!");
        newMatchTimer = null;
        console.log("Notifikace o nových zápasech odeslána.");
    }, 5 * 60 * 1000);
};

// --- B) VÝSLEDEK ZÁPASU ---
const notifyResult = (matchId, scoreHome, scoreAway) => {
    const users = getUsers();
    const match = getMatches().find(m => m.id === matchId);
    if (!match) return;

    // Najdeme jména týmů (pokud je nemáš v objektu match, musíš načíst i teams.json)
    // Zde předpokládám zjednodušení
    const title = "Výsledek zápasu";
    const body = `Zápas skončil ${scoreHome}:${scoreAway}. Zkontroluj si body!`;

    users.forEach(u => {
        // Tady můžeš filtrovat, jestli měl uživatel tipnuto, abys nespamoval všechny
        if (u.subscription) {
            sendNotification(u.subscription, { title, body });
        }
    });
};

// --- C) PŘESTUPY ---
const notifyTransfer = (text) => {
    broadcast("Nový přestup!", text);
};

// --- D) VYHODNOCENÍ LIGY ---
const notifyLeagueEnd = (leagueName) => {
    broadcast("Liga vyhodnocena", `Liga ${leagueName} byla uzavřena. Podívej se, jak jsi dopadl.`);
};

// --- E) CRON: UPOZORNĚNÍ NA LOCK (Každou minutu) ---
// Kontroluje, jestli zápas začíná za 60 minut
cron.schedule('* * * * *', () => {
    const matches = getMatches();
    const users = getUsers();
    const now = new Date();

    // Rozmezí: zápas začíná za 60 až 61 minut
    const checkTimeStart = new Date(now.getTime() + 60 * 60 * 1000);
    const checkTimeEnd = new Date(now.getTime() + 61 * 60 * 1000);

    const matchesStartingSoon = matches.filter(m => {
        const mDate = new Date(m.datetime); // Předpokládám ISO formát
        return mDate >= checkTimeStart && mDate <= checkTimeEnd && !m.result;
    });

    matchesStartingSoon.forEach(match => {
        users.forEach(u => {
            if (!u.subscription) return;

            // Zjistíme, jestli má uživatel tip
            // !!! UPRAV SI CESTU K TIPŮM PODLE TVÉ STRUKTURY JSONU !!!
            // Příklad: u.tips['2024']['extraliga']...
            const userTipsForSeason = u.tips?.[match.season]?.[match.liga] || [];
            const hasTip = userTipsForSeason.find(t => t.matchId === match.id);

            // Pokud NEMÁ tip, pošleme upozornění
            if (!hasTip) {
                sendNotification(u.subscription, {
                    title: "⏳ Blíží se uzávěrka!",
                    body: `Za hodinu začíná zápas a nemáš tipnuto! Šup tam s tím.`
                });
            }
        });
    });
});

module.exports = {
    notifyNewMatches,
    notifyResult,
    notifyTransfer,
    notifyLeagueEnd,
    publicVapidKey // Exportujeme, abychom ho mohli poslat na frontend
};