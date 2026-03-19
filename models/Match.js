const BaseModel = require('./BaseModel');

class Match extends BaseModel {
    constructor() {
        super('matches');
    }

    async findBySeasonAndLeague(season, league) {
        return await this.findMany({ season, liga: league });
    }

    async findUnfinishedBySeasonAndLeague(season, league) {
        return await this.findMany({ 
            season, 
            liga: league, 
            result: { $exists: false } 
        });
    }

    async create(matchData) {
        return await this.insertOne(matchData);
    }

    async updateResult(matchId, result) {
        return await this.updateOne(
            { id: matchId },
            { 
                result,
                updatedAt: new Date()
            }
        );
    }

    async deleteMatch(matchId) {
        return await this.deleteOne({ id: matchId });
    }
}

module.exports = new Match();
