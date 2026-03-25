const axios = require('axios');

// AGRESIVNÍ KEEP-ALIVE KONFIGURACE
const AGGRESSIVE_KEEPALIVE = {
    // Hlavní wake endpointy
    primaryEndpoints: [
        process.env.WAKE_ENDPOINT || 'http://localhost:3000/wake',
        process.env.WARM_ENDPOINT || 'http://localhost:3000/warm',
        'http://localhost:3000/health/ping',
        'http://localhost:3000/health/status'
    ],
    
    // Záložní endpointy
    fallbackEndpoints: [
        'http://localhost:3000/',
        'http://localhost:3000/health',
        'http://localhost:3000/security/security-alerts'
    ],
    
    // Externí endpointy (pro otestování konektivity)
    externalEndpoints: [
        'https://httpbin.org/get',
        'https://api.github.com/users/github'
    ],
    
    // Intervaly
    intervals: {
        ultraFast: 30000,      // 30 sekund - ultra agresivní
        fast: 60000,           // 1 minuta - agresivní
        normal: 120000,        // 2 minuty - normální
        slow: 300000           // 5 minut - pomalý
    },
    
    // Timeouty
    timeouts: {
        primary: 10000,        // 10 sekund
        fallback: 15000,       // 15 sekund
        external: 20000        // 20 sekund
    }
};

// Statistiky keep-alive
const keepAliveStats = {
    totalPings: 0,
    successfulPings: 0,
    failedPings: 0,
    lastPing: null,
    lastSuccess: null,
    lastFailure: null,
    endpoints: {},
    uptime: process.uptime()
};

// Agresivní ping funkce
async function aggressivePing(endpoint, timeout, category = 'primary') {
    const startTime = Date.now();
    const endpointKey = endpoint.replace(/[^a-zA-Z0-9]/g, '_');
    
    try {
        const response = await axios.get(endpoint, {
            timeout: timeout,
            headers: {
                'User-Agent': `Aggressive-KeepAlive-${category}`,
                'X-KeepAlive-Timestamp': new Date().toISOString(),
                'X-Force-Awake': 'true',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            // Přidat náhodný parametr pro zabránění cachování
            params: {
                _t: Date.now(),
                _rand: Math.random().toString(36).substr(2, 9)
            }
        });
        
        const responseTime = Date.now() - startTime;
        const success = response.status >= 200 && response.status < 300;
        
        // Aktualizace statistik
        if (!keepAliveStats.endpoints[endpointKey]) {
            keepAliveStats.endpoints[endpointKey] = {
                url: endpoint,
                category,
                pings: 0,
                successes: 0,
                failures: 0,
                avgResponseTime: 0,
                lastPing: null,
                lastSuccess: null,
                lastFailure: null
            };
        }
        
        const endpointStats = keepAliveStats.endpoints[endpointKey];
        endpointStats.pings++;
        endpointStats.lastPing = new Date().toISOString();
        endpointStats.lastResponseTime = responseTime;
        
        if (success) {
            endpointStats.successes++;
            endpointStats.lastSuccess = new Date().toISOString();
            keepAliveStats.successfulPings++;
            keepAliveStats.lastSuccess = new Date().toISOString();
            
            console.log(`🚀 [${category.toUpperCase()}] ${endpoint} - SUCCESS (${responseTime}ms)`);
        } else {
            endpointStats.failures++;
            endpointStats.lastFailure = new Date().toISOString();
            keepAliveStats.failedPings++;
            keepAliveStats.lastFailure = new Date().toISOString();
            
            console.log(`❌ [${category.toUpperCase()}] ${endpoint} - HTTP ${response.status} (${responseTime}ms)`);
        }
        
        // Přepočet průměrné response time
        endpointStats.avgResponseTime = Math.round(
            (endpointStats.avgResponseTime * (endpointStats.pings - 1) + responseTime) / endpointStats.pings
        );
        
        keepAliveStats.totalPings++;
        keepAliveStats.lastPing = new Date().toISOString();
        
        return {
            success,
            status: response.status,
            responseTime,
            endpoint,
            category,
            timestamp: new Date().toISOString()
        };
        
    } catch (error) {
        const responseTime = Date.now() - startTime;
        
        // Aktualizace statistik pro chybu
        const endpointKey = endpoint.replace(/[^a-zA-Z0-9]/g, '_');
        if (!keepAliveStats.endpoints[endpointKey]) {
            keepAliveStats.endpoints[endpointKey] = {
                url: endpoint,
                category,
                pings: 0,
                successes: 0,
                failures: 0,
                avgResponseTime: 0,
                lastPing: null,
                lastSuccess: null,
                lastFailure: null
            };
        }
        
        const endpointStats = keepAliveStats.endpoints[endpointKey];
        endpointStats.pings++;
        endpointStats.failures++;
        endpointStats.lastPing = new Date().toISOString();
        endpointStats.lastFailure = new Date().toISOString();
        endpointStats.lastResponseTime = responseTime;
        
        keepAliveStats.totalPings++;
        keepAliveStats.failedPings++;
        keepAliveStats.lastFailure = new Date().toISOString();
        
        console.error(`💀 [${category.toUpperCase()}] ${endpoint} - ERROR: ${error.message} (${responseTime}ms)`);
        
        return {
            success: false,
            error: error.message,
            responseTime,
            endpoint,
            category,
            timestamp: new Date().toISOString()
        };
    }
}

// Souběžný ping všech endpointů
async function concurrentPing(endpoints, timeout, category) {
    const promises = endpoints.map(endpoint => 
        aggressivePing(endpoint, timeout, category)
    );
    
    const results = await Promise.allSettled(promises);
    
    return results.map((result, index) => {
        if (result.status === 'fulfilled') {
            return result.value;
        } else {
            return {
                success: false,
                error: 'Promise rejected',
                endpoint: endpoints[index],
                category,
                timestamp: new Date().toISOString()
            };
        }
    });
}

// CPU aktivita pro udržení procesu aktivního
function generateCPUActivity() {
    const startTime = Date.now();
    let result = 0;
    
    // Intenzivní výpočet na 50ms
    while (Date.now() - startTime < 50) {
        result += Math.random() * Math.sin(Date.now()) * Math.cos(Date.now());
    }
    
    return result;
}

// Memory aktivita pro udržení paměti aktivní
function generateMemoryActivity() {
    const arrays = [];
    const startTime = Date.now();
    
    // Vytvoření a okamžité smazání polí na 100ms
    while (Date.now() - startTime < 100) {
        const arr = new Array(1000).fill(0).map(() => Math.random());
        arrays.push(arr);
        if (arrays.length > 10) {
            arrays.shift(); // Smazat nejstarší pole
        }
    }
    
    return arrays.length;
}

// Hlavní agresivní keep-alive smyčka
async function aggressiveKeepAlive() {
    const timestamp = new Date().toISOString();
    console.log(`\n🔥 AGGRESSIVE KEEP-ALIVE CYCLE STARTED at ${timestamp}`);
    console.log(`📊 Stats: Total: ${keepAliveStats.totalPings} | Success: ${keepAliveStats.successfulPings} | Failed: ${keepAliveStats.failedPings}`);
    
    const allResults = [];
    
    // 1. Ultra fast ping (primární endpointy)
    console.log(`⚡ Ultra-fast pinging primary endpoints...`);
    const ultraFastResults = await concurrentPing(
        AGGRESSIVE_KEEPALIVE.primaryEndpoints, 
        AGGRESSIVE_KEEPALIVE.timeouts.primary, 
        'ultraFast'
    );
    allResults.push(...ultraFastResults);
    
    // 2. CPU aktivita
    const cpuResult = generateCPUActivity();
    console.log(`💻 CPU Activity: ${cpuResult.toFixed(2)}`);
    
    // 3. Memory aktivita
    const memoryResult = generateMemoryActivity();
    console.log(`🧠 Memory Activity: ${memoryResult} arrays created`);
    
    // 4. Fast ping (záložní endpointy)
    console.log(`🚀 Fast pinging fallback endpoints...`);
    const fastResults = await concurrentPing(
        AGGRESSIVE_KEEPALIVE.fallbackEndpoints, 
        AGGRESSIVE_KEEPALIVE.timeouts.fallback, 
        'fast'
    );
    allResults.push(...fastResults);
    
    // 5. Externí konektivita test
    console.log(`🌐 Testing external connectivity...`);
    const externalResults = await concurrentPing(
        AGGRESSIVE_KEEPALIVE.externalEndpoints, 
        AGGRESSIVE_KEEPALIVE.timeouts.external, 
        'external'
    );
    allResults.push(...externalResults);
    
    // Souhrn výsledků
    const successful = allResults.filter(r => r.success).length;
    const failed = allResults.filter(r => !r.success).length;
    const successRate = Math.round((successful / allResults.length) * 100);
    
    console.log(`\n📋 AGGRESSIVE KEEP-ALIVE SUMMARY:`);
    console.log(`   ✅ Successful: ${successful}/${allResults.length} (${successRate}%)`);
    console.log(`   ❌ Failed: ${failed}/${allResults.length}`);
    console.log(`   ⏱️ Avg Response Time: ${Math.round(allResults.reduce((sum, r) => sum + (r.responseTime || 0), 0) / allResults.length)}ms`);
    
    if (failed > 0) {
        console.log(`\n⚠️ Failed endpoints:`);
        allResults.filter(r => !r.success).forEach(r => {
            console.log(`   - ${r.endpoint}: ${r.error || 'Unknown error'}`);
        });
    }
    
    // Uložit statistiky do databáze
    try {
        const { connectToDatabase } = require('../config/database');
        const db = await connectToDatabase();
        const logsCollection = db.collection('aggressive_keepalive_logs');
        
        await logsCollection.insertOne({
            timestamp: new Date(),
            cycle: keepAliveStats.totalPings,
            results: allResults,
            summary: {
                total: allResults.length,
                successful,
                failed,
                successRate
            },
            stats: keepAliveStats,
            cpuActivity: cpuResult,
            memoryActivity: memoryResult
        });
        
    } catch (dbError) {
        console.error('❌ Failed to save aggressive keep-alive log:', dbError.message);
    }
    
    return allResults;
}

// Nucené probuzení serveru
async function forceAwakeServer() {
    console.log('🔄 FORCING SERVER AWAKE...');
    
    try {
        // 1. Zkusit několikrát rychle za sebou
        for (let i = 0; i < 5; i++) {
            await aggressivePing('http://localhost:3000/wake', 5000, 'force');
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 sekunda pauza
        }
        
        // 2. CPU aktivita
        for (let i = 0; i < 3; i++) {
            generateCPUActivity();
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log('✅ Server force awake completed');
        
    } catch (error) {
        console.error('❌ Force awake failed:', error.message);
    }
}

// Start agresivního keep-alive
function startAggressiveKeepAlive() {
    console.log('🔥🔥🔥 STARTING AGGRESSIVE KEEP-ALIVE SYSTEM 🔥🔥🔥');
    console.log('⚡ Ultra-fast mode activated - server will NOT sleep!');
    console.log(`🎯 Primary endpoints: ${AGGRESSIVE_KEEPALIVE.primaryEndpoints.length}`);
    console.log(`🔄 Fallback endpoints: ${AGGRESSIVE_KEEPALIVE.fallbackEndpoints.length}`);
    console.log(`🌐 External endpoints: ${AGGRESSIVE_KEEPALIVE.externalEndpoints.length}`);
    
    // Okamžitý start
    aggressiveKeepAlive();
    
    // Ultra agresivní interval - každých 30 sekund
    setInterval(aggressiveKeepAlive, AGGRESSIVE_KEEPALIVE.intervals.ultraFast);
    
    // Force awake každých 2 minuty
    setInterval(forceAwakeServer, 120000);
    
    // CPU aktivita každých 10 sekund
    setInterval(() => {
        generateCPUActivity();
    }, 10000);
    
    // Memory aktivita každých 30 sekund
    setInterval(() => {
        generateMemoryActivity();
    }, 30000);
    
    console.log('🚀 Aggressive keep-alive system fully activated!');
}

// Statistiky endpoint
async function getAggressiveKeepAliveStats(req, res) {
    try {
        res.json({
            status: 'OK',
            timestamp: new Date().toISOString(),
            keepAlive: keepAliveStats,
            config: AGGRESSIVE_KEEPALIVE,
            uptime: process.uptime()
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
    aggressiveKeepAlive,
    startAggressiveKeepAlive,
    forceAwakeServer,
    getAggressiveKeepAliveStats,
    keepAliveStats
};
