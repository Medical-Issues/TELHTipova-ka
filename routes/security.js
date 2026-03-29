const express = require('express');
require('fs');
require('path');
const router = express.Router();

// Dummy middleware pro kompatibilitu
const dummyMiddleware = (req, res, next) => next();

// Security endpointy - zjednodušené
router.get('/security-status', async (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        status: 'OK',
        message: 'Protection handled by Render'
    });
});

router.get('/security-alerts', async (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        status: 'OK',
        security: {
            criticalEvents: 0,
            totalAttacks: 0
        },
        protections: {
            rateLimiting: 'DISABLED'
        }
    });
});

router.get('/blacklist', async (req, res) => {
    res.json({
        timestamp: new Date().toISOString(),
        blockedIPs: [],
        totalBlocked: 0,
        message: 'IP blacklist disabled'
    });
});

// Export - dummy middleware pro kompatibilitu
module.exports = {
    router,
    limiter: dummyMiddleware,
    authLimiter: dummyMiddleware,
    securityMonitor: dummyMiddleware,
    securityStats: {}
};
