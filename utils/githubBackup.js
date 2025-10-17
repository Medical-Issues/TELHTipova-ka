const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'Medical-Issues';
const REPO_NAME = 'TELHTipovackaZaloha';
const BRANCH = 'main';
const DATA_FOLDER = path.join(__dirname, '..', 'data');

async function backupJsonFilesToGitHub() {
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

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
}

module.exports = { backupJsonFilesToGitHub };
