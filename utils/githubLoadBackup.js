const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'Medical-Issues';
const REPO_NAME = 'TELHTipovackaZaloha';
const BRANCH = 'main';
const DATA_FOLDER = path.join(__dirname, '..', 'data');
const IMAGES_FOLDER = path.join(DATA_FOLDER, 'images');

async function loadJsonFilesFromGitHub() {
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
            retryAfter: 1000,
        },
    });

    async function downloadFolder(remotePath, localPath) {
        try {
            const { data: files } = await octokit.repos.getContent({
                owner: REPO_OWNER, repo: REPO_NAME, path: remotePath, ref: BRANCH
            });

            if (!fs.existsSync(localPath)) fs.mkdirSync(localPath, { recursive: true });

            for (const file of files) {
                if (file.type === 'file') {
                    const { data: fileData } = await octokit.repos.getContent({
                        owner: REPO_OWNER, repo: REPO_NAME, path: file.path, ref: BRANCH
                    });

                    // Buffer automaticky zvládne Base64 na binární soubor
                    const content = Buffer.from(fileData.content, 'base64');
                    fs.writeFileSync(path.join(localPath, file.name), content);
                    console.log(`⬇️ Staženo: ${file.path}`);
                }
            }
        } catch (e) {
            console.log(`ℹ️ Složka ${remotePath} na GitHubu nenalezena.`);
        }
    }

    // --- TEĎ JE TO ČISTÉ A EFEKTIVNÍ ---
    console.log("🚀 Zahajuji obnovu dat ze zálohy...");

    // 1. Stáhne JSONy (leagues.json, users.json atd.)
    await downloadFolder('data', DATA_FOLDER);

    // 2. Stáhne obrázky (loga týmů)
    await downloadFolder('data/images', IMAGES_FOLDER);

    console.log("✅ Obnova kompletní.");
}

module.exports = { loadJsonFilesFromGitHub };