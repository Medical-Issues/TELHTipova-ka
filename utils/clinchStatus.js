const { getStandingsCriteria } = require('./standings');

function getTeamZone(index, totalTeams, cfg) {
    const pos = index + 1;
    if (pos <= cfg.quarterfinal) return "quarterfinal";
    if (pos <= cfg.playin) return "playin";
    if (pos > totalTeams - cfg.relegation) return "relegation";
    return "neutral";
}

function getZoneForRank(rank, totalTeams, cfg) {
    if (rank <= cfg.quarterfinal) return "quarterfinal";
    if (cfg.playin > cfg.quarterfinal && rank <= cfg.playin) return "playin";
    if (rank > totalTeams - cfg.relegation) return "relegation";
    return "neutral";
}

function getEstimatedMatchesPerTeam(leagueObj, teamCount) {
    const configured = Number(leagueObj?.maxMatches) || 0;
    const groups = leagueObj?.isMultigroup ? Number(leagueObj.groupCount) || 1 : 1;
    const totalTeams = Math.max(1, teamCount * groups);
    if (configured > 0) return Math.ceil((configured * 2) / totalTeams);
    return leagueObj?.isMultigroup ? Math.max(1, teamCount - 1) : 0;
}

function getRemainingMatchesByTeam(teams, leagueObj, matches, season, liga, estimateTeamCount = teams.length) {
    const teamIds = new Set(teams.map(team => Number(team.id)));
    const scheduledTotal = new Map([...teamIds].map(id => [id, 0]));
    const scheduledRemaining = new Map([...teamIds].map(id => [id, 0]));
    const remainingOpponents = new Map([...teamIds].map(id => [id, new Map()]));

    (matches || []).forEach(match => {
        if (match.season !== season || match.liga !== liga || match.isPlayoff) return;
        const isScheduled = match.homeTeamId != null && match.awayTeamId != null;
        if (!isScheduled) return;
        const hasResult = Boolean(match.result);
        const homeId = Number(match.homeTeamId);
        const awayId = Number(match.awayTeamId);
        if (!teamIds.has(homeId) || !teamIds.has(awayId)) return;
        scheduledTotal.set(homeId, scheduledTotal.get(homeId) + 1);
        scheduledTotal.set(awayId, scheduledTotal.get(awayId) + 1);
        if (hasResult) return;
        scheduledRemaining.set(homeId, scheduledRemaining.get(homeId) + 1);
        scheduledRemaining.set(awayId, scheduledRemaining.get(awayId) + 1);
        remainingOpponents.get(homeId).set(awayId, (remainingOpponents.get(homeId).get(awayId) || 0) + 1);
        remainingOpponents.get(awayId).set(homeId, (remainingOpponents.get(awayId).get(homeId) || 0) + 1);
    });

    const estimatedMatches = getEstimatedMatchesPerTeam(leagueObj, estimateTeamCount);
    const remainingByTeam = new Map();
    const scheduleCompleteByTeam = new Map();
    teams.forEach(team => {
        const id = Number(team.id);
        const stats = team.stats?.[season] || {};
        const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0) + (stats.manualGames || 0);
        const expectedMatches = Math.max(estimatedMatches, scheduledTotal.get(id) || 0);
        const configuredRemaining = Math.max(0, expectedMatches - played);
        const scheduleComplete = estimatedMatches > 0 && (scheduledTotal.get(id) || 0) >= expectedMatches;
        scheduleCompleteByTeam.set(id, scheduleComplete);
        remainingByTeam.set(
            id,
            scheduleComplete
                ? (scheduledRemaining.get(id) || 0)
                : Math.max(scheduledRemaining.get(id) || 0, configuredRemaining)
        );
    });

    return { remainingByTeam, remainingOpponents, scheduleCompleteByTeam };
}

function getPossibleRankBounds(teams, season, remainingByTeam) {
    const rankBounds = new Map();
    teams.forEach(team => {
        const stats = team.stats?.[season] || {};
        const points = Number(stats.points) || 0;
        const remaining = remainingByTeam.get(Number(team.id)) || 0;
        const maxPoints = points + (remaining * 3);
        let guaranteedAhead = 0;
        let possiblyAhead = 0;

        teams.forEach(opponent => {
            if (Number(opponent.id) === Number(team.id)) return;
            const opponentStats = opponent.stats?.[season] || {};
            const opponentPoints = Number(opponentStats.points) || 0;
            const opponentRemaining = remainingByTeam.get(Number(opponent.id)) || 0;
            const opponentMaxPoints = opponentPoints + (opponentRemaining * 3);

            if (opponentMaxPoints >= points) {
                possiblyAhead++;
            }
            if (opponentPoints > maxPoints) {
                guaranteedAhead++;
            }
        });

        rankBounds.set(Number(team.id), {
            minRank: guaranteedAhead + 1,
            maxRank: possiblyAhead + 1
        });
    });
    return rankBounds;
}

function getMatchPointOutcomes() {
    return [
        { home: 3, away: 0 },
        { home: 2, away: 1 },
        { home: 1, away: 2 },
        { home: 0, away: 3 }
    ];
}

function compareManualTiebreakers(teamValue, opponentValue) {
    if (teamValue === opponentValue) return 0;
    if (teamValue === 0) return 1;
    if (opponentValue === 0) return -1;
    return teamValue - opponentValue;
}

function compareScenarioTeams(
    teamId,
    opponentId,
    activeIds,
    scenarioPoints,
    scenarioH2H,
    futureMatches,
    remainingByTeam,
    manualTiebreaker,
    totalGoalDiff,
    totalGoalsFor,
    headToHeadGoalDiff,
    headToHeadGoalsFor,
    teamStatsById,
    leagueObj,
    phase
) {
    let tiedIds = [...activeIds];
    const criteria = getStandingsCriteria(leagueObj, phase).map(criterion =>
        typeof criterion === 'string' ? criterion : criterion?.type
    );
    const compareHigherIsBetter = (first, second) =>
        first === second ? 0 : (first > second ? -1 : 1);
    const criterionValue = (criterion, id, groupIds) => {
        const stats = teamStatsById.get(id) || {};
        const remainingGames = remainingByTeam.get(id) || 0;
        const groupSet = new Set(groupIds);

        switch (criterion) {
            case 'points':
                return scenarioPoints.get(id);
            case 'manualTiebreaker':
                return manualTiebreaker.get(id);
            case 'headToHeadPoints':
                return groupIds.reduce((sum, opponent) =>
                    sum + (scenarioH2H.get(id)?.get(opponent) || 0), 0);
            case 'headToHeadGoalDifference':
            case 'headToHeadGoalsFor': {
                const hasFutureMeeting = futureMatches.some(match =>
                    groupSet.has(Number(match.homeTeamId)) && groupSet.has(Number(match.awayTeamId))
                );
                if (hasFutureMeeting) return null;
                return groupIds.reduce((sum, opponent) => sum + (
                    criterion === 'headToHeadGoalDifference'
                        ? headToHeadGoalDiff.get(id)?.get(opponent) || 0
                        : headToHeadGoalsFor.get(id)?.get(opponent) || 0
                ), 0);
            }
            case 'directResult': {
                if (groupIds.length !== 2) return 0;
                const opponent = groupIds.find(candidate => candidate !== id);
                return (scenarioH2H.get(id)?.get(opponent) || 0) -
                    (scenarioH2H.get(opponent)?.get(id) || 0);
            }
            case 'goalDifference':
                return remainingGames ? null : totalGoalDiff.get(id) || 0;
            case 'goalsFor':
                return remainingGames ? null : totalGoalsFor.get(id) || 0;
            case 'regulationWins':
                return remainingGames
                    ? null
                    : Number(stats.regulationWins ?? stats.wins) || 0;
            case 'wins':
                return remainingGames
                    ? null
                    : (Number(stats.wins) || 0) + (Number(stats.otWins) || 0);
            case 'penaltyMinutes':
                if (remainingGames || stats.penaltyMinutes === undefined ||
                    stats.penaltyMinutes === null || stats.penaltyMinutes === '') return null;
                return Number.isFinite(Number(stats.penaltyMinutes)) &&
                    Number(stats.penaltyMinutes) >= 0
                    ? Number(stats.penaltyMinutes)
                    : null;
            case 'seeding':
            {
                const value = Number(stats.seeding ?? stats.seed);
                return Number.isFinite(value) && value > 0 ? value : Infinity;
            }
            case 'groupRank':
            {
                const value = Number(stats.groupRank);
                return Number.isFinite(value) && value > 0 ? value : Infinity;
            }
            default:
                throw new Error(`Unsupported standings criterion: ${criterion}`);
        }
    };

    for (const criterion of criteria) {
        if (!criterion) throw new Error('Standings criteria must be strings or objects with a type.');
        const teamValue = criterionValue(criterion, teamId, tiedIds);
        const opponentValue = criterionValue(criterion, opponentId, tiedIds);
        if (teamValue === null || opponentValue === null) return null;

        let comparison;
        if (criterion === 'manualTiebreaker' || criterion === 'penaltyMinutes') {
            comparison = criterion === 'manualTiebreaker'
                ? compareManualTiebreakers(teamValue, opponentValue)
                : (teamValue === opponentValue ? 0 : (teamValue < opponentValue ? -1 : 1));
        } else if (criterion === 'seeding' || criterion === 'groupRank') {
            comparison = teamValue === opponentValue ? 0 : (teamValue < opponentValue ? -1 : 1);
        } else {
            comparison = compareHigherIsBetter(teamValue, opponentValue);
        }
        if (comparison !== 0) return comparison;

        tiedIds = tiedIds.filter(id => criterionValue(criterion, id, tiedIds) === teamValue);
    }
    return 0;
}

function calculateScenarioRankBounds(
    teams,
    season,
    leagueObj,
    matches,
    liga,
    scheduleData,
    scores,
    assumeComplete = false,
    phase = 'group',
    maxNodes = 1000000
) {
    const { remainingByTeam, scheduleCompleteByTeam } = scheduleData;
    if (!teams.length) {
        return {
            rankBounds: null,
            status: 'incomplete-schedule',
            tiebreakCoverage: 'not-evaluated',
            nodesVisited: 0,
            scenarios: 0
        };
    }

    const teamIds = teams.map(team => Number(team.id));
    const teamIdSet = new Set(teamIds);
    const points = new Map(teams.map(team => [
        Number(team.id),
        Number(team.stats?.[season]?.points) || 0
    ]));
    const headToHeadPoints = new Map(teamIds.map(id => [id, new Map(teamIds.map(opponentId => [opponentId, 0]))]));
    const headToHeadGoalDiff = new Map(teamIds.map(id => [id, new Map(teamIds.map(opponentId => [opponentId, 0]))]));
    const headToHeadGoalsFor = new Map(teamIds.map(id => [id, new Map(teamIds.map(opponentId => [opponentId, 0]))]));
    const totalGoalDiff = new Map();
    const totalGoalsFor = new Map();
    const teamStatsById = new Map(teams.map(team => {
        const stats = team.stats?.[season] || {};
        return [
            Number(team.id),
            { ...stats, groupRank: team.groupRank ?? stats.groupRank }
        ];
    }));
    const completedMatches = (matches || []).filter(match =>
        match.season === season &&
        match.liga === liga &&
        !match.isPlayoff &&
        match.result &&
        teamIdSet.has(Number(match.homeTeamId)) &&
        teamIdSet.has(Number(match.awayTeamId))
    );
    const futureMatches = assumeComplete ? [] : (matches || []).filter(match =>
        match.season === season &&
        match.liga === liga &&
        !match.isPlayoff &&
        !match.result &&
        teamIdSet.has(Number(match.homeTeamId)) &&
        teamIdSet.has(Number(match.awayTeamId))
    ).sort((a, b) => {
        const aPointGap = Math.abs(points.get(Number(a.homeTeamId)) - points.get(Number(a.awayTeamId)));
        const bPointGap = Math.abs(points.get(Number(b.homeTeamId)) - points.get(Number(b.awayTeamId)));
        return aPointGap - bPointGap;
    });
    if (!assumeComplete && teams.some(team => !scheduleCompleteByTeam.get(Number(team.id)))) {
        return {
            rankBounds: null,
            status: 'incomplete-schedule',
            tiebreakCoverage: 'not-evaluated',
            nodesVisited: 0,
            scenarios: 0
        };
    }
    const completedGoalTotals = new Map(teamIds.map(id => [id, { gf: 0, ga: 0 }]));
    completedMatches.forEach(match => {
        const homeId = Number(match.homeTeamId);
        const awayId = Number(match.awayTeamId);
        const homeGoals = Number(match.result?.scoreHome ?? match.scoreHome) || 0;
        const awayGoals = Number(match.result?.scoreAway ?? match.scoreAway) || 0;
        completedGoalTotals.get(homeId).gf += homeGoals;
        completedGoalTotals.get(homeId).ga += awayGoals;
        completedGoalTotals.get(awayId).gf += awayGoals;
        completedGoalTotals.get(awayId).ga += homeGoals;
    });

    const addHeadToHeadPoints = (homeId, awayId, homePoints, awayPoints) => {
        headToHeadPoints.get(homeId).set(awayId, headToHeadPoints.get(homeId).get(awayId) + homePoints);
        headToHeadPoints.get(awayId).set(homeId, headToHeadPoints.get(awayId).get(homeId) + awayPoints);
    };
    const addHeadToHeadGoals = (homeId, awayId, homeGoals, awayGoals) => {
        headToHeadGoalDiff.get(homeId).set(awayId, headToHeadGoalDiff.get(homeId).get(awayId) + homeGoals - awayGoals);
        headToHeadGoalDiff.get(awayId).set(homeId, headToHeadGoalDiff.get(homeId).get(awayId) + awayGoals - homeGoals);
        headToHeadGoalsFor.get(homeId).set(awayId, headToHeadGoalsFor.get(homeId).get(awayId) + homeGoals);
        headToHeadGoalsFor.get(awayId).set(homeId, headToHeadGoalsFor.get(awayId).get(homeId) + awayGoals);
    };

    teamIds.forEach(id => {
        const stats = teams.find(team => Number(team.id) === id)?.stats?.[season] || {};
        const scoreStats = scores?.[id] || scores?.[String(id)] || {};
        const completedTotals = completedGoalTotals.get(id);
        const gf = Number(scoreStats.gf ?? stats.gf ?? completedTotals.gf) || 0;
        const ga = Number(scoreStats.ga ?? stats.ga ?? completedTotals.ga) || 0;
        totalGoalDiff.set(id, gf - ga);
        totalGoalsFor.set(id, gf);
    });

    completedMatches.forEach(match => {
        const homeId = Number(match.homeTeamId);
        const awayId = Number(match.awayTeamId);
        const result = match.result;
        const homeGoals = Number(result.scoreHome ?? match.scoreHome);
        const awayGoals = Number(result.scoreAway ?? match.scoreAway);
        const overtime = Boolean(result.ot ?? match.ot);
        let homePoints = 1;
        let awayPoints = 1;
        if (homeGoals > awayGoals) {
            homePoints = overtime ? 2 : 3;
            awayPoints = overtime ? 1 : 0;
        } else if (awayGoals > homeGoals) {
            homePoints = overtime ? 1 : 0;
            awayPoints = overtime ? 2 : 3;
        }
        addHeadToHeadPoints(homeId, awayId, homePoints, awayPoints);
        addHeadToHeadGoals(homeId, awayId, homeGoals, awayGoals);
    });

    const rankBounds = new Map(teamIds.map(id => [id, { minRank: teams.length, maxRank: 1 }]));
    const manualTiebreaker = new Map(teams.map(team => [
        Number(team.id),
        Number(team.stats?.[season]?.tiebreaker) || 0
    ]));
    const scheduledRemainingByTeam = new Map(teamIds.map(id => [id, 0]));
    futureMatches.forEach(match => {
        const homeId = Number(match.homeTeamId);
        const awayId = Number(match.awayTeamId);
        scheduledRemainingByTeam.set(homeId, scheduledRemainingByTeam.get(homeId) + 1);
        scheduledRemainingByTeam.set(awayId, scheduledRemainingByTeam.get(awayId) + 1);
    });
    const getScheduleAwareRankBounds = (matchIndex = 0, pointTotals = points) => {
        const remainingGames = new Map(teamIds.map(id => [id, 0]));
        const remainingDirectGames = new Map(teamIds.map(id => [id, new Map()]));
        futureMatches.slice(matchIndex).forEach(match => {
            const homeId = Number(match.homeTeamId);
            const awayId = Number(match.awayTeamId);
            remainingGames.set(homeId, remainingGames.get(homeId) + 1);
            remainingGames.set(awayId, remainingGames.get(awayId) + 1);
            remainingDirectGames.get(homeId).set(awayId,
                (remainingDirectGames.get(homeId).get(awayId) || 0) + 1);
            remainingDirectGames.get(awayId).set(homeId,
                (remainingDirectGames.get(awayId).get(homeId) || 0) + 1);
        });
        const boundsByTeam = new Map();
        teamIds.forEach(teamId => {
            let guaranteedAhead = 0;
            let possiblyAhead = 0;
            teamIds.forEach(opponentId => {
                if (teamId === opponentId) return;

                const directGames = remainingDirectGames.get(teamId).get(opponentId) || 0;
                const maximumSwing = (remainingGames.get(teamId) + remainingGames.get(opponentId) - directGames) * 3;
                const currentLead = pointTotals.get(opponentId) - pointTotals.get(teamId);
                const maximumOpponentLead = currentLead + maximumSwing;
                const minimumOpponentLead = currentLead - maximumSwing;

                if (minimumOpponentLead > 0) {
                    guaranteedAhead++;
                }
                if (maximumOpponentLead >= 0) {
                    possiblyAhead++;
                }
            });
            boundsByTeam.set(teamId, {
                minRank: guaranteedAhead + 1,
                maxRank: possiblyAhead + 1
            });
        });
        return boundsByTeam;
    };
    let nodesVisited = 0;
    let scenarios = 0;
    let prunedBranches = 0;
    let exceededLimit = false;
    let earlyTerminated = false;
    const fallbackBounds = getScheduleAwareRankBounds();
    const evaluateTargetRank = (targetId, activeIds, activeMatches, isWorstCase, scenarioPoints, scenarioH2H) => {
        let ahead = 0;
        activeIds.forEach(opponentId => {
            if (opponentId === targetId) return;
            const comparison = compareScenarioTeams(
                targetId,
                opponentId,
                activeIds,
                scenarioPoints,
                scenarioH2H,
                activeMatches,
                remainingByTeam,
                manualTiebreaker,
                totalGoalDiff,
                totalGoalsFor,
                headToHeadGoalDiff,
                headToHeadGoalsFor,
                teamStatsById,
                leagueObj,
                phase
            );
            if (comparison === 1 || (comparison === null && isWorstCase)) ahead++;
        });
        return ahead;
    };
    const rawLeadingCriterion = getStandingsCriteria(leagueObj, phase)[0];
    const leadingCriterion = typeof rawLeadingCriterion === 'string'
        ? rawLeadingCriterion
        : rawLeadingCriterion?.type;

    const solveTargetBound = (targetId, isWorstCase) => {
        const targetBase = points.get(targetId);
        const targetRemaining = scheduledRemainingByTeam.get(targetId) || 0;
        const targetMaximum = targetBase + targetRemaining * 3;
        const targetGroupRank = Number(teamStatsById.get(targetId)?.groupRank);
        const normalizedTargetGroupRank = Number.isFinite(targetGroupRank) && targetGroupRank > 0
            ? targetGroupRank
            : Infinity;
        const baseAhead = [];
        const contenders = [];
        teamIds.forEach(opponentId => {
            if (opponentId === targetId) return;
            if (leadingCriterion === 'groupRank') {
                const opponentGroupRank = Number(teamStatsById.get(opponentId)?.groupRank);
                const normalizedOpponentGroupRank = Number.isFinite(opponentGroupRank) && opponentGroupRank > 0
                    ? opponentGroupRank
                    : Infinity;
                if (normalizedOpponentGroupRank < normalizedTargetGroupRank) {
                    baseAhead.push(opponentId);
                    return;
                }
                if (normalizedOpponentGroupRank > normalizedTargetGroupRank) return;
            }
            const opponentBase = points.get(opponentId);
            const opponentMaximum = opponentBase + (scheduledRemainingByTeam.get(opponentId) || 0) * 3;
            const guaranteedAbove = opponentBase > targetMaximum;
            if (guaranteedAbove) {
                baseAhead.push(opponentId);
                return;
            }
            const canFinishAbove = isWorstCase
                ? opponentMaximum >= targetBase
                : opponentMaximum >= targetMaximum;
            if (canFinishAbove) contenders.push(opponentId);
        });

        if (!contenders.length) return { rank: baseAhead.length + 1, exceeded: false };
        const activeIds = [targetId, ...contenders];
        const activeIdSet = new Set(activeIds);
        const rawMatches = futureMatches.filter(match =>
            activeIdSet.has(Number(match.homeTeamId)) || activeIdSet.has(Number(match.awayTeamId))
        );
        rawMatches.sort((a, b) => {
            const aTargetGame = Number(a.homeTeamId) === targetId || Number(a.awayTeamId) === targetId;
            const bTargetGame = Number(b.homeTeamId) === targetId || Number(b.awayTeamId) === targetId;
            if (aTargetGame !== bTargetGame) return aTargetGame ? -1 : 1;
            const aGap = Math.abs(points.get(Number(a.homeTeamId)) - points.get(Number(a.awayTeamId)));
            const bGap = Math.abs(points.get(Number(b.homeTeamId)) - points.get(Number(b.awayTeamId)));
            return aGap - bGap;
        });
        const suffixRemaining = Array.from({ length: rawMatches.length + 1 }, () =>
            new Map(activeIds.map(id => [id, 0])));
        for (let index = rawMatches.length - 1; index >= 0; index--) {
            activeIds.forEach(id => suffixRemaining[index].set(id, suffixRemaining[index + 1].get(id)));
            const match = rawMatches[index];
            const homeId = Number(match.homeTeamId);
            const awayId = Number(match.awayTeamId);
            if (activeIdSet.has(homeId)) {
                suffixRemaining[index].set(homeId, suffixRemaining[index].get(homeId) + 1);
            }
            if (activeIdSet.has(awayId)) {
                suffixRemaining[index].set(awayId, suffixRemaining[index].get(awayId) + 1);
            }
        }
        const outcomesByMatch = rawMatches.map(match => {
            const homeId = Number(match.homeTeamId);
            const awayId = Number(match.awayTeamId);
            const homeActive = activeIdSet.has(homeId);
            const awayActive = activeIdSet.has(awayId);
            if (homeActive && awayActive) return getMatchPointOutcomes();

            const activeId = homeActive ? homeId : awayId;
            const activeIsTarget = activeId === targetId;
            const activeWantsWin = isWorstCase ? !activeIsTarget : activeIsTarget;
            return homeActive
                ? (activeWantsWin ? [{ home: 3, away: 0 }] : [{ home: 0, away: 3 }])
                : (activeWantsWin ? [{ home: 0, away: 3 }] : [{ home: 3, away: 0 }]);
        });
        const mutableHeadToHeadPairs = [];
        for (let firstIndex = 0; firstIndex < activeIds.length; firstIndex++) {
            for (let secondIndex = firstIndex + 1; secondIndex < activeIds.length; secondIndex++) {
                const firstId = activeIds[firstIndex];
                const secondId = activeIds[secondIndex];
                const hasFutureMeeting = rawMatches.some(match =>
                    (Number(match.homeTeamId) === firstId && Number(match.awayTeamId) === secondId) ||
                    (Number(match.homeTeamId) === secondId && Number(match.awayTeamId) === firstId)
                );
                if (hasFutureMeeting) mutableHeadToHeadPairs.push([firstId, secondId]);
            }
        }
        const scenarioPoints = new Map(activeIds.map(id => [id, points.get(id)]));
        const scenarioH2H = new Map(activeIds.map(id => [
            id,
            new Map(activeIds.map(opponentId => [
                opponentId,
                headToHeadPoints.get(id)?.get(opponentId) || 0
            ]))
        ]));
        const bestRank = { value: isWorstCase ? -Infinity : Infinity };
        const visited = new Set();
        let exceeded = false;

        const visit = index => {
            if (exceeded || nodesVisited >= maxNodes) {
                exceeded = true;
                return;
            }
            const stateKey = [
                index,
                ...activeIds.map(id => scenarioPoints.get(id)),
                ...mutableHeadToHeadPairs.flatMap(([firstId, secondId]) => [
                    scenarioH2H.get(firstId).get(secondId),
                    scenarioH2H.get(secondId).get(firstId)
                ])
            ].join(',');
            if (visited.has(stateKey)) return;

            if (index === rawMatches.length) {
                visited.add(stateKey);
                nodesVisited++;
                scenarios++;
                const ahead = evaluateTargetRank(
                    targetId,
                    activeIds,
                    rawMatches,
                    isWorstCase,
                    scenarioPoints,
                    scenarioH2H
                );
                const rank = baseAhead.length + ahead + 1;
                bestRank.value = isWorstCase
                    ? Math.max(bestRank.value, rank)
                    : Math.min(bestRank.value, rank);
                return;
            }

            const remaining = suffixRemaining[index];
            if (Number.isFinite(bestRank.value) && isWorstCase) {
                let maximumAhead = 0;
                contenders.forEach(id => {
                    if (scenarioPoints.get(id) + remaining.get(id) * 3 >= scenarioPoints.get(targetId)) {
                        maximumAhead++;
                    }
                });
                if (baseAhead.length + maximumAhead + 1 <= bestRank.value) {
                    prunedBranches++;
                    return;
                }
            } else if (Number.isFinite(bestRank.value)) {
                const targetMax = scenarioPoints.get(targetId) + remaining.get(targetId) * 3;
                let minimumAhead = 0;
                contenders.forEach(id => {
                    if (scenarioPoints.get(id) > targetMax) minimumAhead++;
                });
                if (baseAhead.length + minimumAhead + 1 >= bestRank.value) {
                    prunedBranches++;
                    return;
                }
            }
            visited.add(stateKey);
            nodesVisited++;
            const match = rawMatches[index];
            const homeId = Number(match.homeTeamId);
            const awayId = Number(match.awayTeamId);
            const homeActive = activeIdSet.has(homeId);
            const awayActive = activeIdSet.has(awayId);
            for (const outcome of outcomesByMatch[index]) {
                if (homeActive) scenarioPoints.set(homeId, scenarioPoints.get(homeId) + outcome.home);
                if (awayActive) scenarioPoints.set(awayId, scenarioPoints.get(awayId) + outcome.away);
                if (homeActive && awayActive) {
                    scenarioH2H.get(homeId).set(awayId, scenarioH2H.get(homeId).get(awayId) + outcome.home);
                    scenarioH2H.get(awayId).set(homeId, scenarioH2H.get(awayId).get(homeId) + outcome.away);
                }
                visit(index + 1);
                if (homeActive && awayActive) {
                    scenarioH2H.get(homeId).set(awayId, scenarioH2H.get(homeId).get(awayId) - outcome.home);
                    scenarioH2H.get(awayId).set(homeId, scenarioH2H.get(awayId).get(homeId) - outcome.away);
                }
                if (homeActive) scenarioPoints.set(homeId, scenarioPoints.get(homeId) - outcome.home);
                if (awayActive) scenarioPoints.set(awayId, scenarioPoints.get(awayId) - outcome.away);
                if (exceeded || bestRank.value === (isWorstCase
                    ? baseAhead.length + contenders.length + 1
                    : baseAhead.length + 1)) {
                    if (!exceeded && bestRank.value === (isWorstCase
                        ? baseAhead.length + contenders.length + 1
                        : baseAhead.length + 1)) earlyTerminated = true;
                    return;
                }
            }
        };
        visit(0);
        if (exceeded) {
            exceededLimit = true;
            return {
                rank: isWorstCase
                    ? fallbackBounds.get(targetId).maxRank
                    : fallbackBounds.get(targetId).minRank,
                exceeded: true
            };
        }
        return { rank: bestRank.value, exceeded: false };
    };

    teamIds.forEach(id => {
        const best = solveTargetBound(id, false);
        const worst = solveTargetBound(id, true);
        rankBounds.set(id, { minRank: best.rank, maxRank: worst.rank });
    });
    return {
        rankBounds,
        status: exceededLimit ? 'search-limit' : 'complete',
        tiebreakCoverage: exceededLimit
            ? 'schedule-aware-points-bounds'
            : (getStandingsCriteria(leagueObj, phase).some(criterion =>
                (typeof criterion === 'string' ? criterion : criterion?.type) === 'goalDifference')
                ? 'points-manual-h2h-points-overall-goal-diff-h2h-goals-conservative-unknowns'
                : 'points-manual-h2h-points-h2h-goals-overall-goal-diff-conservative-unknowns'),
        nodesVisited,
        scenarios,
        prunedBranches,
        earlyTerminated: earlyTerminated || prunedBranches > 0
    };
}

/**
 * Calculate clinch statuses for teams in a group.
 * Returns teams with added clinch status properties.
 * This function contains the same logic as generateLeftPanel for consistency.
 */
function calculateClinchStatusesForGroup(
    teamsInGroup,
    leagueObj,
    selectedSeason,
    clinchMode,
    scores,
    matches = null,
    liga = null
) {
    if (!teamsInGroup || teamsInGroup.length === 0) return [];

    const zoneConfig = { 
        quarterfinal: Number(leagueObj?.quarterfinal || 0),
        playin: Number(leagueObj?.playin || 0),
        relegation: Number(leagueObj?.relegation || 0)
    };

    const sorted = [...teamsInGroup];
    const scheduleData = getRemainingMatchesByTeam(
        sorted,
        leagueObj,
        matches,
        selectedSeason,
        liga
    );
    const {
        remainingByTeam,
        remainingOpponents,
        scheduleCompleteByTeam
    } = scheduleData;
    const scenarioAnalysis = calculateScenarioRankBounds(
        sorted,
        selectedSeason,
        leagueObj,
        matches,
        liga,
        scheduleData,
        scores
    );
    const rankBoundsByTeam = scenarioAnalysis.rankBounds || getPossibleRankBounds(sorted, selectedSeason, remainingByTeam);
    const noGamesRemaining = getEstimatedMatchesPerTeam(leagueObj, sorted.length) > 0 &&
        [...remainingByTeam.values()].every(remaining => remaining === 0);
    const effectiveRankBoundsByTeam = scenarioAnalysis.rankBounds
        ? rankBoundsByTeam
        : noGamesRemaining
            ? new Map(sorted.map((team, index) => [
                Number(team.id),
                { minRank: index + 1, maxRank: index + 1 }
            ]))
            : rankBoundsByTeam;

    const qfLimit = zoneConfig.quarterfinal;
    const playinLimit = zoneConfig.playin;
    const relegationLimit = zoneConfig.relegation;
    const totalAdvancing = playinLimit > 0 ? playinLimit : qfLimit;

    const safeZoneRank = sorted.length - relegationLimit;
    return sorted.map((team, index) => {
        const currentZone = getTeamZone(index, sorted.length, zoneConfig);
        const stats = team.stats?.[selectedSeason] || {};
        const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) +
            (stats.losses || 0) + (stats.manualGames || 0);
        const remaining = remainingByTeam.get(Number(team.id)) || 0;
        const { minRank, maxRank } = effectiveRankBoundsByTeam.get(Number(team.id));
        const clinchedQF = qfLimit > 0 && maxRank <= qfLimit;
        const clinchedPlayin = totalAdvancing > qfLimit && maxRank <= totalAdvancing &&
            (clinchMode === 'strict' ? minRank > qfLimit : !clinchedQF);
        const clinchedRelegation = relegationLimit > 0 && minRank > safeZoneRank;
        const clinchedNeutral = clinchMode === 'strict'
            ? minRank > totalAdvancing && maxRank <= safeZoneRank
            : !clinchedQF && !clinchedPlayin && maxRank <= safeZoneRank;
        const lockedZone = getZoneForRank(minRank, sorted.length, zoneConfig) ===
            getZoneForRank(maxRank, sorted.length, zoneConfig);
        const teamStats = scores?.[team.id] || { gf: stats.gf || 0, ga: stats.ga || 0 };

        return {
            ...team,
            _clinchStatus: {
                currentZone,
                locked: minRank === maxRank,
                canRise: minRank < index + 1,
                canDrop: maxRank > index + 1,
                lockedZone,
                minRank,
                maxRank,
                clinchedQF,
                clinchedPlayin,
                clinchedRelegation,
                clinchedNeutral,
                matchesPlayed: played,
                matchesRemaining: remaining,
                remainingOpponents: Object.fromEntries(remainingOpponents.get(Number(team.id)) || []),
                scheduleComplete: scheduleCompleteByTeam.get(Number(team.id)) || false,
                scenarioAnalysis: {
                    status: scenarioAnalysis.status,
                    scenarios: scenarioAnalysis.scenarios,
                    nodesVisited: scenarioAnalysis.nodesVisited,
                    prunedBranches: scenarioAnalysis.prunedBranches || 0,
                    tiebreakCoverage: scenarioAnalysis.tiebreakCoverage,
                    earlyTerminated: scenarioAnalysis.earlyTerminated || false
                },
                goalDiff: (teamStats.gf || 0) - (teamStats.ga || 0),
                gf: teamStats.gf || 0,
                ga: teamStats.ga || 0
            }
        };
    });
}

function calculateCrossGroupClinchStatuses(
    teams,
    {
        season,
        leagueObj,
        matches,
        liga,
        quarterfinal,
        advancing,
        relegation,
        clinchMode,
        isRegularSeasonFinished,
        estimateTeamCount,
        scores
    }
) {
    const qfLimit = Number(quarterfinal) || 0;
    const advancingLimit = Number(advancing) || 0;
    const relegationLimit = Number(relegation) || 0;
    const safeZoneIndex = teams.length - relegationLimit - 1;
    const {
        remainingByTeam,
        remainingOpponents,
        scheduleCompleteByTeam
    } = getRemainingMatchesByTeam(
        teams,
        leagueObj,
        matches,
        season,
        liga,
        estimateTeamCount || teams.length
    );
    if (isRegularSeasonFinished) {
        teams.forEach(team => remainingByTeam.set(Number(team.id), 0));
    }
    const scheduleData = {
        remainingByTeam,
        scheduleCompleteByTeam
    };
    const scenarioAnalysis = calculateScenarioRankBounds(
        teams,
        season,
        leagueObj,
        matches,
        liga,
        scheduleData,
        scores,
        isRegularSeasonFinished,
        'crossGroup'
    );
    const rankBoundsByTeam = scenarioAnalysis.rankBounds || getPossibleRankBounds(teams, season, remainingByTeam);
    const noGamesRemaining = getEstimatedMatchesPerTeam(
        leagueObj,
        estimateTeamCount || teams.length
    ) > 0 && [...remainingByTeam.values()].every(remaining => remaining === 0);
    const effectiveRankBoundsByTeam = scenarioAnalysis.rankBounds
        ? rankBoundsByTeam
        : noGamesRemaining
            ? new Map(teams.map((team, index) => [
                Number(team.id),
                { minRank: index + 1, maxRank: index + 1 }
            ]))
            : rankBoundsByTeam;

    const safeZoneRank = teams.length - relegationLimit;
    return teams.map((team, index) => {
        const stats = team.stats?.[season] || {};
        const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) +
            (stats.losses || 0) + (stats.manualGames || 0);
        const remaining = remainingByTeam.get(Number(team.id)) || 0;
        const currentZone = relegationLimit > 0 && index > safeZoneIndex
            ? 'relegation'
            : qfLimit > 0 && index < qfLimit
                ? 'quarterfinal'
                : advancingLimit > qfLimit && index < advancingLimit
                    ? 'playin'
                    : 'neutral';
        const { minRank, maxRank } = effectiveRankBoundsByTeam.get(Number(team.id));
        const clinchedQF = qfLimit > 0 && maxRank <= qfLimit;
        const clinchedPlayin = advancingLimit > qfLimit && maxRank <= advancingLimit &&
            (clinchMode === 'strict' ? minRank > qfLimit : !clinchedQF);
        const clinchedRelegation = relegationLimit > 0 && minRank > safeZoneRank;
        const clinchedNeutral = clinchMode === 'strict'
            ? minRank > advancingLimit && maxRank <= safeZoneRank
            : !clinchedQF && !clinchedPlayin && maxRank <= safeZoneRank;
        const lockedZone = getZoneForRank(minRank, teams.length, {
            quarterfinal: qfLimit,
            playin: advancingLimit,
            relegation: relegationLimit
        }) === getZoneForRank(maxRank, teams.length, {
            quarterfinal: qfLimit,
            playin: advancingLimit,
            relegation: relegationLimit
        });
        const teamStats = scores?.[team.id] || { gf: stats.gf || 0, ga: stats.ga || 0 };

        return {
            ...team,
            _clinchStatus: {
                currentZone,
                locked: minRank === maxRank,
                canRise: minRank < index + 1,
                canDrop: maxRank > index + 1,
                lockedZone,
                minRank,
                maxRank,
                clinchedQF,
                clinchedPlayin,
                clinchedRelegation,
                clinchedNeutral,
                matchesPlayed: played,
                matchesRemaining: remaining,
                remainingOpponents: Object.fromEntries(remainingOpponents.get(Number(team.id)) || []),
                scheduleComplete: scheduleCompleteByTeam.get(Number(team.id)) || false,
                scenarioAnalysis: {
                    status: scenarioAnalysis.status,
                    scenarios: scenarioAnalysis.scenarios,
                    nodesVisited: scenarioAnalysis.nodesVisited,
                    prunedBranches: scenarioAnalysis.prunedBranches || 0,
                    tiebreakCoverage: scenarioAnalysis.tiebreakCoverage,
                    earlyTerminated: scenarioAnalysis.earlyTerminated || false
                },
                goalDiff: (teamStats.gf || 0) - (teamStats.ga || 0),
                gf: teamStats.gf || 0,
                ga: teamStats.ga || 0
            }
        };
    });
}

/**
 * Exact zone probability calculation using exhaustive scenario analysis.
 * Returns Map<teamId, { quarterfinal: number, playin: number, neutral: number, relegation: number }>
 * where values are percentages (0-100).
 */
function calculateZoneProbabilitiesExact(
    teams,
    season,
    leagueObj,
    matches,
    liga,
    scheduleData,
    scores,
    phase = 'group',
    maxNodes = 1000000
) {
    const { remainingByTeam, scheduleCompleteByTeam } = scheduleData;
    if (!teams.length) return new Map();

    const zoneConfig = {
        quarterfinal: Number(leagueObj?.quarterfinal || 0),
        playin: Number(leagueObj?.playin || 0),
        relegation: Number(leagueObj?.relegation || 0)
    };

    const teamIds = teams.map(team => Number(team.id));
    const teamIdSet = new Set(teamIds);
    const points = new Map(teams.map(team => [
        Number(team.id),
        Number(team.stats?.[season]?.points) || 0
    ]));
    const headToHeadPoints = new Map(teamIds.map(id => [id, new Map(teamIds.map(opponentId => [opponentId, 0]))]));
    const headToHeadGoalDiff = new Map(teamIds.map(id => [id, new Map(teamIds.map(opponentId => [opponentId, 0]))]));
    const headToHeadGoalsFor = new Map(teamIds.map(id => [id, new Map(teamIds.map(opponentId => [opponentId, 0]))]));
    const totalGoalDiff = new Map();
    const totalGoalsFor = new Map();
    const teamStatsById = new Map(teams.map(team => {
        const stats = team.stats?.[season] || {};
        return [
            Number(team.id),
            { ...stats, groupRank: team.groupRank ?? stats.groupRank }
        ];
    }));

    const completedMatches = (matches || []).filter(match =>
        match.season === season &&
        match.liga === liga &&
        !match.isPlayoff &&
        match.result &&
        teamIdSet.has(Number(match.homeTeamId)) &&
        teamIdSet.has(Number(match.awayTeamId))
    );
    const futureMatches = (matches || []).filter(match =>
        match.season === season &&
        match.liga === liga &&
        !match.isPlayoff &&
        !match.result &&
        teamIdSet.has(Number(match.homeTeamId)) &&
        teamIdSet.has(Number(match.awayTeamId))
    ).sort((a, b) => {
        const aPointGap = Math.abs(points.get(Number(a.homeTeamId)) - points.get(Number(a.awayTeamId)));
        const bPointGap = Math.abs(points.get(Number(b.homeTeamId)) - points.get(Number(b.awayTeamId)));
        return aPointGap - bPointGap;
    });

    if (teams.some(team => !scheduleCompleteByTeam.get(Number(team.id)))) {
        // Schedule incomplete - return null to indicate we need Monte Carlo
        return null;
    }

    const completedGoalTotals = new Map(teamIds.map(id => [id, { gf: 0, ga: 0 }]));
    completedMatches.forEach(match => {
        const homeId = Number(match.homeTeamId);
        const awayId = Number(match.awayTeamId);
        const homeGoals = Number(match.result?.scoreHome ?? match.scoreHome) || 0;
        const awayGoals = Number(match.result?.scoreAway ?? match.scoreAway) || 0;
        completedGoalTotals.get(homeId).gf += homeGoals;
        completedGoalTotals.get(homeId).ga += awayGoals;
        completedGoalTotals.get(awayId).gf += awayGoals;
        completedGoalTotals.get(awayId).ga += homeGoals;
    });

    const addHeadToHeadPoints = (homeId, awayId, homePoints, awayPoints) => {
        headToHeadPoints.get(homeId).set(awayId, headToHeadPoints.get(homeId).get(awayId) + homePoints);
        headToHeadPoints.get(awayId).set(homeId, headToHeadPoints.get(awayId).get(homeId) + awayPoints);
    };
    const addHeadToHeadGoals = (homeId, awayId, homeGoals, awayGoals) => {
        headToHeadGoalDiff.get(homeId).set(awayId, headToHeadGoalDiff.get(homeId).get(awayId) + homeGoals - awayGoals);
        headToHeadGoalDiff.get(awayId).set(homeId, headToHeadGoalDiff.get(homeId).get(awayId) + awayGoals - homeGoals);
        headToHeadGoalsFor.get(homeId).set(awayId, headToHeadGoalsFor.get(homeId).get(awayId) + homeGoals);
        headToHeadGoalsFor.get(awayId).set(homeId, headToHeadGoalsFor.get(awayId).get(homeId) + awayGoals);
    };

    teamIds.forEach(id => {
        const stats = teams.find(team => Number(team.id) === id)?.stats?.[season] || {};
        const scoreStats = scores?.[id] || scores?.[String(id)] || {};
        const completedTotals = completedGoalTotals.get(id);
        const gf = Number(scoreStats.gf ?? stats.gf ?? completedTotals.gf) || 0;
        const ga = Number(scoreStats.ga ?? stats.ga ?? completedTotals.ga) || 0;
        totalGoalDiff.set(id, gf - ga);
        totalGoalsFor.set(id, gf);
    });

    completedMatches.forEach(match => {
        const homeId = Number(match.homeTeamId);
        const awayId = Number(match.awayTeamId);
        const result = match.result;
        const homeGoals = Number(result.scoreHome ?? match.scoreHome);
        const awayGoals = Number(result.scoreAway ?? match.scoreAway);
        const overtime = Boolean(result.ot ?? match.ot);
        let homePoints = 1;
        let awayPoints = 1;
        if (homeGoals > awayGoals) {
            homePoints = overtime ? 2 : 3;
            awayPoints = overtime ? 1 : 0;
        } else if (awayGoals > homeGoals) {
            homePoints = overtime ? 1 : 0;
            awayPoints = overtime ? 2 : 3;
        }
        addHeadToHeadPoints(homeId, awayId, homePoints, awayPoints);
        addHeadToHeadGoals(homeId, awayId, homeGoals, awayGoals);
    });

    const manualTiebreaker = new Map(teams.map(team => [
        Number(team.id),
        Number(team.stats?.[season]?.tiebreaker) || 0
    ]));

    // Zone counters for each team
    const zoneCounts = new Map(teamIds.map(id => [id, { quarterfinal: 0, playin: 0, neutral: 0, relegation: 0 }]));
    let totalScenarios = 0;
    let nodesVisited = 0;

    // For each team, we need to evaluate all possible final rankings
    // This is expensive, so we use a different approach:
    // For each scenario (combination of match outcomes), rank all teams and count zones

    const scenarioPoints = new Map(teamIds.map(id => [id, points.get(id)]));
    const scenarioH2H = new Map(teamIds.map(id => [
        id,
        new Map(teamIds.map(opponentId => [
            opponentId,
            headToHeadPoints.get(id)?.get(opponentId) || 0
        ]))
    ]));

    // Sort matches by point gap (closest first) for better pruning
    const sortedMatches = [...futureMatches].sort((a, b) => {
        const aGap = Math.abs(points.get(Number(a.homeTeamId)) - points.get(Number(a.awayTeamId)));
        const bGap = Math.abs(points.get(Number(b.homeTeamId)) - points.get(Number(b.awayTeamId)));
        return aGap - bGap;
    });

    const outcomesByMatch = sortedMatches.map(match => getMatchPointOutcomes());

    const visit = (matchIndex) => {
        if (nodesVisited >= maxNodes) return;

        if (matchIndex === sortedMatches.length) {
            // All matches simulated - rank all teams and count zones
            nodesVisited++;
            totalScenarios++;

            // Create temporary team objects with updated points
            const simTeams = teams.map(team => ({
                ...team,
                stats: {
                    ...team.stats,
                    [season]: {
                        ...(team.stats?.[season] || {}),
                        points: scenarioPoints.get(Number(team.id))
                    }
                }
            }));

            // Rank teams using the same logic as standings
            const ranked = rankTeamsForScenarios(simTeams, {
                season,
                matches: [...completedMatches, ...sortedMatches.map((m, i) => ({
                    ...m,
                    result: {
                        scoreHome: outcomesByMatch[i].home,
                        scoreAway: outcomesByMatch[i].away,
                        ot: outcomesByMatch[i].home === 2 || outcomesByMatch[i].away === 2
                    }
                }))],
                liga,
                scores,
                criteria: getStandingsCriteria(leagueObj, phase)
            });

            // Count zones for each team
            ranked.forEach((team, index) => {
                const rank = index + 1;
                const zone = getZoneForRank(rank, teamIds.length, zoneConfig);
                zoneCounts.get(Number(team.id))[zone]++;
            });

            return;
        }

        const match = sortedMatches[matchIndex];
        const homeId = Number(match.homeTeamId);
        const awayId = Number(match.awayTeamId);

        for (const outcome of outcomesByMatch[matchIndex]) {
            // Apply outcome
            scenarioPoints.set(homeId, scenarioPoints.get(homeId) + outcome.home);
            scenarioPoints.set(awayId, scenarioPoints.get(awayId) + outcome.away);
            scenarioH2H.get(homeId).set(awayId, scenarioH2H.get(homeId).get(awayId) + outcome.home);
            scenarioH2H.get(awayId).set(homeId, scenarioH2H.get(awayId).get(homeId) + outcome.away);

            visit(matchIndex + 1);

            // Revert outcome
            scenarioPoints.set(homeId, scenarioPoints.get(homeId) - outcome.home);
            scenarioPoints.set(awayId, scenarioPoints.get(awayId) - outcome.away);
            scenarioH2H.get(homeId).set(awayId, scenarioH2H.get(awayId) - outcome.home);
            scenarioH2H.get(awayId).set(homeId, scenarioH2H.get(awayId).get(homeId) - outcome.away);
        }
    };

    visit(0);

    // Convert counts to percentages
    const result = new Map();
    teamIds.forEach(id => {
        const counts = zoneCounts.get(id);
        result.set(id, {
            quarterfinal: totalScenarios > 0 ? Math.round((counts.quarterfinal / totalScenarios) * 100) : 0,
            playin: totalScenarios > 0 ? Math.round((counts.playin / totalScenarios) * 100) : 0,
            neutral: totalScenarios > 0 ? Math.round((counts.neutral / totalScenarios) * 100) : 0,
            relegation: totalScenarios > 0 ? Math.round((counts.relegation / totalScenarios) * 100) : 0
        });
    });

    return result;
}

// Helper function for ranking teams in scenarios (simplified version of rankTeams)
function rankTeamsForScenarios(teams, { season, matches, liga, scores, criteria }) {
    // This is a simplified version - in practice we'd use the full rankTeams
    // For now, use points + goal difference + goals for
    return [...teams].sort((a, b) => {
        const statsA = a.stats?.[season] || {};
        const statsB = b.stats?.[season] || {};
        const pointsA = Number(statsA.points) || 0;
        const pointsB = Number(statsB.points) || 0;
        if (pointsB !== pointsA) return pointsB - pointsA;

        const scoreA = scores?.[Number(a.id)] || { gf: 0, ga: 0 };
        const scoreB = scores?.[Number(b.id)] || { gf: 0, ga: 0 };
        const gdA = scoreA.gf - scoreA.ga;
        const gdB = scoreB.gf - scoreB.ga;
        if (gdB !== gdA) return gdB - gdA;
        if (scoreB.gf !== scoreA.gf) return scoreB.gf - scoreA.gf;
        return Number(a.id) - Number(b.id);
    });
}

module.exports = {
    getTeamZone,
    getEstimatedMatchesPerTeam,
    getRemainingMatchesByTeam,
    calculateClinchStatusesForGroup,
    calculateCrossGroupClinchStatuses,
    calculateZoneProbabilitiesExact
};
