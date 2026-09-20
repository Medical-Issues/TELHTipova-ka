const path = require('path');
const fs = require('fs');
const bcrypt = require("bcrypt");
const express = require("express");
const router = express.Router();
const { renderErrorHtml, logUserAction, logAdminAction } = require("../utils/fileUtils");
const { Settings, Users } = require('../utils/mongoDataAccess');

// Jednoduchý brute force protection - max 5 pokusů za 15 minut na IP
const loginAttempts = new Map();

// Tracking neúspěšných admin přihlášení - critical alert po 5 pokusech
const adminLoginAttempts = new Map();

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
    // Generate CSRF token if it doesn't exist
    if (!req.session.csrfToken) {
        req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
    }
    
    // Read the HTML file and inject the CSRF token
    const htmlPath = path.join(__dirname, "../views/register.html");
    const html = fs.readFileSync(htmlPath, 'utf8');
    const htmlWithToken = html.replace('<input type="hidden" name="_csrf" id="csrfToken" value="">', 
        `<input type="hidden" name="_csrf" id="csrfToken" value="${req.session.csrfToken}">`);
    res.send(htmlWithToken);
});
router.post("/register", express.urlencoded({ extended: true }), async (req, res) => {
    // Pro localhost vývoj úplně vynecháme CSRF kontrolu
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    
    if (!isLocalhost) {
        // CSRF kontrola jen pro produkci
        if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
            return res.status(403).send('Neplatný CSRF token');
        }
    }
    
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

        await logUserAction(username, "REGISTER", `Registrace nového uživatele: ${username}`, 'user', null, req, 'info', true);

        res.redirect('/auth/login');
    } catch (err) {
        console.error(err);
        await logUserAction(username, "REGISTER", `Neúspěšná registrace: ${username} - ${err.message}`, 'user', null, req, 'error', false);
        await renderErrorHtml(res, "Při registraci nastala chyba. Zkuste to prosím později.");
    }
});

router.get("/login", (req, res) => {
    // Generate CSRF token if it doesn't exist
    if (!req.session.csrfToken) {
        req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');
    }
    
    // Read the HTML file and inject the CSRF token
    const htmlPath = path.join(__dirname, "../views/login.html");
    const html = fs.readFileSync(htmlPath, 'utf8');
    const htmlWithToken = html.replace('<input type="hidden" name="_csrf" id="csrfToken" value="">', 
        `<input type="hidden" name="_csrf" id="csrfToken" value="${req.session.csrfToken}">`);
    res.send(htmlWithToken);
});

router.post('/login', express.urlencoded({ extended: true }), checkBruteForce, async (req, res) => {
    // Pro localhost vývoj úplně vynecháme CSRF kontrolu
    const isLocalhost = req.hostname === 'localhost' || req.hostname === '127.0.0.1';
    
    if (!isLocalhost) {
        // CSRF kontrola jen pro produkci
        if (!req.body._csrf || req.body._csrf !== req.session.csrfToken) {
            console.error('CSRF failed - User:', req.body.username, 'Token:', req.body._csrf, 'Session:', req.session.csrfToken);
            return res.status(403).send('Neplatný CSRF token');
        }
    }
    
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
        await logUserAction(username, "LOGIN", `Neúspěšné přihlášení: uživatel nenalezen - ${username}`, 'user', null, req, 'warning', false);
        return res.redirect('/auth/login?error=1');
    }

    // Pokud se jedná o admin účet, trackingovat neúspěšné pokusy
    if (user.role === 'admin') {
        const ip = req.ip || req.connection.remoteAddress;
        const key = `${ip}:${username}`;
        
        if (!adminLoginAttempts.has(key)) {
            adminLoginAttempts.set(key, []);
        }
        
        const attempts = adminLoginAttempts.get(key);
        const now = Date.now();
        
        // Odstranit staré pokusy (> 1 hodina)
        const recentAttempts = attempts.filter(time => now - time < 60 * 60 * 1000);
        adminLoginAttempts.set(key, recentAttempts);
        
        // Přidat aktuální pokus
        recentAttempts.push(now);
        
        // Pokud je to 5. pokus, poslat critical alert
        if (recentAttempts.length === 5) {
            await logAdminAction(username, "BRUTE_FORCE_SUSPECTED", `5 neúspěšných pokusů o admin přihlášení z IP: ${ip}`, 'admin', null, req, 'critical', false);
        }
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
        await logUserAction(username, "LOGIN", `Neúspěšné přihlášení: špatné heslo - ${username}`, 'user', null, req, 'warning', false);
        return res.redirect("/auth/login?error=1");
    }

    // Reset admin pokusů po úspěšném přihlášení
    if (user.role === 'admin') {
        const ip = req.ip || req.connection.remoteAddress;
        const key = `${ip}:${username}`;
        adminLoginAttempts.delete(key);
    }

    // Reset pokusů po úspěšném přihlášení
    const ip = req.ip || req.connection.remoteAddress;
    loginAttempts.delete(ip);

    req.session.user = username;
    req.session.role = user.role || "user";

    await logUserAction(username, "LOGIN", `Úspěšné přihlášení uživatele: ${username}`, 'user', null, req, 'info', true);

    req.session.save((err) => {
        if (err) {
            console.error('Chyba při ukládání session:', err);
            return renderErrorHtml(res, "Nastala chyba při přihlášení.");
        }

        res.redirect('/');

    });
});

router.get("/logout", (req, res) => {
    const username = req.session.user;
    req.session.destroy(async () => {
        if (username) {
            await logUserAction(username, "LOGOUT", `Odhlášení uživatele: ${username}`, 'user', null, req, 'info', true);
        }
        res.redirect('/auth/login');
    });
});

module.exports = router;

