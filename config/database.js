const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || 'mongodb://veselskyhonza_db_user:PjVT5DyG48HVkSVC@ac-pvzhs5t-shard-00-00.ifbc9x0.mongodb.net:27017,ac-pvzhs5t-shard-00-01.ifbc9x0.mongodb.net:27017,ac-pvzhs5t-shard-00-02.ifbc9x0.mongodb.net:27017/?ssl=true&replicaSet=atlas-uji3sl-shard-0&authSource=admin&appName=Cluster0';
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

async function closeDatabase() {
    if (client) {
        await client.close();
        console.log('🔌 Odpojeno od MongoDB');
    }
}

module.exports = {
    connectToDatabase,
    getDatabase,
    getCollection,
    closeDatabase
};
