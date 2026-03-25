const axios = require('axios');

// Konfigurace
const WAKE_ENDPOINT = process.env.WAKE_ENDPOINT || 'http://localhost:3000/wake';
const WARM_ENDPOINT = process.env.WARM_ENDPOINT || 'http://localhost:3000/warm';
const PING_INTERVAL = process.env.PING_INTERVAL || 10 * 60 * 1000; // 10 minut

async function selfPing() {
    const timestamp = new Date().toISOString();
    
    try {
        // Wake endpoint
        const wakeResponse = await axios.get(WAKE_ENDPOINT, {
            timeout: 30000,
            headers: {
                'User-Agent': 'Self-Ping-Service'
            }
        });
        
        console.log(`✅ Self-ping successful at ${timestamp}`);
        console.log(`   Wake status: ${wakeResponse.data.status}`);
        console.log(`   Response time: ${wakeResponse.data.responseTime}ms`);
        
        // Každou hodinu zavolat i warm endpoint
        if (new Date().getMinutes() === 0) {
            try {
                const warmResponse = await axios.get(WARM_ENDPOINT, {
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'Self-Ping-Service'
                    }
                });
                console.log(`🔥 Warm endpoint called: ${warmResponse.data.status}`);
            } catch (warmError) {
                console.error(`❌ Warm endpoint error: ${warmError.message}`);
            }
        }
        
    } catch (error) {
        console.error(`❌ Self-ping failed at ${timestamp}:`, error.message);
        
        // Pokud wake selže, zkusit warm
        try {
            const warmResponse = await axios.get(WARM_ENDPOINT, {
                timeout: 30000,
                headers: {
                    'User-Agent': 'Self-Ping-Service-Fallback'
                }
            });
            console.log(`🔥 Fallback warm successful: ${warmResponse.data.status}`);
        } catch (warmError) {
            console.error(`❌ Both endpoints failed!`);
        }
    }
}

// Spustit okamžitě a pak každých PING_INTERVAL
console.log('🚀 Starting self-ping service...');
console.log(`   Wake endpoint: ${WAKE_ENDPOINT}`);
console.log(`   Warm endpoint: ${WARM_ENDPOINT}`);
console.log(`   Interval: ${PING_INTERVAL/1000/60} minutes`);

selfPing(); // Okamžitý start
setInterval(selfPing, PING_INTERVAL);

module.exports = { selfPing };
