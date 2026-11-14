function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);
    return [];
}

function groupLabel(key) {
    if (!key || key === 'default') return 'Celá tabulka';
    if (/^\d+$/.test(String(key))) return 'Skupina ' + key;
    return String(key);
}

function dateParts(match) {
    const raw = String(match.datetime || match.date || '');
    const date = raw.slice(0, 10);
    const ok = /^\d{4}-\d{2}-\d{2}$/.test(date);
    const hourMatch = raw.match(/T(\d{2})/);
    const hour = hourMatch ? Number(hourMatch[1]) : null;
    const time = ok ? new Date(date + 'T' + (hourMatch ? hourMatch[1] : '12') + ':00:00').getTime() : 0;
    return {
        date: ok ? date : '',
        hour,
        dow: ok ? new Date(date + 'T12:00:00').getDay() : null,
        time
    };
}

function evaluateTip(match, tip, nameOf) {
    if (!match?.result || !match.result.winner) return null;
    const res = match.result;
    const bo = Number(match.bo);
    const when = dateParts(match);
    const home = nameOf(match.homeTeamId, match.season, match.liga);
    const away = nameOf(match.awayTeamId, match.season, match.liga);
    const real = (res.scoreHome ?? '–') + ':' + (res.scoreAway ?? '–');
    const base = {
        id: match.id,
        time: when.time,
        date: when.date,
        hour: when.hour,
        dow: when.dow,
        ot: res.ot ? 1 : 0,
        realSide: res.winner,
        home,
        away,
        real
    };

    if (match.isPlayoff && bo === 1) {
        let tipHome = Number(tip.scoreHome ?? tip.scoreH ?? tip.homeGoals ?? 0);
        let tipAway = Number(tip.scoreAway ?? tip.scoreA ?? tip.awayGoals ?? 0);
        const realHome = Number(res.scoreHome ?? 0);
        const realAway = Number(res.scoreAway ?? 0);
        if (res.sideSwap === true) {
            const tmp = tipHome;
            tipHome = tipAway;
            tipAway = tmp;
        }
        const nan = Number.isNaN(tipHome) || Number.isNaN(tipAway);
        let points = 0;
        let hit = 0;
        let delta = null;
        let side = '';
        if (!nan) {
            const realOutcome = Math.sign(realHome - realAway);
            const tipOutcome = Math.sign(tipHome - tipAway);
            delta = Math.abs(tipHome - realHome) + Math.abs(tipAway - realAway);
            side = tipOutcome > 0 ? 'home' : (tipOutcome < 0 ? 'away' : 'draw');
            if (realOutcome === tipOutcome) {
                hit = 1;
                if (delta === 0) points = 5;
                else if (delta === 1) points = 4;
                else if (delta === 2) points = 3;
                else points = 1;
            }
        }
        return Object.assign(base, {
            kind: 'bo1',
            points,
            max: 5,
            hit,
            delta,
            exact: delta === 0 && hit ? 1 : 0,
            side,
            tip: nan ? 'bez skóre' : (tipHome + ':' + tipAway)
        });
    }

    if (match.isPlayoff && bo > 1) {
        const tipWinner = tip.winner;
        const hit = tipWinner === res.winner ? 1 : 0;
        let points = 0;
        let exact = 0;
        if (hit) {
            const realLoserWins = res.winner === 'home' ? Number(res.scoreAway ?? 0) : Number(res.scoreHome ?? 0);
            const tipLoserWins = Number.isFinite(Number(tip.loserWins)) ? Number(tip.loserWins) : -1;
            if (tipLoserWins === realLoserWins) {
                points = 3;
                exact = 1;
            } else {
                points = 1;
            }
        }
        const who = tipWinner === 'home' ? 'domácí' : (tipWinner === 'away' ? 'hosté' : '—');
        const loser = Number.isFinite(Number(tip.loserWins)) ? (', poražený ' + tip.loserWins) : '';
        return Object.assign(base, {
            kind: 'series',
            points,
            max: 3,
            hit,
            delta: null,
            exact,
            side: tipWinner || '',
            tip: who + loser
        });
    }

    if (!match.isPlayoff) {
        let evaluatedWinner = tip.winner;
        if (res.sideSwap === true) {
            evaluatedWinner = tip.winner === 'home' ? 'away' : 'home';
        }
        const hit = evaluatedWinner === res.winner ? 1 : 0;
        const who = evaluatedWinner === 'home' ? 'domácí' : (evaluatedWinner === 'away' ? 'hosté' : '—');
        return Object.assign(base, {
            kind: 'regular',
            points: hit ? 1 : 0,
            max: 1,
            hit,
            delta: null,
            exact: 0,
            side: evaluatedWinner || '',
            tip: who
        });
    }

    return null;
}

function tableDocument(tableTips) {
    if (!tableTips) return {};
    if (Array.isArray(tableTips)) {
        return tableTips.find((doc) => doc && typeof doc === 'object') || {};
    }
    return tableTips;
}

function buildStatisticsBoard({ users, matches, teams, tableTips, viewer, preferredSeason }) {
    const teamName = new Map();
    for (const team of teams || []) {
        const name = team.name || ('Tým ' + team.id);
        teamName.set(team.id + '|' + team.season + '|' + team.liga, name);
        if (!teamName.has(team.id + '|' + team.season)) teamName.set(team.id + '|' + team.season, name);
        if (!teamName.has(String(team.id))) teamName.set(String(team.id), name);
    }
    const nameOf = (id, season, liga) => teamName.get(id + '|' + season + '|' + liga)
        || teamName.get(id + '|' + season)
        || teamName.get(String(id))
        || ('Tým ' + id);

    const matchById = new Map();
    for (const match of matches || []) {
        if (!matchById.has(match.id)) matchById.set(match.id, match);
        const asNumber = Number(match.id);
        if (!Number.isNaN(asNumber) && !matchById.has(asNumber)) matchById.set(asNumber, match);
        if (!matchById.has(String(match.id))) matchById.set(String(match.id), match);
    }
    const findMatch = (id) => matchById.get(id) || matchById.get(Number(id)) || matchById.get(String(id)) || null;

    const tips = [];
    const people = [];
    const mismatches = [];

    for (const user of users || []) {
        if (!user?.username || user.username === 'Admin') continue;
        people.push(user.username);
        const byLeague = {};
        for (const season of Object.keys(user.tips || {})) {
            if (season.startsWith('_')) continue;
            for (const league of Object.keys(user.tips[season] || {})) {
                for (const tip of asArray(user.tips[season][league])) {
                    if (!tip || tip.matchId == null) continue;
                    const scored = evaluateTip(findMatch(tip.matchId), tip, nameOf);
                    if (!scored) continue;
                    tips.push(Object.assign({ user: user.username, season, league }, scored));
                    const key = season + '|' + league;
                    if (!byLeague[key]) byLeague[key] = { points: 0, regular: 0, playoff: 0 };
                    byLeague[key].points += scored.points;
                    if (scored.kind === 'regular') byLeague[key].regular += 1;
                    else byLeague[key].playoff += 1;
                }
            }
        }
        for (const season of Object.keys(user.stats || {})) {
            if (season.startsWith('_')) continue;
            for (const league of Object.keys(user.stats[season] || {})) {
                const stored = user.stats[season][league] || {};
                const got = byLeague[season + '|' + league] || { points: 0, regular: 0, playoff: 0 };
                if (got.points !== (stored.correct || 0)
                    || got.regular !== (stored.totalRegular || 0)
                    || got.playoff !== (stored.totalPlayoff || 0)) {
                    mismatches.push({ user: user.username, season, league });
                }
            }
        }
    }

    const tables = [];
    const tableDoc = tableDocument(tableTips);
    for (const season of Object.keys(tableDoc)) {
        if (season.startsWith('_') || !tableDoc[season] || typeof tableDoc[season] !== 'object') continue;
        for (const league of Object.keys(tableDoc[season])) {
            const leagueTips = tableDoc[season][league];
            if (!leagueTips || typeof leagueTips !== 'object' || Array.isArray(leagueTips)) continue;
            for (const username of Object.keys(leagueTips)) {
                if (username === 'Admin' || username.startsWith('_')) continue;
                const raw = leagueTips[username];
                const groups = [];
                if (Array.isArray(raw)) {
                    groups.push({
                        key: 'default',
                        label: 'Celá tabulka',
                        names: raw.map((id) => nameOf(id, season, league))
                    });
                } else if (raw && typeof raw === 'object') {
                    for (const key of Object.keys(raw)) {
                        const ids = Array.isArray(raw[key]) ? raw[key] : [];
                        groups.push({
                            key,
                            label: groupLabel(key),
                            names: ids.map((id) => nameOf(id, season, league))
                        });
                    }
                }
                if (!groups.length) continue;
                const user = (users || []).find((item) => item.username === username);
                const stored = user?.stats?.[season]?.[league] || {};
                const evaluated = (stored.tableCorrect || 0) > 0 || (stored.tableDeviation || 0) > 0;
                tables.push({
                    user: username,
                    season,
                    league,
                    evaluated,
                    correct: evaluated ? (stored.tableCorrect || 0) : null,
                    deviation: evaluated ? (stored.tableDeviation || 0) : null,
                    groups
                });
            }
        }
    }

    const seasonCounts = {};
    for (const tip of tips) seasonCounts[tip.season] = (seasonCounts[tip.season] || 0) + 1;
    const seasons = Object.keys(seasonCounts).sort().reverse();
    const defaultSeason = seasons.includes(preferredSeason) ? preferredSeason : (seasons[0] || preferredSeason || '');
    const viewerName = people.includes(viewer) ? viewer : (people[0] || viewer || '');

    return {
        viewer: viewerName,
        defaultSeason,
        users: people,
        seasons,
        tips,
        tables,
        audit: {
            tips: tips.length,
            mismatches: mismatches.length
        }
    };
}

module.exports = { buildStatisticsBoard };
