const axios = require('axios');

// EXTRÉMNÍ AGRESIVNÍ KEEP-ALIVE - NIKDY NEUSNE
class ExtremeKeepAlive {
    constructor() {
        this.isRunning = false;
        this.stats = {
            totalPings: 0,
            successfulPings: 0,
            failedPings: 0,
            startTime: Date.now(),
            lastPing: null
        };
        this.endpoints = [
            'http://localhost:3000/wake',
            'http://localhost:3000/warm',
            'http://localhost:3000/health/ping',
            'http://localhost:3000/health/status',
            'http://localhost:3000/',
            'http://localhost:3000/health'
        ];
    }

    // Extrémně rychlé pingování
    async ultraFastPing() {
        const promises = this.endpoints.map(async (endpoint) => {
            try {
                const startTime = Date.now();
                const response = await axios.get(endpoint, {
                    timeout: 5000,
                    headers: {
                        'User-Agent': 'EXTREME-KEEP-ALIVE',
                        'X-Force-Awake': 'true',
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'Expires': '0'
                    },
                    params: {
                        _t: Date.now(),
                        _r: Math.random(),
                        _force: 'awake'
                    }
                });
                
                const responseTime = Date.now() - startTime;
                this.stats.totalPings++;
                this.stats.successfulPings++;
                this.stats.lastPing = new Date().toISOString();
                
                console.log(`⚡⚡⚡ [EXTREME] ${endpoint.split('/').pop() || 'root'} - ${response.status} (${responseTime}ms)`);
                
                return { success: true, endpoint, responseTime, status: response.status };
                
            } catch (error) {
                this.stats.totalPings++;
                this.stats.failedPings++;
                console.error(`💀💀💀 [EXTREME] ${endpoint} - ERROR: ${error.message}`);
                return { success: false, endpoint, error: error.message };
            }
        });
        
        return await Promise.allSettled(promises);
    }

    // CPU intenzivní operace
    cpuIntensiveTask() {
        const start = Date.now();
        let result = 0;
        
        // Intenzivní výpočet na 200ms
        while (Date.now() - start < 200) {
            result += Math.sin(Date.now()) * Math.cos(Date.now()) * Math.tan((Date.now() % 1000) + 1);
            result += Math.sqrt(Math.abs(Math.sin(Date.now()) * 1000));
            result += Math.pow(Math.random(), 3);
        }
        
        console.log(`🔥🔥🔥 [CPU] Intensive task completed: ${result.toFixed(2)}`);
        return result;
    }

    // Memory intenzivní operace
    memoryIntensiveTask() {
        const arrays = [];
        const start = Date.now();
        
        // Vytvoření velkých polí na 300ms
        while (Date.now() - start < 300) {
            const arr = new Array(10000).fill(0).map(() => ({
                id: Math.random(),
                data: Math.random().toString(36),
                timestamp: Date.now(),
                hash: Math.random().toString(36).substr(2, 9)
            }));
            arrays.push(arr);
            
            // Udržet pouze posledních 5 polí
            if (arrays.length > 5) {
                arrays.shift();
            }
        }
        
        console.log(`🧠🧠🧠 [MEMORY] Created ${arrays.length} large arrays`);
        return arrays.length;
    }

    // Síťová aktivita
    async networkActivity() {
        try {
            // Ping externí služby
            const response = await axios.get('https://httpbin.org/get', {
                timeout: 10000,
                headers: {
                    'User-Agent': 'EXTREME-NETWORK-ACTIVITY'
                }
            });
            
            console.log(`🌐🌐🌐 [NETWORK] External ping successful: ${response.status}`);
            return true;
        } catch (error) {
            console.error(`💀💀💀 [NETWORK] External ping failed: ${error.message}`);
            return false;
        }
    }

    // Hlavní extrémní cyklus
    async extremeCycle() {
        if (this.isRunning) return;
        this.isRunning = true;
        
        console.log(`\n🔥🔥🔥🔥🔥 EXTREME KEEP-ALIVE CYCLE STARTED 🔥🔥🔥🔥🔥`);
        console.log(`⏱️ Uptime: ${Math.floor((Date.now() - this.stats.startTime) / 1000)}s`);
        console.log(`📊 Stats: ${this.stats.successfulPings}/${this.stats.totalPings} successful`);
        
        try {
            // 1. Ultra fast pinging
            console.log(`⚡⚡⚡ Ultra-fast pinging all endpoints...`);
            await this.ultraFastPing();
            
            // 2. CPU intenzivní task
            console.log(`🔥🔥🔥 CPU intensive task...`);
            this.cpuIntensiveTask();
            
            // 3. Memory intenzivní task
            console.log(`🧠🧠🧠 Memory intensive task...`);
            this.memoryIntensiveTask();
            
            // 4. Síťová aktivita
            console.log(`🌐🌐🌐 Network activity...`);
            await this.networkActivity();
            
            // 5. Druhé kolo pingování
            console.log(`⚡⚡⚡ Second round of ultra-fast pinging...`);
            await this.ultraFastPing();
            
            // 6. Finální CPU burst
            console.log(`🔥🔥🔥 Final CPU burst...`);
            for (let i = 0; i < 3; i++) {
                this.cpuIntensiveTask();
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            console.log(`✅✅✅ EXTREME KEEP-ALIVE CYCLE COMPLETED ✅✅✅`);
            
        } catch (error) {
            console.error(`💀💀💀 EXTREME CYCLE ERROR: ${error.message}`);
        }
        
        this.isRunning = false;
    }

    // Start extrémního keep-alive
    start() {
        console.log(`🚀🚀🚀🚀🚀 STARTING EXTREME KEEP-ALIVE SYSTEM 🚀🚀🚀🚀🚀`);
        console.log(`⚡ Ultra-fast mode: EVERY 15 SECONDS`);
        console.log(`🔥 CPU intensive: CONTINUOUS`);
        console.log(`🧠 Memory intensive: CONTINUOUS`);
        console.log(`🌐 Network activity: CONTINUOUS`);
        console.log(`💀 SERVER WILL NEVER SLEEP AGAIN! 💀`);
        
        // Okamžitý start
        this.extremeCycle();
        
        // Extrémně agresivní interval - každých 15 sekund
        setInterval(() => {
            this.extremeCycle();
        }, 15000);
        
        // CPU aktivita každých 5 sekund
        setInterval(() => {
            this.cpuIntensiveTask();
        }, 5000);
        
        // Memory aktivita každých 10 sekund
        setInterval(() => {
            this.memoryIntensiveTask();
        }, 10000);
        
        // Síťová aktivita každých 30 sekund
        setInterval(() => {
            this.networkActivity();
        }, 30000);
        
        // Paralelní pingování každých 20 sekund
        setInterval(() => {
            this.ultraFastPing();
        }, 20000);
        
        console.log(`🔥🔥🔥🔥🔥 EXTREME KEEP-ACTIVE FULLY ACTIVATED 🔥🔥🔥🔥🔥`);
    }

    // Získání statistik
    getStats() {
        return {
            ...this.stats,
            uptime: Date.now() - this.stats.startTime,
            successRate: this.stats.totalPings > 0 ? Math.round((this.stats.successfulPings / this.stats.totalPings) * 100) : 0,
            isRunning: this.isRunning
        };
    }
}

// Export instance
const extremeKeepAlive = new ExtremeKeepAlive();

module.exports = extremeKeepAlive;
