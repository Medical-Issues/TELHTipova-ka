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
app.post('/api/subscribe', (req, res) => {
    const subscription = req.body;
    const username = req.session.user;

    if (!username) return res.status(401).send('Nejste přihlášen');

    const usersPath = path.join(__dirname, 'data', 'users.json');

    try {
        let users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));

        // 1. Odstraníme tento endpoint od kohokoliv jiného
        users.forEach(u => {
            if (u.subscriptions) {
                u.subscriptions = u.subscriptions.filter(sub => sub.endpoint !== subscription.endpoint);
            }
        });

        // 2. Přidáme k aktuálnímu uživateli
        const user = users.find(u => u.username === username);
        if (user) {
            if (!user.subscriptions) user.subscriptions = [];
            user.subscriptions.push(subscription);

            // ZÁPIS DO SOUBORU
            fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
            console.log(`✅ Odběr fyzicky zapsán do users.json pro: ${username}`);
            console.log(`📊 Počet aktivních zařízení uživatele: ${user.subscriptions.length}`);
        }

        res.status(201).json({ message: "OK" });
    } catch (e) {
        console.error("❌ CHYBA PŘI ZÁPISU:", e);
        res.status(500).send("Chyba databáze");
    }
});

app.post('/api/unsubscribe', (req, res) => {
    const username = req.session.user;
    const { endpoint } = req.body; // Frontend posílá konkrétní endpoint k smazání

    if (!username) return res.status(401).send('Nejste přihlášen');
    if (!endpoint) return res.status(400).send('Chybí endpoint zařízení');

    const usersPath = path.join(__dirname, 'data', 'users.json');

    try {
        let users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        const user = users.find(u => u.username === username);

        if (user && user.subscriptions) {
            // Odebereme pouze to jedno konkrétní zařízení (např. jen PC, mobil zůstane)
            const initialCount = user.subscriptions.length;
            user.subscriptions = user.subscriptions.filter(s => s.endpoint !== endpoint);

            if (user.subscriptions.length < initialCount) {
                fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
                console.log(`🔕 Zařízení (endpoint) odebráno pro: ${username}`);
            }
        }
        res.status(200).json({ message: "Zařízení odhlášeno" });

    } catch (error) {
        console.error("Chyba při unsubscribe:", error);
        res.status(500).send("Chyba serveru");
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
