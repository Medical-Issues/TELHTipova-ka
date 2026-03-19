const express = require('express');
const path = require('path');
const bodyParser = require("body-parser");
const session = require("express-session");
const FileStore = require('session-file-store')(session);
const fs = require('fs');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const { Users } = require('./utils/mongoDataAccess');

require('dotenv').config();

// MongoDB připojení
const { connectToDatabase } = require('./config/database');
const {backupJsonFilesToGitHub} = require("./utils/githubBackup");
const {restoreFromGitHub, fullRestoreFromGitHub} = require("./utils/githubRestore");

const app = express();

// Vytvoření sessions adresáře pokud neexistuje
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/logoteamu', express.static(path.join(__dirname, 'data', 'images')));
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

app.use(session({
    store: new FileStore({
        path: sessionsDir
    }),
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

// Admin endpoint pro manuální restore z GitHubu
app.post('/admin/restore-from-github', (req, res) => {
    // Zde by měla být auth kontrola, ale pro jednoduchost ji vynecháváme
    if (!process.env.GITHUB_TOKEN) {
        return res.status(400).json({ success: false, message: 'GITHUB_TOKEN není nastaven' });
    }
    
    restoreFromGitHub().then(success => {
        if (success) {
            res.json({ success: true, message: 'Restore obrázků z GitHubu úspěšný' });
        } else {
            res.status(500).json({ success: false, message: 'Restore obrázků z GitHubu selhal' });
        }
    }).catch(error => {
        res.status(500).json({ success: false, message: error.message });
    });
});

// Admin endpoint pro kompletní restore (JSON + obrázky) - pro nouzové případy
app.post('/admin/full-restore-from-github', (req, res) => {
    if (!process.env.GITHUB_TOKEN) {
        return res.status(400).json({ success: false, message: 'GITHUB_TOKEN není nastaven' });
    }
    
    fullRestoreFromGitHub().then(success => {
        if (success) {
            res.json({ success: true, message: 'Kompletní restore (JSON + obrázky) z GitHubu úspěšný' });
        } else {
            res.status(500).json({ success: false, message: 'Kompletní restore z GitHubu selhal' });
        }
    }).catch(error => {
        res.status(500).json({ success: false, message: error.message });
    });
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
app.post('/api/subscribe', async (req, res) => {
    // 1. Kontrola přihlášení
    if (!req.session.user) {
        return res.status(401).json({ error: "Pro zapnutí notifikací musíš být přihlášen." });
    }

    const subscription = req.body;
    // Základní validace dat z prohlížeče
    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ error: "Neplatná data odběru." });
    }

    let users = [];

    try {
        users = await Users.findAll();
    } catch (e) {
        console.error("Chyba při čtení z MongoDB:", e);
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
            await Users.updateAll(users);
            console.log(`✅ Notifikace nastaveny pro uživatele: ${req.session.user}`);
            res.status(201).json({ success: true });
        } catch (err) {
            console.error("Chyba při zápisu do MongoDB:", err);
            res.status(500).json({ error: "Nepodařilo se uložit data na server." });
        }
    } else {
        res.status(404).json({ error: "Uživatel nenalezen v databázi." });
    }
});

app.post('/api/check-subscription', async (req, res) => {
    const { endpoint } = req.body;
    const username = req.session.user;

    if (!username || !endpoint) {
        return res.json({ belongsToMe: false });
    }

    try {
        const users = await Users.findAll();
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
app.post('/api/check-subscription-legacy', async (req, res) => {
    const { endpoint } = req.body;
    const users = await Users.findAll();
    const user = users.find(u => u.username === req.session.user);

    const belongsToMe = user?.subscriptions?.some(sub => sub.endpoint === endpoint) || false;
    res.json({ belongsToMe });
});

// Odhlášení z notifikací
app.post('/api/unsubscribe', async (req, res) => {
    const { endpoint } = req.body;
    let users = await Users.findAll();

    const userIndex = users.findIndex(u => u.username === req.session.user);
    if (userIndex !== -1 && users[userIndex].subscriptions) {
        users[userIndex].subscriptions = users[userIndex].subscriptions.filter(sub => sub.endpoint !== endpoint);
        await Users.updateAll(users);
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
    // Připojení k MongoDB
    await connectToDatabase();

    // Automatický restore obrázků z GitHubu při startu
    if (process.env.GITHUB_TOKEN) {
        console.log('🔄 Spouštím automatický restore obrázků z GitHubu...');
        const restoreSuccess = await restoreFromGitHub();
        if (restoreSuccess) {
            console.log('✅ Restore obrázků z GitHubu úspěšný');
        } else {
            console.log('⚠️ Restore obrázků z GitHubu selhal, pokračuji bez něj');
        }
    } else {
        console.log('⚠️ GITHUB_TOKEN nenalezen, přeskočuji restore z GitHubu');
    }

    app.listen(3000, () => {
        console.log('Server běží.');
    });

    setInterval(() => {
        console.log('⏰ Spouštím automatickou zálohu...');
        backupJsonFilesToGitHub();
    }, 60*60*1000*24);
}

startServer().then(() => {});
