const assert = require('node:assert/strict');
const test = require('node:test');

const {
    getStandingsCriteria,
    normalizeStandingsCriteria,
    copyStandingsRules,
    rankTeams
} = require('../utils/standings');

function team(id, stats) {
    return { id, stats: { season: stats } };
}

function match(homeTeamId, awayTeamId, scoreHome, scoreAway, options = {}) {
    return {
        season: 'season',
        liga: 'league',
        homeTeamId,
        awayTeamId,
        result: { scoreHome, scoreAway, ot: options.overtime || false }
    };
}

test('applies criteria in order and recalculates the mini-table for the remaining tied teams', () => {
    const teams = [
        team(1, { points: 10, tiebreaker: 0 }),
        team(2, { points: 10, tiebreaker: 0 }),
        team(3, { points: 10, tiebreaker: 0 }),
        team(4, { points: 10, tiebreaker: 0 })
    ];
    const matches = [
        match(1, 2, 3, 0),
        match(1, 3, 3, 0),
        match(1, 4, 3, 0),
        match(2, 3, 4, 0),
        match(3, 4, 3, 0),
        match(4, 2, 4, 0)
    ];

    const ranked = rankTeams(teams, {
        season: 'season',
        liga: 'league',
        matches,
        criteria: ['points', 'headToHeadPoints', 'headToHeadGoalDifference', 'goalDifference']
    });

    assert.deepEqual(ranked.map(entry => entry.id), [1, 4, 2, 3]);
});

test('supports configurable regulation wins and other generic criteria', () => {
    const teams = [
        team(1, { points: 9, regulationWins: 2, gf: 9, ga: 3 }),
        team(2, { points: 9, regulationWins: 3, gf: 8, ga: 4 })
    ];

    const ranked = rankTeams(teams, {
        season: 'season',
        criteria: ['points', 'regulationWins', 'goalDifference', 'goalsFor']
    });

    assert.deepEqual(ranked.map(entry => entry.id), [2, 1]);
});

test('supports phase-specific rule lists and preserves the legacy default', () => {
    assert.deepEqual(
        getStandingsCriteria({
            standingsRules: {
                group: { criteria: ['points', 'regulationWins'] },
                groupInProgress: ['points', 'goalDifference', 'goalsFor']
            }
        }),
        ['points', 'regulationWins']
    );
    assert.deepEqual(
        getStandingsCriteria({
            standingsRules: {
                group: ['points', 'headToHeadPoints'],
                groupInProgress: ['points', 'goalDifference', 'goalsFor']
            }
        }, 'groupInProgress'),
        ['points', 'goalDifference', 'goalsFor']
    );
    assert.deepEqual(
        getStandingsCriteria({
            standingsRules: { group: ['points', 'headToHeadPoints'] }
        }, 'groupInProgress'),
        ['points', 'headToHeadPoints']
    );
    assert.ok(getStandingsCriteria({ tiebreakerPriority: 'goalDiff' }).includes('goalDifference'));
    assert.ok(getStandingsCriteria({}).includes('headToHeadPoints'));
});

test('supports group rank as the leading cross-group criterion', () => {
    const teams = [
        { ...team(1, { points: 12 }), groupRank: 2 },
        { ...team(2, { points: 8 }), groupRank: 1 }
    ];

    const ranked = rankTeams(teams, {
        season: 'season',
        criteria: ['groupRank', 'points', 'goalDifference']
    });

    assert.deepEqual(ranked.map(entry => entry.id), [2, 1]);
    assert.deepEqual(
        getStandingsCriteria({
            standingsRules: {
                crossGroup: ['groupRank', 'points', 'goalDifference']
            }
        }, 'crossGroup'),
        ['groupRank', 'points', 'goalDifference']
    );
});

test('sorts missing seeding after valid seeding and keeps zero penalty minutes valid', () => {
    const teams = [
        team(1, { points: 10, seeding: 0, penaltyMinutes: 5 }),
        team(2, { points: 10, seeding: 5, penaltyMinutes: 0 }),
        team(3, { points: 10, seeding: null, penaltyMinutes: 10 }),
        team(4, { points: 10, seeding: 1 })
    ];

    assert.deepEqual(
        rankTeams(teams, {
            season: 'season',
            criteria: ['points', 'seeding']
        }).map(entry => entry.id),
        [4, 2, 1, 3]
    );
    assert.deepEqual(
        rankTeams(teams, {
            season: 'season',
            criteria: ['points', 'penaltyMinutes']
        }).map(entry => entry.id),
        [2, 1, 3, 4]
    );
});

test('counts overtime wins in total wins but not regulation wins', () => {
    const teams = [
        team(1, { points: 9, wins: 3, otWins: 0, regulationWins: 3 }),
        team(2, { points: 9, wins: 2, otWins: 2, regulationWins: 2 })
    ];

    assert.deepEqual(
        rankTeams(teams, {
            season: 'season',
            criteria: ['points', 'wins']
        }).map(entry => entry.id),
        [2, 1]
    );
    assert.deepEqual(
        rankTeams(teams, {
            season: 'season',
            criteria: ['points', 'regulationWins']
        }).map(entry => entry.id),
        [1, 2]
    );
});

test('validates configurable criteria and required leading rules', () => {
    assert.deepEqual(
        normalizeStandingsCriteria(
            ['points', 'headToHeadPoints', 'seeding'],
            'group'
        ),
        ['points', 'headToHeadPoints', 'seeding']
    );
    assert.deepEqual(
        normalizeStandingsCriteria(
            ['groupRank', 'points', 'goalDifference'],
            'crossGroup'
        ),
        ['groupRank', 'points', 'goalDifference']
    );
    assert.throws(
        () => normalizeStandingsCriteria(['goalDifference', 'points'], 'group'),
        /začínat body/
    );
    assert.throws(
        () => normalizeStandingsCriteria(['points', 'points'], 'group'),
        /pouze jednou/
    );
    assert.throws(
        () => normalizeStandingsCriteria(['points', 'groupRank'], 'group'),
        /pouze pro křížovou/
    );
    assert.throws(
        () => normalizeStandingsCriteria(['points', 'unknown'], 'group'),
        /nepodporované kritérium/
    );
});

test('copies standings rules to a new season without sharing nested objects', () => {
    const source = {
        name: 'TELH',
        standingsRules: {
            group: ['points', 'headToHeadPoints'],
            groupInProgress: ['points', 'goalDifference']
        }
    };
    const target = copyStandingsRules(source, { name: 'TELH', maxMatches: 364 });

    assert.deepEqual(target, {
        name: 'TELH',
        maxMatches: 364,
        standingsRules: source.standingsRules
    });
    target.standingsRules.group.push('seeding');
    assert.deepEqual(source.standingsRules.group, ['points', 'headToHeadPoints']);

    assert.deepEqual(
        copyStandingsRules({ name: 'TELH' }, target),
        { name: 'TELH', maxMatches: 364 }
    );
});

test('fails explicitly for unknown criteria instead of silently assigning a rank', () => {
    assert.throws(
        () => rankTeams([team(1, { points: 1 }), team(2, { points: 1 })], {
            season: 'season',
            criteria: ['points', 'futureRule']
        }),
        /Unsupported standings criterion: futureRule/
    );
});
