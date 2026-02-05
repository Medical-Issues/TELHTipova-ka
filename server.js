const express = require('express');
const path = require('path');
const bodyParser = require("body-parser");
const session = require("express-session");
const FileStore = require('session-file-store')(session);
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
require('dotenv').config();
const { backupJsonFilesToGitHub } = require('./utils/githubBackup');
const { loadJsonFilesFromGitHub } = require('./utils/githubLoadBackup');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({extended: true}));
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
// ... všechny tvé app.use a routes ...

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
            <img src="/images/logo.png" style="width: 300px" alt="Logo" class="logo">
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
    await backupJsonFilesToGitHub();

    app.listen(3000, () => {
        console.log('Server běží.');
    });

    setInterval(() => {
        console.log('⏰ Spouštím automatickou zálohu...');
        backupJsonFilesToGitHub();
    }, 60*5*1000);
}

startServer().then(() => {});
