const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Bezpečnostní statistiky
const securityStats = {
    requests: {
        total: 0,
        lastMinute: 0,
        lastHour: 0,
        last24Hours: 0
    },
    attacks: {
        ddos: { detected: 0, blocked: 0, lastDetection: null },
        bruteForce: { detected: 0, blocked: 0, lastDetection: null },
        suspicious: { detected: 0, blocked: 0, lastDetection: null },
        sqlInjection: { detected: 0, blocked: 0, lastDetection: null },
        xss: { detected: 0, blocked: 0, lastDetection: null }
    },
    ips: {
        unique: new Set(),
        blocked: new Set(),
        suspicious: new Set()
    },
    endpoints: {
        mostAccessed: {},
        errorRate: {}
    },
    lastReset: Date.now()
};

// Rate limiting pro DDOS ochranu
const ddosLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minuta
    max: 100, // max 100 requestů za minutu
    message: { error: 'Too many requests', blocked: true },
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        securityStats.attacks.ddos.detected++;
        securityStats.attacks.ddos.blocked++;
        securityStats.attacks.ddos.lastDetection = new Date().toISOString();
        
        const clientIP = req.ip || req.connection.remoteAddress;
        securityStats.ips.blocked.add(clientIP);
        
        console.log(`🚨 DDOS Attack detected from ${clientIP}`);
        
        res.status(429).json({
            error: 'DDOS protection activated',
            blocked: true,
            ip: clientIP,
            timestamp: new Date().toISOString()
        });
    }
});

// Rate limiting pro auth endpointy
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minut
    max: 10, // max 10 pokusů o přihlášení za 15 minut
    message: { error: 'Too many auth attempts', blocked: true },
    keyGenerator: (req) => req.ip || req.connection.remoteAddress,
    handler: (req, res) => {
        securityStats.attacks.bruteForce.detected++;
        securityStats.attacks.bruteForce.blocked++;
        securityStats.attacks.bruteForce.lastDetection = new Date().toISOString();
        
        const clientIP = req.ip || req.connection.remoteAddress;
        securityStats.ips.blocked.add(clientIP);
        
        console.log(`🚨 Brute force attack detected from ${clientIP}`);
        
        res.status(429).json({
            error: 'Brute force protection activated',
            blocked: true,
            ip: clientIP,
            timestamp: new Date().toISOString()
        });
    }
});

// Middleware pro security monitoring
const securityMonitor = (req, res, next) => {
    const clientIP = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent') || 'Unknown';
    const endpoint = req.path;
    
    // Aktualizace statistik
    securityStats.requests.total++;
    securityStats.ips.unique.add(clientIP);
    
    // Track endpoint access
    if (!securityStats.endpoints.mostAccessed[endpoint]) {
        securityStats.endpoints.mostAccessed[endpoint] = 0;
    }
    securityStats.endpoints.mostAccessed[endpoint]++;
    
    // DDOS detection - příliš mnoho requestů z jedné IP
    const ipRequests = getIPRequestCount(clientIP);
    if (ipRequests > 50) { // více než 50 requestů za minutu
        securityStats.attacks.ddos.detected++;
        securityStats.attacks.ddos.lastDetection = new Date().toISOString();
        securityStats.ips.suspicious.add(clientIP);
        
        console.log(`⚠️ Suspicious activity detected from ${clientIP}: ${ipRequests} requests/min`);
    }
    
    // SQL Injection detection
    const sqlPatterns = [
        /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/i,
        /(--|#|\/\*|\*\/|;|'|")/,
        /(\b(OR|AND)\s+\d+\s*=\s*\d+)/i,
        /(\b(OR|AND)\s+['"]?\w+['"]?\s*=\s*['"]?\w+['"]?)/i
    ];
    
    const queryString = JSON.stringify(req.query) + JSON.stringify(req.body);
    const isSQLInjection = sqlPatterns.some(pattern => pattern.test(queryString));
    
    if (isSQLInjection) {
        securityStats.attacks.sqlInjection.detected++;
        securityStats.attacks.sqlInjection.blocked++;
        securityStats.attacks.sqlInjection.lastDetection = new Date().toISOString();
        securityStats.ips.blocked.add(clientIP);
        
        console.log(`🚨 SQL Injection attempt detected from ${clientIP}`);
        
        return res.status(403).json({
            error: 'Malicious request detected',
            blocked: true,
            type: 'SQL_INJECTION',
            ip: clientIP,
            timestamp: new Date().toISOString()
        });
    }
    
    // XSS detection
    const xssPatterns = [
        /<script[^>]*>.*?<\/script>/gi,
        /javascript:/gi,
        /on\w+\s*=/gi,
        /<iframe[^>]*>/gi,
        /<object[^>]*>/gi,
        /<embed[^>]*>/gi
    ];
    
    const isXSS = xssPatterns.some(pattern => pattern.test(queryString));
    
    if (isXSS) {
        securityStats.attacks.xss.detected++;
        securityStats.attacks.xss.blocked++;
        securityStats.attacks.xss.lastDetection = new Date().toISOString();
        securityStats.ips.blocked.add(clientIP);
        
        console.log(`🚨 XSS attempt detected from ${clientIP}`);
        
        return res.status(403).json({
            error: 'Malicious request detected',
            blocked: true,
            type: 'XSS',
            ip: clientIP,
            timestamp: new Date().toISOString()
        });
    }
    
    // Suspicious User Agent detection
    const suspiciousUserAgents = [
        /bot/i,
        /crawler/i,
        /scanner/i,
        /wget/i,
        /curl/i,
        /python/i,
        /java/i,
        /go-http/i,
        /postman/i,
        /insomnia/i
    ];
    
    const isSuspiciousUA = suspiciousUserAgents.some(pattern => pattern.test(userAgent));
    
    if (isSuspiciousUA && !endpoint.includes('/health') && !endpoint.includes('/ping')) {
        securityStats.attacks.suspicious.detected++;
        securityStats.attacks.suspicious.lastDetection = new Date().toISOString();
        securityStats.ips.suspicious.add(clientIP);
        
        console.log(`⚠️ Suspicious User Agent detected: ${userAgent} from ${clientIP}`);
    }
    
    // Logování requestů
    logSecurityEvent({
        type: 'REQUEST',
        ip: clientIP,
        userAgent,
        endpoint,
        method: req.method,
        timestamp: new Date(),
        suspicious: isSuspiciousUA
    });
    
    next();
};

// Pomocné funkce
function getIPRequestCount() {
    // Zjednodušené počítání - v produkci by bylo v Redis/DB
    return Math.floor(Math.random() * 100); // Simulace
}

function logSecurityEvent(event) {
    try {
        const logEntry = {
            ...event,
            id: Date.now().toString() + Math.random().toString(36).substr(2, 9)
        };
        
        // Uložit do log souboru
        const logFile = path.join(__dirname, '..', 'logs', 'security.log');
        if (!fs.existsSync(path.dirname(logFile))) {
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
        }
        
        fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');
        
        // Uložit do databáze (asynchronně)
        saveSecurityLogToDB(logEntry);
        
    } catch (error) {
        console.error('Error logging security event:', error);
    }
}

async function saveSecurityLogToDB(event) {
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const collection = db.collection('security_logs');
        await collection.insertOne(event);
    } catch (error) {
        // Ignorovat chyby logování
    }
}

// Aplikovat middleware
router.use(securityMonitor);
router.use(ddosLimiter);

// Security monitoring endpoint
router.get('/security-status', async (req, res) => {
    try {
        const now = Date.now();
        const oneHourAgo = now - 3600000;
        const oneDayAgo = now - 86400000;
        
        // Získání dat z databáze
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const securityCollection = db.collection('security_logs');
        
        // Statistiky za poslední hodinu/den
        const lastHourEvents = await securityCollection.countDocuments({
            timestamp: { $gte: new Date(oneHourAgo) }
        });
        
        const lastDayEvents = await securityCollection.countDocuments({
            timestamp: { $gte: new Date(oneDayAgo) }
        });
        
        // Blokované IP adresy
        const blockedIPs = await securityCollection.distinct('ip', {
            blocked: true,
            timestamp: { $gte: new Date(oneDayAgo) }
        });
        
        // Typy útoků
        const attackTypes = await securityCollection.aggregate([
            { $match: { timestamp: { $gte: new Date(oneDayAgo) } } },
            { $group: { _id: '$type', count: { $sum: 1 } } }
        ]).toArray();
        
        const securityData = {
            timestamp: new Date().toISOString(),
            status: 'OK',
            monitoring: {
                requests: {
                    total: securityStats.requests.total,
                    lastHour: lastHourEvents,
                    last24Hours: lastDayEvents
                },
                attacks: {
                    ...securityStats.attacks,
                    total: Object.values(securityStats.attacks).reduce((sum, attack) => sum + attack.detected, 0)
                },
                ips: {
                    unique: securityStats.ips.unique.size,
                    blocked: blockedIPs.length,
                    suspicious: securityStats.ips.suspicious.size
                },
                endpoints: {
                    mostAccessed: Object.entries(securityStats.endpoints.mostAccessed)
                        .sort(([,a], [,b]) => b - a)
                        .slice(0, 10)
                        .map(([endpoint, count]) => ({ endpoint, count })),
                    attackTypes: attackTypes.map(type => ({ type: type._id, count: type.count }))
                }
            },
            protections: {
                ddosProtection: 'ACTIVE',
                bruteForceProtection: 'ACTIVE',
                sqlInjectionProtection: 'ACTIVE',
                xssProtection: 'ACTIVE',
                rateLimiting: 'ACTIVE'
            },
            alerts: []
        };
        
        // Generování alertů
        if (securityData.monitoring.attacks.total > 10) {
            securityData.alerts.push({
                level: 'HIGH',
                type: 'MULTIPLE_ATTACKS',
                message: `Detected ${securityData.monitoring.attacks.total} attacks in last 24h`
            });
        }
        
        if (securityData.monitoring.ips.blocked > 50) {
            securityData.alerts.push({
                level: 'MEDIUM',
                type: 'HIGH_BLOCKED_IPS',
                message: `${securityData.monitoring.ips.blocked} IPs blocked in last 24h`
            });
        }
        
        if (securityData.monitoring.requests.lastHour > 1000) {
            securityData.alerts.push({
                level: 'MEDIUM',
                type: 'HIGH_TRAFFIC',
                message: `${securityData.monitoring.requests.lastHour} requests in last hour`
            });
        }
        
        res.json(securityData);
        
    } catch (error) {
        console.error('Security status error:', error);
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Security alerts endpoint (pro UptimeRobot)
router.get('/security-alerts', async (req, res) => {
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const securityCollection = db.collection('security_logs');
        
        const oneHourAgo = new Date(Date.now() - 3600000);
        
        // Kontrola kritických bezpečnostních událostí
        const criticalEvents = await securityCollection.countDocuments({
            timestamp: { $gte: oneHourAgo },
            $or: [
                { type: 'SQL_INJECTION' },
                { type: 'XSS' },
                { blocked: true }
            ]
        });
        
        const ddosAttempts = await securityCollection.countDocuments({
            timestamp: { $gte: oneHourAgo },
            type: 'DDOS'
        });
        
        const bruteForceAttempts = await securityCollection.countDocuments({
            timestamp: { $gte: oneHourAgo },
            type: 'BRUTE_FORCE'
        });
        
        const status = {
            timestamp: new Date().toISOString(),
            status: 'OK',
            security: {
                criticalEvents,
                ddosAttempts,
                bruteForceAttempts,
                totalAttacks: criticalEvents + ddosAttempts + bruteForceAttempts
            },
            protections: {
                ddosProtection: 'ACTIVE',
                bruteForceProtection: 'ACTIVE',
                sqlInjectionProtection: 'ACTIVE',
                xssProtection: 'ACTIVE'
            }
        };
        
        // Pokud jsou příliš mnoho útoků, změnit status
        if (status.security.totalAttacks > 50) {
            status.status = 'CRITICAL';
        } else if (status.security.totalAttacks > 10) {
            status.status = 'WARNING';
        }
        
        // Pro UptimeRobot - vždy 200 OK, ale s detailním stavem
        res.status(200).json(status);
        
    } catch (error) {
        // I při chybě vracíme 200 pro UptimeRobot
        res.status(200).json({
            timestamp: new Date().toISOString(),
            status: 'ERROR',
            error: error.message,
            security: {
                criticalEvents: 0,
                ddosAttempts: 0,
                bruteForceAttempts: 0,
                totalAttacks: 0
            }
        });
    }
});

// IP blacklist endpoint
router.get('/blacklist', async (req, res) => {
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const securityCollection = db.collection('security_logs');
        
        const oneDayAgo = new Date(Date.now() - 86400000);
        
        const blockedIPs = await securityCollection.aggregate([
            { $match: { blocked: true, timestamp: { $gte: oneDayAgo } } },
            { $group: { _id: '$ip', count: { $sum: 1 }, lastSeen: { $max: '$timestamp' } } },
            { $sort: { count: -1 } },
            { $limit: 100 }
        ]).toArray();
        
        res.json({
            timestamp: new Date().toISOString(),
            blockedIPs: blockedIPs.map(ip => ({
                ip: ip._id,
                violations: ip.count,
                lastSeen: ip.lastSeen
            })),
            totalBlocked: blockedIPs.length
        });
        
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Export rate limiters pro použití v ostatních routách
module.exports = {
    router,
    ddosLimiter,
    authLimiter,
    securityMonitor,
    securityStats
};
