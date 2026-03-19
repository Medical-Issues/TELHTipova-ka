const BaseModel = require('./BaseModel');

// Model pro remaining JSON files
class ConfigModel extends BaseModel {
    constructor(collectionName) {
        super(collectionName);
    }

    async getConfig() {
        const config = await this.findOne({});
        return config || {};
    }

    async updateConfig(configData) {
        const existing = await this.findOne({});
        if (existing) {
            return await this.updateOne({}, { ...configData, updatedAt: new Date() });
        } else {
            return await this.insertOne({ ...configData, createdAt: new Date() });
        }
    }

    async getValue(key) {
        const config = await this.getConfig();
        return config[key];
    }

    async setValue(key, value) {
        return await this.updateConfig({ [key]: value });
    }
}

// Create instances for all remaining collections
const AllowedLeagues = new ConfigModel('allowedLeagues');
const ChosenSeason = new ConfigModel('chosenSeason');
const LeagueStatus = new ConfigModel('leagueStatus');
const Playoff = new ConfigModel('playoff');
const PlayoffTemplates = new ConfigModel('playoffTemplates');
const Settings = new ConfigModel('settings');
const TableTips = new ConfigModel('tableTips');
const TeamBonuses = new ConfigModel('teamBonuses');
const Tips = new ConfigModel('tips');
const TransferLeagues = new ConfigModel('transferLeagues');
const Transfers = new ConfigModel('transfers');

module.exports = {
    ConfigModel,
    AllowedLeagues,
    ChosenSeason,
    LeagueStatus,
    Playoff,
    PlayoffTemplates,
    Settings,
    TableTips,
    TeamBonuses,
    Tips,
    TransferLeagues,
    Transfers
};
