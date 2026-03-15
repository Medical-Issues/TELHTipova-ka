const express = require('express');
const path = require('path');
const bodyParser = require("body-parser");
const session = require("express-session");
const FileStore = require('session-file-store')(session);
const fs = require('fs');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');

require('dotenv').config();
const { backupJsonFilesToGitHub } = require('./utils/githubBackup');
const { loadJsonFilesFromGitHub } = require('./utils/githubLoadBackup');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/logoteamu', express.static(path.join(__dirname, 'data', 'images')));
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

app.use(session({
    store: new FileStore({}),
    secret: 'tajnyklic',
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 30,
    }
}));
app.get('/wake', (req, res) => {
    res.send('OK');
});

app.use('/auth', authRoutes);
app.use('/', userRoutes)
app.use('/admin', adminRoutes);

app.get('/api/vapid-public-key', (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY) {
        return res.status(500).send("VAPID_PUBLIC_KEY chybí na serveru");
    }
    res.send(process.env.VAPID_PUBLIC_KEY);
});

// 2. Uložení odběru k uživateli
app.post('/api/subscribe', (req, res) => {
    // 1. Kontrola přihlášení
    if (!req.session.user) {
        return res.status(401).json({ error: "Pro zapnutí notifikací musíš být přihlášen." });
    }

    const subscription = req.body;
    // Základní validace dat z prohlížeče
    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ error: "Neplatná data odběru." });
    }

    const usersPath = path.join(__dirname, 'data', 'users.json');
    let users = [];

    try {
        users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    } catch (e) {
        console.error("Chyba při čtení users.json:", e);
        return res.status(500).json({ error: "Chyba databáze." });
    }

    // --- KLÍČOVÁ ČÁST: VYČIŠTĚNÍ STARÝCH VAZEB ---
    // Projdeme všechny uživatele a pokud někdo jiný používá tento prohlížeč (endpoint), smažeme mu ho
    users = users.map(u => {
        if (u.subscriptions) {
            u.subscriptions = u.subscriptions.filter(sub => sub.endpoint !== subscription.endpoint);
        }
        return u;
    });

    // --- PŘIŘAZENÍ AKTUÁLNÍMU UŽIVATELI ---
    const userIndex = users.findIndex(u => u.username === req.session.user);
    if (userIndex !== -1) {
        if (!users[userIndex].subscriptions) {
            users[userIndex].subscriptions = [];
        }

        // Přidáme nový odběr aktuálnímu uživateli
        users[userIndex].subscriptions.push(subscription);

        try {
            fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
            console.log(`✅ Notifikace nastaveny pro uživatele: ${req.session.user}`);
            res.status(201).json({ success: true });
        } catch (err) {
            console.error("Chyba při zápisu do users.json:", err);
            res.status(500).json({ error: "Nepodařilo se uložit data na server." });
        }
    } else {
        res.status(404).json({ error: "Uživatel nenalezen v databázi." });
    }
});

app.post('/api/check-subscription', (req, res) => {
    const { endpoint } = req.body;
    const username = req.session.user;

    if (!username || !endpoint) {
        return res.json({ belongsToMe: false });
    }

    try {
        const usersPath = path.join(__dirname, 'data', 'users.json');
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        const user = users.find(u => u.username === username);

        if (!user) return res.json({ belongsToMe: false });

        // DŮLEŽITÉ: Kontrola v poli subscriptions
        const hasIt = user.subscriptions && user.subscriptions.some(s => s.endpoint === endpoint);

        console.log(`[Stav] Uživatel: ${username}, nalezen odběr: ${!!hasIt}`);
        res.json({ belongsToMe: !!hasIt });
    } catch (e) {
        console.error("Chyba check-subscription:", e);
        res.json({ belongsToMe: false });
    }
});

// Kontrola, jestli uživatel už má tento endpoint (používalo tvé staré user.js)
app.post('/api/check-subscription', (req, res) => {
    const { endpoint } = req.body;
    const users = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));
    const user = users.find(u => u.username === req.session.user);

    const belongsToMe = user?.subscriptions?.some(sub => sub.endpoint === endpoint) || false;
    res.json({ belongsToMe });
});

// Odhlášení z notifikací
app.post('/api/unsubscribe', (req, res) => {
    const { endpoint } = req.body;
    const usersPath = path.join(__dirname, 'data', 'users.json');
    let users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));

    const userIndex = users.findIndex(u => u.username === req.session.user);
    if (userIndex !== -1 && users[userIndex].subscriptions) {
        users[userIndex].subscriptions = users[userIndex].subscriptions.filter(sub => sub.endpoint !== endpoint);
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
    }
    res.json({ success: true });
});

// 404 Handler - Zachytí vše, co nebylo vyřešeno výše
app.use((req, res) => {
    res.status(404).send(`
        <!DOCTYPE html>
        <html lang="cs">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Stránka nenalezena</title>
            <link rel="icon" href="/images/logo.png">
            <style>
                body { background-color: #121212; color: white; font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
                h1 { color: orangered; font-size: 3em; margin-bottom: 0.2em; }
                p { font-size: 1.2em; color: #ccc; }
                a { color: white; text-decoration: underline; margin-top: 20px; font-size: 1.1em; }
                a:hover { color: orangered; }
                .logo { width: 400px; margin-bottom: 20px; }
            </style>
        </head>
        <body>
            <img src="/images/logo.png" alt="Logo" class="logo">
            <h1>404</h1>
            <p>Jejda! Tuhle stránku jsme nenašli.</p>
            <p>Asi jsi zabloudil mimo mantinely.</p>
            <a href="/">Vrátit se na střídačku (Domů)</a>
        </body>
        </html>
    `);
});

// app.listen(...)
async function startServer() {
    await loadJsonFilesFromGitHub();

    app.listen(3000, () => {
        console.log('Server běží.');
    });

    setInterval(() => {
        console.log('⏰ Spouštím automatickou zálohu...');
        backupJsonFilesToGitHub();
    }, 60*5*1000);
}

startServer().then(() => {});
