const axios = require('axios');

// Konfigurace pro bezpečnostní monitoring
const SECURITY_MONITORING = {
    // Hlavní security endpoint
    mainSecurity: {
        url: process.env.SECURITY_URL || 'https://telhtipova-ka.onrender.com/security/security-alerts',
        interval: 300000, // 5 minut
        timeout: 15000
    },
    
    // Security status endpoint
    securityStatus: {
        url: process.env.SECURITY_STATUS_URL || 'https://telhtipova-ka.onrender.com/security/security-status',
        interval: 600000, // 10 minut
        timeout: 20000
    }
};

// Bezpečnostní statistiky
const securityMonitoringStats = {
    totalChecks: 0,
    securityIncidents: 0,
    ddosAttacks: 0,
    bruteForceAttempts: 0,
    sqlInjectionAttempts: 0,
    xssAttempts: 0,
    blockedIPs: 0,
    lastSecurityCheck: null,
    lastIncident: null
};

// Funkce pro bezpečnostní kontrolu
async function checkSecurityStatus(name, config) {
    const startTime = Date.now();
    
    try {
        const response = await axios.get(config.url, {
            timeout: config.timeout,
            headers: {
                'User-Agent': `Security-Monitoring-${name}`,
                'X-Security-Timestamp': new Date().toISOString()
            }
        });
        
        const responseTime = Date.now() - startTime;
        const data = response.data;
        
        // Analýza bezpečnostních dat
        let securityLevel = 'NORMAL';
        let incidents = 0;
        
        if (data.security) {
            const { criticalEvents, ddosAttempts, bruteForceAttempts, totalAttacks } = data.security;
            
            incidents = totalAttacks || 0;
            securityMonitoringStats.ddosAttacks += ddosAttempts || 0;
            securityMonitoringStats.bruteForceAttempts += bruteForceAttempts || 0;
            securityMonitoringStats.securityIncidents += criticalEvents || 0;
            
            if (totalAttacks > 50) {
                securityLevel = 'CRITICAL';
            } else if (totalAttacks > 10) {
                securityLevel = 'HIGH';
            } else if (totalAttacks > 0) {
                securityLevel = 'MEDIUM';
            }
        }
        
        if (data.blockedIPs) {
            securityMonitoringStats.blockedIPs += data.blockedIPs.totalBlocked || 0;
        }
        
        if (incidents > 0) {
            securityMonitoringStats.lastIncident = new Date().toISOString();
        }
        
        securityMonitoringStats.totalChecks++;
        securityMonitoringStats.lastSecurityCheck = new Date().toISOString();
        
        console.log(`🔒 [${name}] Security check completed - Level: ${securityLevel} (${responseTime}ms)`);
        
        if (securityLevel !== 'NORMAL') {
            console.log(`⚠️ [${name}] Security incidents detected: ${incidents}`);
        }
        
        return {
            name,
            success: true,
            securityLevel,
            incidents,
            responseTime,
            timestamp: new Date().toISOString(),
            data
        };
        
    } catch (error) {
        const responseTime = Date.now() - startTime;
        
        console.error(`❌ [${name}] Security check failed (${responseTime}ms): ${error.message}`);
        
        return {
            name,
            success: false,
            error: error.message,
            responseTime,
            timestamp: new Date().toISOString(),
            securityLevel: 'ERROR'
        };
    }
}

// Automatické bezpečnostní akce
async function handleSecurityIncident(incident) {
    try {
        console.log(`🚨 Handling security incident: ${incident.type}`);
        
        // Zde by mohly být automatické akce:
        // - Blokace IP adres
        // - Oznámení adminům
        // - Zvýšení security levelu
        // - Automatické zálohy
        
        // Logování incidentu
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const incidentsCollection = db.collection('security_incidents');
        
        await incidentsCollection.insertOne({
            ...incident,
            handledAt: new Date(),
            automaticResponse: true
        });
        
    } catch (error) {
        console.error('❌ Failed to handle security incident:', error.message);
    }
}

// Hlavní bezpečnostní monitoring funkce
async function runSecurityMonitoring() {
    const timestamp = new Date().toISOString();
    
    console.log(`\n🔒 Starting security monitoring cycle at ${timestamp}`);
    console.log(`📊 Security Stats: Incidents: ${securityMonitoringStats.securityIncidents} | DDOS: ${securityMonitoringStats.ddosAttacks} | Blocked IPs: ${securityMonitoringStats.blockedIPs}`);
    
    const results = [];
    
    // Paralelní kontrola všech bezpečnostních endpointů
    const promises = Object.entries(SECURITY_MONITORING).map(([name, config]) => 
        checkSecurityStatus(name, config)
    );
    
    const checkResults = await Promise.allSettled(promises);
    
    // Zpracování výsledků
    checkResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            results.push(result.value);
            
            // Automatické zpracování incidentů
            if (result.value.incidents > 0) {
                handleSecurityIncident({
                    type: 'SECURITY_INCIDENT',
                    source: result.value.name,
                    incidents: result.value.incidents,
                    securityLevel: result.value.securityLevel,
                    data: result.value.data
                });
            }
        } else {
            const name = Object.keys(SECURITY_MONITORING)[index];
            console.error(`❌ [${name}] Security check promise rejected:`, result.reason);
            results.push({
                name,
                success: false,
                error: 'Promise rejected',
                timestamp: new Date().toISOString(),
                securityLevel: 'ERROR'
            });
        }
    });
    
    // Celkový souhrn
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    const totalIncidents = results.reduce((sum, r) => sum + (r.incidents || 0), 0);
    
    console.log(`\n🔒 Security Monitoring Summary:`);
    console.log(`   ✅ Successful checks: ${successful}/${results.length}`);
    console.log(`   ❌ Failed checks: ${failed}/${results.length}`);
    console.log(`   🚨 Total incidents: ${totalIncidents}`);
    
    if (totalIncidents > 0) {
        console.log(`\n⚠️ Security incidents by source:`);
        results.filter(r => r.incidents > 0).forEach(r => {
            console.log(`   - ${r.name}: ${r.incidents} incidents (Level: ${r.securityLevel})`);
        });
    }
    
    // Záznam do databáze
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const logsCollection = db.collection('security_monitoring_logs');
        
        await logsCollection.insertOne({
            timestamp: new Date(),
            cycle: securityMonitoringStats.totalChecks,
            results: results,
            summary: {
                total: results.length,
                successful,
                failed,
                totalIncidents,
                securityLevel: totalIncidents > 50 ? 'CRITICAL' : totalIncidents > 10 ? 'HIGH' : totalIncidents > 0 ? 'MEDIUM' : 'NORMAL'
            },
            stats: securityMonitoringStats
        });
        
    } catch (dbError) {
        console.error('❌ Failed to save security monitoring log:', dbError.message);
    }
    
    return results;
}

// Funkce pro získání bezpečnostních statistik
function getSecurityStats() {
    return {
        ...securityMonitoringStats,
        uptime: process.uptime(),
        securityLevel: securityMonitoringStats.securityIncidents > 50 ? 'CRITICAL' : 
                      securityMonitoringStats.securityIncidents > 10 ? 'HIGH' : 
                      securityMonitoringStats.securityIncidents > 0 ? 'MEDIUM' : 'NORMAL'
    };
}

// Automatické spouštění bezpečnostního monitoringu
function startSecurityMonitoring() {
    console.log('🚀 Starting comprehensive security monitoring service...');
    console.log('🔒 Security monitoring endpoints:');
    
    Object.entries(SECURITY_MONITORING).forEach(([name, config]) => {
        console.log(`   - ${name}: ${config.url} (every ${config.interval/1000}s)`);
    });
    
    // Okamžitý start
    runSecurityMonitoring();
    
    // Pravidelné spouštění pro každý endpoint s vlastním intervalem
    Object.entries(SECURITY_MONITORING).forEach(([name, config]) => {
        setInterval(() => {
            checkSecurityStatus(name, config);
        }, config.interval);
    });
    
    // Kompletní security monitoring cyklus každých 5 minut
    setInterval(runSecurityMonitoring, 300000);
    
    // Čištění starých záznamů každý den
    setInterval(cleanupOldSecurityLogs, 86400000); // 24 hodin
}

// Čištění starých bezpečnostních logů
async function cleanupOldSecurityLogs() {
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        
        const thirtyDaysAgo = new Date(Date.now() - (30 * 24 * 60 * 60 * 1000));
        
        // Smazání starých logů
        await db.collection('security_logs').deleteMany({
            timestamp: { $lt: thirtyDaysAgo }
        });
        
        await db.collection('security_monitoring_logs').deleteMany({
            timestamp: { $lt: thirtyDaysAgo }
        });
        
        await db.collection('security_incidents').deleteMany({
            handledAt: { $lt: thirtyDaysAgo }
        });
        
        console.log('🧹 Cleaned up old security logs (older than 30 days)');
        
    } catch (error) {
        console.error('❌ Failed to cleanup old security logs:', error.message);
    }
}

// Endpoint pro bezpečnostní statistiky
async function getSecurityMonitoringStats(req, res) {
    try {
        const stats = getSecurityStats();
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            security: stats,
            monitoring: SECURITY_MONITORING
        });
    } catch (error) {
        res.status(500).json({
            status: 'ERROR',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
}

module.exports = {
    runSecurityMonitoring,
    getSecurityStats,
    startSecurityMonitoring,
    getSecurityMonitoringStats,
    checkSecurityStatus
};
