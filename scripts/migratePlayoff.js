/**
 * Skript pro nahrání playoff JSON dat do MongoDB
 * Použití: node scripts/migratePlayoff.js
 */

const fs = require('fs');
const path = require('path');
const { connectToDatabase } = require('../config/database');

async function migratePlayoff() {
    try {
        // Připojení k MongoDB
        await connectToDatabase();
        console.log('✅ Připojeno k MongoDB');

        // Načtení playoff dat z JSON
        const playoffPath = path.join(__dirname, '../data/playoff.json');
        let playoffData = {};
        
        try {
            const rawData = fs.readFileSync(playoffPath, 'utf8');
            playoffData = JSON.parse(rawData);
            console.log('📁 Načteno playoff.json');
        } catch (e) {
            console.log('⚠️  playoff.json nenalezen nebo prázdný, používám prázdný objekt');
        }

        // Import do MongoDB přes mongoDataAccess
        const { Playoff } = require('../utils/mongoDataAccess');
        
        // Uložení do MongoDB
        await Playoff.replaceAll(playoffData);
        console.log('✅ Playoff data úspěšně nahrána do MongoDB');
        
        // Kontrola
        const verify = await Playoff.findAll();
        console.log(`📊 Počet záznamů v databázi: ${Object.keys(verify).length}`);
        
        process.exit(0);
    } catch (err) {
        console.error('❌ Chyba migrace:', err);
        process.exit(1);
    }
}

migratePlayoff();
