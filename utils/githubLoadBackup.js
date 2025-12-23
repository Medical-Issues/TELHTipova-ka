const fs = require('fs');
const path = require('path');

const REPO_OWNER = 'Medical-Issues';
const REPO_NAME = 'TELHTipovackaZaloha';
const BRANCH = 'main';
const DATA_FOLDER = path.join(__dirname, '..', 'data');

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

    try {
        const { data: files } = await octokit.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: 'data',
            ref: BRANCH,
        });

        for (const file of files) {
            if (file.name.endsWith('.json')) {
                const { data: fileData } = await octokit.repos.getContent({
                    owner: REPO_OWNER,
                    repo: REPO_NAME,
                    path: `data/${file.name}`,
                    ref: BRANCH,
                });

                const content = Buffer.from(fileData.content, 'base64').toString('utf8');

                const filePath = path.join(DATA_FOLDER, file.name);

                if (!fs.existsSync(DATA_FOLDER)){
                    fs.mkdirSync(DATA_FOLDER, { recursive: true });
                }

                fs.writeFileSync(filePath, content, 'utf8');
                console.log(`⬇️ Staženo: ${file.name}`);
            }
        }
    } catch (e) {
        console.error('Chyba při stahování záloh z GitHubu:', e);
    }
}

module.exports = { loadJsonFilesFromGitHub };