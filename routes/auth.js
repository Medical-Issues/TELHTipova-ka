const path = require('path');
const bcrypt = require("bcrypt");
const express = require("express");
const router = express.Router();
const { renderErrorHtml } = require("../utils/fileUtils");
const { Settings, Users } = require('../utils/mongoDataAccess');

// Jednoduchý brute force protection - max 5 pokusů za 15 minut na IP
const loginAttempts = new Map();

// Funkce pro logování neúspěšných pokusů do MongoDB
async function logFailedLogin(ip, username, reason) {
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const logsCollection = db.collection('failed_logins');
        
        await logsCollection.insertOne({
            timestamp: new Date(),
            ip: ip,
            username: username || 'unknown',
            reason: reason, // 'user_not_found' nebo 'wrong_password'
            userAgent: req?.get('User-Agent') || 'unknown'
        });
    } catch (error) {
        // Ignorovat chyby logování - nesmí blokovat přihlášení
        console.error('Failed to log failed login:', error.message);
    }
}

function checkBruteForce(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!loginAttempts.has(ip)) {
        loginAttempts.set(ip, []);
    }
    
    const attempts = loginAttempts.get(ip);
    // Odstranit staré pokusy (> 15 minut)
    const recentAttempts = attempts.filter(time => now - time < 15 * 60 * 1000);
    loginAttempts.set(ip, recentAttempts);
    
    if (recentAttempts.length >= 5) {
        return res.status(429).send("Příliš mnoho pokusů o přihlášení. Zkus to znovu za 15 minut.");
    }
    
    next();
}
router.get("/register", (req, res) => {
    res.sendFile(path.join(__dirname, "../views/register.html"));
});
router.post("/register", async (req, res) => {
    let {username, password} = req.body;
    
    // Validace - username musí být string
    if (typeof username !== 'string' || typeof password !== 'string') {
        return renderErrorHtml(res, "Neplatný formát dat.", 400);
    }
    
    // Odstranit mezery
    username = username.trim();
    
    if (!username || !password) {
        return renderErrorHtml(res, "Username a password jsou povinné.", 400);
    }
    
    // Kontrola, zda jsou registrace blokovány
    const settings = await Settings.findAll();
    if (settings && settings.registrationsBlocked) {
        return renderErrorHtml(res, "Registrace jsou aktuálně blokovány administrátorem. Zkuste to prosím později.", 403);
    }
    
    // Kontrola existence uživatele v MongoDB
    const existingUser = await Users.findOne({ username: username.toString() });
    
    if (existingUser) {
        return res.redirect('/auth/register?error=1');
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = {
            username,
            password: hashedPassword,
            role: "user",
            correct: 0,
            total: 0
        };
        
        // Uložení do MongoDB
        await Users.insertOne(newUser);
        
        res.redirect('/auth/login');
    } catch (err) {
        console.error(err);
        await renderErrorHtml(res, "Při registraci nastala chyba. Zkuste to prosím později.");
    }
});

router.get("/login", (req, res) => {
    res.sendFile(path.join(__dirname, "../views/login.html"));
});

router.post('/login', checkBruteForce, async (req, res) => {
    let {username, password} = req.body;
    
    // Validace - username musí být string
    if (typeof username !== 'string' || typeof password !== 'string') {
        return res.redirect('/auth/login?error=1');
    }
    
    username = username.trim();
    
    // Načtení uživatele z MongoDB - explicitně jako string
    const user = await Users.findOne({ username: username.toString() });

    if (!user) {
        // Zaznamenat neúspěšný pokus
        const ip = req.ip || req.connection.remoteAddress;
        if (loginAttempts.has(ip)) {
            loginAttempts.get(ip).push(Date.now());
        }
        // Logovat do DB
        await logFailedLogin(ip, username, 'user_not_found');
        return res.redirect('/auth/login?error=1');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
        // Zaznamenat neúspěšný pokus
        const ip = req.ip || req.connection.remoteAddress;
        if (loginAttempts.has(ip)) {
            loginAttempts.get(ip).push(Date.now());
        }
        // Logovat do DB
        await logFailedLogin(ip, username, 'wrong_password');
        return res.redirect("/auth/login?error=1");
    }

    // Reset pokusů po úspěšném přihlášení
    const ip = req.ip || req.connection.remoteAddress;
    loginAttempts.delete(ip);

    req.session.user = username;
    req.session.role = user.role || "user";

    req.session.save((err) => {
        if (err) {
            console.error('Chyba při ukládání session:', err);
            return renderErrorHtml(res, "Nastala chyba při přihlášení.");
        }

        res.redirect('/');

    });
});

router.get("/logout", (req, res) => {
    req.session.destroy(() => {
        res.redirect('/auth/login');
    });
});

module.exports = router;

