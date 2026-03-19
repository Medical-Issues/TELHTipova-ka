// Migrace dat z JSON souborů do MongoDB
const fs = require('fs');
const path = require('path');
const { connectToDatabase, getCollection } = require('../config/database');

async function migrateData() {
    try {
        console.log('🚀 Začínám migraci dat...');
        
        // Připojení k databázi
        await connectToDatabase();
        
        // Seznam všech JSON souborů k migraci
        const files = [
            { name: 'users', file: 'users.json', isArray: true },
            { name: 'matches', file: 'matches.json', isArray: true },
            { name: 'teams', file: 'teams.json', isArray: true },
            { name: 'leagues', file: 'leagues.json', isArray: false },
            { name: 'allowedLeagues', file: 'allowedLeagues.json', isArray: true },
            { name: 'chosenSeason', file: 'chosenSeason.json', isArray: false, isString: true },
            { name: 'settings', file: 'settings.json', isArray: false },
            { name: 'leagueStatus', file: 'leagueStatus.json', isArray: false },
            { name: 'teamBonuses', file: 'teamBonuses.json', isArray: false },
            { name: 'tableTips', file: 'tableTips.json', isArray: false },
            { name: 'playoff', file: 'playoff.json', isArray: false },
            { name: 'playoffTemplates', file: 'playoffTemplates.json', isArray: false },
            { name: 'transferLeagues', file: 'transferLeagues.json', isArray: true },
            { name: 'transfers', file: 'transfers.json', isArray: false },
            { name: 'tips', file: 'tips.json', isArray: true }
        ];
        
        for (const fileInfo of files) {
            console.log(`📁 Migrace ${fileInfo.name}...`);
            
            try {
                // Načtení JSON souboru
                const filePath = path.join(__dirname, '../data', fileInfo.file);
                let data;
                
                if (fs.existsSync(filePath)) {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    data = JSON.parse(content);
                } else {
                    console.log(`⚠️  Soubor ${fileInfo.file} neexistuje, vytvořím prázdný objekt`);
                    data = fileInfo.isArray ? [] : {};
                }
                
                // Vložení do MongoDB
                const collection = getCollection(fileInfo.name);
                
                if (fileInfo.isArray) {
                    // Pole - vložíme všechny dokumenty
                    if (data.length > 0) {
                        // Pokud jsou to stringy, uložíme jako objekt s polem
                        if (typeof data[0] === 'string') {
                            await collection.insertOne({ values: data });
                            console.log(`✅ ${fileInfo.name}: pole ${data.length} stringů uloženo`);
                        } else {
                            await collection.insertMany(data);
                            console.log(`✅ ${fileInfo.name}: ${data.length} dokumentů importováno`);
                        }
                    } else {
                        console.log(`✅ ${fileInfo.name}: prázdné pole`);
                    }
                } else {
                    // Objekt - vložíme jako jeden dokument
                    if (fileInfo.isString) {
                        // String hodnota - uložíme jako objekt
                        await collection.insertOne({ value: data });
                        console.log(`✅ ${fileInfo.name}: string hodnota uložena`);
                    } else if (Object.keys(data).length > 0) {
                        await collection.insertOne(data);
                        console.log(`✅ ${fileInfo.name}: 1 dokument importován`);
                    } else {
                        console.log(`✅ ${fileInfo.name}: prázdný objekt`);
                    }
                }
                
            } catch (error) {
                console.error(`❌ Chyba při migraci ${fileInfo.name}:`, error.message);
            }
        }
        
        console.log('🎉 Migrace dokončena!');
        
    } catch (error) {
        console.error('❌ Chyba migrace:', error);
    }
}

// Spuštění migrace
if (require.main === module) {
    migrateData().then(() => {
        console.log('✅ Migrace úspěšně dokončena');
        process.exit(0);
    }).catch(error => {
        console.error('❌ Migrace selhala:', error);
        process.exit(1);
    });
}

module.exports = { migrateData };
