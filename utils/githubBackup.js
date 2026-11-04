const { backupToGitHub } = require('./backupService');

async function backupJsonFilesToGitHub(username = 'system') {
    return await backupToGitHub(username);
}

module.exports = { backupJsonFilesToGitHub };
