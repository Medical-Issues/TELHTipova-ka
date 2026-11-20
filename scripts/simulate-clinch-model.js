const { calculateClinchStatusesForGroup } = require('../utils/clinchStatus');

const season = 'model-14';
const leagueName = 'Model League (14)';
const league = {
    maxMatches: 364,
    isMultigroup: false,
    groupCount: 1,
    quarterfinal: 4,
    playin: 12,
    relegation: 1,
    tiebreakerPriority: 'h2h'
};

function shuffleDeterministically(items) {
    let seed = 20261120;
    const nextRandom = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
    };

    for (let index = items.length - 1; index > 0; index--) {
        const swapIndex = Math.floor(nextRandom() * (index + 1));
        [items[index], items[swapIndex]] = [items[swapIndex], items[index]];
    }
    return items;
}

function selectBalancedRemainingFixtures(fixtures, remainingCount) {
    const candidates = shuffleDeterministically([...fixtures]);
    const gamesPerTeam = new Map();
    const remaining = [];

    while (remaining.length < remainingCount) {
        let bestIndex = -1;
        let bestLoad = Infinity;

        candidates.forEach((fixture, index) => {
            if (!fixture || remaining.includes(fixture)) return;
            const homeLoad = gamesPerTeam.get(fixture.homeTeamId) || 0;
            const awayLoad = gamesPerTeam.get(fixture.awayTeamId) || 0;
            if (homeLoad >= 2 || awayLoad >= 2) return;
            const load = homeLoad + awayLoad;
            if (load < bestLoad) {
                bestIndex = index;
                bestLoad = load;
            }
        });

        if (bestIndex < 0) {
            throw new Error(`Could only schedule ${remaining.length} of ${remainingCount} remaining model fixtures.`);
        }

        const fixture = candidates[bestIndex];
        remaining.push(fixture);
        gamesPerTeam.set(fixture.homeTeamId, (gamesPerTeam.get(fixture.homeTeamId) || 0) + 1);
        gamesPerTeam.set(fixture.awayTeamId, (gamesPerTeam.get(fixture.awayTeamId) || 0) + 1);
    }

    return new Set(remaining.map(fixture => fixture.id));
}

function buildModelLeague() {
    const teams = Array.from({ length: 14 }, (_, index) => ({
        id: index + 1,
        name: `Tým ${String(index + 1).padStart(2, '0')}`,
        stats: {
            [season]: {
                points: 0,
                wins: 0,
                otWins: 0,
                otLosses: 0,
                losses: 0,
                gf: 0,
                ga: 0,
                tiebreaker: 0
            }
        }
    }));
    const teamsById = new Map(teams.map(team => [team.id, team]));
    const fixtures = [];
    let fixtureId = 0;

    for (let homeId = 1; homeId <= teams.length; homeId++) {
        for (let awayId = homeId + 1; awayId <= teams.length; awayId++) {
            for (let meeting = 0; meeting < 4; meeting++) {
                const homeTeamId = meeting % 2 === 0 ? homeId : awayId;
                const awayTeamId = meeting % 2 === 0 ? awayId : homeId;
                fixtures.push({
                    id: ++fixtureId,
                    season,
                    liga: leagueName,
                    homeTeamId,
                    awayTeamId,
                    isPlayoff: false
                });
            }
        }
    }

    shuffleDeterministically(fixtures);
    const remainingFixtureIds = selectBalancedRemainingFixtures(fixtures, 13);
    const pointOutcomes = [
        { scoreHome: 3, scoreAway: 1, homePoints: 3, awayPoints: 0, ot: false },
        { scoreHome: 2, scoreAway: 1, homePoints: 2, awayPoints: 1, ot: true },
        { scoreHome: 1, scoreAway: 2, homePoints: 1, awayPoints: 2, ot: true },
        { scoreHome: 1, scoreAway: 3, homePoints: 0, awayPoints: 3, ot: false }
    ];

    fixtures.forEach(fixture => {
        if (remainingFixtureIds.has(fixture.id)) return;

        const strengthDifference = fixture.awayTeamId - fixture.homeTeamId;
        const homeWinChance = Math.max(0.08, Math.min(0.92, 0.5 + strengthDifference * 0.055));
        const randomValue = ((fixture.id * 48271 + fixture.homeTeamId * 69621 +
            fixture.awayTeamId * 29791) % 10000) / 10000;
        const homeWins = randomValue < homeWinChance;
        const overtime = fixture.id % 4 === 0;
        const outcomeIndex = homeWins
            ? (overtime ? 1 : 0)
            : (overtime ? 2 : 3);
        const outcome = pointOutcomes[outcomeIndex];
        fixture.result = {
            scoreHome: outcome.scoreHome,
            scoreAway: outcome.scoreAway,
            ot: outcome.ot
        };
        const homeStats = teamsById.get(fixture.homeTeamId).stats[season];
        const awayStats = teamsById.get(fixture.awayTeamId).stats[season];
        homeStats.points += outcome.homePoints;
        awayStats.points += outcome.awayPoints;
        homeStats.gf += outcome.scoreHome;
        homeStats.ga += outcome.scoreAway;
        awayStats.gf += outcome.scoreAway;
        awayStats.ga += outcome.scoreHome;

        if (outcome.homePoints === 3) {
            homeStats.wins++;
            awayStats.losses++;
        } else if (outcome.homePoints === 2) {
            homeStats.otWins++;
            awayStats.otLosses++;
        } else if (outcome.homePoints === 1) {
            homeStats.otLosses++;
            awayStats.otWins++;
        } else {
            homeStats.losses++;
            awayStats.wins++;
        }
    });

    return { season, leagueName, league, teams, matches: fixtures };
}

function runSimulation() {
    const model = buildModelLeague();
    const teamsById = new Map(model.teams.map(team => [team.id, team]));
    const rankedTeams = [...model.teams].sort((a, b) => {
        const aStats = a.stats[model.season];
        const bStats = b.stats[model.season];
        return bStats.points - aStats.points || a.id - b.id;
    });
    const statuses = calculateClinchStatusesForGroup(
        rankedTeams,
        model.league,
        model.season,
        'cascade',
        {},
        model.matches,
        model.leagueName
    );
    const pendingFixtures = model.matches.filter(fixture => !fixture.result).length;
    const analysis = statuses[0]._clinchStatus.scenarioAnalysis;

    console.log(`Model league: ${model.teams.length} teams, ${model.matches.length} scheduled games, ${pendingFixtures} remaining`);
    console.log(`Zone setup: top ${model.league.quarterfinal} direct, top ${model.league.playin} playoff, bottom ${model.league.relegation} relegation`);
    console.log('Standings use deterministic synthetic team strengths; this is a demonstration, not real league data.');
    console.log(`Scenario search: ${analysis.status}, ${analysis.scenarios} terminal evaluations, ${analysis.nodesVisited} nodes, ${analysis.prunedBranches || 0} pruned branches${analysis.earlyTerminated ? ', safely stopped when remaining branches could not widen rank ranges' : ''}`);
    if (analysis.status === 'search-limit') {
        console.log('Note: rank ranges use conservative pairwise bounds from the remaining fixtures because the scenario search reached its node limit.');
    } else if (analysis.status === 'incomplete-schedule') {
        console.log('Note: rank ranges use the conservative fallback because the fixture schedule is incomplete.');
    }
    console.table(statuses.map(team => {
        const status = team._clinchStatus;
        const stats = team.stats[model.season];
        return {
            team: teamsById.get(team.id).name,
            points: stats.points,
            remaining: status.matchesRemaining,
            minRank: status.minRank,
            maxRank: status.maxRank,
            lockedRank: status.locked ? 'yes' : 'no',
            lockedZone: status.lockedZone ? 'yes' : 'no',
            clinchedTop4: status.clinchedQF ? 'yes' : 'no',
            clinchedPlayoff: status.clinchedQF || status.clinchedPlayin ? 'yes' : 'no',
            clinchedRelegation: status.clinchedRelegation ? 'yes' : 'no'
        };
    }));
}

if (require.main === module) runSimulation();

module.exports = { buildModelLeague, selectBalancedRemainingFixtures };
