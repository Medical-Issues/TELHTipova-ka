const fs = require('fs');
const path = require('path');
const { connectToDatabase, getCollection } = require('../config/database');

async function migrateUsers() {
    try {
        console.log('🔄 Připojování k MongoDB...');
        await connectToDatabase();
        
        const usersCollection = getCollection('users');
        
        // Načtení users.json
        const usersPath = path.join(__dirname, '../data/users.json');
        if (!fs.existsSync(usersPath)) {
            console.error('❌ Soubor users.json neexistuje!');
            process.exit(1);
        }
        
        const usersData = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        console.log(`📂 Načteno ${usersData.length} uživatelů z users.json`);
        
        if (usersData.length === 0) {
            console.log('⚠️  Soubor users.json je prázdný!');
            process.exit(0);
        }
        
        // Smazání existujících dat v MongoDB
        await usersCollection.deleteMany({});
        console.log('🗑️  Existující data v MongoDB smazána');
        
        // Vložení dat do MongoDB
        const result = await usersCollection.insertMany(usersData);
        console.log(`✅ Úspěšně migrováno ${result.insertedCount} uživatelů do MongoDB`);
        
        // Ověření
        const count = await usersCollection.countDocuments();
        console.log(`📊 Celkem v MongoDB: ${count} uživatelů`);
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Chyba při migraci:', error);
        process.exit(1);
    }
}

migrateUsers();
