const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'Medical-Issues';
const REPO_NAME = 'TELHTipovackaZaloha';
const BRANCH = 'main';
const DATA_FOLDER = path.join(__dirname, '..', 'data');

async function backupJsonFilesToGitHub() {
    const { Octokit } = await import('@octokit/rest');
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

    const files = fs.readdirSync(DATA_FOLDER).filter(file => file.endsWith('.json'));

    for (const file of files) {
        const filePath = path.join(DATA_FOLDER, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const base64Content = Buffer.from(content).toString('base64');
        const gitPath = `data/${file}`;

        let sha = null;
        try {
            const { data } = await octokit.rest.repos.getContent({
                owner: REPO_OWNER,
                repo: REPO_NAME,
                path: gitPath,
                ref: BRANCH,
            });
            sha = data.sha;
        } catch (e) {
            console.log(`Soubor ${file} bude vytvořen.`);
        }

        await octokit.rest.repos.createOrUpdateFileContents({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: gitPath,
            message: `🧠 Auto-backup: ${file}`,
            content: base64Content,
            branch: BRANCH,
            sha: sha || undefined,
        });

        console.log(`✅ Zálohováno: ${file}`);
    }
    try {
        console.log("✅ Záloha úspěšná");
    } catch (error) {
        if (error.status >= 500) {
            console.error("🔥 GitHub má problémy (Status 500).");
        } else {
            console.error("❌ Jiná chyba::", error.message);
        }
    }
}

module.exports = { backupJsonFilesToGitHub };
