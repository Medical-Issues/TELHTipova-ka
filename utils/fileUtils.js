const {readFileSync} = require("node:fs");
const path = require("path");
const fs = require("fs");

function loadTeams() {
    const data = readFileSync(path.join(__dirname, '../data/teams.json'), 'utf-8');
    return JSON.parse(data);
}

function requireLogin(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/auth/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || req.session.user !== 'Admin') {
        return res.status(403).send('Přístup odepřen, nejsi admin.');
    }
    next();
}

function updateTeamsPoints(currentMatches) {
    let teams;
    try {
        teams = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/teams.json'), 'utf-8'));
    } catch (err) {
        console.error('Chyba při čtení teams.json:', err);
        return;
    }

    for (const team of teams) {
        if (!team.stats) team.stats = {};
        for (const season of Object.keys(team.stats)) {
            team.stats[season] = {
                points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0
            };
        }
    }

    currentMatches.forEach(match => {
        if (!match.result || typeof match.result.scoreHome !== 'number' || typeof match.result.scoreAway !== 'number') return;
        if (match.isPlayoff) return;

        const season = match.season;
        const r = match.result;
        const ot = !!r.ot;

        const homeTeam = teams.find(t => t.id === match.homeTeamId && t.liga === match.liga);
        const awayTeam = teams.find(t => t.id === match.awayTeamId && t.liga === match.liga);
        if (!homeTeam || !awayTeam) return;

        if (!homeTeam.stats[season]) homeTeam.stats[season] = {points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0};
        if (!awayTeam.stats[season]) awayTeam.stats[season] = {points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0};

        let winner;
        if (r.scoreHome === r.scoreAway) {
            if (ot && (r.overtimeWinner === 'home' || r.overtimeWinner === 'away')) {
                winner = r.overtimeWinner;
            } else {
                console.log('Remíza bez overtime winner, nelze určit vítěze.');
                return;
            }
        } else {
            winner = r.scoreHome > r.scoreAway ? 'home' : 'away';
        }

        const homeStats = homeTeam.stats[season];
        const awayStats = awayTeam.stats[season];

        if (winner === 'home') {
            if (ot) {
                homeStats.points += 2; homeStats.otWins++;
                awayStats.points += 1; awayStats.otLosses++;
            } else {
                homeStats.points += 3; homeStats.wins++;
                awayStats.losses++;
            }
        } else {
            if (ot) {
                awayStats.points += 2; awayStats.otWins++;
                homeStats.points += 1; homeStats.otLosses++;
            } else {
                awayStats.points += 3; awayStats.wins++;
                homeStats.losses++;
            }
        }
    });

    try {
        fs.writeFileSync(path.join(__dirname, '../data/teams.json'), JSON.stringify(teams, null, 2));
    } catch (err) {
        console.error('Chyba při zápisu do teams.json:', err);
    }
}

function evaluateAndAssignPoints(liga, season) {
    const matches = JSON.parse(fs.readFileSync('./data/matches.json'));
    const users = JSON.parse(fs.readFileSync('./data/users.json'));

    for (const user of users) {
        const tipsInSeason = user.tips?.[season]?.[liga] || [];
        let correctPoints = 0;
        let totalRegular = 0;
        let totalPlayoff = 0;

        for (const tip of tipsInSeason) {
            const match = matches.find(m => m.id === tip.matchId);
            if (!match?.result || !match.result.winner) continue;

            if (match.isPlayoff && Number(match.bo) === 1) {
                totalPlayoff++;

                const realHome = Number(match.result.scoreHome ?? 0);
                const realAway = Number(match.result.scoreAway ?? 0);

                const tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
                const tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);

                if (Number.isNaN(tipHome) || Number.isNaN(tipAway)) {
                    continue;
                }

                if (tipHome === realHome && tipAway === realAway) {
                    correctPoints += 5;
                } else {
                    const delta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);

                    if (delta === 1) correctPoints += 4;
                    else if (delta === 2) correctPoints += 3;
                    else correctPoints += 1;
                }

                continue;
            }

            if (match.isPlayoff && Number(match.bo) > 1) {
                totalPlayoff++;

                const realWinner = match.result.winner;
                const tipWinner = tip.winner;
                const realLoserWins = realWinner === "home"
                    ? Number(match.result.scoreAway ?? 0)
                    : Number(match.result.scoreHome ?? 0);
                const tipLoserWins = Number.isFinite(Number(tip.loserWins)) ? Number(tip.loserWins) : -1;

                if (tipWinner === realWinner) correctPoints += 1;
                if (tipWinner === realWinner && tipLoserWins === realLoserWins) correctPoints += 2;

                continue;
            }

            if (!match.isPlayoff) {
                totalRegular++;
                if (tip.winner === match.result.winner) correctPoints += 1;
            }
        }

        if (!user.stats) user.stats = {};
        if (!user.stats[season]) user.stats[season] = {};
        if (!user.stats[season][liga]) user.stats[season][liga] = {};

        user.stats[season][liga].correct = correctPoints;
        user.stats[season][liga].totalRegular = totalRegular;
        user.stats[season][liga].totalPlayoff = totalPlayoff;
    }

    fs.writeFileSync('./data/users.json', JSON.stringify(users, null, 2));
}

function generateSeasonRange(startYear, numberOfSeasons) {
    const seasons = [];
    for (let i = 0; i < numberOfSeasons; i++) {
        const y1 = startYear + i;
        const y2 = y1 + 1;
        const shortY1 = String(y1 % 100).padStart(2, '0');
        const shortY2 = String(y2 % 100).padStart(2, '0');

        seasons.push(`${shortY1}/${shortY2}`);
    }
    return seasons;
}


function removeTipsForDeletedMatch(matchId) {
    let league = null;
    let season = null;

    try {
        const matches = JSON.parse(fs.readFileSync('./data/matches.json'));
        const match = matches.find(m => m.id === matchId);

        if (match) {
            console.log(`Zápas ID ${matchId} stále existuje. Tipy se nemazaly.`);
            return;
        }

        const usersData = JSON.parse(fs.readFileSync('./data/users.json'));

        for (const user of usersData) {
            if (!user.tips) continue;

            for (const [s, leagues] of Object.entries(user.tips)) {
                for (const [l, tips] of Object.entries(leagues)) {
                    if (tips.some(t => t.matchId === matchId)) {
                        season = s;
                        league = l;
                        break;
                    }
                }
                if (season && league) break;
            }
            if (season && league) break;
        }

        if (!season || !league) {
            console.log(`Nepodařilo se zjistit ligu/sezónu pro zápas ID ${matchId}.`);
            return;
        }

        let changesMade = false;

        for (const user of usersData) {
            if (
                user.tips &&
                user.tips[season] &&
                user.tips[season][league]
            ) {
                const originalTips = user.tips[season][league];
                const filteredTips = originalTips.filter(tip => tip.matchId !== matchId);

                if (filteredTips.length !== originalTips.length) {
                    user.tips[season][league] = filteredTips;
                    changesMade = true;
                    console.log(`Smazán tip u uživatele ${user.username}`);
                }
            }
        }

        if (changesMade) {
            fs.writeFileSync('./data/users.json', JSON.stringify(usersData, null, 2));
            console.log(`Tipy na zápas ID ${matchId} (liga: ${league}, sezóna: ${season}) byly smazány.`);
        } else {
            console.log(`Nebyly nalezeny žádné tipy na zápas ID ${matchId}.`);
        }

    } catch (err) {
        console.error("Chyba při mazání tipů:", err);
    }
}

function calculateTeamScores(matches, selectedSeason, selectedLiga) {
    const scores = {};

    matches.forEach(match => {
        const result = match.result;

        if (
            match.season !== selectedSeason ||
            match.liga !== selectedLiga ||
            match.isPlayoff ||
            !result ||
            result.scoreHome == null ||
            result.scoreAway == null
        ) {
            return;
        }

        const homeId = match.homeTeamId;
        const awayId = match.awayTeamId;

        if (!scores[homeId]) scores[homeId] = { gf: 0, ga: 0 };
        if (!scores[awayId]) scores[awayId] = { gf: 0, ga: 0 };

        scores[homeId].gf += result.scoreHome;
        scores[homeId].ga += result.scoreAway;

        scores[awayId].gf += result.scoreAway;
        scores[awayId].ga += result.scoreHome;
    });

    return scores;
}
function getLeagueZones(leagueObj) {
    if (!leagueObj) return { quarterfinal: 0, playin: 0, relegation: 0 };
    return {
        quarterfinal: Number(leagueObj.quarterfinal || 0),
        playin: Number(leagueObj.playin || 0),
        relegation: Number(leagueObj.relegation || 0)
    };
}

function getTeamZone(index, totalTeams, cfg) {
    const pos = index + 1;
    if (pos <= cfg.quarterfinal) return "quarterfinal";
    if (pos <= cfg.playin) return "playin";
    if (pos > totalTeams - cfg.relegation) return "relegation";
    return "neutral";
}

function getTeamStats(team, season, maxMatches) {
    if (!team) {
        return { points: 0, maxPoints: Number.MAX_SAFE_INTEGER, remaining: Number.MAX_SAFE_INTEGER };
    }
    const stats = team.stats?.[season] || {};
    const points = stats.points || 0;
    const played = (stats.wins || 0) + (stats.otWins || 0) + (stats.otLosses || 0) + (stats.losses || 0);

    let remaining;
    if (played > maxMatches) {
        remaining = 0;
    } else {
        remaining = maxMatches - played;
    }

    const maxPoints = points + (remaining * 3);
    return { points, maxPoints };
}
function isLockedPosition(index, totalTeams, sortedTeams, cfg, season, maxMatches, allTeamsFinished) {
    if (cfg.quarterfinal === 0 && cfg.playin === 0 && cfg.relegation === 0) {
        return false;
    }
    if (allTeamsFinished) {
        return true;
    }
    const myTeam = sortedTeams[index];
    if (!myTeam) return false;

    const { points: myPoints, maxPoints: myMaxPoints } = getTeamStats(myTeam, season, maxMatches);

    const lastQfIndex = cfg.quarterfinal - 1;
    const lastPlayinIndex = cfg.playin - 1;
    const firstRelegationIndex = totalTeams - cfg.relegation;

    if (index <= lastQfIndex) {
        const chaser = sortedTeams[lastQfIndex + 1];
        if (!chaser) return true;

        const { maxPoints: chaserMaxPoints } = getTeamStats(chaser, season, maxMatches);

        return chaserMaxPoints < myPoints;
    }

    else if (index <= lastPlayinIndex) {
        const chaser = sortedTeams[lastPlayinIndex + 1];
        const cannotFall = !chaser || (getTeamStats(chaser, season, maxMatches).maxPoints < myPoints);

        const leader = sortedTeams[lastQfIndex];
        const cannotRise = !leader || (myMaxPoints < getTeamStats(leader, season, maxMatches).points);

        return cannotFall && cannotRise;
    }

    else if (index >= firstRelegationIndex) {
        const leader = sortedTeams[firstRelegationIndex - 1];
        if (!leader) return true;

        const { points: leaderPoints } = getTeamStats(leader, season, maxMatches);

        return myMaxPoints < leaderPoints;
    }

    else {
        const chaser = sortedTeams[firstRelegationIndex];
        const cannotFall = !chaser || (getTeamStats(chaser, season, maxMatches).maxPoints < myPoints);

        const leader = sortedTeams[lastPlayinIndex];
        const cannotRise = !leader || (myMaxPoints < getTeamStats(leader, season, maxMatches).points);

        return cannotFall && cannotRise;
    }
}

module.exports = {
    requireLogin,
    requireAdmin,
    loadTeams,
    updateTeamsPoints,
    evaluateAndAssignPoints,
    generateSeasonRange,
    removeTipsForDeletedMatch,
    calculateTeamScores,
    getLeagueZones,
    getTeamZone,
    isLockedPosition,
}