const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'Medical-Issues';
const REPO_NAME = 'TELHTipovackaZaloha';
const BRANCH = 'main';
const DATA_FOLDER = path.join(__dirname, '..', 'data');
const IMAGES_FOLDER = path.resolve(DATA_FOLDER, 'images');

async function backupJsonFilesToGitHub() {
    const { Octokit } = require("@octokit/rest");
    const { retry } = require("@octokit/plugin-retry");

    const MyOctokit = Octokit.plugin(retry);
    const octokit = new MyOctokit({
        auth: process.env.GITHUB_TOKEN,
        retry: {
            doNotRetry: ["429"],
        },
        request: {
            retries: 3,
            retryAfter: 2000,
        },
    });

    try {
        const jsonFiles = fs.readdirSync(DATA_FOLDER).filter(f => f.endsWith('.json'));
        let imageFiles = [];
        if (fs.existsSync(IMAGES_FOLDER)) {
            imageFiles = fs.readdirSync(IMAGES_FOLDER).filter(f => f.match(/\.(jpg|jpeg|png|gif|webp)$/i));
        }
        const allFiles = [
            ...jsonFiles.map(f => ({ local: path.join(DATA_FOLDER, f), remote: `data/${f}`, type: 'utf8' })),
            ...imageFiles.map(f => ({ local: path.join(IMAGES_FOLDER, f), remote: `data/images/${f}`, type: 'binary' }))
        ];

        for (const fileObj of allFiles) {
            const content = fs.readFileSync(fileObj.local);
            const base64Content = content.toString('base64');

            let sha = null;
            // ... v cyklu for (const fileObj of allFiles)
            try {
                const { data } = await octokit.repos.getContent({
                    owner: REPO_OWNER, repo: REPO_NAME, path: fileObj.remote, ref: BRANCH
                });
                sha = data.sha;
            } catch (e) {
                if (e.status !== 404) {
                    // OPRAVA: změněno na fileObj.local
                    console.log(`⚠️ Varování u souboru ${fileObj.local}: ${e.message}`);
                }
            }
            await octokit.repos.createOrUpdateFileContents({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                path: fileObj.remote,
                message: `🧠 Auto-backup: ${path.basename(fileObj.local)}`,
                content: base64Content,
                branch: BRANCH,
                sha: sha || undefined,
            });
            console.log(`✅ Zálohováno: ${fileObj.remote}`);
        }
        console.log("🎉 Záloha kompletně dokončena (včetně obrázků).");

    } catch (error) {
        if (error.status >= 500) {
            console.error("🔥 GitHub má problémy (Status 500).");
        } else {
            console.error("❌ Chyba při zálohování:", error.message);
        }
    }
}

module.exports = { backupJsonFilesToGitHub };