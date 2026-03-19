const BaseModel = require('./BaseModel');

class Team extends BaseModel {
    constructor() {
        super('teams');
    }

    async findById(teamId) {
        return await this.findOne({ id: teamId });
    }

    async create(teamData) {
        return await this.insertOne(teamData);
    }

    async updateTeam(teamId, teamData) {
        return await this.updateOne(
            { id: teamId },
            { 
                ...teamData,
                updatedAt: new Date()
            }
        );
    }

    async deleteTeam(teamId) {
        return await this.deleteOne({ id: teamId });
    }
}

module.exports = new Team();
