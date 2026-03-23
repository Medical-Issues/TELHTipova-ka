const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('❌ Chyba: MONGODB_URI není nastaven v .env souboru');
    process.exit(1);
}
const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000
});

let db;

async function connectToDatabase() {
    if (db) return db;
    
    try {
        await client.connect();
        db = client.db('telhtipovaka');
        console.log('✅ Připojeno k MongoDB');
        return db;
    } catch (error) {
        console.error('❌ Chyba připojení k MongoDB:', error);
        process.exit(1);
    }
}

function getDatabase() {
    if (!db) {
        throw new Error('Databáze není inicializována. Zavolejte connectToDatabase()');
    }
    return db;
}

function getCollection(name) {
    return getDatabase().collection(name);
}
module.exports = {
    connectToDatabase,
    getDatabase,
    getCollection
};
