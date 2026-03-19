// MongoDB data access layer
const { getCollection } = require('../config/database');

// MongoDB data access třída
class MongoDataAccess {
    constructor(collectionName) {
        this.collectionName = collectionName;
    }

    async getCollection() {
        return getCollection(this.collectionName);
    }

    async findAll() {
        try {
            const collection = await this.getCollection();
            const data = await collection.find({}).toArray();
            
            // Speciální případy pro různé datové typy
            if (this.collectionName === 'allowedLeagues' || this.collectionName === 'transferLeagues') {
                // Pole stringů - vrátíme pole hodnot
                const doc = data[0];
                return doc ? doc.values || [] : [];
            } else if (this.collectionName === 'chosenSeason') {
                // String - vrátíme hodnotu
                const doc = data[0];
                return doc ? doc.value : 'Neurčeno';
            } else if (this.collectionName === 'leagues' || this.collectionName === 'settings') {
                // Objekt - vrátíme první dokument
                const doc = data[0];
                return doc || {};
            } else if (this.collectionName === 'tableTips' || this.collectionName === 'playoff' || this.collectionName === 'playoffTemplates' || this.collectionName === 'transfers' || this.collectionName === 'leagueStatus' || this.collectionName === 'teamBonuses') {
                // Jeden dokument s vnořenou strukturou - vrátíme první dokument bez _id
                const doc = data[0];
                if (doc && doc._id) {
                    const { _id, ...cleanDoc } = doc;
                    return cleanDoc || {};
                }
                return doc || {};
            } else {
                // Pole objektů - vrátíme pole
                return data;
            }
        } catch (error) {
            console.error(`Chyba v findAll ${this.collectionName}:`, error);
            return this.collectionName === 'leagues' || this.collectionName === 'chosenSeason' || this.collectionName === 'settings' || this.collectionName === 'tableTips' || this.collectionName === 'playoff' || this.collectionName === 'playoffTemplates' || this.collectionName === 'transfers' || this.collectionName === 'leagueStatus' || this.collectionName === 'teamBonuses' ? {} : [];
        }
    }

    // Přidání findMany funkce (alias pro findAll)
    async findMany(query = {}) {
        try {
            const collection = await this.getCollection();
            const data = await collection.find(query).toArray();
            
            // Stejná logika jako findAll
            if (this.collectionName === 'allowedLeagues' || this.collectionName === 'transferLeagues') {
                const doc = data[0];
                return doc ? doc.values || [] : [];
            } else if (this.collectionName === 'chosenSeason') {
                const doc = data[0];
                return doc ? doc.value : 'Neurčeno';
            } else if (this.collectionName === 'leagues' || this.collectionName === 'settings') {
                const doc = data[0];
                return doc || {};
            } else if (this.collectionName === 'tableTips' || this.collectionName === 'playoff' || this.collectionName === 'playoffTemplates' || this.collectionName === 'transfers' || this.collectionName === 'leagueStatus' || this.collectionName === 'teamBonuses') {
                const doc = data[0];
                if (doc && doc._id) {
                    const { _id, ...cleanDoc } = doc;
                    return cleanDoc || {};
                }
                return doc || {};
            } else {
                return data;
            }
        } catch (error) {
            console.error(`Chyba v findMany ${this.collectionName}:`, error);
            return this.collectionName === 'leagues' || this.collectionName === 'chosenSeason' || this.collectionName === 'settings' || this.collectionName === 'tableTips' || this.collectionName === 'playoff' || this.collectionName === 'playoffTemplates' || this.collectionName === 'transfers' || this.collectionName === 'leagueStatus' || this.collectionName === 'teamBonuses' ? {} : [];
        }
    }

    async findOne(query) {
        try {
            const collection = await this.getCollection();
            
            if (typeof query === 'string' || typeof query === 'number') {
                return await collection.findOne({ id: query });
            } else if (query.username) {
                return await collection.findOne({ username: query.username });
            } else {
                return await collection.findOne(query);
            }
        } catch (error) {
            console.error(`Chyba v findOne ${this.collectionName}:`, error);
            return null;
        }
    }

    async insertOne(document) {
        try {
            const collection = await this.getCollection();
            const result = await collection.insertOne(document);
            return { ...document, _id: result.insertedId };
        } catch (error) {
            console.error(`Chyba v insertOne ${this.collectionName}:`, error);
            return null;
        }
    }

    async insertMany(documents) {
        try {
            const collection = await this.getCollection();
            const result = await collection.insertMany(documents);
            return documents.map((doc, index) => ({ ...doc, _id: result.insertedIds[index] }));
        } catch (error) {
            console.error(`Chyba v insertMany ${this.collectionName}:`, error);
            return null;
        }
    }

    async updateOne(query, update, options = {}) {
        try {
            const collection = await this.getCollection();
            const result = await collection.updateOne(query, { $set: update }, options);
            if (result.matchedCount > 0) {
                return await this.findOne(query);
            }
            return null;
        } catch (error) {
            console.error(`Chyba v updateOne ${this.collectionName}:`, error);
            return null;
        }
    }

    async deleteOne(query) {
        try {
            const collection = await this.getCollection();
            const deleted = await collection.findOne(query);
            if (deleted) {
                await collection.deleteOne(query);
                return deleted;
            }
            return null;
        } catch (error) {
            console.error(`Chyba v deleteOne ${this.collectionName}:`, error);
            return null;
        }
    }

    // Přidání deleteMany funkce
    async deleteMany(query = {}) {
        try {
            const collection = await this.getCollection();
            const result = await collection.deleteMany(query);
            return result.deletedCount || 0;
        } catch (error) {
            console.error(`Chyba v deleteMany ${this.collectionName}:`, error);
            return 0;
        }
    }

    // Přidání countDocuments funkce
    async countDocuments(query = {}) {
        try {
            const collection = await this.getCollection();
            return await collection.countDocuments(query);
        } catch (error) {
            console.error(`Chyba v countDocuments ${this.collectionName}:`, error);
            return 0;
        }
    }

    async replaceAll(data) {
        try {
            const collection = await this.getCollection();
            await collection.deleteMany({});
            
            // Speciální případy
            if (this.collectionName === 'allowedLeagues' || this.collectionName === 'transferLeagues') {
                await collection.insertOne({ values: data });
            } else if (this.collectionName === 'chosenSeason') {
                await collection.insertOne({ value: data });
            } else if (this.collectionName === 'leagues' || this.collectionName === 'playoffTemplates') {
                await collection.insertOne(data);
            } else {
                if (Array.isArray(data)) {
                    await collection.insertMany(data);
                } else {
                    await collection.insertOne(data);
                }
            }
            
            return true;
        } catch (error) {
            console.error(`Chyba v replaceAll ${this.collectionName}:`, error);
            return false;
        }
    }
}

// Vytvoření instancí pro všechny datové typy
const Users = new MongoDataAccess('users');
const Matches = new MongoDataAccess('matches');
const Teams = new MongoDataAccess('teams');
const Leagues = new MongoDataAccess('leagues');
const AllowedLeagues = new MongoDataAccess('allowedLeagues');
const ChosenSeason = new MongoDataAccess('chosenSeason');
const Settings = new MongoDataAccess('settings');
const Playoff = new MongoDataAccess('playoff');
const PlayoffTemplates = new MongoDataAccess('playoffTemplates');
const TransferLeagues = new MongoDataAccess('transferLeagues');
const TableTips = new MongoDataAccess('tableTips');
const TeamBonuses = new MongoDataAccess('teamBonuses');
const LeagueStatus = new MongoDataAccess('leagueStatus');
const Transfers = new MongoDataAccess('transfers');
const Tips = new MongoDataAccess('tips');

module.exports = {
    Users,
    Matches,
    Teams,
    Leagues,
    AllowedLeagues,
    ChosenSeason,
    Settings,
    Playoff,
    PlayoffTemplates,
    TransferLeagues,
    TableTips,
    TeamBonuses,
    LeagueStatus,
    Transfers,
    Tips
};
