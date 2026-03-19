const BaseModel = require('./BaseModel');

class League extends BaseModel {
    constructor() {
        super('leagues');
    }

    async findBySeason(season) {
        return await this.findOne({ season });
    }

    async createSeasonData(seasonData) {
        return await this.insertOne(seasonData);
    }

    async updateSeasonLeagues(season, leagues) {
        return await this.updateOne(
            { season },
            { 
                leagues,
                updatedAt: new Date()
            }
        );
    }

    async addLeagueToSeason(season, newLeague) {
        return await this.updateOne(
            { season },
            { 
                $push: { leagues: newLeague },
                updatedAt: new Date()
            }
        );
    }
}

module.exports = new League();
