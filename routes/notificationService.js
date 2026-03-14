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

    // 2. Projdeme všechna zařízení uživatele a odešleme notifikaci
    const promises = user.subscriptions.map(sub => {
        return webpush.sendNotification(sub, JSON.stringify(payload))
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
    Promise.all(promises).then(() => {
        if (hasChanges) {
            user.subscriptions = activeSubscriptions;
            const users = getUsers();
            const userIndex = users.findIndex(u => u.username === user.username);
            if (userIndex !== -1) {
                users[userIndex].subscriptions = activeSubscriptions;
                // Úklid starého klíče, pokud existoval
                delete users[userIndex].subscription;
                fs.writeFileSync(path.join(__dirname, '../data/users.json'), JSON.stringify(users, null, 2));
            }
        }
    });
};

// --- NOTIFIKAČNÍ FUNKCE PRO RŮZNÉ UDÁLOSTI ---

const notifyNewMatches = () => {
    const payload = {
        title: "🏒 Nové zápasy/série!",
        body: "Byly vypsány nové zápasy k tipování. Nezapomeň si tipnout!",
        icon: '/images/logo.png',
        url: '/'
    };
    getUsers().forEach(u => sendToUserDevices(u, payload));
};

const notifyResult = (matchId, scoreHome, scoreAway) => {
    const matches = getMatches();
    const match = matches.find(m => m.id === parseInt(matchId));
    if (!match) return;

    const teams = getTeams();
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

    const payload = {
        title,
        body,
        icon: '/images/logo.png',
        url: `/?liga=${encodeURIComponent(match.liga)}`
    };

    getUsers().forEach(u => sendToUserDevices(u, payload));
};

// PRŮBĚŽNÝ STAV SÉRIE (Nová smysluplná funkce pro jednotlivé zápasy série)
const notifySeriesProgress = (matchId, matchIndex, scoreHome, scoreAway, ot, seriesScoreH, seriesScoreA) => {
    const matches = getMatches();
    const match = matches.find(m => m.id === parseInt(matchId));
    if (!match) return;

    const teams = getTeams();
    const homeTeam = teams.find(t => t.id === match.homeTeamId);
    const awayTeam = teams.find(t => t.id === match.awayTeamId);
    if (!homeTeam || !awayTeam) return;

    const otText = ot ? " pp" : "";
    const payload = {
        title: `🏒 Playoff: ${homeTeam.name} vs ${awayTeam.name}`,
        body: `${matchIndex}. zápas: ${scoreHome}:${scoreAway}${otText} | Průběžný stav série: ${seriesScoreH}:${seriesScoreA}`,
        icon: '/images/logo.png',
        url: `/?liga=${encodeURIComponent(match.liga)}`
    };

    getUsers().forEach(u => sendToUserDevices(u, payload));
};

const notifyMatchUpdate = (matchId, details) => {
    const matches = getMatches();
    const match = matches.find(m => m.id === parseInt(matchId));
    if (!match) return;

    const teams = getTeams();
    const homeTeam = teams.find(t => t.id === match.homeTeamId);
    const awayTeam = teams.find(t => t.id === match.awayTeamId);

    if (!homeTeam || !awayTeam) return;

    const matchTypeStr = (match.isPlayoff && match.bo > 1) ? "série" : "zápasu";

    const payload = {
        title: `⚠️ Změna u ${matchTypeStr}!`,
        body: `${homeTeam.name} vs ${awayTeam.name}\nDetaily: ${details}`,
        icon: '/images/logo.png',
        url: `/?liga=${encodeURIComponent(match.liga)}`
    };

    getUsers().forEach(u => sendToUserDevices(u, payload));
};

const notifyTransfer = (message) => {
    const payload = {
        title: "🔄 Nové přestupy!",
        body: message,
        icon: '/images/logo.png',
        url: '/prestupy'
    };
    getUsers().forEach(u => sendToUserDevices(u, payload));
};

const notifyLeagueEnd = (liga) => {
    const payload = {
        title: "🏁 Základní část skončila!",
        body: `Základní část ligy ${liga} byla ukončena. Podívej se na konečné pořadí a rozdělení bodů za tabulku!`,
        icon: '/images/logo.png',
        url: `/history/table/?liga=${encodeURIComponent(liga)}`
    };
    getUsers().forEach(u => sendToUserDevices(u, payload));
};

// --- AUTOMATICKÉ NOTIFIKACE (CRON) ---
cron.schedule('0 * * * *', () => {
    const now = new Date();
    const matches = getMatches();
    const users = getUsers();

    if (!users || users.length === 0) return;

    const targetTimes = [
        { diffMs: 4 * 60 * 60 * 1000, type: "4h" },
        { diffMs: 60 * 60 * 1000, type: "1h" }
    ];

    targetTimes.forEach(({ diffMs, type }) => {
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

        if (upcomingMatches.length === 0) return;

        const teams = getTeams();

        upcomingMatches.forEach(match => {
            const homeName = teams.find(t => t.id === match.homeTeamId)?.name || 'Neznámý tým';
            const awayName = teams.find(t => t.id === match.awayTeamId)?.name || 'Neznámý tým';

            const isSeries = match.isPlayoff && match.bo > 1;
            const matchTypeStr = isSeries ? "sérii" : "zápas";
            const matchTypeSubj = isSeries ? "série" : "zápas";

            users.forEach(u => {
                if (!u.subscriptions || u.subscriptions.length === 0) return;

                const userTipsForSeason = u.tips?.[match.season]?.[match.liga] || [];
                const hasTip = userTipsForSeason.find(t => Number(t.matchId) === Number(match.id));

                if (!hasTip) {
                    const timeText = type === "4h" ? "4 hodiny" : "hodinu";
                    console.log(`[CRON] Posílám ${type} upozornění že nemá tip: ${u.username} (${homeName} vs ${awayName})`);
                    sendToUserDevices(u, {
                        title: type === "4h" ? "🔔 Nezapomeň si tipnout!" : "⏳ Poslední šance!",
                        body: `Za ${timeText} začíná ${matchTypeSubj} ${homeName} vs ${awayName}. Ještě nemáš tipnuto na tuto ${matchTypeStr}!`,
                        icon: '/images/logo.png',
                        url: `/?liga=${encodeURIComponent(match.liga)}`
                    });
                } else if (hasTip && type === "1h") {
                    console.log(`[CRON] Posílám ${type} upozornění že začíná zápas: ${u.username} (${homeName} vs ${awayName})`);
                    sendToUserDevices(u, {
                        title: "⏳ Za hodinu už si nezměníš tip!",
                        body: `Za hodinu začíná ${matchTypeSubj} ${homeName} vs ${awayName}.`,
                        icon: '/images/logo.png',
                        url: `/?liga=${encodeURIComponent(match.liga)}`
                    });
                }
            });
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