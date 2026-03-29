const axios = require('axios');

// Konfigurace pro různé monitoring služby
const MONITORING_ENDPOINTS = {
    // Pouze wake endpoint - unified keep-alive už volá /wake každých 30s
    // Tento monitoring je pro statistiky, ne pro keep-alive
    wakeEndpoint: {
        url: process.env.WAKE_URL || 'https://telhtipova-ka.onrender.com/wake',
        interval: 60000, // 1 minuta pro statistiky
        timeout: 15000
    }
};

// Statistiky monitoringu
const stats = {
    totalChecks: 0,
    successfulChecks: 0,
    failedChecks: 0,
    lastCheck: null,
    lastSuccess: null,
    lastFailure: null,
    endpoints: {}
};

// Funkce pro kontrolu jednoho endpointu
async function checkEndpoint(name, config) {
    const startTime = Date.now();
    
    try {
        const response = await axios.get(config.url, {
            timeout: config.timeout,
            headers: {
                'User-Agent': `Monitoring-Service-${name}`,
                'X-Monitoring-Timestamp': new Date().toISOString()
            }
        });
        
        const responseTime = Date.now() - startTime;
        const success = response.status >= 200 && response.status < 300;
        
        // Aktualizace statistik
        if (!stats.endpoints[name]) {
            stats.endpoints[name] = {
                checks: 0,
                successes: 0,
                failures: 0,
                lastCheck: null,
                lastSuccess: null,
                lastFailure: null,
                avgResponseTime: 0,
                lastResponseTime: 0
            };
        }
        
        const endpointStats = stats.endpoints[name];
        endpointStats.checks++;
        endpointStats.lastCheck = new Date().toISOString();
        endpointStats.lastResponseTime = responseTime;
        
        if (success) {
            endpointStats.successes++;
            endpointStats.lastSuccess = new Date().toISOString();
            stats.successfulChecks++;
        } else {
            endpointStats.failures++;
            endpointStats.lastFailure = new Date().toISOString();
            stats.failedChecks++;
        }
        
        // Přepočet průměrné response time
        endpointStats.avgResponseTime = Math.round(
            (endpointStats.avgResponseTime * (endpointStats.checks - 1) + responseTime) / endpointStats.checks
        );
        
        console.log(`✅ [${name}] ${response.status} (${responseTime}ms)`);
        
        return {
            name,
            success,
            status: response.status,
            responseTime,
            timestamp: new Date().toISOString(),
            data: response.data
        };
        
    } catch (error) {
        const responseTime = Date.now() - startTime;
        
        // Aktualizace statistik pro chybu
        if (!stats.endpoints[name]) {
            stats.endpoints[name] = {
                checks: 0,
                successes: 0,
                failures: 0,
                lastCheck: null,
                lastSuccess: null,
                lastFailure: null,
                avgResponseTime: 0,
                lastResponseTime: 0
            };
        }
        
        const endpointStats = stats.endpoints[name];
        endpointStats.checks++;
        endpointStats.failures++;
        endpointStats.lastCheck = new Date().toISOString();
        endpointStats.lastFailure = new Date().toISOString();
        endpointStats.lastResponseTime = responseTime;
        stats.failedChecks++;
        
        console.error(`❌ [${name}] ERROR (${responseTime}ms): ${error.message}`);
        
        return {
            name,
            success: false,
            error: error.message,
            responseTime,
            timestamp: new Date().toISOString(),
            code: error.code || 'UNKNOWN'
        };
    }
}

// Hlavní monitoring funkce
async function runMonitoring() {
    const timestamp = new Date().toISOString();
    stats.totalChecks++;
    stats.lastCheck = timestamp;
    
    console.log(`\n🔍 Starting monitoring cycle at ${timestamp}`);
    console.log(`📊 Total checks: ${stats.totalChecks} | Success: ${stats.successfulChecks} | Failed: ${stats.failedChecks}`);
    
    const results = [];
    
    // Paralelní kontrola všech endpointů
    const promises = Object.entries(MONITORING_ENDPOINTS).map(([name, config]) => 
        checkEndpoint(name, config)
    );
    
    const checkResults = await Promise.allSettled(promises);
    
    // Zpracování výsledků
    checkResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
            results.push(result.value);
        } else {
            const name = Object.keys(MONITORING_ENDPOINTS)[index];
            console.error(`❌ [${name}] Promise rejected:`, result.reason);
            results.push({
                name,
                success: false,
                error: 'Promise rejected',
                timestamp: new Date().toISOString()
            });
        }
    });
    
    // Celkový souhrn
    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    
    console.log(`\n📋 Monitoring Summary:`);
    console.log(`   ✅ Successful: ${successful}/${results.length}`);
    console.log(`   ❌ Failed: ${failed}/${results.length}`);
    
    if (failed > 0) {
        console.log(`\n⚠️ Failed endpoints:`);
        results.filter(r => !r.success).forEach(r => {
            console.log(`   - ${r.name}: ${r.error || 'Unknown error'}`);
        });
    }
    
    // Záznam do databáze (pokud je dostupná)
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const logsCollection = db.collection('monitoring_logs');
        
        await logsCollection.insertOne({
            timestamp: new Date(),
            cycle: stats.totalChecks,
            results: results,
            summary: {
                total: results.length,
                successful,
                failed,
                successRate: Math.round((successful / results.length) * 100)
            },
            stats: stats
        });
        
    } catch (dbError) {
        console.error('❌ Failed to save monitoring log to database:', dbError.message);
    }
    
    return results;
}

// Funkce pro získání statistik
function getStats() {
    return {
        ...stats,
        successRate: stats.totalChecks > 0 ? Math.round((stats.successfulChecks / stats.totalChecks) * 100) : 0,
        uptime: process.uptime()
    };
}

// Automatické spouštění
function startMonitoring() {
    console.log('🚀 Starting comprehensive monitoring service...');
    console.log('📡 Monitoring endpoints:');
    
    Object.entries(MONITORING_ENDPOINTS).forEach(([name, config]) => {
        console.log(`   - ${name}: ${config.url} (every ${config.interval/1000}s)`);
    });
    
    // Okamžitý start
    runMonitoring();
    
    // Pravidelné spouštění pro každý endpoint s vlastním intervalem
    Object.entries(MONITORING_ENDPOINTS).forEach(([name, config]) => {
        setInterval(() => {
            checkEndpoint(name, config);
        }, config.interval);
    });
    
    // Kompletní monitoring cyklus každých 5 minut
    setInterval(runMonitoring, 300000);
}

// Endpoint pro statistiky
async function getMonitoringStats(req, res) {
    try {
        const stats = getStats();
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            monitoring: stats,
            endpoints: MONITORING_ENDPOINTS
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
    runMonitoring,
    getStats,
    startMonitoring,
    getMonitoringStats,
    checkEndpoint
};
