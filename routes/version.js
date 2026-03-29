const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../utils/fileUtils');
const { connectToDatabase } = require('../config/database');

// GET - Získat aktuální verzi a changelog
router.get('/version', async (req, res) => {
    try {
        const db = await connectToDatabase();
        const versionsCollection = db.collection('versions');
        
        // Najít nejnovější verzi
        const latestVersion = await versionsCollection
            .findOne({}, { sort: { releasedAt: -1 } });
        
        if (!latestVersion) {
            return res.json({
                version: '1.0.0',
                changelog: ['Počáteční verze'],
                releasedAt: new Date(),
                isInitial: true
            });
        }
        
        res.json({
            version: latestVersion.version,
            changelog: latestVersion.changelog || [],
            releasedAt: latestVersion.releasedAt,
            title: latestVersion.title || 'Nová aktualizace',
            isInitial: false
        });
    } catch (error) {
        console.error('Chyba při získávání verze:', error);
        res.status(500).json({ error: 'Nepodařilo se načíst verzi' });
    }
});

// GET - Historie verzí
router.get('/version-history', async (req, res) => {
    try {
        const db = await connectToDatabase();
        const versionsCollection = db.collection('versions');
        
        const versions = await versionsCollection
            .find({})
            .sort({ releasedAt: -1 })
            .limit(10)
            .toArray();
        
        res.json(versions);
    } catch (error) {
        console.error('Chyba při získávání historie verzí:', error);
        res.status(500).json({ error: 'Nepodařilo se načíst historii' });
    }
});

// POST - Vytvořit novou verzi (pouze admin)
router.post('/version', requireAdmin, async (req, res) => {
    try {
        const { version, title, changelog } = req.body;
        
        if (!version || !title || !changelog || !Array.isArray(changelog)) {
            return res.status(400).json({ 
                error: 'Chybí povinná pole: version, title, changelog (pole)' 
            });
        }
        
        const db = await connectToDatabase();
        const versionsCollection = db.collection('versions');
        
        // Kontrola duplicitní verze
        const existing = await versionsCollection.findOne({ version });
        if (existing) {
            return res.status(400).json({ error: 'Verze již existuje' });
        }
        
        const newVersion = {
            version,
            title,
            changelog,
            releasedAt: new Date(),
            createdBy: req.session.user
        };
        
        await versionsCollection.insertOne(newVersion);
        
        console.log(`✅ Nová verze ${version} vytvořena uživatelem ${req.session.user}`);
        res.json({ success: true, message: `Verze ${version} byla vytvořena` });
    } catch (error) {
        console.error('Chyba při vytváření verze:', error);
        res.status(500).json({ error: 'Nepodařilo se vytvořit verzi' });
    }
});

// GET - Admin stránka pro správu verzí
router.get('/versions/manage', requireAdmin, async (req, res) => {
    try {
        const db = await connectToDatabase();
        const versionsCollection = db.collection('versions');
        
        const versions = await versionsCollection
            .find({})
            .sort({ releasedAt: -1 })
            .toArray();
        
        // Generování další verze (automaticky)
        let nextVersion = '1.0.0';
        if (versions.length > 0) {
            const latest = versions[0].version;
            const parts = latest.split('.');
            const patch = parseInt(parts[2]) + 1;
            nextVersion = `${parts[0]}.${parts[1]}.${patch}`;
        }
        
        res.send(`
        <!DOCTYPE html>
        <html lang="cs">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <link rel="stylesheet" href="/css/styles.css">
            <link rel="icon" href="/images/logo.png">
            <title>Správa verzí</title>
            <style>
                .version-form {
                    background: #1e1e1e;
                    padding: 20px;
                    border-radius: 10px;
                    margin-bottom: 30px;
                }
                .version-form input, .version-form textarea {
                    width: 100%;
                    padding: 10px;
                    margin: 10px 0;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    color: white;
                    border-radius: 5px;
                }
                .version-form button {
                    background: orangered;
                    color: white;
                    border: none;
                    padding: 12px 30px;
                    border-radius: 5px;
                    cursor: pointer;
                    font-weight: bold;
                    margin-top: 10px;
                }
                .version-card {
                    background: #1e1e1e;
                    padding: 15px;
                    margin: 10px 0;
                    border-radius: 8px;
                    border-left: 4px solid orangered;
                }
                .version-number {
                    font-size: 1.5em;
                    font-weight: bold;
                    color: orangered;
                }
                .version-date {
                    color: #888;
                    font-size: 0.9em;
                }
                .changelog-item {
                    padding: 5px 0;
                    border-bottom: 1px solid #333;
                }
                .changelog-item:last-child {
                    border-bottom: none;
                }
            </style>
        </head>
        <body class="usersite">
            <main class="admin_site">
                <h1>Správa verzí a changelog</h1>
                <p><a href="/admin" style="color: orangered;">← Zpět do adminu</a></p>
                
                <div class="version-form">
                    <h2>Vytvořit novou verzi</h2>
                    <form method="POST" action="/api/version-form">
                        <label>Číslo verze:</label>
                        <input type="text" name="version" value="${nextVersion}" required 
                               placeholder="např. 1.0.1">
                        
                        <label>Název aktualizace:</label>
                        <input type="text" name="title" required 
                               placeholder="např. Opravy a vylepšení">
                        
                        <label>Seznam změn (každá změna na nový řádek):</label>
                        <textarea name="changelog" rows="6" required 
                                  placeholder="- Opraveno mazání uživatelů&#10;- Přidán systém verzí&#10;- Vylepšen monitoring"></textarea>
                        
                        <button type="submit">Vytvořit verzi</button>
                    </form>
                </div>
                
                <h2>Historie verzí</h2>
                ${versions.map(v => `
                    <div class="version-card">
                        <div class="version-number">Verze ${v.version}</div>
                        <div class="version-title" style="font-weight: bold; margin: 5px 0;">${v.title}</div>
                        <div class="version-date">${new Date(v.releasedAt).toLocaleString('cs-CZ')}</div>
                        <div style="margin-top: 10px;">
                            ${v.changelog.map(item => `
                                <div class="changelog-item">• ${item}</div>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
                
                ${versions.length === 0 ? '<p style="color: #888;">Zatím žádné verze.</p>' : ''}
            </main>
        </body>
        </html>
        `);
    } catch (error) {
        console.error('Chyba při načítání správy verzí:', error);
        res.status(500).send('Chyba serveru');
    }
});

// POST z formuláře - přesměrování na JSON API
router.post('/version-form', requireAdmin, async (req, res) => {
    try {
        const { version, title, changelog } = req.body;
        
        // Převést textarea na pole
        const changelogArray = changelog
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => line.replace(/^[-•]\s*/, '')); // Odstranit odrážky
        
        const db = await connectToDatabase();
        const versionsCollection = db.collection('versions');
        
        // Kontrola duplicitní verze
        const existing = await versionsCollection.findOne({ version });
        if (existing) {
            return res.send(`
                <h1>Chyba</h1>
                <p>Verze ${version} již existuje.</p>
                <a href="/api/versions/manage">Zpět</a>
            `);
        }
        
        await versionsCollection.insertOne({
            version,
            title,
            changelog: changelogArray,
            releasedAt: new Date(),
            createdBy: req.session.user
        });
        
        console.log(`✅ Nová verze ${version} vytvořena uživatelem ${req.session.user}`);
        res.redirect('/api/versions/manage');
    } catch (error) {
        console.error('Chyba při vytváření verze:', error);
        res.status(500).send('Chyba při vytváření verze');
    }
});

module.exports = router;
