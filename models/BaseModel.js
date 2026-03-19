const { getDatabase } = require('../config/database');

class BaseModel {
    constructor(collectionName) {
        this.collectionName = collectionName;
    }

    getCollection() {
        const db = getDatabase();
        return db.collection(this.collectionName);
    }

    async findAll() {
        return await this.getCollection().find({}).toArray();
    }

    async findById(id) {
        return await this.getCollection().findOne({ _id: id });
    }

    async findOne(query) {
        return await this.getCollection().findOne(query);
    }

    async findMany(query) {
        return await this.getCollection().find(query).toArray();
    }

    async insertOne(data) {
        const result = await this.getCollection().insertOne(data);
        return result.insertedId;
    }

    async insertMany(data) {
        const result = await this.getCollection().insertMany(data);
        return result.insertedIds;
    }

    async updateOne(query, update) {
        return await this.getCollection().updateOne(query, { $set: update });
    }

    async updateMany(query, update) {
        return await this.getCollection().updateMany(query, { $set: update });
    }

    async replaceOne(query, data) {
        return await this.getCollection().replaceOne(query, data);
    }

    async deleteOne(query) {
        return await this.getCollection().deleteOne(query);
    }

    async deleteMany(query) {
        return await this.getCollection().deleteMany(query);
    }

    async countDocuments(query = {}) {
        return await this.getCollection().countDocuments(query);
    }
}

module.exports = BaseModel;
