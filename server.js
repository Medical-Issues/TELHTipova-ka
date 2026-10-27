require('dotenv').config();

// Debug mód pro vypnutí obrázků
const DEBUG_NO_IMAGES = process.env.DEBUG_NO_IMAGES === 'true';
console.log("=== BEZÍCÍ VERZE NODE.JS ===", process.version);
const express = require('express');
const path = require('path');
const bodyParser = require("body-parser");
const session = require("express-session");
const { default: MongoStore } = require('connect-mongo');
const fs = require('fs');
const userRoutes = require('./routes/user');
const adminRoutes = require('./routes/admin');
const authRoutes = require('./routes/auth');
const healthRoutes = require('./routes/health');
const { router: securityRoutes } = require('./routes/security');
const versionRoutes = require('./routes/version');
const { Users } = require('./utils/mongoDataAccess');

// MongoDB připojení
const { connectToDatabase } = require('./config/database');
const { backupJsonFilesToGitHub } = require("./utils/githubBackup");
const { restoreFromGitHub, fullRestoreFromGitHub } = require("./utils/githubRestore");
const app = express();

// Nastavit debug mód pro všechny routy
app.locals.debugNoImages = DEBUG_NO_IMAGES;

// Debug mód bez stahování obrázků (DEBUG_NO_IMAGES=true v .env)
if (DEBUG_NO_IMAGES) {
    console.log('⚡ [DEBUG] DEBUG_NO_IMAGES je aktivní - stahování obrázků z GitHubu je vypnuté (použijí se již stažené lokální obrázky)');

    // Injektovat pouze fixní plovoucí odznak
    app.use((req, res, next) => {
        const originalSend = res.send;
        res.send = function (body) {
            if (typeof body === 'string' && body.includes('<!DOCTYPE html>')) {
                const badgeHtml = `<div id="debug-no-images-badge" style="position: fixed; bottom: 12px; right: 12px; background: rgba(220, 38, 38, 0.88); color: #ffffff; padding: 5px 12px; border-radius: 20px; font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-weight: 600; letter-spacing: 0.3px; z-index: 999999; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35); pointer-events: none; user-select: none;">⚡ DEBUG: Bez stahování obrázků</div>`;

                if (/<body[^>]*>/i.test(body)) {
                    body = body.replace(/(<body[^>]*>)/i, `$1${badgeHtml}`);
                }
            }
            return originalSend.call(this, body);
        };
        next();
    });
}

// Serve static files (CSS, images, etc.)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));

// Google Search Console ověření
app.get(/\/google.*\.html$/, (req, res) => {
    const fileName = req.path.replace(/^\//, '');
    const filePath = path.join(__dirname, 'public', fileName);

    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Verification file not found');
    }
});

// Obrázky - zkusíme nejprve public/images, pak data/images
app.use('/images', (req, res, next) => {
    const filename = req.path.replace(/^\//, '');
    const publicPath = path.join(__dirname, 'public', 'images', filename);
    const dataPath = path.join(__dirname, 'data', 'images', filename);

    if (fs.existsSync(publicPath)) {
        return res.sendFile(publicPath);
    }
    if (fs.existsSync(dataPath)) {
        return res.sendFile(dataPath);
    }
    next();
});

// Service Worker file
app.get('/sw.js', (req, res) => {
    const swPath = path.join(__dirname, 'public', 'sw.js');
    if (fs.existsSync(swPath)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.sendFile(swPath);
    } else {
        res.status(404).send('Service Worker not found');
    }
});

// Favicon endpoint
app.get('/favicon.ico', (req, res) => {
    const logoPath = path.join(__dirname, 'data', 'images', 'logo.png');
    if (fs.existsSync(logoPath)) {
        res.sendFile(logoPath);
    } else {
        res.status(404).send('Favicon not found');
    }
});

// Also serve from /logoteamu/ for backward compatibility
app.use('/logoteamu', (req, res, next) => {
    const filename = req.path.replace(/^\//, '');
    const dataPath = path.join(__dirname, 'data', 'images', filename);
    const publicPath = path.join(__dirname, 'public', 'images', filename);

    if (fs.existsSync(dataPath)) {
        return res.sendFile(dataPath);
    }
    if (fs.existsSync(publicPath)) {
        return res.sendFile(publicPath);
    }
    if (DEBUG_NO_IMAGES) {
        const fallbackPublic = path.join(__dirname, 'public', 'images', 'logo.png');
        const fallbackData = path.join(__dirname, 'data', 'images', 'logo.png');
        if (fs.existsSync(fallbackPublic)) return res.sendFile(fallbackPublic);
        if (fs.existsSync(fallbackData)) return res.sendFile(fallbackData);
    }
    next();
});

// Security headers s plnou podporou pro Google Fonts i CDNs (povoluje style-src-elem i font-src)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "style-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "img-src 'self' data: blob:;"
    );
    next();
});

// CSRF token generátor a middleware
function generateCsrfToken() {
    return require('crypto').randomBytes(32).toString('hex');
}

function csrfMiddleware(req, res, next) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = generateCsrfToken();
    }

    res.locals.csrfToken = req.session.csrfToken;
    res.locals.csrfField = `<input type="hidden" name="_csrf" value="${req.session.csrfToken}">`;

    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const token = req.body?._csrf || req.headers['x-csrf-token'] || req.query._csrf;

        if (!token) {
            return res.status(403).json({ error: 'CSRF token missing' });
        }

        if (token !== req.session.csrfToken) {
            return res.status(403).json({ error: 'CSRF token invalid' });
        }
    }

    next();
}

app.set('trust proxy', true);

const isProductionServer = process.env.RENDER === 'true';

const sessionStore = MongoStore.create({
    mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/tipovacka',
    touchAfter: 24 * 3600,
    stringify: true,
    autoCreate: true
});

sessionStore.on('error', (err) => {
    console.error('❌ MongoDB Session Store Error:', err.message);
});

app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'tajnyklic',
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 30, // 30 dní
        httpOnly: true,
        secure: isProductionServer,
        sameSite: 'lax'
    }
}));

// Body parser middleware
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(bodyParser.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();

    res.status(200).json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'TELH Tipovačka',
        uptime: uptime,
        uptimeHours: Math.floor(uptime / 3600),
        memory: {
            rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
            heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
            heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
            external: Math.round(memoryUsage.external / 1024 / 1024) + ' MB'
        },
        requestInfo: {
            ip: req.ip || req.connection.remoteAddress,
            userAgent: req.get('User-Agent') || 'Unknown',
            method: req.method,
            url: req.url
        }
    });
});

// Keep-alive endpointy
app.get('/wake', async (req, res) => {
    try {
        const startTime = Date.now();
        const db = await connectToDatabase();
        const collections = await db.listCollections().toArray();
        const operations = [db.admin().ping(), db.listCollections().toArray()];

        try {
            operations.push(db.collection('users').findOne({}));
            operations.push(db.collection('matches').findOne({}));
            operations.push(db.collection('ligy').findOne({}));
        } catch (e) {
            console.error('Chyba při přístupu k kolekcím v wake endpoint:', e);
        }

        try {
            const clientIP = req.ip || req.connection.remoteAddress;
            const isLocalhost = clientIP === '::1' || clientIP === '127.0.0.1' || clientIP === 'localhost';

            if (!isLocalhost) {
                const logsCollection = db.collection('wake_logs');
                await logsCollection.insertOne({
                    timestamp: new Date(),
                    ip: clientIP,
                    userAgent: req.get('User-Agent') || 'cron-job',
                    responseTime: Date.now() - startTime,
                    collectionsCount: collections.length
                });
            }
        } catch (logError) {
            console.error('Chyba při zápisu do wake_logs:', logError);
        }

        await Promise.all(operations);

        let result = 0;
        for (let i = 0; i < 500000; i++) {
            result += Math.sin(i) * Math.cos(i);
        }

        const testArray = [];
        for (let i = 0; i < 10000; i++) {
            testArray.push(Math.random() * i);
        }
        testArray.sort();

        const responseTime = Date.now() - startTime;
        console.log(`✅ Wake endpoint called at: ${new Date().toISOString()}, Response time: ${responseTime}ms, Collections: ${collections.length}`);

        res.json({
            status: 'OK',
            message: 'Application is awake and active',
            timestamp: new Date().toISOString(),
            responseTime: responseTime,
            collectionsCount: collections.length,
            computationResult: Math.round(result),
            memoryTest: testArray.length
        });

    } catch (error) {
        console.error('❌ Wake endpoint error:', error);
        res.status(500).json({
            status: 'ERROR',
            message: 'Error keeping app awake',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/warm', async (req, res) => {
    try {
        const startTime = Date.now();
        const db = await connectToDatabase();
        const operations = [db.admin().ping(), db.listCollections().toArray()];

        try { operations.push(db.collection('users').findOne({})); } catch (e) {}
        try { operations.push(db.collection('ligy').findOne({})); } catch (e) {}

        await Promise.all(operations);

        let result = 0;
        for (let i = 0; i < 100000; i++) {
            result += Math.random();
        }

        console.log(`🔥 Warm endpoint called at: ${new Date().toISOString()}, Response time: ${Date.now() - startTime}ms`);

        res.json({
            status: 'WARM',
            message: 'Application is fully warmed up',
            timestamp: new Date().toISOString(),
            responseTime: Date.now() - startTime,
            computationResult: result
        });

    } catch (error) {
        console.error('❌ Warm endpoint error:', error);
        res.status(500).json({
            status: 'ERROR',
            message: 'Error warming up app',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Admin restore endpointy
app.post('/admin/restore-from-github', async (req, res) => {
    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

    if (!process.env.GITHUB_TOKEN) {
        return res.status(400).json({ success: false, message: 'GITHUB_TOKEN není nastaven' });
    }

    const { logAdminAction } = require('./utils/fileUtils');
    await logAdminAction(req.session.user, "GITHUB_RESTORE_START", `Spuštěn restore obrázků z GitHubu`, 'admin', null, req, 'info', true);

    restoreFromGitHub().then(async (success) => {
        if (success) {
            await logAdminAction(req.session.user, "GITHUB_RESTORE_SUCCESS", `Restore obrázků z GitHubu úspěšný`, 'admin', null, req, 'info', true);
            res.json({ success: true, message: 'Restore obrázků z GitHubu úspěšný' });
        } else {
            await logAdminAction(req.session.user, "GITHUB_RESTORE_FAILED", `Restore obrázků z GitHubu selhal`, 'admin', null, req, 'error', false);
            res.status(500).json({ success: false, message: 'Restore obrázků z GitHubu selhal' });
        }
    }).catch(async (error) => {
        await logAdminAction(req.session.user, "GITHUB_RESTORE_ERROR", `Chyba při restore z GitHubu: ${error.message}`, 'admin', null, req, 'critical', false);
        res.status(500).json({ success: false, message: error.message });
    });
});

app.post('/admin/full-restore-from-github', async (req, res) => {
    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

    if (!process.env.GITHUB_TOKEN) {
        return res.status(400).json({ success: false, message: 'GITHUB_TOKEN není nastaven' });
    }

    const { logAdminAction } = require('./utils/fileUtils');
    await logAdminAction(req.session.user, "GITHUB_FULL_RESTORE_START", `Spuštěn kompletní restore (JSON + obrázky) z GitHubu`, 'admin', null, req, 'warning', true);

    fullRestoreFromGitHub().then(async (success) => {
        if (success) {
            await logAdminAction(req.session.user, "GITHUB_FULL_RESTORE_SUCCESS", `Kompletní restore (JSON + obrázky) z GitHubu úspěšný`, 'admin', null, req, 'info', true);
            res.json({ success: true, message: 'Kompletní restore (JSON + obrázky) z GitHubu úspěšný' });
        } else {
            await logAdminAction(req.session.user, "GITHUB_FULL_RESTORE_FAILED", `Kompletní restore z GitHubu selhal`, 'admin', null, req, 'error', false);
            res.status(500).json({ success: false, message: 'Kompletní restore z GitHubu selhal' });
        }
    }).catch(async (error) => {
        await logAdminAction(req.session.user, "GITHUB_FULL_RESTORE_ERROR", `Chyba při kompletním restore z GitHubu: ${error.message}`, 'admin', null, req, 'critical', false);
        res.status(500).json({ success: false, message: error.message });
    });
});

app.use('/auth', authRoutes);
app.use('/health', healthRoutes);
app.use('/security', securityRoutes);

app.use('/admin', express.json({ limit: '50mb' }), express.urlencoded({ extended: true, limit: '50mb' }), adminRoutes);

app.use('/api', csrfMiddleware, versionRoutes);
app.use('/', csrfMiddleware, userRoutes);

app.get('/api/csrf-token', (req, res) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = generateCsrfToken();
    }
    res.json({ csrfToken: req.session.csrfToken });
});

app.get('/api/vapid-public-key', (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY) {
        return res.status(500).send("VAPID_PUBLIC_KEY chybí na serveru");
    }
    res.send(process.env.VAPID_PUBLIC_KEY);
});

app.post('/api/subscribe', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: "Pro zapnutí notifikací musíš být přihlášen." });
    }

    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

    const subscription = req.body;
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

    users = users.map(u => {
        if (u.subscriptions) {
            u.subscriptions = u.subscriptions.filter(sub => sub.endpoint !== subscription.endpoint);
        }
        return u;
    });

    const userIndex = users.findIndex(u => u.username === req.session.user);
    if (userIndex !== -1) {
        if (!users[userIndex].subscriptions) {
            users[userIndex].subscriptions = [];
        }

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

    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

    try {
        const users = await Users.findAll();
        const user = users.find(u => u.username === username);

        if (!user) return res.json({ belongsToMe: false });

        const hasIt = user.subscriptions && user.subscriptions.some(s => s.endpoint === endpoint);
        res.json({ belongsToMe: !!hasIt });
    } catch (e) {
        console.error("Chyba check-subscription:", e);
        res.json({ belongsToMe: false });
    }
});

app.post('/api/check-subscription-legacy', async (req, res) => {
    const { endpoint } = req.body;
    const users = await Users.findAll();
    const user = users.find(u => u.username === req.session.user);

    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

    const belongsToMe = user?.subscriptions?.some(sub => sub.endpoint === endpoint) || false;
    res.json({ belongsToMe });
});

app.post('/api/unsubscribe', async (req, res) => {
    const { endpoint } = req.body;

    const csrfToken = req.headers['x-csrf-token'] || req.body._csrf;
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
        return res.status(403).json({ error: 'Neplatný CSRF token' });
    }

    let users = await Users.findAll();

    const userIndex = users.findIndex(u => u.username === req.session.user);
    if (userIndex !== -1 && users[userIndex].subscriptions) {
        users[userIndex].subscriptions = users[userIndex].subscriptions.filter(sub => sub.endpoint !== endpoint);
        await Users.updateAll(users);
    }
    res.json({ success: true });
});

// 404 Handler
app.use((req, res) => {
    res.status(404).send(`
        <!DOCTYPE html>
        <html lang="cs">
        <head>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
            <meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;">
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
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

// JEDNOTNÝ KEEP-ALIVE SYSTÉM
function startUnifiedKeepAlive() {
    const WAKE_URL = process.env.WAKE_URL || 'https://telhtipova-ka.onrender.com/wake';
    console.log(`💓 Starting unified keep-alive system (every 45s), WAKE_URL: ${WAKE_URL}`);

    const axios = require('axios');
    let counter = 0;

    setInterval(async () => {
        counter++;
        try {
            const wakePromise = axios.get(WAKE_URL, {
                timeout: 8000,
                headers: {
                    'User-Agent': 'Render-Keep-Alive',
                    'Cache-Control': 'no-cache'
                }
            });

            let dbPromise = Promise.resolve();
            if (counter % 6 === 0) {
                const { connectToDatabase } = require('./config/database');
                dbPromise = connectToDatabase().then(db => db.admin().ping());
            }

            const [wakeResponse] = await Promise.all([wakePromise, dbPromise]);

            if (counter % 10 === 0) {
                console.log(`💓 Keep-alive #${counter}: wake=${wakeResponse.status}, db=${counter % 6 === 0 ? 'pinged' : 'skipped'}`);
            }

        } catch (error) {
            console.error(`❌ Keep-alive #${counter} error:`, error.message);
            if (error.response) {
                console.error(`   Status: ${error.response.status}, URL: ${WAKE_URL}`);
            }
        }
    }, 45 * 1000);
}

async function startServer() {
    await connectToDatabase();

    if (DEBUG_NO_IMAGES) {
        console.log('⚡ [DEBUG] DEBUG_NO_IMAGES je aktivní -> Automatický restore obrázků z GitHubu přeskočen');
    } else if (process.env.GITHUB_TOKEN) {
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
        console.log('Server běží na portu 3000.');

        setTimeout(() => {
            console.log('🔄 Monitoring service skipped (unified keep-alive handles this)');
            setTimeout(() => {
                console.log('🔒 Security monitoring disabled - using Render protection');
                startUnifiedKeepAlive();
            }, 5000);
        }, 10000);
    });

    setInterval(() => {
        console.log('⏰ Spouštím automatickou zálohu...');
        backupJsonFilesToGitHub();
    }, 60 * 60 * 1000 * 24);
}

startServer().catch(err => {
    console.error('❌ Selhal start serveru:', err);
});

module.exports.csrfMiddleware = csrfMiddleware;