const assert = require('node:assert/strict');
const test = require('node:test');

const {
    calculateClinchStatusesForGroup,
    calculateCrossGroupClinchStatuses
} = require('../utils/clinchStatus');
const { getStandingsCriteria, rankTeams } = require('../utils/standings');
const { buildLeagueTable } = require('../utils/playoffEditor');
const { buildPlayoffModel, hydratePlayoffModel } = require('../utils/playoffBracket');
const {
    buildModelLeague,
    selectBalancedRemainingFixtures
} = require('../scripts/simulate-clinch-model');

const season = 'test-season';

function team(id, points, { gf = 0, ga = 0, tiebreaker = 0, wins = 1, losses = 1 } = {}) {
    return {
        id,
        stats: {
            [season]: { points, gf, ga, tiebreaker, wins, losses }
        }
    };
}

function completedMatch(homeTeamId, awayTeamId, scoreHome, scoreAway) {
    return {
        season,
        liga: 'Test League',
        homeTeamId,
        awayTeamId,
        result: { scoreHome, scoreAway }
    };
}

function calculateGroup(teams, matches, tiebreakerPriority = 'h2h', scores = {}) {
    return calculateClinchStatusesForGroup(
        teams,
        {
            maxMatches: matches.length,
            quarterfinal: 1,
            playin: 2,
            relegation: 0,
            tiebreakerPriority
        },
        season,
        'cascade',
        scores,
        matches,
        'Test League'
    );
}

test('uses head-to-head mini-table goal difference when configured', () => {
    const teams = [
        team(1, 3, { gf: 2, ga: 1 }),
        team(2, 3, { gf: 2, ga: 2 }),
        team(3, 3, { gf: 1, ga: 2 })
    ];
    const matches = [
        completedMatch(1, 2, 2, 0),
        completedMatch(2, 3, 2, 0),
        completedMatch(3, 1, 1, 0)
    ];

    const result = calculateGroup(teams, matches);

    assert.deepEqual(
        result.map(item => [item._clinchStatus.minRank, item._clinchStatus.maxRank]),
        [[1, 1], [2, 2], [3, 3]]
    );
    assert.equal(result[0]._clinchStatus.scenarioAnalysis.status, 'complete');
    assert.match(result[0]._clinchStatus.scenarioAnalysis.tiebreakCoverage, /h2h-goals/);
});

test('uses overall goal difference first when configured', () => {
    const teams = [team(1, 3), team(2, 3), team(3, 3)];
    const matches = [
        completedMatch(1, 2, 2, 0),
        completedMatch(2, 3, 2, 0),
        completedMatch(3, 1, 1, 0)
    ];
    const scores = {
        1: { gf: 0, ga: 10 },
        2: { gf: 10, ga: 0 },
        3: { gf: 0, ga: 0 }
    };

    const result = calculateGroup(teams, matches, 'goalDiff', scores);

    assert.deepEqual(
        result.map(item => [item._clinchStatus.minRank, item._clinchStatus.maxRank]),
        [[3, 3], [1, 1], [2, 2]]
    );
    assert.match(result[0]._clinchStatus.scenarioAnalysis.tiebreakCoverage, /overall-goal-diff/);
});

test('builds the head-to-head mini-table only for teams still tied manually', () => {
    const teams = [
        team(1, 3, { tiebreaker: 1 }),
        team(2, 3, { tiebreaker: 1 }),
        team(3, 3, { tiebreaker: 2 })
    ];
    const matches = [
        completedMatch(1, 2, 1, 0),
        completedMatch(2, 3, 10, 0),
        completedMatch(3, 1, 10, 0)
    ];

    const result = calculateGroup(teams, matches);

    assert.deepEqual(
        result.map(item => [item._clinchStatus.minRank, item._clinchStatus.maxRank]),
        [[1, 1], [2, 2], [3, 3]]
    );
});

test('places teams without a manual tie-break behind teams with one', () => {
    const teams = [
        team(1, 3, { tiebreaker: 0 }),
        team(2, 3, { tiebreaker: 1 })
    ];
    const matches = [completedMatch(1, 2, 5, 0)];

    const result = calculateGroup(teams, matches);

    assert.deepEqual(
        result.map(item => [item._clinchStatus.minRank, item._clinchStatus.maxRank]),
        [[2, 2], [1, 1]]
    );
});

test('uses complete standings to resolve cross-group clinch ranks', () => {
    const teams = [team(1, 3), team(2, 3), team(3, 3)];
    const matches = [
        completedMatch(1, 2, 2, 0),
        completedMatch(2, 3, 2, 0),
        completedMatch(3, 1, 1, 0)
    ];
    const result = calculateCrossGroupClinchStatuses(teams, {
        season,
        leagueObj: { maxMatches: 3, tiebreakerPriority: 'goalDiff' },
        matches,
        liga: 'Test League',
        quarterfinal: 1,
        advancing: 2,
        relegation: 0,
        clinchMode: 'cascade',
        isRegularSeasonFinished: true,
        estimateTeamCount: 3,
        scores: {
            1: { gf: 0, ga: 10 },
            2: { gf: 10, ga: 0 },
            3: { gf: 0, ga: 0 }
        }
    });

    assert.deepEqual(
        result.map(item => [item._clinchStatus.minRank, item._clinchStatus.maxRank]),
        [[3, 3], [1, 1], [2, 2]]
    );
    assert.equal(result[0]._clinchStatus.scenarioAnalysis.status, 'complete');
});

test('falls back to broad bounds when the schedule is incomplete', () => {
    const result = calculateGroup([team(1, 3), team(2, 3)], []);

    assert.equal(result[0]._clinchStatus.scenarioAnalysis.status, 'incomplete-schedule');
    assert.deepEqual(
        [result[0]._clinchStatus.minRank, result[0]._clinchStatus.maxRank],
        [1, 2]
    );
    assert.equal(result[0]._clinchStatus.locked, false);
});

test('uses the entered final order for completed manual standings without a fixture list', () => {
    const teams = Array.from({ length: 14 }, (_, index) => ({
        ...team(index + 1, 100 - index, { wins: 0, losses: 0 }),
        stats: {
            [season]: {
                points: 100 - index,
                manualGames: 52,
                wins: 0,
                otWins: 0,
                otLosses: 0,
                losses: 0
            }
        }
    }));
    const result = calculateClinchStatusesForGroup(
        teams,
        {
            maxMatches: 364,
            quarterfinal: 6,
            playin: 10,
            relegation: 1
        },
        season,
        'cascade',
        {},
        [],
        'Test League'
    );

    assert.deepEqual(
        result.map(item => [
            item._clinchStatus.minRank,
            item._clinchStatus.maxRank,
            item._clinchStatus.currentZone
        ]),
        teams.map((_, index) => {
            const rank = index + 1;
            const zone = rank <= 6 ? 'quarterfinal'
                : rank <= 10 ? 'playin'
                    : rank === 14 ? 'relegation' : 'neutral';
            return [rank, rank, zone];
        })
    );
    assert.equal(result[0]._clinchStatus.clinchedQF, true);
    assert.equal(result[6]._clinchStatus.clinchedPlayin, true);
    assert.equal(result[10]._clinchStatus.clinchedNeutral, true);
    assert.equal(result[13]._clinchStatus.clinchedRelegation, true);
});

test('keeps a points tie unresolved when future goal scores can change the tiebreak', () => {
    const teams = [
        team(1, 3, { gf: 1, ga: 0, wins: 1, losses: 0 }),
        team(2, 0, { gf: 0, ga: 1, wins: 0, losses: 1 })
    ];
    const matches = [
        completedMatch(1, 2, 1, 0),
        {
            season,
            liga: 'Test League',
            homeTeamId: 1,
            awayTeamId: 2
        }
    ];

    const result = calculateClinchStatusesForGroup(
        teams,
        {
            maxMatches: 2,
            quarterfinal: 1,
            playin: 2,
            relegation: 0,
            tiebreakerPriority: 'h2h'
        },
        season,
        'cascade',
        {},
        matches,
        'Test League'
    );

    assert.equal(result[0]._clinchStatus.scenarioAnalysis.status, 'complete');
    assert.ok(result[0]._clinchStatus.scenarioAnalysis.scenarios > 0);
    assert.equal(result[0]._clinchStatus.matchesRemaining, 1);
    assert.deepEqual(
        [result[0]._clinchStatus.minRank, result[0]._clinchStatus.maxRank],
        [1, 2]
    );
    assert.equal(result[0]._clinchStatus.clinchedQF, false);
    assert.equal(result[0]._clinchStatus.locked, false);
});

test('keeps clinch bounds conservative for configured criteria with unknown future results', () => {
    const teams = [
        team(1, 3, { gf: 1, ga: 0, wins: 1, losses: 0 }),
        team(2, 0, { gf: 0, ga: 1, wins: 0, losses: 1 })
    ];
    const matches = [
        completedMatch(1, 2, 1, 0),
        {
            season,
            liga: 'Test League',
            homeTeamId: 1,
            awayTeamId: 2
        }
    ];
    const league = {
        maxMatches: 2,
        quarterfinal: 1,
        playin: 2,
        relegation: 0,
        standingsRules: {
            group: ['points', 'regulationWins', 'goalDifference']
        }
    };

    const result = calculateClinchStatusesForGroup(
        teams,
        league,
        season,
        'cascade',
        {},
        matches,
        'Test League'
    );

    assert.equal(result[0]._clinchStatus.scenarioAnalysis.status, 'complete');
    assert.deepEqual(
        [result[0]._clinchStatus.minRank, result[0]._clinchStatus.maxRank],
        [1, 2]
    );
});

test('uses configured standings criteria in final clinch ranks', () => {
    const teams = [
        team(1, 3, { gf: 1, ga: 0, wins: 1, losses: 0 }),
        team(2, 3, { gf: 0, ga: 1, wins: 0, losses: 1 })
    ];
    teams[0].stats[season].regulationWins = 1;
    teams[1].stats[season].regulationWins = 0;
    const matches = [completedMatch(1, 2, 1, 0)];
    const league = {
        maxMatches: 1,
        quarterfinal: 1,
        playin: 2,
        relegation: 0,
        standingsRules: {
            group: ['points', 'regulationWins', 'goalDifference']
        }
    };

    const result = calculateClinchStatusesForGroup(
        teams,
        league,
        season,
        'cascade',
        {},
        matches,
        'Test League'
    );

    assert.deepEqual(
        result.map(item => [item._clinchStatus.minRank, item._clinchStatus.maxRank]),
        [[1, 1], [2, 2]]
    );
});

test('keeps in-progress table ranking separate from final clinch ranking', () => {
    const teams = [
        team(1, 3, { gf: 10, ga: 0, wins: 1, losses: 0 }),
        team(2, 3, { gf: 1, ga: 0, wins: 1, losses: 0 })
    ];
    const matches = [completedMatch(2, 1, 1, 0)];
    const league = {
        maxMatches: 1,
        quarterfinal: 1,
        playin: 2,
        relegation: 0,
        standingsRules: {
            groupInProgress: ['points', 'goalDifference', 'goalsFor'],
            group: [
                'points',
                'headToHeadPoints',
                'headToHeadGoalDifference',
                'headToHeadGoalsFor',
                'goalDifference',
                'goalsFor'
            ]
        }
    };

    const tableOrder = rankTeams(teams, {
        season,
        liga: 'Test League',
        matches,
        criteria: getStandingsCriteria(league, 'groupInProgress')
    }).map(entry => entry.id);
    const clinch = calculateClinchStatusesForGroup(
        teams,
        league,
        season,
        'cascade',
        {},
        matches,
        'Test League'
    );

    assert.deepEqual(tableOrder, [1, 2]);
    assert.deepEqual(
        clinch.map(item => [item.id, item._clinchStatus.minRank, item._clinchStatus.maxRank]),
        [[1, 2, 2], [2, 1, 1]]
    );
});

test('playoff editor league table and clinch bounds use the same final ranking', () => {
    const teams = [
        team(1, 3, { gf: 10, ga: 0, wins: 1, losses: 0 }),
        team(2, 3, { gf: 1, ga: 0, wins: 1, losses: 0 })
    ];
    const matches = [completedMatch(2, 1, 1, 0)];
    const league = {
        maxMatches: 1,
        quarterfinal: 1,
        playin: 2,
        relegation: 0,
        isMultigroup: false,
        standingsRules: {
            group: [
                'points',
                'headToHeadPoints',
                'headToHeadGoalDifference',
                'headToHeadGoalsFor',
                'goalDifference',
                'goalsFor'
            ]
        }
    };

    const { teamsByGroup } = buildLeagueTable(
        teams,
        league,
        season,
        matches,
        'Test League',
        calculateClinchStatusesForGroup,
        'cascade'
    );

    assert.deepEqual(
        teamsByGroup.X.map(item => [item.id, item._clinchStatus.minRank, item._clinchStatus.maxRank]),
        [[2, 1, 1], [1, 2, 2]]
    );
});

test('playoff bracket seeds follow the configured final group ranking', () => {
    const teams = [
        { ...team(1, 3, { gf: 10, ga: 0 }), liga: 'Test League', group: 1, name: 'Team 1' },
        { ...team(2, 3, { gf: 1, ga: 0 }), liga: 'Test League', group: 1, name: 'Team 2' }
    ];
    const matches = [completedMatch(2, 1, 1, 0)];
    const league = {
        standingsRules: {
            group: [
                'points',
                'headToHeadPoints',
                'headToHeadGoalDifference',
                'goalDifference'
            ]
        }
    };
    const model = buildPlayoffModel({
        label: 'Test',
        columns: [{ title: 'Semifinále', slots: ['slot-1'] }],
        rules: {
            'slot-1': {
                home: { type: 'place', place: 1, group: '1' },
                away: { type: 'place', place: 2, group: '1' }
            }
        }
    });
    const hydrated = hydratePlayoffModel(model, {
        teams,
        matches,
        scores: {},
        selectedSeason: season,
        selectedLiga: 'Test League',
        leagueObj: league,
        zoneFaces: {
            'slot-1': {
                home: { id: 2, name: 'Team 2', league: 'Test League' },
                away: { id: 1, name: 'Team 1', league: 'Test League' }
            }
        }
    });
    const slot = hydrated.rounds[0].slots[0];

    assert.deepEqual(
        [slot.view.home.name, slot.view.home.seed, slot.view.away.name, slot.view.away.seed],
        ['Team 2', 1, 'Team 1', 2]
    );
});

test('uses group rank before points when calculating cross-group clinch ranks', () => {
    const teams = [
        { ...team(1, 12), groupRank: 2 },
        { ...team(2, 8), groupRank: 1 }
    ];
    const result = calculateCrossGroupClinchStatuses(teams, {
        season,
        leagueObj: {
            standingsRules: {
                crossGroup: [
                    { type: 'groupRank' },
                    'points',
                    'goalDifference'
                ]
            }
        },
        matches: [],
        liga: 'Test League',
        quarterfinal: 1,
        advancing: 2,
        relegation: 0,
        clinchMode: 'cascade',
        isRegularSeasonFinished: true,
        estimateTeamCount: teams.length,
        scores: {}
    });

    assert.deepEqual(
        result.map(item => [item.id, item._clinchStatus.minRank, item._clinchStatus.maxRank]),
        [[1, 2, 2], [2, 1, 1]]
    );
});

test('confirms clinch when remaining points rule out a tie-break dependency', () => {
    const teams = [
        team(1, 10, { gf: 5, ga: 2, wins: 3, losses: 0 }),
        team(2, 0, { gf: 0, ga: 5, wins: 0, losses: 3 })
    ];
    const matches = [
        completedMatch(1, 2, 2, 0),
        completedMatch(1, 2, 2, 1),
        completedMatch(1, 2, 1, 1),
        {
            season,
            liga: 'Test League',
            homeTeamId: 1,
            awayTeamId: 2
        },
        {
            season,
            liga: 'Test League',
            homeTeamId: 1,
            awayTeamId: 2
        },
        {
            season,
            liga: 'Test League',
            homeTeamId: 1,
            awayTeamId: 2
        }
    ];

    const result = calculateClinchStatusesForGroup(
        teams,
        {
            maxMatches: 6,
            quarterfinal: 1,
            playin: 2,
            relegation: 0,
            tiebreakerPriority: 'h2h'
        },
        season,
        'cascade',
        {},
        matches,
        'Test League'
    );

    assert.equal(result[0]._clinchStatus.scenarioAnalysis.status, 'complete');
    assert.equal(result[0]._clinchStatus.clinchedQF, true);
    assert.equal(result[0]._clinchStatus.maxRank, 1);
});

test('estimates remaining games per team from league and group configuration', () => {
    const telhTeams = Array.from({ length: 14 }, (_, index) =>
        team(index + 1, 0, { wins: 0, losses: 0 }));
    const telh = calculateClinchStatusesForGroup(
        telhTeams,
        { maxMatches: 364, quarterfinal: 4, playin: 12, relegation: 1 },
        season,
        'cascade',
        {},
        [],
        'TELH'
    );
    assert.ok(telh.every(item => item._clinchStatus.matchesRemaining === 52));
    assert.ok(telh.every(item => item._clinchStatus.scheduleComplete === false));
    assert.ok(telh.every(item => item._clinchStatus.scenarioAnalysis.status === 'incomplete-schedule'));

    const worldChampionshipTeams = Array.from({ length: 8 }, (_, index) =>
        team(index + 1, 0, { wins: 0, losses: 0 }));
    const worldChampionship = calculateClinchStatusesForGroup(
        worldChampionshipTeams,
        { maxMatches: 56, isMultigroup: true, groupCount: 2, quarterfinal: 4, playin: 4, relegation: 1 },
        season,
        'cascade',
        {},
        [],
        'World Championship'
    );
    assert.ok(worldChampionship.every(item => item._clinchStatus.matchesRemaining === 7));
});

test('counts every remaining fixture against the correct opponent', () => {
    const teams = [team(1, 0), team(2, 0)];
    const matches = Array.from({ length: 4 }, () => ({
        season,
        liga: 'Test League',
        homeTeamId: 1,
        awayTeamId: 2
    }));
    const result = calculateClinchStatusesForGroup(
        teams,
        { maxMatches: 4, quarterfinal: 1, playin: 2, relegation: 0 },
        season,
        'cascade',
        {},
        matches,
        'Test League'
    );

    assert.equal(result[0]._clinchStatus.scheduleComplete, true);
    assert.equal(result[0]._clinchStatus.matchesRemaining, 4);
    assert.deepEqual(result[0]._clinchStatus.remainingOpponents, { 2: 4 });
    assert.equal(result[0]._clinchStatus.scenarioAnalysis.status, 'complete');
});

test('stops once scenario bounds reach the full possible rank range', () => {
    const teams = [team(1, 0), team(2, 0)];
    const matches = Array.from({ length: 10 }, () => ({
        season,
        liga: 'Test League',
        homeTeamId: 1,
        awayTeamId: 2
    }));
    const result = calculateClinchStatusesForGroup(
        teams,
        { maxMatches: 10, quarterfinal: 1, playin: 2, relegation: 0 },
        season,
        'cascade',
        {},
        matches,
        'Test League'
    );

    assert.equal(result[0]._clinchStatus.scenarioAnalysis.status, 'complete');
    assert.equal(result[0]._clinchStatus.scenarioAnalysis.earlyTerminated, true);
    assert.ok(result[0]._clinchStatus.scenarioAnalysis.nodesVisited < 1000);
    assert.deepEqual(
        [result[0]._clinchStatus.minRank, result[0]._clinchStatus.maxRank],
        [1, 2]
    );
});

test('simulates a four-team league across playoff and relegation zones', () => {
    const modelSeason = 'model-season';
    const modelTeam = (id, name, points, wins, losses, gf, ga) => ({
        id,
        name,
        stats: {
            [modelSeason]: { points, wins, losses, gf, ga }
        }
    });
    const teams = [
        modelTeam(1, 'A', 6, 2, 0, 6, 2),
        modelTeam(2, 'B', 0, 0, 1, 1, 3),
        modelTeam(3, 'C', 0, 0, 1, 1, 3),
        modelTeam(4, 'D', 0, 0, 0, 0, 0)
    ];
    const matches = [
        {
            season: modelSeason,
            liga: 'Model League',
            homeTeamId: 1,
            awayTeamId: 2,
            result: { scoreHome: 3, scoreAway: 1, ot: false }
        },
        {
            season: modelSeason,
            liga: 'Model League',
            homeTeamId: 1,
            awayTeamId: 3,
            result: { scoreHome: 3, scoreAway: 1, ot: false }
        },
        { season: modelSeason, liga: 'Model League', homeTeamId: 3, awayTeamId: 4 },
        { season: modelSeason, liga: 'Model League', homeTeamId: 4, awayTeamId: 2 }
    ];
    const result = calculateClinchStatusesForGroup(
        teams,
        {
            maxMatches: 4,
            quarterfinal: 2,
            playin: 3,
            relegation: 1,
            tiebreakerPriority: 'h2h'
        },
        modelSeason,
        'cascade',
        {},
        matches,
        'Model League'
    );
    const [teamA, teamB, teamC, teamD] = result.map(item => item._clinchStatus);

    assert.ok(result.every(item => item._clinchStatus.scheduleComplete));
    assert.ok(result.every(item => item._clinchStatus.scenarioAnalysis.status === 'complete'));
    assert.ok(result.every(item => item._clinchStatus.scenarioAnalysis.scenarios > 0));
    assert.equal(teamA.clinchedQF, true);
    assert.deepEqual([teamA.minRank, teamA.maxRank], [1, 2]);
    assert.equal(teamA.lockedZone, true);
    assert.equal(teamB.clinchedQF, false);
    assert.equal(teamC.clinchedQF, false);
    assert.equal(teamD.clinchedRelegation, false);
    assert.deepEqual([teamD.minRank, teamD.maxRank], [1, 4]);
});

test('simulates a 14-team league with 13 remaining fixtures', () => {
    const model = buildModelLeague();
    const remainingMatches = model.matches.filter(match => !match.result);
    const remainingGamesPerTeam = new Map(model.teams.map(team => [team.id, 0]));
    remainingMatches.forEach(match => {
        remainingGamesPerTeam.set(match.homeTeamId, remainingGamesPerTeam.get(match.homeTeamId) + 1);
        remainingGamesPerTeam.set(match.awayTeamId, remainingGamesPerTeam.get(match.awayTeamId) + 1);
    });
    const rankedTeams = [...model.teams].sort((a, b) => (
        b.stats[model.season].points - a.stats[model.season].points || a.id - b.id
    ));
    const statuses = calculateClinchStatusesForGroup(
        rankedTeams,
        model.league,
        model.season,
        'cascade',
        {},
        model.matches,
        model.leagueName
    );

    assert.equal(model.matches.length, 364);
    assert.equal(model.matches.filter(match => !match.result).length, 13);
    assert.ok([...remainingGamesPerTeam.values()].every(count => count >= 1 && count <= 2));
    assert.equal([...remainingGamesPerTeam.values()].filter(count => count === 2).length, 12);
    assert.ok(statuses.every(team => team._clinchStatus.scheduleComplete));
    assert.ok(statuses.every(team => team._clinchStatus.scenarioAnalysis.status === 'complete'));
    assert.ok(statuses.every(team => team._clinchStatus.minRank >= 1));
    assert.ok(statuses.every(team => team._clinchStatus.maxRank <= 14));
    const statusById = new Map(statuses.map(team => [team.id, team._clinchStatus]));
    assert.equal(statusById.get(1).clinchedQF, true);
    assert.equal(statusById.get(14).clinchedRelegation, true);
    assert.deepEqual([statusById.get(1).minRank, statusById.get(1).maxRank], [1, 1]);
    assert.deepEqual([statusById.get(14).minRank, statusById.get(14).maxRank], [14, 14]);
});

test('preserves the shared result constraint when two contenders play each other', () => {
    const teams = [
        team(1, 6, { wins: 2, losses: 0 }),
        team(2, 5, { wins: 1, losses: 0 }),
        team(3, 5, { wins: 1, losses: 0 })
    ];
    const matches = [
        { ...completedMatch(1, 2, 3, 0), result: { scoreHome: 3, scoreAway: 0, ot: false } },
        { ...completedMatch(1, 3, 3, 0), result: { scoreHome: 3, scoreAway: 0, ot: false } },
        { season, liga: 'Test League', homeTeamId: 2, awayTeamId: 3 }
    ];
    const result = calculateClinchStatusesForGroup(
        teams,
        { maxMatches: 3, quarterfinal: 1, playin: 2, relegation: 0 },
        season,
        'cascade',
        {},
        matches,
        'Test League'
    );

    assert.equal(result[0]._clinchStatus.scenarioAnalysis.status, 'complete');
    assert.deepEqual(
        [result[0]._clinchStatus.minRank, result[0]._clinchStatus.maxRank],
        [2, 2]
    );
});

test('marks guaranteed play-off participation in cascade mode while strict mode requires a locked zone', () => {
    const teams = [team(1, 0, { wins: 0, losses: 0 }), team(2, 0, { wins: 0, losses: 0 })];
    const matches = [{ season, liga: 'Test League', homeTeamId: 1, awayTeamId: 2 }];
    const league = { maxMatches: 1, quarterfinal: 1, playin: 2, relegation: 0 };
    const cascade = calculateClinchStatusesForGroup(
        teams, league, season, 'cascade', {}, matches, 'Test League'
    );
    const strict = calculateClinchStatusesForGroup(
        teams, league, season, 'strict', {}, matches, 'Test League'
    );

    assert.deepEqual(
        [cascade[0]._clinchStatus.minRank, cascade[0]._clinchStatus.maxRank],
        [1, 2]
    );
    assert.equal(cascade[0]._clinchStatus.clinchedQF, false);
    assert.equal(cascade[0]._clinchStatus.clinchedPlayin, true);
    assert.equal(strict[0]._clinchStatus.clinchedPlayin, false);
});

test('marks guaranteed safety in cascade mode when a team may still reach play-offs', () => {
    const teams = [team(1, 0, { wins: 0, losses: 0 }), team(2, 0, { wins: 0, losses: 0 })];
    const matches = [{ season, liga: 'Test League', homeTeamId: 1, awayTeamId: 2 }];
    const league = { maxMatches: 1, quarterfinal: 1, playin: 1, relegation: 0 };
    const cascade = calculateClinchStatusesForGroup(
        teams, league, season, 'cascade', {}, matches, 'Test League'
    );
    const strict = calculateClinchStatusesForGroup(
        teams, league, season, 'strict', {}, matches, 'Test League'
    );

    assert.equal(cascade[0]._clinchStatus.clinchedNeutral, true);
    assert.equal(strict[0]._clinchStatus.clinchedNeutral, false);
});

test('uses the same cascade and strict zone semantics for cross-group standings', () => {
    const teams = [team(1, 0, { wins: 0, losses: 0 }), team(2, 0, { wins: 0, losses: 0 })];
    const matches = [{ season, liga: 'Test League', homeTeamId: 1, awayTeamId: 2 }];
    const calculate = clinchMode => calculateCrossGroupClinchStatuses(teams, {
        season,
        leagueObj: { maxMatches: 1 },
        matches,
        liga: 'Test League',
        quarterfinal: 1,
        advancing: 2,
        relegation: 0,
        clinchMode,
        isRegularSeasonFinished: false,
        estimateTeamCount: teams.length,
        scores: {}
    });

    const cascade = calculate('cascade');
    const strict = calculate('strict');

    assert.equal(cascade[0]._clinchStatus.clinchedPlayin, true);
    assert.equal(strict[0]._clinchStatus.clinchedPlayin, false);
});

test('keeps the neutral rank before the relegation rank', () => {
    const teams = [
        team(1, 9, { wins: 3, losses: 0 }),
        team(2, 6, { wins: 2, losses: 1 }),
        team(3, 3, { wins: 1, losses: 2 }),
        team(4, 0, { wins: 0, losses: 3 })
    ];
    const matches = [];
    for (let homeTeamId = 1; homeTeamId <= teams.length; homeTeamId++) {
        for (let awayTeamId = homeTeamId + 1; awayTeamId <= teams.length; awayTeamId++) {
            matches.push(completedMatch(homeTeamId, awayTeamId, 3, 0));
        }
    }

    const result = calculateClinchStatusesForGroup(
        teams,
        { maxMatches: matches.length, quarterfinal: 1, playin: 2, relegation: 1 },
        season,
        'cascade',
        {},
        matches,
        'Test League'
    );

    assert.equal(result[2]._clinchStatus.minRank, 3);
    assert.equal(result[2]._clinchStatus.clinchedNeutral, true);
    assert.equal(result[2]._clinchStatus.clinchedRelegation, false);
    assert.equal(result[3]._clinchStatus.minRank, 4);
    assert.equal(result[3]._clinchStatus.clinchedRelegation, true);
});

test('keeps the cross-group neutral rank before the relegation rank', () => {
    const teams = [
        team(1, 9, { wins: 3, losses: 0 }),
        team(2, 6, { wins: 2, losses: 1 }),
        team(3, 3, { wins: 1, losses: 2 }),
        team(4, 0, { wins: 0, losses: 3 })
    ];
    const matches = [];
    for (let homeTeamId = 1; homeTeamId <= teams.length; homeTeamId++) {
        for (let awayTeamId = homeTeamId + 1; awayTeamId <= teams.length; awayTeamId++) {
            matches.push(completedMatch(homeTeamId, awayTeamId, 3, 0));
        }
    }

    const result = calculateCrossGroupClinchStatuses(teams, {
        season,
        leagueObj: { maxMatches: matches.length },
        matches,
        liga: 'Test League',
        quarterfinal: 1,
        advancing: 2,
        relegation: 1,
        clinchMode: 'cascade',
        isRegularSeasonFinished: true,
        estimateTeamCount: teams.length,
        scores: {}
    });

    assert.equal(result[2]._clinchStatus.minRank, 3);
    assert.equal(result[2]._clinchStatus.clinchedNeutral, true);
    assert.equal(result[2]._clinchStatus.clinchedRelegation, false);
    assert.equal(result[3]._clinchStatus.minRank, 4);
    assert.equal(result[3]._clinchStatus.clinchedRelegation, true);
});

test('balances remaining fixtures across a model league', () => {
    const fixtures = [];
    for (let home = 1; home <= 14; home++) {
        for (let away = home + 1; away <= 14; away++) {
            for (let meeting = 0; meeting < 4; meeting++) {
                fixtures.push({
                    id: fixtures.length + 1,
                    homeTeamId: meeting % 2 ? away : home,
                    awayTeamId: meeting % 2 ? home : away
                });
            }
        }
    }
    const remainingIds = selectBalancedRemainingFixtures(fixtures, 13);
    const counts = new Map(Array.from({ length: 14 }, (_, index) => [index + 1, 0]));
    fixtures.filter(fixture => remainingIds.has(fixture.id)).forEach(fixture => {
        counts.set(fixture.homeTeamId, counts.get(fixture.homeTeamId) + 1);
        counts.set(fixture.awayTeamId, counts.get(fixture.awayTeamId) + 1);
    });

    assert.equal(remainingIds.size, 13);
    assert.ok([...counts.values()].every(count => count >= 1 && count <= 2));
    assert.equal([...counts.values()].filter(count => count === 2).length, 12);
});
