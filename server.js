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
    const usersPath = path.join(__dirname, '../data/users.json');

    let users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));

    // --- HLAVNÍ LOGIKA: Jeden prohlížeč = jeden majitel ---
    // Projdeme všechny uživatele a pokud někdo už má tento přesný endpoint, smažeme mu ho.
    // Tím zajistíme, že se odběr "nepropíše" na dva lidi naráz na jednom PC.
    users.forEach(u => {
        if (u.subscriptions) {
            u.subscriptions = u.subscriptions.filter(sub => sub.endpoint !== subscription.endpoint);
        }
        // Ošetření starého formátu, pokud ho ještě někde máš
        if (u.subscription && u.subscription.endpoint === subscription.endpoint) {
            delete u.subscription;
        }
    });

    // --- PŘIDÁNÍ ODBĚRU AKTUÁLNÍMU UŽIVATELI ---
    const currentUser = users.find(u => u.username === username);
    if (currentUser) {
        if (!currentUser.subscriptions) currentUser.subscriptions = [];

        // Přidáme nový odběr (pokud tam už náhodou není)
        const exists = currentUser.subscriptions.some(s => s.endpoint === subscription.endpoint);
        if (!exists) {
            currentUser.subscriptions.push(subscription);
        }
    }

    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
    res.status(201).json({ message: "Odběr aktivován" });
});

app.post('/api/unsubscribe', (req, res) => {
    const username = req.session.user;
    // Frontend nám musí poslat endpoint zařízení, které chce smazat
    const { endpoint } = req.body;

    if (!username) return res.status(401).send('Nejste přihlášen');

    const usersPath = path.join(__dirname, 'data', 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    const userIndex = users.findIndex(u => u.username === username);

    if (userIndex !== -1) {
        const user = users[userIndex];

        if (user.subscriptions) {
            // Vyfiltrujeme pryč to zařízení, které se odhlašuje
            user.subscriptions = user.subscriptions.filter(s => s.endpoint !== endpoint);

            fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
            console.log(`🔕 Zařízení odebráno pro: ${username}`);
        }
        res.status(200).json({ message: "Odhlášeno" });
    } else {
        res.status(404).send('Uživatel nenalezen');
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
                .logo { width: 100px; margin-bottom: 20px; }
            </style>
        </head>
        <body>
            <img src="/images/logo.png" style="width: 400px" alt="Logo" class="logo">
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
