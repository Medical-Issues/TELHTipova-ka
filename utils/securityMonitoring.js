// Security monitoring - VYPNUTO (Render má vlastní ochranu)

function startSecurityMonitoring() {
    console.log('🔒 Security monitoring disabled - using Render built-in protection');
}

function runSecurityMonitoring() {
    // No-op
}

function getSecurityStats() {
    return {
        status: 'DISABLED',
        message: 'Security monitoring disabled'
    };
}

function getSecurityMonitoringStats(req, res) {
    res.json({
        status: 'DISABLED',
        message: 'Security monitoring disabled - using Render built-in protection'
    });
}

function checkSecurityStatus() {
    return Promise.resolve({ disabled: true });
}

module.exports = {
    runSecurityMonitoring,
    getSecurityStats,
    startSecurityMonitoring,
    getSecurityMonitoringStats,
    checkSecurityStatus
};

