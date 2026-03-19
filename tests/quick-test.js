const assert = require('assert');
const { connectToDatabase } = require('../config/database');
const { Users, Teams, Matches, Leagues } = require('../utils/mongoDataAccess');
const { loadTeams, generateSeasonRange, getGroupDisplayLabel } = require('../utils/fileUtils');

async function runQuickTests() {
    console.log('🧪 SPUŠTĚNÍ RYCHLÝCH TESTŮ...');
    
    try {
        // 1. Připojení k databázi
        console.log('📡 Připojování k MongoDB...');
        await connectToDatabase();
        console.log('✅ MongoDB připojeno');
        
        // 2. Test základních funkcí
        console.log('🔍 Testování základních funkcí...');
        
        // Test načtení týmů
        const teams = await loadTeams();
        assert.ok(Array.isArray(teams), 'loadTeams by mělo vrátit pole');
        console.log(`✅ Teams: ${teams.length} týmů`);
        
        // Test uživatelů
        const users = await Users.findAll();
        assert.ok(Array.isArray(users), 'Users.findAll by mělo vrátit pole');
        console.log(`✅ Users: ${users.length} uživatelů`);
        
        // Test zápasů
        const matches = await Matches.findAll();
        assert.ok(Array.isArray(matches), 'Matches.findAll by mělo vrátit pole');
        console.log(`✅ Matches: ${matches.length} zápasů`);
        
        // Test lig
        const leagues = await Leagues.findAll();
        assert.ok(typeof leagues === 'object', 'Leagues.findAll by mělo vrátit objekt');
        console.log(`✅ Leagues: ${Object.keys(leagues).length} sezón`);
        
        // 3. Test utility funkcí
        console.log('🛠️ Testování utility funkcí...');
        
        // Test generování sezón
        const seasons = await generateSeasonRange(2024, 3);
        assert.ok(Array.isArray(seasons), 'generateSeasonRange by mělo vrátit pole');
        assert.strictEqual(seasons.length, 3, 'mělo by vygenerovat 3 sezóny');
        console.log(`✅ Season range: ${seasons.join(', ')}`);
        
        // Test group label
        const label = getGroupDisplayLabel('1');
        assert.strictEqual(label, 'Skupina A', 'skupina 1 by měla mít label Skupina A');
        console.log(`✅ Group label: ${label}`);
        
        // 4. Test výkonu
        console.log('⚡ Test výkonu...');
        const startTime = Date.now();
        
        await Promise.all([
            Teams.findAll(),
            Users.findAll()
        ]);
        
        const duration = Date.now() - startTime;
        assert.ok(duration < 5000, `Operace by měly trvat méně než 5s (trvalo ${duration}ms)`);
        console.log(`✅ Performance test: ${duration}ms`);
        
        console.log('🎉 VŠECHNY TESTY PROŠLY!');
        console.log('✅ Žádná data nebyla smazána');
        
        return {
            success: true,
            results: {
                teams: teams.length,
                users: users.length,
                matches: matches.length,
                leagues: Object.keys(leagues).length,
                performance: duration
            }
        };
        
    } catch (error) {
        console.error('❌ TEST SELHAL:', error.message);
        return {
            success: false,
            error: error.message
        };
    }
}

// Spuštění testů
if (require.main === module) {
    runQuickTests()
        .then(result => {
            if (result.success) {
                console.log('\n📊 VÝSLEDKY:', result.results);
                process.exit(0);
            } else {
                console.log('\n❌ CHYBA:', result.error);
                process.exit(1);
            }
        })
        .catch(error => {
            console.error('💥 NEOČEKÁVANÁ CHYBA:', error);
            process.exit(1);
        });
}

module.exports = { runQuickTests };
