// Vyčistění MongoDB před novou migrací
const { connectToDatabase, getCollection } = require('../config/database');

async function clearCollections() {
    try {
        console.log('🧹 Vyčišťuji MongoDB kolekce...');
        
        await connectToDatabase();
        
        const collections = [
            'users', 'matches', 'teams', 'leagues', 'allowedLeagues', 
            'chosenSeason', 'settings', 'leagueStatus', 'teamBonuses', 
            'tableTips', 'playoff', 'playoffTemplates', 'transferLeagues', 'transfers', 'tips'
        ];
        
        for (const name of collections) {
            const collection = getCollection(name);
            await collection.deleteMany({});
            console.log(`✅ ${name} vyčištěno`);
        }
        
        console.log('🧹 MongoDB vyčištěno!');
        
    } catch (error) {
        console.error('❌ Chyba při čištění:', error);
    }
}

if (require.main === module) {
    clearCollections().then(() => {
        console.log('✅ Vyčištění dokončeno');
        process.exit(0);
    });
}

module.exports = { clearCollections };
