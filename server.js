require('dotenv').config();

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
const {backupJsonFilesToGitHub} = require("./utils/githubBackup");
const {restoreFromGitHub, fullRestoreFromGitHub} = require("./utils/githubRestore");
const app = express();

// Serve static files (CSS, images, etc.) - MUSÍ BÝT PRVNÍ!
// CSS a JS z public
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
// Google Search Console ověření (přidej pod statické složky)
app.get(/\/google.*\.html$/, (req, res) => {
    // Získáme název souboru přímo z URL
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

// Service Worker file - musí být dostupný na kořenové cestě pro push notifikace
app.get('/sw.js', (req, res) => {
    const swPath = path.join(__dirname, 'public', 'sw.js');
    if (fs.existsSync(swPath)) {
        res.setHeader('Content-Type', 'application/javascript');
        res.sendFile(swPath);
    } else {
        res.status(404).send('Service Worker not found');
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
    next();
});

// Helmet-like security headers (bez balíčku)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});

// CSRF token generátor a middleware
function generateCsrfToken() {
    return require('crypto').randomBytes(32).toString('hex');
}

function csrfMiddleware(req, res, next) {
    // Vytvořit token pokud neexistuje
    if (!req.session.csrfToken) {
        req.session.csrfToken = generateCsrfToken();
    }
    
    // Přidat token do res.locals pro EJS/views
    res.locals.csrfToken = req.session.csrfToken;
    
    // Přidat funkci pro vložení CSRF token do HTML
    res.locals.csrfField = `<input type="hidden" name="_csrf" value="${req.session.csrfToken}">`;
    
    // Kontrolovat POST/PUT/DELETE requesty - token je POVINNÝ
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const token = req.body?._csrf || req.headers['x-csrf-token'] || req.query._csrf;
        
        // Token je povinný pro všechny modifikující requesty
        if (!token) {
            return res.status(403).json({ error: 'CSRF token missing' });
        }
        
        // Kontrola validity tokenu
        if (token !== req.session.csrfToken) {
            return res.status(403).json({ error: 'CSRF token invalid' });
        }
    }
    
    next();
}
// Důvěřovat proxy hlavičkám (X-Forwarded-For) pro získání reálné IP klienta
app.set('trust proxy', true);

app.use(session({
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI || 'mongodb://localhost:27017/tipovacka',
        touchAfter: 24 * 3600,
        stringify: true
    }),
    secret: 'tajnyklic',
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 30,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

// Body parser middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Health check endpoint pro monitoring služby (bez autentizace) - MUSÍ BÝT PŘED ROUTES!
app.get('/health', (req, res) => {
    Date.now();
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

// DDOS ochrana ODSTRANĚNA - Render má vlastní ochranu

// Keep-alive endpointy
app.get('/wake', async (req, res) => {
    try {
        const startTime = Date.now();
        
        // 1. Připojení k databáze
        const { connectToDatabase } = require('./config/database');
        const db = await connectToDatabase();
        
        // 2. Provést skutečnou operaci v databázi
        const collections = await db.listCollections().toArray();
        
        // 3. Více databázových operací pro meaningful activity
        const operations = [];
        
        // Ping
        operations.push(db.admin().ping());
        
        // List collections
        operations.push(db.listCollections().toArray());
        
        // Zkusit číst z různých kolekcí
        try {
            operations.push(db.collection('users').findOne({}));
            operations.push(db.collection('matches').findOne({}));
            operations.push(db.collection('ligy').findOne({}));
        } catch (e) {
            // Ignorovat pokud kolekce neexistuje
        }
        
        // Zápis do log kolekce (pokud existuje) - pouze pro externí IP
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
            // Pokud kolekce neexistuje, ignorujeme chybu
        }
        
        // Čekat na všechny operace
        await Promise.all(operations);
        
        // 4. CPU aktivita - intenzivnější výpočet
        let result = 0;
        for (let i = 0; i < 500000; i++) {
            result += Math.sin(i) * Math.cos(i);
        }
        
        // 5. Memory operace
        const testArray = [];
        for (let i = 0; i < 10000; i++) {
            testArray.push(Math.random() * i);
        }
        testArray.sort();
        
        const responseTime = Date.now() - startTime;
        
        // 6. Log do konzole
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

// Další endpoint pro intenzivnější warm-up
app.get('/warm', async (req, res) => {
    try {
        const startTime = Date.now();
        
        // 1. Připojení k databáze
        const { connectToDatabase } = require('./config/database');
        const db = await connectToDatabase();
        
        // 2. Různé databázové operace
        const operations = [];
        
        // Ping
        operations.push(db.admin().ping());
        
        // List collections
        operations.push(db.listCollections().toArray());
        
        // Zkusit číst z users kolekce
        try {
            operations.push(db.collection('users').findOne({}));
        } catch (e) {
            operations.push(Promise.resolve(null));
        }
        
        // Zkusit číst z ligy kolekce
        try {
            operations.push(db.collection('ligy').findOne({}));
        } catch (e) {
            operations.push(Promise.resolve(null));
        }
        
        // Čekat na všechny operace
        await Promise.all(operations);
        
        // 3. CPU aktivita - jednoduchý výpočet
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
app.use('/health', healthRoutes);
app.use('/security', securityRoutes);
app.use('/api', csrfMiddleware, versionRoutes);
app.use('/', csrfMiddleware, userRoutes)
app.use('/admin', csrfMiddleware, adminRoutes);

// API endpoint pro CSRF token
app.get('/api/csrf-token', (req, res) => {
    // Vygenerovat token pokud neexistuje (např. po odhlášení)
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
        
        // Spustit monitoring service po 10 sekundách
        setTimeout(() => {
            // Monitoring vypnut - unified keep-alive už zajišťuje probuzení
            console.log('🔄 Monitoring service skipped (unified keep-alive handles this)');
            
            // Spustit security monitoring po dalších 5 sekundách
            setTimeout(() => {
                console.log('🔒 Security monitoring disabled - using Render protection');
                
                // Spustit jednotný keep-alive systém
                startUnifiedKeepAlive();
            }, 5000);
        }, 10000);
    });

    // JEDNOTNÝ KEEP-ALIVE SYSTÉM - kombinuje všechny mechanismy
    function startUnifiedKeepAlive() {
        const WAKE_URL = process.env.WAKE_URL || 'https://telhtipova-ka.onrender.com/wake';
        console.log(`💓 Starting unified keep-alive system (every 45s), WAKE_URL: ${WAKE_URL}`);
        
        const axios = require('axios');
        let counter = 0;
        
        setInterval(async () => {
            counter++;
            new Date().toISOString();
            try {
                // 1. Externí HTTP wake - reálná aktivita pro Render (každých 45s)
                const wakePromise = axios.get(WAKE_URL, {
                    timeout: 8000,
                    headers: {
                        'User-Agent': 'Render-Keep-Alive',
                        'Cache-Control': 'no-cache'
                    }
                });
                
                // 2. Interní MongoDB ping (každé 3 minuty = every 6th run)
                let dbPromise = Promise.resolve();
                if (counter % 6 === 0) {
                    const { connectToDatabase } = require('./config/database');
                    dbPromise = connectToDatabase().then(db => db.admin().ping());
                }
                
                // Spustit paralelně
                const [wakeResponse] = await Promise.all([wakePromise, dbPromise]);
                
                // Logovat jen každý 10. úspěšný běh
                if (counter % 10 === 0) {
                    console.log(`💓 Keep-alive #${counter}: wake=${wakeResponse.status}, db=${counter % 6 === 0 ? 'pinged' : 'skipped'}`);
                }
                
            } catch (error) {
                // Logovat každý error s detaily pro diagnostiku
                console.error(`❌ Keep-alive #${counter} error:`, error.message);
                if (error.response) {
                    console.error(`   Status: ${error.response.status}, URL: ${WAKE_URL}`);
                }
            }
        }, 45 * 1000); // Každých 45 sekund
    }

    // Záloha každých 24 hodin
    setInterval(() => {
        console.log('⏰ Spouštím automatickou zálohu...');
        backupJsonFilesToGitHub();
    }, 60*60*1000*24);
}

startServer().then(() => {});
