const fs = require('fs');
const path = require('path');
const { connectToDatabase } = require('./config/database');
const { Users, Matches, Teams, Leagues, AllowedLeagues, ChosenSeason, Settings, TeamBonuses, LeagueStatus, TableTips, Playoff, PlayoffTemplates, Transfers, TransferLeagues, Tips } = require('./utils/mongoDataAccess');

console.log('🔄 MIGRACE VŠECH JSON DAT DO MONGODB');
console.log('='.repeat(50));

const dataDir = path.join(__dirname, 'data');

// Funkce pro načtení JSON souboru
function loadJsonFile(filename) {
    const filePath = path.join(dataDir, filename);
    if (fs.existsSync(filePath)) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            console.error(`❌ Chyba při čtení ${filename}:`, error.message);
            return null;
        }
    } else {
        console.warn(`⚠️  Soubor ${filename} neexistuje`);
        return null;
    }
}

// Funkce pro uložení do MongoDB
async function saveToMongoDB(collectionName, data) {
    try {
        const collection = {
            'users': Users,
            'matches': Matches,
            'teams': Teams,
            'leagues': Leagues,
            'allowedLeagues': AllowedLeagues,
            'chosenSeason': ChosenSeason,
            'settings': Settings,
            'teamBonuses': TeamBonuses,
            'leagueStatus': LeagueStatus,
            'tableTips': TableTips,
            'playoff': Playoff,
            'playoffTemplates': PlayoffTemplates,
            'transfers': Transfers,
            'transferLeagues': TransferLeagues,
            'tips': Tips
        }[collectionName];

        if (!collection) {
            console.warn(`⚠️  Neznámá kolekce: ${collectionName}`);
            return;
        }

        if (data) {
            await collection.replaceAll(data);
            console.log(`✅ ${collectionName}: ${Array.isArray(data) ? data.length : Object.keys(data).length} položek`);
        } else {
            console.log(`⏭️  ${collectionName}: Žádná data k migraci`);
        }
    } catch (error) {
        console.error(`❌ Chyba při ukládání ${collectionName}:`, error.message);
    }
}

// Hlavní migrační funkce
async function migrateAllData() {
    try {
        // Připojení k MongoDB
        console.log('📡 Připojuji k MongoDB...');
        await connectToDatabase();
        console.log('✅ Připojeno k MongoDB');

        // Seznam všech JSON souborů k migraci
        const migrations = [
            { file: 'users.json', collection: 'users' },
            { file: 'matches.json', collection: 'matches' },
            { file: 'teams.json', collection: 'teams' },
            { file: 'leagues.json', collection: 'leagues' },
            { file: 'allowedLeagues.json', collection: 'allowedLeagues' },
            { file: 'chosenSeason.json', collection: 'chosenSeason' },
            { file: 'settings.json', collection: 'settings' },
            { file: 'teamBonuses.json', collection: 'teamBonuses' },
            { file: 'leagueStatus.json', collection: 'leagueStatus' },
            { file: 'tableTips.json', collection: 'tableTips' },
            { file: 'playoff.json', collection: 'playoff' },
            { file: 'playoffTemplates.json', collection: 'playoffTemplates' },
            { file: 'transfers.json', collection: 'transfers' },
            { file: 'transferLeagues.json', collection: 'transferLeagues' },
            { file: 'tips.json', collection: 'tips' }
        ];

        console.log('\n📂 Spouštím migraci souborů...');
        
        let totalMigrated = 0;
        let totalFiles = 0;

        for (const migration of migrations) {
            console.log(`\n📄 Zpracovávám ${migration.file}...`);
            const data = loadJsonFile(migration.file);
            totalFiles++;
            
            if (data) {
                await saveToMongoDB(migration.collection, data);
                totalMigrated++;
            }
        }

        console.log('\n' + '='.repeat(50));
        console.log('📊 MIGRACE DOKONČENA');
        console.log('='.repeat(50));
        console.log(`📁 Zpracováno souborů: ${totalFiles}/${migrations.length}`);
        console.log(`✅ Úspěšně migrováno: ${totalMigrated}`);
        console.log(`❌ Chybných souborů: ${totalFiles - totalMigrated}`);
        
        if (totalMigrated > 0) {
            console.log('\n🎉 VŠECHNA DATA BYLA ÚSPĚŠNĚ NAHRÁNA DO MONGODB!');
            console.log('✅ Projekt je připraven k použití');
        } else {
            console.log('\n⚠️  ŽÁDNÁ DATA NEBYLA NAHRÁNA');
            console.log('🔍 Zkontroluj, zda existují JSON soubory v adresáři data/');
        }

    } catch (error) {
        console.error('\n❌ Kritická chyba migrace:', error);
        process.exit(1);
    }
}

// Spuštění migrace
if (require.main === module) {
    migrateAllData().then(() => {
        console.log('\n🚀 Migrace dokončena, ukončuji proces.');
        process.exit(0);
    }).catch(error => {
        console.error('\n💥 Migrace selhala:', error);
        process.exit(1);
    });
}

module.exports = { migrateAllData, loadJsonFile, saveToMongoDB };
