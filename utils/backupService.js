const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../config/database');

const REPO_OWNER = 'Medical-Issues';
const REPO_NAME = 'TELHTipovackaZaloha';
const BRANCH = 'main';

const DATA_FOLDER = path.join(__dirname, '..', 'data');
const IMAGES_FOLDER = path.join(DATA_FOLDER, 'images');
const BACKUPS_DIR = path.join(__dirname, '..', 'backups');
const SNAPSHOTS_DIR = path.join(BACKUPS_DIR, 'snapshots');
const PRE_ACTION_DIR = path.join(BACKUPS_DIR, 'pre-action');

// Ensure required directories exist
[DATA_FOLDER, IMAGES_FOLDER, BACKUPS_DIR, SNAPSHOTS_DIR, PRE_ACTION_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const CORE_COLLECTIONS = [
    'users',
    'matches',
    'teams',
    'leagues',
    'tableTips',
    'settings',
    'chosenSeason',
    'allowedLeagues',
    'playoff',
    'playoffTemplates',
    'transfers',
    'transferLeagues',
    'teamBonuses',
    'leagueStatus',
    'tips',
    'players',
    'image_hashes',
    'deleted_images',
    'versions',
    'auditLogs'
];

/**
 * Dump all core collections from MongoDB into an in-memory object
 */
async function dumpMongoCollections() {
    const db = getDatabase();
    if (!db) {
        throw new Error('Database is not initialized.');
    }

    const dump = {
        meta: {
            createdAt: new Date().toISOString(),
            version: '1.0',
            counts: {}
        },
        collections: {}
    };

    for (const colName of CORE_COLLECTIONS) {
        try {
            const docs = await db.collection(colName).find({}).toArray();
            dump.collections[colName] = docs;
            dump.meta.counts[colName] = docs.length;
        } catch (err) {
            console.error(`⚠️ Chyba při čtení kolekce ${colName}:`, err.message);
            dump.collections[colName] = [];
            dump.meta.counts[colName] = 0;
        }
    }

    return dump;
}

/**
 * Export MongoDB collections into data/*.json files for GitHub backup
 */
async function exportMongoToDataFolder() {
    const dump = await dumpMongoCollections();

    for (const [colName, docs] of Object.entries(dump.collections)) {
        const filePath = path.join(DATA_FOLDER, `${colName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(docs, null, 2), 'utf8');
    }

    console.log(`📦 Vyexportováno ${Object.keys(dump.collections).length} kolekcí do složky ${DATA_FOLDER}`);
    return dump;
}

/**
 * Clean up snapshots older than retentionDays (default 30 days)
 */
function cleanupOldSnapshots(retentionDays = 30) {
    const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let removed = 0;

    [SNAPSHOTS_DIR, PRE_ACTION_DIR].forEach(dir => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            if (!file.endsWith('.json')) return;
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.statSync(fullPath);
                if (now - stat.mtimeMs > maxAgeMs) {
                    fs.unlinkSync(fullPath);
                    removed++;
                }
            } catch (e) {
                console.error(`⚠️ Chyba při mazání starého snapshotu ${file}:`, e.message);
            }
        });
    });

    if (removed > 0) {
        console.log(`🧹 Vymazáno ${removed} starých snapshotů (starší než ${retentionDays} dní)`);
    }
}

/**
 * Create a local snapshot JSON file
 * @param {'periodic'|'pre-action'} type 
 * @param {string} actionLabel 
 * @param {string} username 
 */
async function createLocalSnapshot(type = 'periodic', actionLabel = '', username = 'system') {
    try {
        const dump = await dumpMongoCollections();
        dump.meta.type = type;
        dump.meta.actionLabel = actionLabel;
        dump.meta.user = username;

        const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
        const safeLabel = actionLabel ? `_${actionLabel.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
        const filename = `${type === 'pre-action' ? 'pre' : 'snapshot'}_${dateStr}${safeLabel}.json`;

        const targetDir = type === 'pre-action' ? PRE_ACTION_DIR : SNAPSHOTS_DIR;
        const targetPath = path.join(targetDir, filename);

        fs.writeFileSync(targetPath, JSON.stringify(dump), 'utf8');
        const sizeMb = (fs.statSync(targetPath).size / 1024 / 1024).toFixed(2);
        console.log(`💾 Vytvořen ${type} snapshot: ${filename} (${sizeMb} MB)`);

        cleanupOldSnapshots(30);

        return { success: true, filename, targetPath, sizeMb, counts: dump.meta.counts };
    } catch (err) {
        console.error(`❌ Chyba při vytváření ${type} snapshotu:`, err);
        return { success: false, error: err.message };
    }
}

/**
 * Upload all current data/*.json and data/images/* to GitHub repo
 */
async function backupToGitHub(username = 'system') {
    const { Octokit } = require('@octokit/rest');
    const { retry } = require('@octokit/plugin-retry');

    if (!process.env.GITHUB_TOKEN) {
        throw new Error('GITHUB_TOKEN není nastaven v .env');
    }

    // 1. First dump live MongoDB to data/*.json and create local snapshot
    await exportMongoToDataFolder();
    await createLocalSnapshot('periodic', 'github_sync', username);

    // 2. Prepare Octokit with proper retry exclusion
    const MyOctokit = Octokit.plugin(retry);
    const octokit = new MyOctokit({
        auth: process.env.GITHUB_TOKEN,
        retry: {
            doNotRetry: ['400', '401', '403', '404', '422', '429']
        },
        request: { retries: 1, retryAfter: 1000 }
    });

    // 3. Pre-fetch remote file SHAs in batch (1 request for data folder, 1 for images)
    const remoteShas = new Map();
    try {
        const { data: dataFiles } = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: 'data',
            ref: BRANCH
        });
        if (Array.isArray(dataFiles)) {
            dataFiles.forEach(f => remoteShas.set(f.path, f.sha));
        }
    } catch (e) {
        if (e.status !== 404) console.warn('⚠️ Chyba při čtení složky data na GitHubu:', e.message);
    }

    try {
        const { data: imgFiles } = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: 'data/images',
            ref: BRANCH
        });
        if (Array.isArray(imgFiles)) {
            imgFiles.forEach(f => remoteShas.set(f.path, f.sha));
        }
    } catch (e) {
        if (e.status !== 404) console.warn('⚠️ Chyba při čtení složky data/images na GitHubu:', e.message);
    }

    const jsonFiles = fs.readdirSync(DATA_FOLDER).filter(f => f.endsWith('.json'));
    let imageFiles = [];
    if (fs.existsSync(IMAGES_FOLDER)) {
        imageFiles = fs.readdirSync(IMAGES_FOLDER).filter(f => f.match(/\.(jpg|jpeg|png|gif|webp)$/i));
    }

    const allFiles = [
        ...jsonFiles.map(f => ({ local: path.join(DATA_FOLDER, f), remote: `data/${f}` })),
        ...imageFiles.map(f => ({ local: path.join(IMAGES_FOLDER, f), remote: `data/images/${f}` }))
    ];

    let uploadedCount = 0;
    for (const fileObj of allFiles) {
        try {
            const content = fs.readFileSync(fileObj.local);
            const base64Content = content.toString('base64');
            const sha = remoteShas.get(fileObj.remote);

            await octokit.repos.createOrUpdateFileContents({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                path: fileObj.remote,
                message: `🧠 Auto-backup: ${path.basename(fileObj.local)}`,
                content: base64Content,
                branch: BRANCH,
                sha: sha || undefined
            });

            uploadedCount++;
            console.log(`✅ Zálohováno na GitHub: ${fileObj.remote}`);
        } catch (fileErr) {
            console.error(`❌ Chyba při zálohování ${fileObj.remote}:`, fileErr.message);
        }
    }

    console.log(`🎉 Záloha na GitHub dokončena. Nahráno/aktualizováno ${uploadedCount} souborů.`);
    return { success: true, uploadedCount, totalFiles: allFiles.length };
}

/**
 * List all available snapshots with details
 */
function listAvailableSnapshots() {
    const list = [];

    [
        { dir: SNAPSHOTS_DIR, type: 'periodic' },
        { dir: PRE_ACTION_DIR, type: 'pre-action' }
    ].forEach(({ dir, type }) => {
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            if (!file.endsWith('.json')) return;
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.statSync(fullPath);
                let meta = {};
                try {
                    const raw = fs.readFileSync(fullPath, 'utf8');
                    const parsed = JSON.parse(raw);
                    meta = parsed.meta || {};
                } catch (e) {}

                list.push({
                    filename: file,
                    path: fullPath,
                    type,
                    actionLabel: meta.actionLabel || '',
                    user: meta.user || 'system',
                    createdAt: meta.createdAt || stat.birthtime.toISOString(),
                    mtime: stat.mtime,
                    sizeBytes: stat.size,
                    sizeFormatted: (stat.size / 1024 / 1024).toFixed(2) + ' MB',
                    counts: meta.counts || {}
                });
            } catch (e) {}
        });
    });

    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return list;
}

/**
 * Restore MongoDB from a specific snapshot file
 * @param {string} snapshotPath 
 */
async function restoreFromLocalSnapshot(snapshotPath) {
    if (!fs.existsSync(snapshotPath)) {
        throw new Error(`Snapshot soubor ${snapshotPath} neexistuje.`);
    }

    const raw = fs.readFileSync(snapshotPath, 'utf8');
    const dump = JSON.parse(raw);

    if (!dump.collections) {
        throw new Error('Neplatný formát snapshotu (chybí collections).');
    }

    const db = getDatabase();
    if (!db) {
        throw new Error('Databáze není inicializována.');
    }

    // Safety pre-restore snapshot of current state!
    await createLocalSnapshot('pre-action', 'before_restore', 'system');

    const restoredCounts = {};
    for (const [colName, docs] of Object.entries(dump.collections)) {
        if (!CORE_COLLECTIONS.includes(colName)) continue;
        const col = db.collection(colName);
        
        // Clear collection
        await col.deleteMany({});
        
        // Insert docs
        if (Array.isArray(docs) && docs.length > 0) {
            const { ObjectId } = require('mongodb');
            const sanitizedDocs = docs.map(d => {
                if (d._id && typeof d._id === 'string' && d._id.length === 24 && /^[0-9a-fA-F]{24}$/.test(d._id)) {
                    return { ...d, _id: new ObjectId(d._id) };
                }
                return d;
            });
            await col.insertMany(sanitizedDocs);
        }
        restoredCounts[colName] = docs.length;
    }

    console.log('✅ Obnova ze snapshotu byla úspěšně dokončena:', restoredCounts);
    return { success: true, restoredCounts, meta: dump.meta };
}

module.exports = {
    CORE_COLLECTIONS,
    dumpMongoCollections,
    exportMongoToDataFolder,
    createLocalSnapshot,
    cleanupOldSnapshots,
    backupToGitHub,
    listAvailableSnapshots,
    restoreFromLocalSnapshot
};
