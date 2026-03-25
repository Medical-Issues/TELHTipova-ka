const express = require('express');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Komplexní health check endpoint
router.get('/health', async (req, res) => {
    const startTime = Date.now();
    const checks = {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        status: 'OK',
        checks: {},
        summary: {
            passed: 0,
            failed: 0,
            total: 0
        }
    };

    try {
        // 1. Server status check
        checks.server = {
            status: 'OK',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            version: process.version,
            platform: process.platform
        };
        checks.summary.passed++;

        // 2. Database connection check
        try {
            const { connectToDatabase } = require('../config/database');
            const db = await connectToDatabase();
            await db.admin().ping();
            
            // Zjistit info o databázi
            const stats = await db.stats();
            const collections = await db.listCollections().toArray();
            
            checks.database = {
                status: 'OK',
                collections: collections.length,
                dataSize: stats.dataSize,
                storageSize: stats.storageSize,
                indexes: stats.indexes,
                objects: stats.objects
            };
            checks.summary.passed++;
        } catch (dbError) {
            checks.database = {
                status: 'ERROR',
                error: dbError.message
            };
            checks.summary.failed++;
            checks.status = 'DEGRADED';
        }

        // 3. File system check
        try {
            const requiredDirs = ['public', 'data', 'sessions'];
            const dirChecks = {};
            
            for (const dir of requiredDirs) {
                const dirPath = path.join(__dirname, '..', dir);
                dirChecks[dir] = {
                    exists: fs.existsSync(dirPath),
                    readable: fs.existsSync(dirPath) ? fs.accessSync(dirPath, fs.constants.R_OK, () => {}) : false
                };
            }
            
            const allDirsOk = Object.values(dirChecks).every(check => check.exists);
            checks.filesystem = {
                status: allDirsOk ? 'OK' : 'ERROR',
                directories: dirChecks
            };
            
            if (allDirsOk) {
                checks.summary.passed++;
            } else {
                checks.summary.failed++;
                checks.status = 'DEGRADED';
            }
        } catch (fsError) {
            checks.filesystem = {
                status: 'ERROR',
                error: fsError.message
            };
            checks.summary.failed++;
            checks.status = 'DEGRADED';
        }

        // 4. Session storage check
        try {
            const sessionsDir = path.join(__dirname, '..', 'sessions');
            const sessionFiles = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).length : 0;
            
            checks.sessions = {
                status: 'OK',
                directory: sessionsDir,
                sessionCount: sessionFiles,
                directoryExists: fs.existsSync(sessionsDir)
            };
            checks.summary.passed++;
        } catch (sessionError) {
            checks.sessions = {
                status: 'ERROR',
                error: sessionError.message
            };
            checks.summary.failed++;
            checks.status = 'DEGRADED';
        }

        // 5. GitHub backup check
        try {
            if (process.env.GITHUB_TOKEN) {
                checks.github = {
                    status: 'OK',
                    tokenConfigured: true,
                    lastBackup: 'N/A' // Zde by mohl být čas poslední zálohy
                };
                checks.summary.passed++;
            } else {
                checks.github = {
                    status: 'WARNING',
                    tokenConfigured: false,
                    message: 'GitHub token není nastaven'
                };
                checks.summary.failed++;
                checks.status = 'DEGRADED';
            }
        } catch (githubError) {
            checks.github = {
                status: 'ERROR',
                error: githubError.message
            };
            checks.summary.failed++;
            checks.status = 'DEGRADED';
        }

        // 6. Memory check
        const memoryUsage = process.memoryUsage();
        const memoryUsagePercent = (memoryUsage.heapUsed / memoryUsage.heapTotal) * 100;
        
        checks.memory = {
            status: memoryUsagePercent > 90 ? 'ERROR' : memoryUsagePercent > 75 ? 'WARNING' : 'OK',
            heapUsed: memoryUsage.heapUsed,
            heapTotal: memoryUsage.heapTotal,
            external: memoryUsage.external,
            rss: memoryUsage.rss,
            usagePercent: Math.round(memoryUsagePercent)
        };
        
        if (memoryUsagePercent > 90) {
            checks.summary.failed++;
            checks.status = 'ERROR';
        } else if (memoryUsagePercent > 75) {
            checks.summary.failed++;
            checks.status = 'DEGRADED';
        } else {
            checks.summary.passed++;
        }

        // 7. CPU load check (pokud je dostupný)
        try {
            const loadAvg = require('os').loadavg();
            checks.cpu = {
                status: 'OK',
                loadAverage: loadAvg,
                cores: require('os').cpus().length
            };
            checks.summary.passed++;
        } catch (cpuError) {
            checks.cpu = {
                status: 'WARNING',
                error: 'CPU info not available'
            };
            checks.summary.failed++;
        }

        // 8. Application-specific checks
        try {
            const { connectToDatabase } = require('../config/database');
            const db = await connectToDatabase();
            
            // Kontrola klíčových kolekcí
            const criticalCollections = ['users', 'ligy'];
            const collectionChecks = {};
            
            for (const collName of criticalCollections) {
                try {
                    const coll = db.collection(collName);
                    const count = await coll.countDocuments();
                    collectionChecks[collName] = {
                        exists: true,
                        documentCount: count
                    };
                } catch (collError) {
                    collectionChecks[collName] = {
                        exists: false,
                        error: collError.message
                    };
                }
            }
            
            const allCollectionsOk = Object.values(collectionChecks).every(check => check.exists);
            checks.collections = {
                status: allCollectionsOk ? 'OK' : 'ERROR',
                critical: collectionChecks
            };
            
            if (allCollectionsOk) {
                checks.summary.passed++;
            } else {
                checks.summary.failed++;
                checks.status = 'ERROR';
            }
        } catch (appError) {
            checks.collections = {
                status: 'ERROR',
                error: appError.message
            };
            checks.summary.failed++;
            checks.status = 'ERROR';
        }

        // 9. Response time check
        const responseTime = Date.now() - startTime;
        checks.responseTime = {
            status: responseTime > 5000 ? 'ERROR' : responseTime > 2000 ? 'WARNING' : 'OK',
            time: responseTime
        };
        
        if (responseTime > 5000) {
            checks.summary.failed++;
            if (checks.status === 'OK') checks.status = 'DEGRADED';
        } else {
            checks.summary.passed++;
        }

        // 10. Environment variables check
        const criticalEnvVars = ['MONGODB_URI'];
        const envChecks = {};
        
        for (const envVar of criticalEnvVars) {
            envChecks[envVar] = {
                configured: !!process.env[envVar],
                value: process.env[envVar] ? '***CONFIGURED***' : 'NOT_SET'
            };
        }
        
        const allEnvVarsOk = Object.values(envChecks).every(check => check.configured);
        checks.environment = {
            status: allEnvVarsOk ? 'OK' : 'ERROR',
            variables: envChecks
        };
        
        if (allEnvVarsOk) {
            checks.summary.passed++;
        } else {
            checks.summary.failed++;
            checks.status = 'ERROR';
        }

        // Celkový souhrn
        checks.summary.total = checks.summary.passed + checks.summary.failed;
        checks.responseTime = responseTime;

        // Určení HTTP status kódu
        let httpStatus = 200;
        if (checks.status === 'ERROR') httpStatus = 503;
        else if (checks.status === 'DEGRADED') httpStatus = 200; // Stále 200, ale s varováním

        res.status(httpStatus).json(checks);

    } catch (error) {
        console.error('Health check failed:', error);
        res.status(503).json({
            status: 'ERROR',
            timestamp: new Date().toISOString(),
            error: error.message,
            responseTime: Date.now() - startTime
        });
    }
});

// Jednoduchý ping endpoint pro rychlou kontrolu
router.get('/ping', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        message: 'PONG'
    });
});

// Detailní status pro UptimeRobot (vždy 200 s detailním popisem)
router.get('/status', async (req, res) => {
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        await db.admin().ping();
        
        res.status(200).json({
            status: 'OK',
            service: 'TELH Tipovačka',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            database: 'CONNECTED',
            memory: {
                used: process.memoryUsage().heapUsed,
                total: process.memoryUsage().heapTotal
            },
            message: 'All systems operational'
        });
    } catch (error) {
        // I při chybě vracíme 200, ale s informací o problému
        res.status(200).json({
            status: 'DEGRADED',
            service: 'TELH Tipovačka',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            database: 'ERROR',
            error: error.message,
            message: 'Service running with issues'
        });
    }
});

// Endpoint pro monitoring statistiky
router.get('/monitoring-stats', async (req, res) => {
    try {
        const { getStats } = require('../utils/monitoring');
        const stats = getStats();
        
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            monitoring: stats
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint pro security monitoring statistiky
router.get('/security-monitoring-stats', async (req, res) => {
    try {
        const { getSecurityStats } = require('../utils/securityMonitoring');
        const stats = getSecurityStats();
        
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            security: stats
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint pro agresivní keep-alive statistiky
router.get('/aggressive-keepalive-stats', async (req, res) => {
    try {
        const { keepAliveStats } = require('../utils/aggressiveKeepAlive');
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            aggressiveKeepAlive: keepAliveStats
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint pro extrémní keep-alive statistiky
router.get('/extreme-keepalive-stats', async (req, res) => {
    try {
        const stats = extremeKeepAlive.getStats();
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            extremeKeepAlive: stats
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router;
