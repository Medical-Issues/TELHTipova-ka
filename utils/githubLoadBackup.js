const fs = require('fs');
const path = require('path');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = 'Medical-Issues';
const REPO_NAME = 'TELHTipovackaZaloha';
const BRANCH = 'main';
const DATA_FOLDER = path.join(__dirname, '..', 'data');

async function loadJsonFilesFromGitHub() {
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    try {
        const { data: files } = await octokit.rest.repos.getContent({
            owner: REPO_OWNER,
            repo: REPO_NAME,
            path: 'data',
            ref: BRANCH,
        });

        for (const file of files) {
            if (file.name.endsWith('.json')) {
                const { data: fileData } = await octokit.rest.repos.getContent({
                    owner: REPO_OWNER,
                    repo: REPO_NAME,
                    path: `data/${file.name}`,
                    ref: BRANCH,
                });

                const content = Buffer.from(fileData.content, 'base64').toString('utf8');

                const filePath = path.join(DATA_FOLDER, file.name);
                fs.writeFileSync(filePath, content, 'utf8');
                console.log(`⬇️ Staženo: ${file.name}`);
            }
        }
    } catch (e) {
        console.error('Chyba při stahování záloh z GitHubu:', e);
    }
}

module.exports = { loadJsonFilesFromGitHub };
