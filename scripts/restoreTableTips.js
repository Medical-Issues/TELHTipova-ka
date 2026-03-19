const { TableTips } = require('../utils/mongoDataAccess');
const { connectToDatabase } = require('../config/database');
const fs = require('fs');

async function restoreTableTips() {
    try {
        console.log('Připojuji k MongoDB...');
        await connectToDatabase();
        console.log('Připojeno k MongoDB');
        
        console.log('Obnovuji tableTips z JSON do MongoDB...');
        
        // Načtení dat z JSON souboru
        const jsonData = JSON.parse(fs.readFileSync('./data/tableTips.json', 'utf8'));
        console.log('Načtena data z JSON:', Object.keys(jsonData));
        
        // Uložení do MongoDB
        await TableTips.updateOne({}, jsonData, { upsert: true });
        console.log('TableTips úspěšně obnoveny v MongoDB!');
        
        // Kontrola
        const checkData = await TableTips.findAll();
        console.log('Kontrola - data v MongoDB:', Object.keys(checkData));
        
    } catch (error) {
        console.error('Chyba při obnově:', error);
    } finally {
        process.exit(0);
    }
}

restoreTableTips();
