const {calculateClinchStatusesForGroup } = require('./clinchStatus');
const { rankTeams, getStandingsCriteria } = require('./standings');

const ZONE_CACHE = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minut (klíč obsahuje stavy zápasů, takže při novém výsledku se přepočítá hned)

function getCacheKey(teams, leagueObj, matches, season, liga) {
    const teamIds = teams.map(t => t.id).sort().join(',');
    const matchIds = matches
        .filter(m => m.season === season && m.liga === liga && !m.isPlayoff)
        .map(m => `${m.id}:${m.result ? `${m.result.scoreHome}-${m.result.scoreAway}-${m.result.ot ? 1 : 0}` : 'S'}`)
        .join(',');
    return `${season}|${liga}|${teamIds}|${matchIds}|${leagueObj?.quarterfinal}|${leagueObj?.playin}|${leagueObj?.relegation}`;
}

function getCached(key) {
    const entry = ZONE_CACHE.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        ZONE_CACHE.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data) {
    ZONE_CACHE.set(key, { data, timestamp: Date.now() });
    if (ZONE_CACHE.size > 50) {
        const oldest = ZONE_CACHE.keys().next().value;
        ZONE_CACHE.delete(oldest);
    }
}

function getZoneForRank(rank, totalTeams, cfg) {
    if (rank <= cfg.quarterfinal) return 'quarterfinal';
    if (cfg.playin > cfg.quarterfinal && rank <= cfg.playin) return 'playin';
    if (rank > totalTeams - cfg.relegation) return 'relegation';
    return 'neutral';
}

/**
 * Vygeneruje chybějící zápasy pro kompletní schedule.
 * Každý tým hraje maxMatches*2/počet_týmů her, s každým soupeřem stejně.
 */
function generateMissingMatches(teams, existingMatches, season, liga, leagueObj) {
    const teamIds = teams.map(t => Number(t.id));
    const teamCount = teamIds.length;
    
    // Celkový počet zápasů v lize (na skupinu pro multigroup)
    const isMultigroup = leagueObj?.isMultigroup === true;
    const groupCount = isMultigroup ? (Number(leagueObj?.groupCount) || 2) : 1;
    const totalMatches = Number(leagueObj?.maxMatches) || 0;
    if (totalMatches === 0) return existingMatches;
    
    // Pro multigroup ligy: totalMatches je pro celou ligu, musíme vydělit počtem skupin
    const matchesPerGroup = groupCount > 1 ? Math.ceil(totalMatches / groupCount) : totalMatches;
    
    // Zápasy na tým = (celkem zápasů na skupinu * 2) / počet týmů ve skupině
    const matchesPerTeam = Math.ceil((matchesPerGroup * 2) / teamCount);
    // Zápasy proti každému soupeři = matchesPerTeam / (teamCount - 1)
    Math.ceil(matchesPerTeam / (teamCount - 1));
// Spočítej, kolikrát už spolu týmy hrály a kolik her každý tým odehrál
    const playedPairs = new Map(); // key: "homeId-awayId" -> count
    const manualPlayed = new Map(); // key: teamId -> manuálně zadané hry
    const dbPlayed = new Map(); // key: teamId -> odehrané zápasy v DB
    const dbUnplayed = new Map(); // key: teamId -> naplánované zápasy v DB
    
    teamIds.forEach(id => {
        const team = teams.find(t => Number(t.id) === id);
        const stats = team?.stats?.[season] || {};
        // Použij manuálně zadaný počet her (Z/games/matches/played/gp) pokud existuje
        const played = Number(stats.games ?? stats.matches ?? stats.played ?? stats.gp)
            || ((Number(stats.wins) || 0) + (Number(stats.otWins) || 0) + (Number(stats.otLosses) || 0) + (Number(stats.losses) || 0));
        manualPlayed.set(id, played);
        dbPlayed.set(id, 0);
        dbUnplayed.set(id, 0);
    });
    
    (existingMatches || []).forEach(m => {
        if (m.season !== season || m.liga !== liga || m.isPlayoff) return;
        const homeId = Number(m.homeTeamId);
        const awayId = Number(m.awayTeamId);
        if (!teamIds.includes(homeId) || !teamIds.includes(awayId)) return;
        
        const key = `${homeId}-${awayId}`;
        
        // Počítej VŠECHNY zápasy (odehrané i naplánované) pro playedPairs
        // aby se neodehrané zápasy z DB nezdvojovaly jako virtuální
        playedPairs.set(key, (playedPairs.get(key) || 0) + 1);
        
        // Rozděl na odehrané a naplánované pro playedCount
        if (m.result) {
            dbPlayed.set(homeId, dbPlayed.get(homeId) + 1);
            dbPlayed.set(awayId, dbPlayed.get(awayId) + 1);
        } else {
            dbUnplayed.set(homeId, dbUnplayed.get(homeId) + 1);
            dbUnplayed.set(awayId, dbUnplayed.get(awayId) + 1);
        }
    });
    
    // Vygeneruj chybějící zápasy
    const missingMatches = [];
    let matchId = 1000000; // Virtuální ID pro chybějící zápasy
    
    // Zkopíruj playedCount pro sledování zbývajících her
    const remainingGames = new Map();
    teamIds.forEach(id => {
        const actualPlayed = Math.max(manualPlayed.get(id) || 0, dbPlayed.get(id) || 0);
        const scheduled = dbUnplayed.get(id) || 0;
        remainingGames.set(id, Math.max(0, matchesPerTeam - actualPlayed - scheduled));
    });
    
    // Generuj chybějící zápasy rovnoměrně (vždy mezi týmy s nejvíce zbývajícími zápasy a nejméně vzájemnými)
    while (true) {
        // Najdi tým s nejvíce zbývajícími zápasy
        let teamA = null;
        let maxRemA = 0;
        for (const id of teamIds) {
            const rem = remainingGames.get(id) || 0;
            if (rem > maxRemA) {
                maxRemA = rem;
                teamA = id;
            }
        }
        if (!teamA || maxRemA <= 0) break;

        // Najdi pro něj nejlepšího soupeře (má zbývající hry + odehráli spolu nejméně zápasů)
        let bestOpponent = null;
        let minMutual = Infinity;
        let maxRemB = -1;

        for (const candidate of teamIds) {
            if (candidate === teamA) continue;
            const remB = remainingGames.get(candidate) || 0;
            if (remB <= 0) continue;

            const mutual = (playedPairs.get(`${teamA}-${candidate}`) || 0) + (playedPairs.get(`${candidate}-${teamA}`) || 0);
            if (mutual < minMutual || (mutual === minMutual && remB > maxRemB)) {
                minMutual = mutual;
                maxRemB = remB;
                bestOpponent = candidate;
            }
        }

        if (!bestOpponent) break; // Už nelze nikoho spárovat

        const playedAB = playedPairs.get(`${teamA}-${bestOpponent}`) || 0;
        const playedBA = playedPairs.get(`${bestOpponent}-${teamA}`) || 0;
        const isHomeA = playedAB <= playedBA;

        const hId = isHomeA ? teamA : bestOpponent;
        const aId = isHomeA ? bestOpponent : teamA;

        missingMatches.push({
            id: matchId++,
            season,
            liga,
            homeTeamId: hId,
            awayTeamId: aId,
            isPlayoff: false,
            result: null,
            datetime: null,
            bo: null,
            locked: false,
            postponed: false
        });

        playedPairs.set(`${hId}-${aId}`, (playedPairs.get(`${hId}-${aId}`) || 0) + 1);
        remainingGames.set(teamA, remainingGames.get(teamA) - 1);
        remainingGames.set(bestOpponent, remainingGames.get(bestOpponent) - 1);
    }
    
    // Vrátí jen zápasy pro tuto ligu/sezónu a týmy ve skupině
    const filteredExisting = (existingMatches || []).filter(m =>
        m.season === season &&
        m.liga === liga &&
        !m.isPlayoff &&
        teamIds.includes(Number(m.homeTeamId)) &&
        teamIds.includes(Number(m.awayTeamId))
    );
    
    return [...filteredExisting, ...missingMatches];
}

function getMatchPointOutcomes() {
    // Hockey-style: 3-0, 2-1, 1-2, 0-3 (regulace/OT)
    return [
        { home: 3, away: 0, homeGoals: 4, awayGoals: 1 },
        { home: 2, away: 1, homeGoals: 3, awayGoals: 2 },
        { home: 1, away: 2, homeGoals: 2, awayGoals: 3 },
        { home: 0, away: 3, homeGoals: 1, awayGoals: 4 }
    ];
}

function simulateMatchOutcome(match, teamStats) {
    const outcomes = getMatchPointOutcomes();
    const homeId = Number(match.homeTeamId);
    const awayId = Number(match.awayTeamId);
    
    // Čistá matematika - každý výsledek má stejnou pravděpodobnost 25%
    const outcomeIndex = Math.floor(Math.random() * 4);
    const outcome = outcomes[outcomeIndex];

    teamStats.get(homeId).points += outcome.home;
    teamStats.get(awayId).points += outcome.away;
    teamStats.get(homeId).gf += outcome.homeGoals;
    teamStats.get(homeId).ga += outcome.awayGoals;
    teamStats.get(awayId).gf += outcome.awayGoals;
    teamStats.get(awayId).ga += outcome.homeGoals;
    
    // Aktualizuj wins/otWins/otLosses/losses pro tiebreakery
    const isOT = outcome.home !== outcome.away && (outcome.home === 2 || outcome.away === 2);
    if (outcome.home > outcome.away) {
        if (isOT) teamStats.get(homeId).otWins++;
        else teamStats.get(homeId).wins++;
        if (isOT) teamStats.get(awayId).otLosses++;
        else teamStats.get(awayId).losses++;
    } else if (outcome.away > outcome.home) {
        if (isOT) teamStats.get(awayId).otWins++;
        else teamStats.get(awayId).wins++;
        if (isOT) teamStats.get(homeId).otLosses++;
        else teamStats.get(homeId).losses++;
    }

    // Vrátí výsledek pro použití v rankTeams
    return {
        scoreHome: outcome.homeGoals,
        scoreAway: outcome.awayGoals,
        ot: isOT
    };
}

/**
 * Monte Carlo simulace pravděpodobností zón.
 * Simuluje skutečné zápasy mezi týmy.
 */
function calculateZoneProbabilities(teams, leagueObj, matches, season, liga, scores, options = {}) {
    const simulations = options.simulations || 2500;
    const cacheKey = getCacheKey(teams, leagueObj, matches, season, liga);
    const cached = getCached(cacheKey);
    if (cached) return cached;

    const zoneConfig = {
        quarterfinal: Number(leagueObj?.quarterfinal || 0),
        playin: Number(leagueObj?.playin || 0),
        relegation: Number(leagueObj?.relegation || 0)
    };

    const teamIds = teams.map(t => Number(t.id));
    new Set(teamIds);
    // Vygeneruj chybějící zápasy virtuálně
    const allMatches = generateMissingMatches(teams, matches, season, liga, leagueObj);
    const remainingMatches = allMatches.filter(m => !m.result);

    const totalRemaining = remainingMatches.length;
    const playedMatches = (matches || []).filter(m => 
        m.season === season && m.liga === liga && !m.isPlayoff && m.result
    );
    const expectedMatches = Number(leagueObj?.maxMatches) || 0;
    const isSeasonFinished = expectedMatches > 0 && playedMatches.length >= expectedMatches;
    
    if (totalRemaining === 0 || isSeasonFinished) {
        const result = new Map();
        const sorted = [...teams].sort((a, b) => {
            const statsA = a.stats?.[season] || {};
            const statsB = b.stats?.[season] || {};
            return (statsB.points || 0) - (statsA.points || 0);
        });
        sorted.forEach((team, index) => {
            const zone = getZoneForRank(index + 1, sorted.length, zoneConfig);
            result.set(Number(team.id), {
                quarterfinal: zone === 'quarterfinal' ? 100 : 0,
                playin: zone === 'playin' ? 100 : 0,
                neutral: zone === 'neutral' ? 100 : 0,
                relegation: zone === 'relegation' ? 100 : 0
            });
        });
        setCache(cacheKey, result);
        return result;
    }

    // Exact výpočet je vypnutý kvůli bugům v tie-breakerech pro malé skupiny
    // Vždy se používá Monte Carlo simulace pro konzistentní výsledky
    // try {
    //     const exactResult = calculateZoneProbabilitiesExact(
    //         teams,
    //         season,
    //         leagueObj,
    //         matches,
    //         liga,
    //         scheduleData,
    //         scores,
    //         'group',
    //         500000 // max nodes
    //     );
    //     if (exactResult) {
    //         setCache(cacheKey, exactResult);
    //         return exactResult;
    //     }
    // } catch (e) {
    //     console.log('[ZoneProb] Exact výpočet selhal, fallback na Monte Carlo:', e.message);
    // }

    // Fallback na Monte Carlo simulaci

    // Inicializace statistik týmů
    const baseStats = new Map();
    teamIds.forEach(id => {
        const team = teams.find(t => Number(t.id) === id);
        const stats = team?.stats?.[season] || {};
        const scoreStats = scores?.[id] || scores?.[String(id)] || {};
        baseStats.set(id, {
            points: Number(stats.points) || 0,
            gf: Number(scoreStats.gf ?? stats.gf) || 0,
            ga: Number(scoreStats.ga ?? stats.ga) || 0,
            wins: Number(stats.wins) || 0,
            otWins: Number(stats.otWins) || 0,
            otLosses: Number(stats.otLosses) || 0,
            losses: Number(stats.losses) || 0
        });
    });

    // Počítadla zón
    const zoneCounts = new Map();
    teamIds.forEach(id => {
        zoneCounts.set(id, { quarterfinal: 0, playin: 0, neutral: 0, relegation: 0 });
    });

    const criteria = getStandingsCriteria(leagueObj, 'group');
    const playedMatchesForSim = (matches || []).filter(m =>
        m.season === season && m.liga === liga && !m.isPlayoff && m.result &&
        teamIds.includes(Number(m.homeTeamId)) && teamIds.includes(Number(m.awayTeamId))
    );

    // Předpřiprav objekty týmů a zápasů JEDNOU mimo smyčku (žádné .map() a spread operátory uvnitř)
    const simTeams = teams.map(team => ({
        ...team,
        stats: {
            ...team.stats,
            [season]: { ...(team.stats?.[season] || {}) }
        }
    }));
    const simTeamById = new Map(simTeams.map(t => [Number(t.id), t.stats[season]]));

    const simRemainingTemplates = remainingMatches.map(m => ({
        ...m,
        homeId: Number(m.homeTeamId),
        awayId: Number(m.awayTeamId),
        result: { scoreHome: 0, scoreAway: 0, ot: false }
    }));
    const allSimMatches = [...playedMatchesForSim, ...simRemainingTemplates];
    const simScores = {};
    teamIds.forEach(id => { simScores[id] = { gf: 0, ga: 0 }; });

    const outcomes = getMatchPointOutcomes();

    for (let sim = 0; sim < simulations; sim++) {
        // Reset statistik z baseStats
        for (let i = 0; i < teamIds.length; i++) {
            const id = teamIds[i];
            const base = baseStats.get(id);
            const target = simTeamById.get(id);
            target.points = base.points;
            target.wins = base.wins;
            target.otWins = base.otWins;
            target.otLosses = base.otLosses;
            target.losses = base.losses;
            target.gf = base.gf;
            target.ga = base.ga;
            simScores[id].gf = base.gf;
            simScores[id].ga = base.ga;
        }

        // Simuluj zbývající zápasy přímo do předpřipravených objektů
        for (let i = 0; i < simRemainingTemplates.length; i++) {
            const m = simRemainingTemplates[i];
            const o = outcomes[(Math.random() * 4) | 0];
            const hStats = simTeamById.get(m.homeId);
            const aStats = simTeamById.get(m.awayId);

            hStats.points += o.home;
            aStats.points += o.away;
            hStats.gf += o.homeGoals;
            hStats.ga += o.awayGoals;
            aStats.gf += o.awayGoals;
            aStats.ga += o.homeGoals;

            simScores[m.homeId].gf += o.homeGoals;
            simScores[m.homeId].ga += o.awayGoals;
            simScores[m.awayId].gf += o.awayGoals;
            simScores[m.awayId].ga += o.homeGoals;

            const isOT = o.home === 2 || o.away === 2;
            if (o.home > o.away) {
                if (isOT) { hStats.otWins++; aStats.otLosses++; }
                else { hStats.wins++; aStats.losses++; }
            } else {
                if (isOT) { aStats.otWins++; hStats.otLosses++; }
                else { aStats.wins++; hStats.losses++; }
            }

            m.result.scoreHome = o.homeGoals;
            m.result.scoreAway = o.awayGoals;
            m.result.ot = isOT;
        }

        const ranked = rankTeams(simTeams, {
            season,
            matches: allSimMatches,
            liga,
            scores: simScores,
            criteria
        });

        for (let idx = 0; idx < ranked.length; idx++) {
            const zone = getZoneForRank(idx + 1, teamIds.length, zoneConfig);
            zoneCounts.get(Number(ranked[idx].id))[zone]++;
        }
    }

    // Získej clinch statusy pro tvrdé hranice (0 % / 100 %)
    let clinchMap = new Map();
    try {
        // Zkontroluj, jestli už týmy mají _clinchStatus (z fileUtils.js)
        const hasExistingStatus = teams.some(t => t._clinchStatus);
        if (hasExistingStatus) {
            // Použij existující _clinchStatus
            teams.forEach(t => {
                if (t._clinchStatus) clinchMap.set(Number(t.id), t._clinchStatus);
            });
        } else {
            // Spočítej nově a ulož zpět na týmy (aby se nepočítalo dvakrát)
            const clinchTeams = calculateClinchStatusesForGroup(
                teams, leagueObj, season, 'strict', scores, matches, liga
            );
            clinchTeams.forEach(t => {
                if (t._clinchStatus) {
                    clinchMap.set(Number(t.id), t._clinchStatus);
                    // Ulož zpět na originální objekt týmu
                    const originalTeam = teams.find(orig => Number(orig.id) === Number(t.id));
                    if (originalTeam) originalTeam._clinchStatus = t._clinchStatus;
                }
            });
        }
    } catch (e) {
        console.log('[ZoneProb] Clinch status integrace selhala:', e.message);
    }

    const result = new Map();
    teamIds.forEach(id => {
        const counts = zoneCounts.get(id);
        const status = clinchMap.get(id);

        let qf = Math.round((counts.quarterfinal / simulations) * 10000) / 100;
        let pi = Math.round((counts.playin / simulations) * 10000) / 100;
        let neu = Math.round((counts.neutral / simulations) * 10000) / 100;
        let rel = Math.round((counts.relegation / simulations) * 10000) / 100;

        if (status) {
            // 1. Jistota Top 4 (čtvrtfinále)
            if (status.clinchedQF) {
                qf = 100; pi = 0; neu = 0; rel = 0;
            }
            // 2. Jistota Top 12 (předkolo), ale NE nutně Top 4 -> nemůže skončit mimo Top 12
            else if (status.clinchedPlayin) {
                neu = 0; rel = 0;
                if (qf >= 100) qf = 99.99; // Dokud není clinchedQF, max 99.99 %
                pi = Math.round((100 - qf) * 100) / 100;
            }
            // 3. Jistota baráže / sestupu
            else if (status.clinchedRelegation) {
                qf = 0; pi = 0; neu = 0; rel = 100;
            }
            // 4. Jistota 13. místa (konec sezóny bez baráže i play-off)
            else if (status.clinchedNeutral) {
                qf = 0; pi = 0; neu = 100; rel = 0;
            }
            // 5. Zatím bez matematické jistoty -> zastropuj 100 % na 99.99 % a 0 % na 0.01 %
            else {
                const totalTeams = teamIds.length;
                const advancingSpots = Math.max(zoneConfig.quarterfinal, zoneConfig.playin);
                const hasNeutralZone = (totalTeams - advancingSpots - zoneConfig.relegation) > 0;
                const hasRelegationZone = zoneConfig.relegation > 0;

                // Horní hranice - pokud qf + pi >= 100, ale není clinched, nechte 0.01 % pro neu/rel
                if (qf + pi >= 100) {
                    if (qf >= 100) {
                        qf = 99.99;
                        pi = 0;
                    } else {
                        pi = Math.max(0, Math.round((99.99 - qf) * 100) / 100);
                    }
                    // Zajisti, že neu + rel má aspoň 0.01 % (pokud existují)
                    if (neu === 0 && rel === 0) {
                        if (hasNeutralZone) neu = 0.01;
                        else if (hasRelegationZone) rel = 0.01;
                    }
                }
                // Spodní hranice - pokud tým ještě není eliminated, min 0.01 %
                if (qf + pi <= 0 && !status.clinchedRelegation && !status.clinchedNeutral) {
                    // Tým může stále dosáhnout Top 12, ale je to extrémně nepravděpodobné
                    if (zoneConfig.playin > zoneConfig.quarterfinal) pi = 0.01;
                    else if (zoneConfig.quarterfinal > 0) qf = 0.01;

                    // Zajisti, že součet je 100 %
                    const remaining = Math.round((100 - qf - pi - neu - rel) * 100) / 100;
                    if (remaining !== 0) {
                        // Přidej/odečti zbývající procenta do největší zóny
                        if (neu >= rel && neu + remaining >= 0) neu = Math.round((neu + remaining) * 100) / 100;
                        else if (rel + remaining >= 0) rel = Math.round((rel + remaining) * 100) / 100;
                    }
                }
            }
        }

        result.set(id, { quarterfinal: qf, playin: pi, neutral: neu, relegation: rel });
    });

    setCache(cacheKey, result);
    return result;
}

module.exports = {
    calculateZoneProbabilities
};
