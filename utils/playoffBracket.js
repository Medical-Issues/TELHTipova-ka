/**
 * Rámec pavouka.
 *
 * Šablona (sloupce, sloty, title2, gap, slotParents) se tady přeloží na kola,
 * svislé pozice a spojnice. Stejné HTML kreslí uživatelský panel i náhled
 * v administraci. Přiřazení sérií, scénáře a bodování zůstávají venku:
 * sem přijde jen hotová šablona a uložené sloty.
 */

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function cssNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '0';
    return String(Math.round(number * 1000) / 1000);
}

function domId(slotId) {
    return `pb-slot-${String(slotId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function parentSlotId(token) {
    if (typeof token !== 'string' || !token.trim()) return '';
    return token.trim().replace(/_(winner|loser)$/i, '');
}

function densityFromGap(gap) {
    const parsed = parseInt(String(gap || ''), 10);
    if (!Number.isFinite(parsed)) return 'normal';
    if (parsed >= 50) return 'loose';
    if (parsed <= 24) return 'tight';
    return 'normal';
}

function loosestDensity(densities) {
    if (densities.includes('loose')) return 'loose';
    if (densities.includes('normal')) return 'normal';
    return 'tight';
}

/**
 * Ze stávající šablony udělá kola, vedlejší sloty (title2) a vazby rodičů.
 * Vedlejší slot je druhý zápas sloupce, který má title2: zůstane ve sloupci,
 * ale nepočítá se do stromu.
 */
function buildPlayoffModel(template) {
    const columns = Array.isArray(template?.columns) ? template.columns : [];
    const parentsOf = {};
    const rawParents = template?.slotParents && typeof template.slotParents === 'object'
        ? template.slotParents
        : {};

    Object.entries(rawParents).forEach(([child, parents]) => {
        const refs = (Array.isArray(parents) ? parents : [])
            .map(token => ({
                id: parentSlotId(token),
                kind: typeof token === 'string' && /_loser$/i.test(token.trim()) ? 'loser' : 'winner'
            }))
            .filter(ref => ref.id);
        if (refs.length) parentsOf[String(child)] = refs;
    });

    const rounds = [];
    const knownRules = template?.rules && typeof template.rules === 'object' ? template.rules : {};
    columns.forEach((column, index) => {
        const slotIds = (Array.isArray(column?.slots) ? column.slots : [])
            .filter(slotId => slotId !== undefined && slotId !== null && String(slotId).trim() !== '')
            .map(slotId => String(slotId));
        const markedSide = column?.sideSlot && slotIds.includes(String(column.sideSlot))
            ? String(column.sideSlot)
            : '';
        const legacySide = !markedSide && column?.title2 && slotIds.length === 2 ? slotIds[1] : '';
        const sideId = markedSide || legacySide;
        const sideCaption = column?.title2 || column?.sideTitle || 'Umístění';
        const treeIds = sideId ? slotIds.filter(id => id !== sideId) : slotIds;

        rounds.push({
            index,
            title: column?.title ? String(column.title) : '',
            density: densityFromGap(column?.gap),
            slots: treeIds.map(id => ({ id, center: 0, rules: knownRules[id] || null })),
            sideSlots: sideId ? [{ id: sideId, caption: String(sideCaption), rules: knownRules[sideId] || null }] : []
        });
    });

    layoutRounds(rounds, parentsOf);

    let maxCenter = 0;
    rounds.forEach(round => {
        round.slots.forEach(slot => {
            if (slot.center > maxCenter) maxCenter = slot.center;
        });
    });

    rounds.forEach(round => {
        round.slots.concat(round.sideSlots).forEach(slot => {
            slot.parents = parentsOf[slot.id] || [];
        });
    });

    return {
        label: template?.label ? String(template.label) : '',
        rounds,
        connectors: buildConnectors(rounds, parentsOf),
        units: rounds.some(round => round.slots.length) ? maxCenter + 1 : 0,
        density: template?.density || loosestDensity(rounds.map(round => round.density))
    };
}

function ruleOrigin(rule) {
    const parts = [];
    if (rule.phase === 'playoff') parts.push('playoff');
    if (rule.league) parts.push(rule.league);
    return parts.length ? ` ${parts.join(' ')}` : '';
}

function ruleLabel(rule) {
    if (!rule || !rule.type || rule.type === 'empty') return '';
    const group = rule.group ? ` ${rule.group}` : '';
    const origin = ruleOrigin(rule);
    if (rule.type === 'place') return `${rule.place}. místo${origin}${group}`;
    if (rule.type === 'fromEnd') {
        const name = Number(rule.offset) <= 1 ? 'Poslední' : `${rule.offset}. od konce`;
        return `${name}${origin}${group}`;
    }
    if (rule.type === 'winner' && rule.of) return `Vítěz ${String(rule.of).toUpperCase()}`;
    if (rule.type === 'loser' && rule.of) return `Poražený ${String(rule.of).toUpperCase()}`;
    if (rule.type === 'seed') {
        const which = rule.order === 'lowest' ? 'nejnižší' : 'nejvyšší';
        return `${rule.rank}. ${which} seed`;
    }
    if (rule.type === 'manual') return 'Vybraný tým';
    return '';
}

function layoutRounds(rounds, parentsOf) {
    const roundOf = new Map();
    rounds.forEach(round => {
        round.slots.forEach(slot => roundOf.set(slot.id, round.index));
    });
    const placed = new Map();

    rounds.forEach((round, roundIndex) => {
        const slots = round.slots;
        if (!slots.length) return;

        const linked = slots.map(slot => ({
            slot,
            parents: (parentsOf[slot.id] || [])
                .map(parent => parent.id)
                .filter(parentId => roundOf.has(parentId) && roundOf.get(parentId) < roundIndex && placed.has(parentId))
        }));
        const hasLinks = linked.some(item => item.parents.length > 0);

        if (!hasLinks) {
            if (roundIndex === 0) {
                slots.forEach((slot, index) => {
                    slot.center = index;
                    placed.set(slot.id, slot.center);
                });
                return;
            }

            const previous = rounds[roundIndex - 1].slots.filter(slot => placed.has(slot.id));
            const previousCenters = previous.map(slot => placed.get(slot.id));
            const previousMin = previousCenters.length ? Math.min(...previousCenters) : 0;
            const previousCount = Math.max(previousCenters.length, 1);

            if (slots.length === 1) {
                const average = previousCenters.length
                    ? previousCenters.reduce((sum, center) => sum + center, 0) / previousCenters.length
                    : 0;
                slots[0].center = average;
                placed.set(slots[0].id, average);
                return;
            }

            slots.forEach((slot, index) => {
                slot.center = previousMin + ((index + 0.5) * (previousCount / slots.length)) - 0.5;
                placed.set(slot.id, slot.center);
            });
            separateOverlaps(slots, placed);
            return;
        }

        let maxCenter = -1;
        linked.forEach(item => {
            if (!item.parents.length) return;
            const center = item.parents.reduce((sum, parentId) => sum + placed.get(parentId), 0) / item.parents.length;
            item.slot.center = center;
            placed.set(item.slot.id, center);
            if (center > maxCenter) maxCenter = center;
        });
        placed.forEach(center => {
            if (center > maxCenter) maxCenter = center;
        });
        linked.forEach(item => {
            if (item.parents.length) return;
            maxCenter += 1;
            item.slot.center = maxCenter;
            placed.set(item.slot.id, maxCenter);
        });

        separateOverlaps(slots, placed);
    });
}

function separateOverlaps(slots, placed) {
    const sorted = slots.slice().sort((a, b) => a.center - b.center || a.id.localeCompare(b.id));
    for (let index = 1; index < sorted.length; index += 1) {
        const gap = sorted[index].center - sorted[index - 1].center;
        if (gap >= 1) continue;
        const shift = 1 - gap;
        for (let next = index; next < sorted.length; next += 1) {
            sorted[next].center += shift;
            placed.set(sorted[next].id, sorted[next].center);
        }
    }
}

function inferParents(childSlots, previousSlots) {
    const buckets = new Map(childSlots.map(slot => [slot.id, []]));
    if (childSlots.length === 0 || previousSlots.length === 0 || childSlots.length >= previousSlots.length) {
        return buckets;
    }

    if (childSlots.length === 1) {
        buckets.set(childSlots[0].id, previousSlots.map(slot => slot.id));
        return buckets;
    }

    previousSlots.forEach(previous => {
        let nearest = childSlots[0];
        let nearestDistance = Math.abs(previous.center - nearest.center);
        childSlots.slice(1).forEach(child => {
            const distance = Math.abs(previous.center - child.center);
            if (distance < nearestDistance) {
                nearest = child;
                nearestDistance = distance;
            }
        });
        buckets.get(nearest.id).push(previous.id);
    });
    return buckets;
}

function buildConnectors(rounds, parentsOf) {
    const byId = new Map();
    rounds.forEach(round => {
        round.slots.forEach(slot => byId.set(slot.id, { id: slot.id, center: slot.center, round: round.index }));
    });

    const connectors = [];
    for (let index = 1; index < rounds.length; index += 1) {
        const previous = rounds[index - 1].slots;
        const current = rounds[index].slots;
        const inferred = inferParents(current, previous);

        current.forEach(slot => {
            const explicit = (parentsOf[slot.id] || [])
                .map(parent => byId.get(parent.id))
                .filter(parent => parent && parent.round < index);
            const parents = explicit.length
                ? explicit
                : (inferred.get(slot.id) || []).map(parentId => byId.get(parentId)).filter(Boolean);
            if (!parents.length) return;

            const centers = parents.map(parent => parent.center);
            connectors.push({
                beforeRound: index,
                from: Math.min(...centers),
                to: Math.max(...centers),
                at: slot.center
            });
        });
    }
    return connectors;
}

function matchStandingOverlay(teams, matches, season, liga) {
    const overlay = new Map();
    teams.forEach(team => overlay.set(Number(team.id), { points: 0, gf: 0, ga: 0 }));
    let counted = 0;
    (matches || []).forEach(match => {
        if (match.season !== season || match.liga !== liga || match.isPlayoff || !match.result) return;
        const home = overlay.get(Number(match.homeTeamId));
        const away = overlay.get(Number(match.awayTeamId));
        if (!home || !away) return;
        const result = match.result;
        const sH = parseInt(result.scoreHome, 10);
        const sA = parseInt(result.scoreAway, 10);
        if (!Number.isFinite(sH) || !Number.isFinite(sA)) return;
        counted += 1;
        const ot = !!result.ot;
        home.gf += sH;
        home.ga += sA;
        away.gf += sA;
        away.ga += sH;
        let winner;
        if (sH === sA) {
            if (ot && (result.overtimeWinner === 'home' || result.overtimeWinner === 'away')) {
                winner = result.overtimeWinner;
            } else {
                home.points += 1;
                away.points += 1;
                return;
            }
        } else {
            winner = sH > sA ? 'home' : 'away';
        }
        if (winner === 'home') {
            if (ot) {
                home.points += 2;
                away.points += 1;
            } else {
                home.points += 3;
            }
        } else if (ot) {
            away.points += 2;
            home.points += 1;
        } else {
            away.points += 3;
        }
    });
    if (!counted) return null;
    const stored = teams.reduce((sum, team) => sum + (Number(team.stats?.[season]?.points) || 0), 0);
    const derived = [...overlay.values()].reduce((sum, row) => sum + row.points, 0);
    if (derived <= stored) return null;
    return overlay;
}

function compareTeams(a, b, season, scores, matches, liga, overlay) {
    const aOver = overlay?.get(Number(a.id));
    const bOver = overlay?.get(Number(b.id));
    const aStats = a.stats?.[season] || {};
    const bStats = b.stats?.[season] || {};
    const pointsA = aOver ? aOver.points : (aStats.points || 0);
    const pointsB = bOver ? bOver.points : (bStats.points || 0);
    if (pointsB !== pointsA) return pointsB - pointsA;

    const tieA = aStats.tiebreaker || 0;
    const tieB = bStats.tiebreaker || 0;
    if (tieB !== tieA) return tieA - tieB;

    const scoreA = aOver || scores?.[a.id] || { gf: 0, ga: 0 };
    const scoreB = bOver || scores?.[b.id] || { gf: 0, ga: 0 };
    const diffA = (scoreA.gf || 0) - (scoreA.ga || 0);
    const diffB = (scoreB.gf || 0) - (scoreB.ga || 0);
    if (diffA !== diffB) return diffB - diffA;
    if ((scoreA.gf || 0) !== (scoreB.gf || 0)) return (scoreB.gf || 0) - (scoreA.gf || 0);

    const direct = (matches || []).find(match =>
        match.liga === liga &&
        match.result &&
        !match.isPlayoff &&
        ((Number(match.homeTeamId) === Number(a.id) && Number(match.awayTeamId) === Number(b.id)) ||
            (Number(match.homeTeamId) === Number(b.id) && Number(match.awayTeamId) === Number(a.id)))
    );
    if (!direct) return 0;

    const aIsHome = Number(direct.homeTeamId) === Number(a.id);
    const homeGoals = Number(direct.result.scoreHome ?? direct.scoreHome ?? 0);
    const awayGoals = Number(direct.result.scoreAway ?? direct.scoreAway ?? 0);
    if (homeGoals === awayGoals) return 0;
    const homeWon = homeGoals > awayGoals;
    if (aIsHome) return homeWon ? -1 : 1;
    return homeWon ? 1 : -1;
}

function buildSeedMap(teams, context) {
    const { selectedSeason, selectedLiga, scores, matches, ranks } = context;
    const leagueTeams = (teams || []).filter(team => team.liga === selectedLiga);
    if (ranks && leagueTeams.some(team => Number(ranks[team.id]) > 0)) {
        const seeds = new Map();
        leagueTeams.forEach(team => {
            const rank = Number(ranks[team.id]);
            if (Number.isFinite(rank) && rank > 0) seeds.set(Number(team.id), rank);
        });
        return seeds;
    }

    const groups = new Map();
    leagueTeams.forEach(team => {
        const key = team.group ?? '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(team);
    });

    const seeds = new Map();
    groups.forEach(groupTeams => {
        const overlay = matchStandingOverlay(groupTeams, matches, selectedSeason, selectedLiga);
        const sorted = groupTeams.slice().sort((a, b) => compareTeams(
            a,
            b,
            selectedSeason,
            scores,
            matches,
            selectedLiga,
            overlay
        ));
        sorted.forEach((team, index) => seeds.set(Number(team.id), index + 1));
    });
    return seeds;
}

function teamFace(team, seed) {
    if (!team) {
        return { name: 'TBD', logo: '', seed: null };
    }
    return {
        name: team.name || 'TBD',
        logo: team.logo ? `/logoteamu/${team.logo}` : '',
        seed: seed || null
    };
}

function resolveSeries(match, teamsById, seeds) {
    const homeTeam = teamsById.get(Number(match.homeTeamId));
    const awayTeam = teamsById.get(Number(match.awayTeamId));
    const bo = Number(match.bo) || 1;
    const winsNeeded = bo > 1 ? Math.ceil(bo / 2) : 1;

    let scoreH = 0;
    let scoreA = 0;
    const result = match.result;
    if (result && result.scoreHome !== undefined && result.scoreHome !== null && result.scoreHome !== '' &&
        result.scoreAway !== undefined && result.scoreAway !== null && result.scoreAway !== '') {
        scoreH = Number(result.scoreHome);
        scoreA = Number(result.scoreAway);
    } else if (Array.isArray(match.playedMatches)) {
        match.playedMatches.forEach(game => {
            const homeGoals = Number(game.scoreHome);
            const awayGoals = Number(game.scoreAway);
            if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals) || homeGoals === awayGoals) return;
            if (homeGoals > awayGoals) scoreH += 1;
            else scoreA += 1;
        });
    }

    if (!Number.isFinite(scoreH)) scoreH = 0;
    if (!Number.isFinite(scoreA)) scoreA = 0;

    const homeWins = bo === 1 ? scoreH > scoreA : scoreH >= winsNeeded;
    const awayWins = bo === 1 ? scoreA > scoreH : scoreA >= winsNeeded;
    const finished = homeWins || awayWins;
    const live = !finished && (scoreH > 0 || scoreA > 0);

    return {
        state: finished ? 'done' : (live ? 'live' : 'waiting'),
        home: teamFace(homeTeam, seeds.get(Number(match.homeTeamId))),
        away: teamFace(awayTeam, seeds.get(Number(match.awayTeamId))),
        homeName: homeTeam?.name || 'Neznámý',
        awayName: awayTeam?.name || 'Neznámý',
        scoreH,
        scoreA,
        homeWins,
        awayWins,
        bo,
        winsNeeded,
        match
    };
}

function namedTeam(name, teamsByName) {
    if (!name) return teamFace(null);
    const team = teamsByName.get(name);
    if (!team) return { name, logo: '', seed: null };
    return { name: team.name, logo: team.logo ? `/logoteamu/${team.logo}` : '', seed: null };
}

/**
 * Do modelu doplní týmy, skóre a stav podle uložených slotů a zápasů.
 * Čekající tým bere jméno ze slotu (`slot_t1` / `slot_t2`), série bere `series-<id>`.
 */
function parentLabel(parent) {
    const title = String(parent.id || '').toUpperCase();
    return `${parent.kind === 'loser' ? 'Poražený' : 'Vítěz'} ${title}`;
}

function findListedTeam(teams, id, league, preferredLeague, preferredName) {
    const numeric = Number(id);
    const list = (teams || []).filter(team => Number(team.id) === numeric);
    if (!list.length) return null;
    if (league) return list.find(team => team.liga === league) ||
        list.find(team => preferredName && team.name === preferredName) || null;
    if (preferredName) return list.find(team => team.name === preferredName) ||
        list.find(team => team.liga === preferredLeague) || list[0];
    return list.find(team => team.liga === preferredLeague) || list[0];
}

function hydratePlayoffModel(model, context) {
    const teams = context.teams || [];
    const teamsById = new Map();
    teams.forEach(team => {
        const id = Number(team.id);
        const existing = teamsById.get(id);
        if (!existing) teamsById.set(id, team);
        else if (context.selectedLiga && team.liga === context.selectedLiga && existing.liga !== context.selectedLiga) {
            teamsById.set(id, team);
        }
    });
    (context.nameTeams || []).forEach(team => {
        const id = Number(team.id);
        if (!Number.isFinite(id) || teamsById.has(id)) return;
        teamsById.set(id, team);
    });
    const teamsByName = new Map();
    teams.forEach(team => {
        if (context.selectedLiga && team.liga !== context.selectedLiga) return;
        if (team.name && !teamsByName.has(team.name)) teamsByName.set(team.name, team);
    });
    const seeds = buildSeedMap(teams, context);
    const matches = context.matches || [];
    const savedSlots = context.savedSlots || {};

    const usesRankedPositions = (slotId, side) => {
        const slot = findSlot(slotId);
        const rule = slot?.rules?.[side];
        return ['place', 'fromEnd'].includes(rule?.type);
    };

    const linkedSeriesMatchesRankedPositions = (slotId, match) => {
        if (context.historical) return true;
        const rankedSides = ['home', 'away'].filter(side => usesRankedPositions(slotId, side));
        if (!rankedSides.length) return true;
        const expected = rankedSides.map(side => Number(context.zoneFaces?.[slotId]?.[side]?.id) || 0);
        const actual = new Set([Number(match.homeTeamId), Number(match.awayTeamId)]);
        return expected.every(id => id > 0) &&
            new Set(expected).size === expected.length &&
            expected.every(id => actual.has(id));
    };

    const viewFor = slotId => {
        const seriesId = savedSlots[slotId];
        if (seriesId) {
            const matchId = parseInt(String(seriesId).replace('series-', ''), 10);
            const match = matches.find(item => Number(item.id) === matchId);
            if (match && linkedSeriesMatchesRankedPositions(slotId, match)) {
                const view = resolveSeries(match, teamsById, seeds);
                const homeLeague = savedSlots[`${slotId}_t1league`];
                const awayLeague = savedSlots[`${slotId}_t2league`];
                const listedTeams = teams.concat(context.nameTeams || []);
                if (homeLeague) {
                    const team = findListedTeam(
                        listedTeams,
                        match.homeTeamId,
                        homeLeague,
                        context.selectedLiga,
                        savedSlots[`${slotId}_t1`]
                    );
                    if (team) view.home = teamFace(team, team.liga === context.selectedLiga ? seeds.get(Number(team.id)) : null);
                } else if (savedSlots[`${slotId}_t1`]) {
                    const team = findListedTeam(
                        listedTeams,
                        match.homeTeamId,
                        '',
                        context.selectedLiga,
                        savedSlots[`${slotId}_t1`]
                    );
                    if (team) view.home = teamFace(team, team.liga === context.selectedLiga ? seeds.get(Number(team.id)) : null);
                }
                if (awayLeague) {
                    const team = findListedTeam(
                        listedTeams,
                        match.awayTeamId,
                        awayLeague,
                        context.selectedLiga,
                        savedSlots[`${slotId}_t2`]
                    );
                    if (team) view.away = teamFace(team, team.liga === context.selectedLiga ? seeds.get(Number(team.id)) : null);
                } else if (savedSlots[`${slotId}_t2`]) {
                    const team = findListedTeam(
                        listedTeams,
                        match.awayTeamId,
                        '',
                        context.selectedLiga,
                        savedSlots[`${slotId}_t2`]
                    );
                    if (team) view.away = teamFace(team, team.liga === context.selectedLiga ? seeds.get(Number(team.id)) : null);
                }
                return view;
            }
            if (!match) return {
                state: 'missing',
                home: teamFace(null),
                away: teamFace(null),
                scoreH: null,
                scoreA: null,
                bo: 0,
                match: null
            };
        }

        const waitingHome = usesRankedPositions(slotId, 'home') ? null : savedFace(slotId, 'home');
        const waitingAway = usesRankedPositions(slotId, 'away') ? null : savedFace(slotId, 'away');
        const hinted = emptyView(slotId);
        const home = waitingHome || zoneFace(slotId, 'home') || hinted.home;
        const away = waitingAway || zoneFace(slotId, 'away') || hinted.away;
        const zoned = Boolean(home?.zone || away?.zone);
        if (waitingHome || waitingAway || zoned || home?.seed || away?.seed || home?.locked || away?.locked || home?.logo || away?.logo) {
            return {
                state: 'pending',
                home,
                away,
                scoreH: null,
                scoreA: null,
                bo: 0,
                match: null,
                zoned
            };
        }

        return hinted;
    };

    const zoneFace = (slotId, side) => {
        const preview = context.zoneFaces?.[slotId]?.[side];
        if (!preview || !preview.name) return null;
        const sameLeague = !preview.league || preview.league === context.selectedLiga;
        const seed = sameLeague && preview.id ? (seeds.get(Number(preview.id)) || null) : null;
        return {
            name: preview.name,
            logo: preview.logo || '',
            seed,
            zone: preview.zone || '',
            locked: Boolean(preview.locked)
        };
    };

    const savedFace = (slotId, side) => {
        const suffix = side === 'home' ? 't1' : 't2';
        const storedId = savedSlots[`${slotId}_${suffix}id`];
        const storedLeague = savedSlots[`${slotId}_${suffix}league`];
        if (storedId !== undefined && storedId !== null && storedId !== '') {
            const team = findListedTeam(teams, storedId, storedLeague, context.selectedLiga);
            if (team) {
                const seed = !storedLeague || team.liga === context.selectedLiga ? seeds.get(Number(team.id)) : null;
                return teamFace(team, seed);
            }
        }
        const storedName = savedSlots[`${slotId}_${suffix}`];
        if (!storedName) return null;
        const face = namedTeam(storedName, teamsByName);
        const team = teamsByName.get(storedName);
        if (team) face.seed = seeds.get(Number(team.id)) || null;
        return face;
    };

    const emptyView = slotId => {
        const slot = findSlot(slotId);
        const parents = slot?.parents || [];
        const home = faceFromRule(slot?.rules?.home, parents, 0);
        const away = faceFromRule(slot?.rules?.away, parents, 1);
        const hasHint = home.name !== 'TBD' || away.name !== 'TBD';
        return {
            state: hasHint ? 'pending' : 'empty',
            home,
            away,
            scoreH: null,
            scoreA: null,
            bo: 0,
            match: null
        };
    };

    const faceFromRule = (rule, parents, index) => {
        const label = ruleLabel(rule);
        if (label) return { name: label, logo: '', seed: null };
        if (parents[index]) return { name: parentLabel(parents[index]), logo: '', seed: null };
        return teamFace(null);
    };

    const findSlot = slotId => {
        for (const round of model.rounds) {
            const slot = round.slots.concat(round.sideSlots).find(item => item.id === slotId);
            if (slot) return slot;
        }
        return null;
    };

    model.rounds.forEach(round => {
        round.slots.forEach(slot => {
            slot.view = viewFor(slot.id);
        });
        round.sideSlots.forEach(slot => {
            slot.view = viewFor(slot.id);
        });
    });
    return model;
}

function sideClass(view, side) {
    if (view.state !== 'done' && view.state !== 'live') return '';
    if (side === 'home') {
        if (view.homeWins) return 'is-winner';
        if (view.awayWins) return 'is-loser';
    } else {
        if (view.awayWins) return 'is-winner';
        if (view.homeWins) return 'is-loser';
    }
    return '';
}

function renderFace(face, extraClass) {
    const seed = face.seed ? `<span class="pb-seed">#${escapeHtml(face.seed)}</span>` : '';
    const logo = face.logo
        ? `<img class="pb-logo" src="${escapeHtml(face.logo)}" alt="">`
        : '';
    const zone = face.zone ? `<span class="pb-zone">${escapeHtml(face.zone)}</span>` : '';
    const classes = [extraClass, face.zone ? 'is-zone' : ''].filter(Boolean).join(' ');
    return `<span class="pb-team ${classes}">${seed}${logo}<span class="pb-name">${escapeHtml(face.name)}</span>${zone}</span>`;
}

function renderGames(view) {
    const match = view.match;
    if (!match) return '<p class="pb-games-empty">Série není připojená.</p>';

    if (Number(match.bo) === 1 || !Array.isArray(match.playedMatches) || match.playedMatches.length === 0) {
        const result = match.result;
        const hasScore = result && result.scoreHome !== undefined && result.scoreHome !== null && result.scoreHome !== '';
        const score = hasScore ? `${result.scoreHome}:${result.scoreAway}` : 'Čeká se';
        const overtime = hasScore && result.ot ? '<span class="pb-ot">p</span>' : '';
        return `
            <div class="pb-game pb-game-single">
                <span class="pb-game-side ${view.homeWins ? 'is-winner' : ''}">${escapeHtml(view.home.name)}</span>
                <span class="pb-game-score">${escapeHtml(score)}${overtime}</span>
                <span class="pb-game-side ${view.awayWins ? 'is-winner' : ''}">${escapeHtml(view.away.name)}</span>
            </div>`;
    }

    return match.playedMatches.map((game, index) => {
        const swapped = Boolean(game.sideSwap);
        const homeName = swapped ? view.away.name : view.home.name;
        const awayName = swapped ? view.home.name : view.away.name;
        const homeGoals = swapped ? game.scoreAway : game.scoreHome;
        const awayGoals = swapped ? game.scoreHome : game.scoreAway;
        const homeWon = (Number(game.scoreHome) > Number(game.scoreAway) && !swapped) ||
            (Number(game.scoreAway) > Number(game.scoreHome) && swapped);
        const awayWon = (Number(game.scoreAway) > Number(game.scoreHome) && !swapped) ||
            (Number(game.scoreHome) > Number(game.scoreAway) && swapped);
        const overtime = game.ot ? '<span class="pb-ot">p</span>' : '';
        return `
            <div class="pb-game">
                <span class="pb-game-index">${index + 1}</span>
                <span class="pb-game-side ${homeWon ? 'is-winner' : ''}">${escapeHtml(homeName)}</span>
                <span class="pb-game-score">${escapeHtml(homeGoals)}:${escapeHtml(awayGoals)}${overtime}</span>
                <span class="pb-game-side ${awayWon ? 'is-winner' : ''}">${escapeHtml(awayName)}</span>
            </div>`;
    }).join('');
}

function renderCard(slot, extraClass) {
    const view = slot.view;
    const inZone = Boolean(view.zoned || view.home?.zone || view.away?.zone);
    const stateClass = {
        empty: 'is-empty',
        pending: 'is-pending',
        waiting: 'is-waiting',
        live: 'is-live',
        done: 'is-done',
        missing: 'is-missing'
    }[view.state] || 'is-empty';
    const statusLabel = inZone && view.state === 'pending' ? 'V oblasti' : ({
        empty: 'Bez týmů',
        pending: 'Čeká na soupeře',
        waiting: 'Čeká',
        live: 'Hraje se',
        done: 'Hotovo',
        missing: 'Série chybí'
    }[view.state] || 'Čeká');
    const score = view.scoreH === null || view.scoreH === undefined
        ? '–'
        : `${view.scoreH}:${view.scoreA}`;
    const bestOf = view.bo > 1 ? `<span class="pb-bo">BO${view.bo}</span>` : '';
    const progress = view.bo > 1 && view.winsNeeded > 0
        ? `<span class="pb-progress" aria-hidden="true"><span style="width:${Math.min(100, (Math.max(view.scoreH, view.scoreA) / view.winsNeeded) * 100)}%"></span></span>`
        : '';
    const canOpen = Boolean(view.match) && !slot.editHref;
    const summary = `
        <span class="pb-card-head">
            <span class="pb-status">${statusLabel}</span>
            ${bestOf}
            <span class="pb-score">${escapeHtml(score)}</span>
        </span>
        <span class="pb-teams">
            ${renderFace(view.home, sideClass(view, 'home'))}
            ${renderFace(view.away, sideClass(view, 'away'))}
        </span>
        ${progress}`;

    const body = slot.editHref
        ? `<a class="pb-card-hit" href="${escapeHtml(slot.editHref)}">${summary}</a>`
        : (canOpen
            ? `<button type="button" class="pb-card-hit" data-pb-toggle aria-expanded="false">${summary}</button>
           <div class="pb-games">${renderGames(view)}</div>`
            : `<div class="pb-card-hit">${summary}</div>`);

    return `
        <article class="pb-card ${stateClass} ${inZone ? 'is-zone' : ''} ${slot.selected ? 'is-selected' : ''} ${extraClass || ''}" data-slot="${escapeHtml(slot.id)}" style="--center:${cssNumber(slot.center || 0)}" id="${domId(slot.id)}">
            ${body}
        </article>`;
}

function renderRound(round) {
    const cards = round.slots.map(slot => renderCard(slot)).join('');
    const side = round.sideSlots.map(slot => `
        <div class="pb-side">
            <h4 class="pb-round-title pb-side-title">${escapeHtml(slot.caption)}</h4>
            ${renderCard(slot, 'is-side')}
        </div>`).join('');

    return `
        <section class="pb-round">
            <h3 class="pb-round-title">${escapeHtml(round.title)}</h3>
            <div class="pb-track">${cards}</div>
            ${side}
        </section>`;
}

function renderGutter(connectors, roundIndex) {
    const forks = connectors
        .filter(connector => connector.beforeRound === roundIndex)
        .map(connector => {
            const single = connector.from === connector.to;
            if (single) {
                return `<span class="pb-stem" style="--at:${cssNumber(connector.at)}"></span>`;
            }
            return `<span class="pb-fork" style="--from:${cssNumber(connector.from)};--to:${cssNumber(connector.to)};--at:${cssNumber(connector.at)}"></span>`;
        })
        .join('');

    return `
        <div class="pb-gutter" aria-hidden="true">
            <div class="pb-round-title pb-round-spacer"></div>
            <div class="pb-track">${forks}</div>
        </div>`;
}

function playoffBracketScript() {
    return `
    <script>
    (function () {
        if (window.__pbBracket) return;
        window.__pbBracket = true;

        function markScroll(root) {
            var scroll = root.querySelector('.pb-scroll');
            if (!scroll || root.classList.contains('pb-mode-list')) {
                root.classList.remove('pb-can-scroll', 'pb-at-start', 'pb-at-end');
                return;
            }
            var max = scroll.scrollWidth - scroll.clientWidth;
            root.classList.toggle('pb-can-scroll', max > 8);
            root.classList.toggle('pb-at-start', scroll.scrollLeft <= 8);
            root.classList.toggle('pb-at-end', scroll.scrollLeft >= max - 8);
        }
        function markAll() {
            document.querySelectorAll('.pb').forEach(markScroll);
        }
        markAll();
        window.addEventListener('resize', markAll);
        document.addEventListener('scroll', function (event) {
            var node = event.target;
            if (!node || !node.closest || !node.classList || !node.classList.contains('pb-scroll')) return;
            var root = node.closest('.pb');
            if (root) markScroll(root);
        }, true);
        if (window.ResizeObserver) {
            var observer = new ResizeObserver(markAll);
            document.querySelectorAll('.pb-scroll').forEach(function (node) { observer.observe(node); });
        }

        document.addEventListener('click', function (event) {
            var arrow = event.target.closest('[data-pb-scroll]');
            if (arrow) {
                var arrowRoot = arrow.closest('.pb');
                var scroll = arrowRoot && arrowRoot.querySelector('.pb-scroll');
                if (!scroll) return;
                var direction = Number(arrow.getAttribute('data-pb-scroll')) || 0;
                var round = scroll.querySelector('.pb-round');
                var gutter = scroll.querySelector('.pb-gutter');
                var step = (round ? round.getBoundingClientRect().width : 200) + (gutter ? gutter.getBoundingClientRect().width : 0);
                if (step < 80) step = Math.max(180, Math.round(scroll.clientWidth * 0.7));
                scroll.scrollBy({ left: direction * step, behavior: 'smooth' });
                window.setTimeout(function () { markScroll(arrowRoot); }, 350);
                return;
            }

            var viewButton = event.target.closest('[data-pb-view]');
            if (viewButton) {
                var root = viewButton.closest('.pb');
                if (!root) return;
                var mode = viewButton.getAttribute('data-pb-view');
                root.classList.toggle('pb-mode-list', mode === 'list');
                root.querySelectorAll('[data-pb-view]').forEach(function (button) {
                    var pressed = button === viewButton;
                    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
                    button.classList.toggle('is-active', pressed);
                });
                markScroll(root);
                return;
            }

            var toggle = event.target.closest('[data-pb-toggle]');
            if (!toggle) return;
            var card = toggle.closest('.pb-card');
            var bracket = card && card.closest('.pb');
            if (!card || !bracket) return;
            var games = card.querySelector('.pb-games');
            var dock = bracket.querySelector('.pb-detail');
            var open = !card.classList.contains('is-open');
            bracket.querySelectorAll('.pb-card.is-open').forEach(function (other) {
                if (other === card) return;
                other.classList.remove('is-open');
                var otherToggle = other.querySelector('[data-pb-toggle]');
                if (otherToggle) otherToggle.setAttribute('aria-expanded', 'false');
            });
            card.classList.toggle('is-open', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (!dock) return;
            if (open && games) {
                dock.innerHTML = games.innerHTML;
                dock.hidden = false;
            } else {
                dock.innerHTML = '';
                dock.hidden = true;
            }
        });
    })();
    </script>`;
}

function renderPlayoffBracket(options) {
    const template = options?.template;
    const visible = options?.visible !== false;
    const heading = options?.heading || `Playoff · ${options?.selectedLiga || ''} ${options?.selectedSeason || ''}`.trim();

    if (!template || !Array.isArray(template.columns) || template.columns.length === 0) {
        const league = options?.selectedLiga || 'tuto ligu';
        return `
        <div class="pb" id="playoffTablePreview" style="display:${visible ? 'block' : 'none'};">
            <h2 class="pb-heading">${escapeHtml(heading)}</h2>
            <p class="pb-missing">Pro ligu ${escapeHtml(league)} není nastavený formát pavouka.</p>
        </div>`;
    }

    const model = hydratePlayoffModel(buildPlayoffModel(template), options);
    if (options?.editBase) {
        const join = String(options.editBase).includes('?') ? '&' : '?';
        model.rounds.forEach(round => {
            round.slots.concat(round.sideSlots).forEach(slot => {
                slot.editHref = `${options.editBase}${join}slot=${encodeURIComponent(slot.id)}#pb-editor`;
                slot.selected = options.selectedSlot === slot.id;
            });
        });
    }
    const board = model.rounds.map((round, index) => {
        const gutter = index > 0 ? renderGutter(model.connectors, index) : '';
        return `${gutter}${renderRound(round)}`;
    }).join('');

    return `
    <div class="pb pb-density-${model.density}" id="playoffTablePreview" style="--pb-units:${cssNumber(model.units || 1)};display:${visible ? 'block' : 'none'};">
        <div class="pb-toolbar">
            <h2 class="pb-heading">${escapeHtml(heading)}</h2>
            <div class="pb-views" role="group" aria-label="Způsob zobrazení pavouka">
                <button type="button" class="pb-view is-active" data-pb-view="bracket" aria-pressed="true">Pavouk</button>
                <button type="button" class="pb-view" data-pb-view="list" aria-pressed="false">Po kolech</button>
            </div>
        </div>
        <button type="button" class="pb-arrow pb-arrow-prev" data-pb-scroll="-1" aria-label="Předchozí kola">←</button>
        <button type="button" class="pb-arrow pb-arrow-next" data-pb-scroll="1" aria-label="Další kola">→</button>
        <div class="pb-scroll">
            <div class="pb-board">${board}</div>
        </div>
        <div class="pb-detail" hidden></div>
    </div>
    ${playoffBracketScript()}`;
}

module.exports = {
    buildPlayoffModel,
    hydratePlayoffModel,
    renderPlayoffBracket,
    ruleLabel
};
