const DEFAULT_GROUP_CRITERIA = [
    'points',
    'manualTiebreaker',
    'headToHeadPoints',
    'headToHeadGoalDifference',
    'headToHeadGoalsFor',
    'directResult',
    'goalDifference',
    'goalsFor'
];

const LEGACY_GOAL_DIFFERENCE_CRITERIA = [
    'points',
    'manualTiebreaker',
    'headToHeadPoints',
    'goalDifference',
    'headToHeadGoalDifference',
    'headToHeadGoalsFor',
    'directResult',
    'goalsFor'
];

const DEFAULT_CROSS_GROUP_CRITERIA = [
    'points',
    'manualTiebreaker',
    'goalDifference',
    'goalsFor'
];

const HIGHER_IS_BETTER = new Set([
    'points',
    'headToHeadPoints',
    'headToHeadGoalDifference',
    'headToHeadGoalsFor',
    'goalDifference',
    'goalsFor',
    'regulationWins',
    'wins'
]);

const LOWER_IS_BETTER = new Set([
    'manualTiebreaker',
    'penaltyMinutes',
    'seeding',
    'groupRank'
]);

const STANDINGS_CRITERIA = [
    { key: 'points', label: 'Body', description: 'Základní pořadí podle získaných bodů.' },
    { key: 'manualTiebreaker', label: 'Ruční tie-break', description: 'Ruční pořadí zadané u týmu; 0 znamená bez hodnoty.' },
    { key: 'headToHeadPoints', label: 'Vzájemné body', description: 'Body získané ve vzájemných zápasech právě nerozhodných týmů.' },
    { key: 'headToHeadGoalDifference', label: 'Vzájemný rozdíl skóre', description: 'Rozdíl gólů ve vzájemných zápasech nerozhodných týmů.' },
    { key: 'headToHeadGoalsFor', label: 'Vzájemné vstřelené góly', description: 'Góly vstřelené ve vzájemných zápasech nerozhodných týmů.' },
    { key: 'directResult', label: 'Přímý výsledek', description: 'Vzájemný rozdíl skóre; používá se při shodě dvou týmů.' },
    { key: 'goalDifference', label: 'Celkový rozdíl skóre', description: 'Celkový rozdíl vstřelených a obdržených gólů.' },
    { key: 'goalsFor', label: 'Celkový počet vstřelených gólů', description: 'Počet gólů vstřelených v soutěži.' },
    { key: 'regulationWins', label: 'Výhry v základní době', description: 'Počet výher v základní hrací době.' },
    { key: 'wins', label: 'Výhry', description: 'Počet výher včetně výher po prodloužení/nájezdech.' },
    { key: 'penaltyMinutes', label: 'Trestné minuty', description: 'Méně trestných minut znamená lepší pořadí.' },
    { key: 'seeding', label: 'Seeding / nasazení', description: 'Ruční nasazení týmu; nižší kladné číslo je lepší.' },
    { key: 'groupRank', label: 'Pořadí ve skupině', description: 'Pořadí týmu v jeho skupině; pouze pro křížovou tabulku.' }
];
const STANDINGS_CRITERION_KEYS = new Set(STANDINGS_CRITERIA.map(criterion => criterion.key));

function getStandingsCriteria(leagueObj = {}, phase = 'group') {
    const standingsRules = leagueObj.standingsRules || {};
    const configuredRules = standingsRules[phase] ??
        (phase === 'groupInProgress' ? standingsRules.group : undefined) ??
        (phase === 'groupFinal' ? standingsRules.group : undefined);
    let criteria;
    if (Array.isArray(configuredRules)) {
        criteria = configuredRules;
    } else if (Array.isArray(configuredRules?.criteria)) {
        criteria = configuredRules.criteria;
    } else if (phase === 'crossGroup') {
        criteria = DEFAULT_CROSS_GROUP_CRITERIA;
    } else if (leagueObj.tiebreakerPriority === 'goalDiff') {
        criteria = LEGACY_GOAL_DIFFERENCE_CRITERIA;
    } else {
        criteria = DEFAULT_GROUP_CRITERIA;
    }

    const firstCriterion = typeof criteria[0] === 'string' ? criteria[0] : criteria[0]?.type;
    if (firstCriterion !== 'points' && firstCriterion !== 'groupRank') {
        throw new Error(`Standings rules for ${phase} must start with points or groupRank.`);
    }
    return criteria;
}

function normalizeStandingsCriteria(criteria, phase) {
    if (!Array.isArray(criteria) || criteria.length === 0) {
        throw new Error(`Pravidla pro ${phase} musí obsahovat alespoň jedno kritérium.`);
    }

    const normalized = criteria.map(criterion =>
        typeof criterion === 'string' ? criterion : criterion?.type
    );
    if (normalized.some(criterion => !STANDINGS_CRITERION_KEYS.has(criterion))) {
        throw new Error('Pravidla obsahují nepodporované kritérium.');
    }
    if (new Set(normalized).size !== normalized.length) {
        throw new Error('Každé kritérium lze v pořadí použít pouze jednou.');
    }
    if (normalized.includes('groupRank') && phase !== 'crossGroup') {
        throw new Error('Pořadí ve skupině lze použít pouze pro křížovou tabulku.');
    }
    const firstCriterion = normalized[0];
    if (phase === 'crossGroup') {
        if (firstCriterion !== 'points' && firstCriterion !== 'groupRank') {
            throw new Error('Křížové pořadí musí začínat body nebo pořadím ve skupině.');
        }
    } else if (firstCriterion !== 'points') {
        throw new Error(`Pravidla pro ${phase} musí začínat body.`);
    }
    return normalized;
}

function copyStandingsRules(sourceLeague, targetLeague = null) {
    const target = { ...(targetLeague || {}) };
    if (sourceLeague?.standingsRules) {
        target.standingsRules = JSON.parse(JSON.stringify(sourceLeague.standingsRules));
    } else {
        delete target.standingsRules;
    }
    return target;
}

function getTeamId(team) {
    return Number(team.id ?? team.teamId);
}

function getStats(team, season) {
    return team.stats?.[season] || team;
}

function getPointsFromMatch(match, isHome) {
    const homeGoals = Number(match.result?.scoreHome ?? match.scoreHome) || 0;
    const awayGoals = Number(match.result?.scoreAway ?? match.scoreAway) || 0;
    const overtime = Boolean(match.result?.ot ?? match.ot);

    if (homeGoals === awayGoals) return 1;
    const homeWon = homeGoals > awayGoals;
    if (isHome === homeWon) return overtime ? 2 : 3;
    return overtime ? 1 : 0;
}

function compareManualTiebreakers(teamValue, opponentValue) {
    const first = Number(teamValue) || 0;
    const second = Number(opponentValue) || 0;
    if (first === second) return 0;
    if (first === 0) return 1;
    if (second === 0) return -1;
    return first < second ? -1 : 1;
}

function calculateCriterionValue(criterion, team, tiedTeams, context) {
    const { season, matches, scores } = context;
    const teamId = getTeamId(team);
    const stats = getStats(team, season);
    const score = scores?.[teamId] || scores?.[String(teamId)] || {};
    const goalsFor = Number(score.gf ?? stats.gf) || 0;
    const goalsAgainst = Number(score.ga ?? stats.ga) || 0;

    switch (criterion) {
        case 'points':
            return Number(stats.points) || 0;
        case 'manualTiebreaker':
            return Number(stats.tiebreaker) || 0;
        case 'goalDifference':
            return goalsFor - goalsAgainst;
        case 'goalsFor':
            return goalsFor;
        case 'regulationWins':
            return Number(stats.regulationWins ?? stats.wins) || 0;
        case 'wins':
            return (Number(stats.wins) || 0) + (Number(stats.otWins) || 0);
        case 'penaltyMinutes': {
            if (stats.penaltyMinutes === undefined || stats.penaltyMinutes === null ||
                stats.penaltyMinutes === '') return Infinity;
            const value = Number(stats.penaltyMinutes);
            return Number.isFinite(value) && value >= 0 ? value : Infinity;
        }
        case 'seeding': {
            const value = Number(stats.seeding ?? team.seeding);
            return Number.isFinite(value) && value > 0 ? value : Infinity;
        }
        case 'groupRank': {
            const value = Number(team.groupRank ?? stats.groupRank);
            return Number.isFinite(value) && value > 0 ? value : Infinity;
        }
        case 'headToHeadPoints':
        case 'headToHeadGoalDifference':
        case 'headToHeadGoalsFor': {
            const tiedIds = new Set(tiedTeams.map(getTeamId));
            const metric = { points: 0, goalDifference: 0, goalsFor: 0 };
            for (const match of matches) {
                if (match.result == null ||
                    match.isPlayoff ||
                    (match.season != null && match.season !== season) ||
                    (match.liga != null && context.liga != null && match.liga !== context.liga)) {
                    continue;
                }
                const homeId = Number(match.homeTeamId);
                const awayId = Number(match.awayTeamId);
                if (!tiedIds.has(homeId) || !tiedIds.has(awayId)) continue;

                const isHome = homeId === teamId;
                if (!isHome && awayId !== teamId) continue;
                const homeGoals = Number(match.result?.scoreHome ?? match.scoreHome) || 0;
                const awayGoals = Number(match.result?.scoreAway ?? match.scoreAway) || 0;
                if (criterion === 'headToHeadPoints') {
                    metric.points += getPointsFromMatch(match, isHome);
                } else if (criterion === 'headToHeadGoalDifference') {
                    metric.goalDifference += isHome
                        ? homeGoals - awayGoals
                        : awayGoals - homeGoals;
                } else {
                    metric.goalsFor += isHome ? homeGoals : awayGoals;
                }
            }
            if (criterion === 'headToHeadPoints') return metric.points;
            if (criterion === 'headToHeadGoalDifference') return metric.goalDifference;
            return metric.goalsFor;
        }
        case 'directResult': {
            if (tiedTeams.length !== 2) return 0;
            const opponent = tiedTeams.find(candidate => getTeamId(candidate) !== teamId);
            if (!opponent) return 0;
            const opponentId = getTeamId(opponent);
            let goalDifference = 0;
            for (const match of matches) {
                if (match.result == null ||
                    match.isPlayoff ||
                    (match.season != null && match.season !== season) ||
                    (match.liga != null && context.liga != null && match.liga !== context.liga)) {
                    continue;
                }
                const homeId = Number(match.homeTeamId);
                const awayId = Number(match.awayTeamId);
                if (homeId === teamId && awayId === opponentId) {
                    goalDifference += (Number(match.result?.scoreHome ?? match.scoreHome) || 0) -
                        (Number(match.result?.scoreAway ?? match.scoreAway) || 0);
                } else if (homeId === opponentId && awayId === teamId) {
                    goalDifference += (Number(match.result?.scoreAway ?? match.scoreAway) || 0) -
                        (Number(match.result?.scoreHome ?? match.scoreHome) || 0);
                }
            }
            return goalDifference;
        }
        default:
            throw new Error(`Unsupported standings criterion: ${criterion}`);
    }
}

function rankTeams(teams, options = {}) {
    const {
        season,
        matches = [],
        liga,
        scores = {},
        criteria = DEFAULT_GROUP_CRITERIA
    } = options;
    const firstCriterion = typeof criteria[0] === 'string' ? criteria[0] : criteria[0]?.type;
    if (firstCriterion !== 'points' && firstCriterion !== 'groupRank') {
        throw new Error('Standings criteria must start with points or groupRank.');
    }
    const entries = teams.map((team, index) => ({ team, index }));
    let tiedGroups = [entries];

    for (const configuredCriterion of criteria) {
        const criterion = typeof configuredCriterion === 'string'
            ? configuredCriterion
            : configuredCriterion?.type;
        if (!criterion) throw new Error('Standings criteria must be strings or objects with a type.');
        if (!HIGHER_IS_BETTER.has(criterion) && !LOWER_IS_BETTER.has(criterion) &&
            criterion !== 'directResult') {
            throw new Error(`Unsupported standings criterion: ${criterion}`);
        }

        const nextGroups = [];
        for (const group of tiedGroups) {
            if (group.length < 2) {
                nextGroups.push(group);
                continue;
            }
            const groupTeams = group.map(entry => entry.team);
            const values = group.map(entry => ({
                ...entry,
                value: calculateCriterionValue(criterion, entry.team, groupTeams, {
                    season,
                    matches,
                    liga,
                    scores
                })
            }));
            values.sort((first, second) => {
                if (criterion === 'manualTiebreaker') {
                    return compareManualTiebreakers(first.value, second.value) ||
                        first.index - second.index;
                }
                if (first.value !== second.value) {
                    if (LOWER_IS_BETTER.has(criterion)) return first.value - second.value;
                    return second.value - first.value;
                }
                return first.index - second.index;
            });

            let currentGroup = [];
            let currentValue;
            for (const entry of values) {
                if (currentGroup.length && entry.value !== currentValue) {
                    nextGroups.push(currentGroup);
                    currentGroup = [];
                }
                currentValue = entry.value;
                currentGroup.push(entry);
            }
            if (currentGroup.length) nextGroups.push(currentGroup);
        }
        tiedGroups = nextGroups;
    }

    return tiedGroups.flat().map(entry => entry.team);
}

module.exports = {
    DEFAULT_GROUP_CRITERIA,
    STANDINGS_CRITERIA,
    getStandingsCriteria,
    normalizeStandingsCriteria,
    copyStandingsRules,
    rankTeams
};
