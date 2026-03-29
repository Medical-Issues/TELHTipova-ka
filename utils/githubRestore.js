const fs = require('fs');
const path = require('path');
const { Octokit } = require("@octokit/rest");

const REPO_OWNER = 'Medical-Issues';
const REPO_NAME = 'TELHTipovackaZaloha';
const BRANCH = 'main';
const DATA_FOLDER = path.join(__dirname, '..', 'data');
const IMAGES_FOLDER = path.join(__dirname, '..', 'public', 'images');

async function getDeletedImagesList() {
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const deletedImagesCollection = db.collection('deleted_images');
        const deletedDocs = await deletedImagesCollection.find({}).toArray();
        return new Set(deletedDocs.map(doc => doc.filename));
    } catch (error) {
        console.log('⚠️ Nepodařilo se načíst seznam smazaných obrázků:', error.message);
        return new Set();
    }
}

async function restoreFromGitHub() {
    console.log('🔄 Začínám stahování obrázků z GitHubu...');
    
    const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
    });

    // Načíst seznam smazaných obrázků
    const deletedImages = await getDeletedImagesList();
    if (deletedImages.size > 0) {
        console.log(`🗑️ Nalezeno ${deletedImages.size} smazaných obrázků - ty budou přeskočeny`);
    }

    try {
        // Stáhni POUZE obrázky (JSON data jsou v MongoDB)
        console.log('🖼️ Stahuji obrázky...');
        try {
            const { data: imageFiles } = await octokit.repos.getContent({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                path: 'data/images',
                ref: BRANCH
            });

            if (Array.isArray(imageFiles)) {
                // Vytvoř images složku pokud neexistuje
                if (!fs.existsSync(IMAGES_FOLDER)) {
                    fs.mkdirSync(IMAGES_FOLDER, { recursive: true });
                    console.log('📁 Vytvořena složka: images');
                }

                for (const file of imageFiles) {
                    if (file.name.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                        // Přeskočit smazané obrázky
                        if (deletedImages.has(file.name)) {
                            console.log(`🚫 Přeskakuji smazaný obrázek: ${file.name}`);
                            continue;
                        }
                        
                        console.log(`🖼️ Stahuji obrázek: ${file.name}`);
                        
                        const { data: fileContent } = await octokit.repos.getContent({
                            owner: REPO_OWNER,
                            repo: REPO_NAME,
                            path: file.path,
                            ref: BRANCH
                        });

                        const content = Buffer.from(fileContent.content, 'base64');
                        const localPath = path.join(IMAGES_FOLDER, file.name);
                        
                        fs.writeFileSync(localPath, content);
                        console.log(`✅ Uložen obrázek: ${localPath}`);
                    }
                }
            }
        } catch (error) {
            if (error.status === 404) {
                console.log('📁 Složka images neexistuje na GitHubu, přeskakuji...');
            } else {
                console.error('❌ Chyba při stahování obrázků:', error.message);
            }
        }

        console.log('🎉 Restore obrázků z GitHubu dokončen!');
        return true;

    } catch (error) {
        console.error('❌ Chyba při restore z GitHubu:', error);
        return false;
    }
}

// Přidáme funkci pro kompletní restore (včetně JSON) pro případ nouze
async function fullRestoreFromGitHub() {
    console.log('🔄 Začínám kompletní restore (JSON + obrázky) z GitHubu...');
    
    const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
    });

    // Načíst seznam smazaných obrázků
    const deletedImages = await getDeletedImagesList();
    if (deletedImages.size > 0) {
        console.log(`🗑️ Nalezeno ${deletedImages.size} smazaných obrázků - ty budou přeskočeny`);
    }

    try {
        // 1. Stáhni JSON soubory (pro nouzovou obnovu)
        console.log('📄 Stahuji JSON soubory...');
        const { data: jsonFiles } = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: 'data',
            ref: BRANCH
        });

        if (Array.isArray(jsonFiles)) {
            for (const file of jsonFiles) {
                if (file.name.endsWith('.json')) {
                    console.log(`📥 Stahuji: ${file.name}`);
                    
                    const { data: fileContent } = await octokit.repos.getContent({
                        owner: REPO_OWNER,
                        repo: REPO_NAME,
                        path: file.path,
                        ref: BRANCH
                    });

                    const content = Buffer.from(fileContent.content, 'base64').toString('utf8');
                    const localPath = path.join(DATA_FOLDER, file.name);
                    
                    fs.writeFileSync(localPath, content, 'utf8');
                    console.log(`✅ Uloženo: ${localPath}`);
                }
            }
        }

        // 2. Stáhni obrázky
        console.log('🖼️ Stahuji obrázky...');
        try {
            const { data: imageFiles } = await octokit.repos.getContent({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                path: 'data/images',
                ref: BRANCH
            });

            if (Array.isArray(imageFiles)) {
                if (!fs.existsSync(IMAGES_FOLDER)) {
                    fs.mkdirSync(IMAGES_FOLDER, { recursive: true });
                }

                for (const file of imageFiles) {
                    if (file.name.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
                        // Přeskočit smazané obrázky
                        if (deletedImages.has(file.name)) {
                            console.log(`🚫 Přeskakuji smazaný obrázek: ${file.name}`);
                            continue;
                        }
                        
                        console.log(`🖼️ Stahuji obrázek: ${file.name}`);
                        
                        const { data: fileContent } = await octokit.repos.getContent({
                            owner: REPO_OWNER,
                            repo: REPO_NAME,
                            path: file.path,
                            ref: BRANCH
                        });

                        const content = Buffer.from(fileContent.content, 'base64');
                        const localPath = path.join(IMAGES_FOLDER, file.name);
                        
                        fs.writeFileSync(localPath, content);
                        console.log(`✅ Uložen obrázek: ${localPath}`);
                    }
                }
            }
        } catch (error) {
            if (error.status === 404) {
                console.log('📁 Složka images neexistuje na GitHubu, přeskakuji...');
            } else {
                console.error('❌ Chyba při stahování obrázků:', error.message);
            }
        }

        console.log('🎉 Kompletní restore z GitHubu dokončen!');
        return true;

    } catch (error) {
        console.error('❌ Chyba při kompletním restore z GitHubu:', error);
        return false;
    }
}

module.exports = { restoreFromGitHub, fullRestoreFromGitHub };
