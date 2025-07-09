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

            const realWinner = match.result.winner;
            const tipWinner = tip.winner;

            if (match.isPlayoff) {
                const scoreHome = match.result.scoreHome ?? 0;
                const scoreAway = match.result.scoreAway ?? 0;
                const realLoserWins = realWinner === "home" ? scoreAway : scoreHome;
                const userLoserWins = tip.loserWins ?? -1;
                console.log(realLoserWins)
                console.log(userLoserWins)

                totalPlayoff++;

                if (tipWinner === realWinner) {
                    correctPoints += 1;

                    if (userLoserWins === realLoserWins) {
                        correctPoints = correctPoints + 2;
                    }
                }
            } else {
                totalRegular++;

                if (tipWinner === realWinner) {
                    correctPoints += 1;
                }
            }
        }

        if (!user.stats) user.stats = {};
        if (!user.stats[season]) user.stats[season] = {};
        if (!user.stats[season][liga]) {
            user.stats[season][liga] = {};
        }

        user.stats[season][liga].correct = correctPoints;
        user.stats[season][liga].totalRegular = totalRegular;
        user.stats[season][liga].totalPlayoff = totalPlayoff;
    }

    fs.writeFileSync('./data/users.json', JSON.stringify(users, null, 2));
}


function generateSeasonRange(startYear, numberOfSeasons) {
    const seasons = [];
    const addYears = 2024 - startYear;
    for (let i = 0; i < numberOfSeasons + addYears; i++) {
        const y1 = startYear + i;
        const y2 = y1 + 1;
        seasons.push(`${String(y1).slice(-2)}/${String(y2).slice(-2)}`);
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
    const scores = {}; // teamId => { gf, ga }

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


module.exports = {
    requireLogin,
    requireAdmin,
    loadTeams,
    updateTeamsPoints,
    evaluateAndAssignPoints,
    generateSeasonRange,
    removeTipsForDeletedMatch,
    calculateTeamScores,
}