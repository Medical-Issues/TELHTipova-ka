const BaseModel = require('./BaseModel');

class User extends BaseModel {
    constructor() {
        super('users');
    }

    async findByUsername(username) {
        return await this.findOne({ username });
    }

    async create(userData) {
        return await this.insertOne(userData);
    }

    async updateTips(username, season, league, tips) {
        return await this.updateOne(
            { username },
            { 
                [`tips.${season}.${league}`]: tips,
                updatedAt: new Date()
            }
        );
    }

    async updateSubscriptions(username, subscriptions) {
        return await this.updateOne(
            { username },
            { 
                subscriptions,
                updatedAt: new Date()
            }
        );
    }

    async addPoints(username, points) {
        return await this.updateOne(
            { username },
            { 
                $inc: { total: points },
                updatedAt: new Date()
            }
        );
    }
}

module.exports = new User();
