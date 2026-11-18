/**
 * Správa pavouka: úpravy šablony, předlohy a plán doplnění týmů.
 * Zápisy do databáze dělá routes/admin.js.
 */

const { renderPlayoffBracket, ruleLabel } = require('./playoffBracket');

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
}

function columnSideId(column) {
    const slots = (column?.slots || []).map(id => String(id));
    if (column?.sideSlot && slots.includes(String(column.sideSlot))) return String(column.sideSlot);
    if (column?.title2 && slots.length === 2) return slots[1];
    return '';
}

function listSlots(template) {
    const slots = [];
    (template?.columns || []).forEach((column, roundIndex) => {
        const ids = (column.slots || []).map(id => String(id));
        const sideId = columnSideId(column);
        ids.forEach((id, row) => {
            slots.push({
                id,
                roundIndex,
                row,
                title: column.title || '',
                side: id === sideId
            });
        });
    });
    return slots;
}

function gapForDensity(density) {
    if (density === 'tight') return '16px';
    if (density === 'loose') return '64px';
    return '36px';
}

function syncTemplate(template) {
    const parents = {};
    Object.entries(template.rules || {}).forEach(([slotId, sides]) => {
        const links = [];
        ['home', 'away'].forEach(side => {
            const rule = sides?.[side];
            if (!rule || !rule.of) return;
            if (rule.type === 'winner') links.push(`${rule.of}_winner`);
            if (rule.type === 'loser') links.push(`${rule.of}_loser`);
        });
        if (links.length) parents[slotId] = links;
    });
    template.slotParents = parents;
    const gap = gapForDensity(template.density);
    (template.columns || []).forEach(column => {
        column.gap = gap;
    });
    return template;
}

function blankRule() {
    return { type: 'empty' };
}

function parsePositionValue(value) {
    const text = String(value || '').trim();
    const place = text.match(/^(\d+)_([A-Za-z])$/);
    if (place) {
        return { type: 'place', place: Number(place[1]), group: place[2].toUpperCase() === 'X' ? '' : place[2].toUpperCase() };
    }
    const winner = text.match(/^(winner|loser)_(.+?)(?:_X)?$/i);
    if (winner) return { type: winner[1].toLowerCase(), of: winner[2] };
    const seed = text.match(/^seed_(highest|lowest)_(\d+)(?:_X)?$/i);
    if (seed) return { type: 'seed', order: seed[1].toLowerCase(), rank: Number(seed[2]) };
    const clinchSeed = text.match(/^clinch_seed_(\d+)(?:_X)?$/i);
    if (clinchSeed) return { type: 'seed', order: 'highest', rank: Number(clinchSeed[1]) };
    return null;
}

function prepareTemplate(template, positionConfig) {
    const next = clone(template);
    if (!Array.isArray(next.columns)) next.columns = [];
    if (!next.rules || typeof next.rules !== 'object') next.rules = {};
    next.columns.forEach(column => {
        column.slots = (column.slots || []).map(id => String(id));
    });

    const known = new Set(listSlots(next).map(slot => slot.id));
    known.forEach(slotId => {
        if (!next.rules[slotId]) next.rules[slotId] = { home: blankRule(), away: blankRule() };
        if (!next.rules[slotId].home) next.rules[slotId].home = blankRule();
        if (!next.rules[slotId].away) next.rules[slotId].away = blankRule();
    });

    Object.entries(next.slotParents || {}).forEach(([slotId, parents]) => {
        if (!next.rules[slotId]) return;
        (Array.isArray(parents) ? parents : []).forEach((token, index) => {
            const side = index === 0 ? 'home' : 'away';
            if (next.rules[slotId][side].type !== 'empty') return;
            const id = String(token).replace(/_(winner|loser)$/i, '');
            const type = /_loser$/i.test(String(token)) ? 'loser' : 'winner';
            if (id) next.rules[slotId][side] = { type, of: id };
        });
    });

    String(positionConfig || '').split(',').map(part => part.trim()).filter(Boolean).forEach(part => {
        const splitAt = part.indexOf(':');
        if (splitAt < 0) return;
        const key = part.slice(0, splitAt);
        const value = part.slice(splitAt + 1);
        const side = key.endsWith('_t1') ? 'home' : (key.endsWith('_t2') ? 'away' : '');
        if (!side) return;
        const slotId = key.slice(0, -3);
        if (!next.rules[slotId] || next.rules[slotId][side].type !== 'empty') return;
        const rule = parsePositionValue(value);
        if (rule) next.rules[slotId][side] = rule;
    });

    if (!next.density) {
        const gap = parseInt(String(next.columns[0]?.gap || ''), 10);
        next.density = gap >= 50 ? 'loose' : (Number.isFinite(gap) && gap <= 24 ? 'tight' : 'normal');
    }
    return syncTemplate(next);
}

function nextSlotId(template) {
    const used = new Set(listSlots(template).map(slot => slot.id));
    let number = 1;
    while (used.has(`z${number}`)) number += 1;
    return `z${number}`;
}

function addRound(template, title) {
    const next = prepareTemplate(template);
    next.columns.push({
        title: String(title || '').trim() || `Kolo ${next.columns.length + 1}`,
        slots: [],
        gap: gapForDensity(next.density)
    });
    return syncTemplate(next);
}

function addSlot(template, roundIndex) {
    const next = prepareTemplate(template);
    const index = Number(roundIndex);
    if (!next.columns[index]) return next;
    const id = nextSlotId(next);
    next.columns[index].slots.push(id);
    next.rules[id] = { home: blankRule(), away: blankRule() };
    return syncTemplate(next);
}

function deleteSlot(template, slotId) {
    const next = prepareTemplate(template);
    const id = String(slotId || '');
    next.columns.forEach(column => {
        column.slots = (column.slots || []).filter(slot => String(slot) !== id);
        if (String(column.sideSlot || '') === id) {
            delete column.sideSlot;
            delete column.title2;
            delete column.sideTitle;
        }
    });
    next.columns = next.columns.filter(column => (column.slots || []).length > 0);
    delete next.rules[id];
    Object.values(next.rules).forEach(sides => {
        ['home', 'away'].forEach(side => {
            const rule = sides[side];
            if (rule && rule.of === id) sides[side] = blankRule();
        });
    });
    return syncTemplate(next);
}

function setDensity(template, density) {
    const next = prepareTemplate(template);
    next.density = ['tight', 'normal', 'loose'].includes(density) ? density : 'normal';
    return syncTemplate(next);
}

function sourceFields(body, prefix) {
    const league = String(body[`${prefix}League`] || '').trim();
    const phase = body[`${prefix}Phase`] === 'playoff' ? 'playoff' : 'table';
    const extra = {};
    if (league) extra.league = league;
    if (phase === 'playoff') extra.phase = 'playoff';
    return extra;
}

function readRule(body, prefix) {
    let type = body[`${prefix}Type`] || 'empty';
    const pickedLeague = String(body[`${prefix}League`] || '').trim();
    const pickedPlayoff = body[`${prefix}Phase`] === 'playoff';
    if (type === 'empty' && (pickedLeague || pickedPlayoff)) type = 'place';
    if (type === 'place') {
        const league = String(body[`${prefix}League`] || '').trim();
        return {
            type,
            place: Math.max(1, Number(body[`${prefix}Place`]) || 1),
            group: league ? '' : String(body[`${prefix}Group`] || '').trim(),
            ...sourceFields(body, prefix)
        };
    }
    if (type === 'fromEnd') {
        const league = String(body[`${prefix}League`] || '').trim();
        return {
            type,
            offset: Math.max(1, Number(body[`${prefix}Offset`]) || 1),
            group: league ? '' : String(body[`${prefix}Group`] || '').trim(),
            ...sourceFields(body, prefix)
        };
    }
    if (type === 'winner' || type === 'loser') {
        const of = String(body[`${prefix}Of`] || '').trim();
        return of ? { type, of } : blankRule();
    }
    if (type === 'seed') {
        return {
            type,
            rank: Math.max(1, Number(body[`${prefix}Rank`]) || 1),
            order: body[`${prefix}Order`] === 'lowest' ? 'lowest' : 'highest'
        };
    }
    if (type === 'manual') return { type: 'manual' };
    return blankRule();
}

function setSideRule(template, slotId, side, rule) {
    if (!template.rules[slotId]) template.rules[slotId] = { home: blankRule(), away: blankRule() };
    template.rules[slotId][side === 'away' ? 'away' : 'home'] = rule;
}

function updateSlot(template, body) {
    const next = prepareTemplate(template);
    const slotId = String(body.slotId || '');
    const slots = listSlots(next);
    const current = slots.find(slot => slot.id === slotId);
    if (!current) return { template: next, patch: {} };

    const column = next.columns[current.roundIndex];
    if (body.roundTitle !== undefined) column.title = String(body.roundTitle || '').trim() || column.title;
    setSideRule(next, slotId, 'home', readRule(body, 'home'));
    setSideRule(next, slotId, 'away', readRule(body, 'away'));

    if (body.asSide === '1') {
        column.sideSlot = slotId;
        column.title2 = String(body.sideTitle || '').trim() || 'Umístění';
        column.sideTitle = column.title2;
    } else if (String(column.sideSlot || '') === slotId || (column.title2 && columnSideId(column) === slotId)) {
        delete column.sideSlot;
        delete column.title2;
        delete column.sideTitle;
    }

    const link = (targetId, targetSide, type) => {
        if (!targetId || targetId === slotId) return;
        if (!slots.some(slot => slot.id === targetId) && targetId !== slotId) {
            if (!listSlots(next).some(slot => slot.id === targetId)) return;
        }
        setSideRule(next, targetId, targetSide === 'away' ? 'away' : 'home', { type, of: slotId });
    };
    link(body.winnerTo, body.winnerSide, 'winner');
    link(body.loserTo, body.loserSide, 'loser');

    syncTemplate(next);

    const patch = {};
    if (body.series !== undefined) patch[slotId] = String(body.series || '');
    const homeRule = next.rules[slotId].home;
    const awayRule = next.rules[slotId].away;
    if (homeRule.type === 'manual') {
        patch[`${slotId}_t1id`] = String(body.homeTeam || '');
        patch[`${slotId}_t1`] = String(body.homeTeamName || '');
    }
    if (awayRule.type === 'manual') {
        patch[`${slotId}_t2id`] = String(body.awayTeam || '');
        patch[`${slotId}_t2`] = String(body.awayTeamName || '');
    }
    return { template: next, patch };
}

function importTemplate(raw, fallbackLabel) {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || !Array.isArray(parsed.columns)) {
        throw new Error('Šablona musí obsahovat pole columns.');
    }
    if (!parsed.label) parsed.label = fallbackLabel || 'Playoff';
    return prepareTemplate(parsed);
}

function presetCatalog() {
    return [
        { id: 'top4', label: '4 týmy', detail: '1–4 a 2–3, pak finále a zápas o 3. místo.' },
        { id: 'top6', label: '6 týmů', detail: 'První kolo 1–6, 2–5 a 3–4. Další kola doplníš na pavoukovi.' },
        { id: 'top8', label: '8 týmů', detail: 'Čtvrtfinále 1–8 až 4–5, semifinále, finále a o 3. místo.' },
        { id: 'playin', label: 'Play-in', detail: '7–10 a 8–9, k tomu 1–4 a 2–3. Postupy pak propojíš.' },
        { id: 'cross4', label: 'Kříž 4', detail: '1. A proti 2. B a 2. A proti 1. B, pak finále.' },
        { id: 'cross8', label: 'Kříž 8', detail: '1. A–4. B, 2. A–3. B, 3. A–2. B, 4. A–1. B a dál semifinále s finále.' },
        { id: 'groups', label: 'Po skupinách', detail: 'Každá skupina má vlastní semifinále 1–4 a 2–3.' },
        { id: 'relegation', label: 'Baráž', detail: 'Poslední dva celkové, nebo poslední z A proti poslednímu z B.' },
        { id: 'final', label: 'Finále', detail: 'Jen finále a zápas o 3. místo. Týmy vybereš ručně.' }
    ];
}

function place(placeNumber, group) {
    return { type: 'place', place: placeNumber, group: group || '' };
}

function winner(of) {
    return { type: 'winner', of };
}

function loser(of) {
    return { type: 'loser', of };
}

function pair(home, away) {
    return { home, away };
}

function presetTemplate(id, label) {
    const base = { label: label || 'Playoff', density: 'normal', columns: [], rules: {} };
    if (id === 'top4') {
        base.columns = [
            { title: 'Semifinále', slots: ['sf1', 'sf2'] },
            { title: 'Finále', slots: ['fin', 'third'], title2: 'O 3. místo', sideSlot: 'third' }
        ];
        base.rules = {
            sf1: pair(place(1), place(4)),
            sf2: pair(place(2), place(3)),
            fin: pair(winner('sf1'), winner('sf2')),
            third: pair(loser('sf1'), loser('sf2'))
        };
    } else if (id === 'top6') {
        base.columns = [{ title: 'Čtvrtfinále', slots: ['qf1', 'qf2', 'qf3'] }];
        base.rules = {
            qf1: pair(place(1), place(6)),
            qf2: pair(place(2), place(5)),
            qf3: pair(place(3), place(4))
        };
    } else if (id === 'top8') {
        base.columns = [
            { title: 'Čtvrtfinále', slots: ['qf1', 'qf2', 'qf3', 'qf4'] },
            { title: 'Semifinále', slots: ['sf1', 'sf2'] },
            { title: 'Finále', slots: ['fin', 'third'], title2: 'O 3. místo', sideSlot: 'third' }
        ];
        base.rules = {
            qf1: pair(place(1), place(8)),
            qf2: pair(place(2), place(7)),
            qf3: pair(place(3), place(6)),
            qf4: pair(place(4), place(5)),
            sf1: pair(winner('qf1'), winner('qf2')),
            sf2: pair(winner('qf3'), winner('qf4')),
            fin: pair(winner('sf1'), winner('sf2')),
            third: pair(loser('sf1'), loser('sf2'))
        };
    } else if (id === 'playin') {
        base.columns = [
            { title: 'Předkolo', slots: ['pi1', 'pi2'] },
            { title: 'Čtvrtfinále', slots: ['qf1', 'qf2'] }
        ];
        base.rules = {
            pi1: pair(place(7), place(10)),
            pi2: pair(place(8), place(9)),
            qf1: pair(place(1), place(4)),
            qf2: pair(place(2), place(3))
        };
    } else if (id === 'cross4') {
        base.columns = [
            { title: 'Semifinále', slots: ['sf1', 'sf2'] },
            { title: 'Finále', slots: ['fin'] }
        ];
        base.rules = {
            sf1: pair(place(1, 'A'), place(2, 'B')),
            sf2: pair(place(2, 'A'), place(1, 'B')),
            fin: pair(winner('sf1'), winner('sf2'))
        };
    } else if (id === 'cross8') {
        base.columns = [
            { title: 'Čtvrtfinále', slots: ['qf1', 'qf2', 'qf3', 'qf4'] },
            { title: 'Semifinále', slots: ['sf1', 'sf2'] },
            { title: 'Finále', slots: ['fin'] }
        ];
        base.rules = {
            qf1: pair(place(1, 'A'), place(4, 'B')),
            qf2: pair(place(2, 'A'), place(3, 'B')),
            qf3: pair(place(3, 'A'), place(2, 'B')),
            qf4: pair(place(4, 'A'), place(1, 'B')),
            sf1: pair(winner('qf1'), winner('qf2')),
            sf2: pair(winner('qf3'), winner('qf4')),
            fin: pair(winner('sf1'), winner('sf2'))
        };
    } else if (id === 'groups') {
        base.columns = [
            { title: 'Skupina A', slots: ['a1', 'a2'] },
            { title: 'Skupina B', slots: ['b1', 'b2'] }
        ];
        base.rules = {
            a1: pair(place(1, 'A'), place(4, 'A')),
            a2: pair(place(2, 'A'), place(3, 'A')),
            b1: pair(place(1, 'B'), place(4, 'B')),
            b2: pair(place(2, 'B'), place(3, 'B'))
        };
    } else if (id === 'relegation') {
        base.columns = [{ title: 'Baráž', slots: ['bar1'] }];
        base.rules = {
            bar1: pair({ type: 'fromEnd', offset: 2, group: '' }, { type: 'fromEnd', offset: 1, group: '' })
        };
    } else if (id === 'relegation-groups') {
        base.columns = [{ title: 'Baráž', slots: ['bar1'] }];
        base.rules = {
            bar1: pair({ type: 'fromEnd', offset: 1, group: 'A' }, { type: 'fromEnd', offset: 1, group: 'B' })
        };
    } else {
        base.columns = [
            { title: 'Finále', slots: ['fin', 'third'], title2: 'O 3. místo', sideSlot: 'third' }
        ];
        base.rules = {
            fin: pair({ type: 'manual' }, { type: 'manual' }),
            third: pair({ type: 'manual' }, { type: 'manual' })
        };
    }
    return syncTemplate(base);
}

function groupTeams(teamsByGroup, group) {
    const letters = Object.keys(teamsByGroup || {}).sort();
    if (!group) {
        if (letters.length === 1) return teamsByGroup[letters[0]] || [];
        if (teamsByGroup.X) return teamsByGroup.X;
        return letters.flatMap(letter => teamsByGroup[letter] || []);
    }
    return teamsByGroup[group] || [];
}

function seriesBySlot(savedSlots, slotId, matches) {
    const seriesId = savedSlots?.[slotId];
    const matchId = parseInt(String(seriesId || '').replace('series-', ''), 10);
    if (!Number.isFinite(matchId)) return null;
    return (matches || []).find(match => Number(match.id) === matchId) || null;
}

function playoffRanking(template, savedSlots, matches, teams) {
    const teamsById = new Map((teams || []).map(team => [Number(team.id), team]));
    const columns = template?.columns || [];
    let slotId = '';
    for (let index = columns.length - 1; index >= 0; index -= 1) {
        const column = columns[index];
        const side = columnSideId(column);
        const mains = (column.slots || []).map(id => String(id)).filter(id => id !== side);
        if (mains.length === 1 && /fin[aá]le/i.test(String(column.title || ''))) {
            slotId = mains[0];
            break;
        }
    }
    if (!slotId) {
        for (let index = columns.length - 1; index >= 0; index -= 1) {
            const column = columns[index];
            const side = columnSideId(column);
            const mains = (column.slots || []).map(id => String(id)).filter(id => id !== side);
            if (mains.length === 1) {
                slotId = mains[0];
                break;
            }
        }
    }
    if (!slotId) return [];
    const match = seriesBySlot(savedSlots, slotId, matches);
    const winner = seriesWinner(match, teamsById, 'winner');
    const loser = seriesWinner(match, teamsById, 'loser');
    const ranking = [];
    if (winner) ranking[0] = winner;
    if (loser) ranking[1] = loser;
    return ranking;
}

function seriesWinner(match, teamsById, which) {
    if (!match) return null;
    const bo = Number(match.bo) || 1;
    let home = 0;
    let away = 0;
    if (match.result && match.result.scoreHome !== '' && match.result.scoreHome !== undefined && match.result.scoreHome !== null) {
        home = Number(match.result.scoreHome);
        away = Number(match.result.scoreAway);
    } else if (Array.isArray(match.playedMatches)) {
        match.playedMatches.forEach(game => {
            const homeGoals = Number(game.scoreHome);
            const awayGoals = Number(game.scoreAway);
            if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals) || homeGoals === awayGoals) return;
            if (homeGoals > awayGoals) home += 1;
            else away += 1;
        });
    }
    const winsNeeded = bo > 1 ? Math.ceil(bo / 2) : 1;
    const homeWins = bo === 1 ? home > away : home >= winsNeeded;
    const awayWins = bo === 1 ? away > home : away >= winsNeeded;
    if (!homeWins && !awayWins) return null;
    const winnerId = homeWins ? match.homeTeamId : match.awayTeamId;
    const loserId = homeWins ? match.awayTeamId : match.homeTeamId;
    const team = teamsById.get(Number(which === 'loser' ? loserId : winnerId));
    return team || null;
}

function zoneClaim(team) {
    const status = team && team._clinchStatus;
    if (!status || status.locked) return '';
    if (status.currentZone === 'quarterfinal' && status.clinchedQF) return 'zatím čtvrtfinále';
    if (status.currentZone === 'playin' && status.clinchedPlayin) return 'zatím play-in';
    if (status.currentZone === 'relegation' && status.clinchedRelegation) return 'zatím baráž';
    if (status.currentZone === 'neutral' && status.clinchedNeutral) return 'zatím střed';
    return '';
}

function teamSeed(team, teamsByGroup) {
    const letters = Object.keys(teamsByGroup || {}).sort();
    for (const letter of letters) {
        const index = (teamsByGroup[letter] || []).findIndex(item => Number(item.id) === Number(team.id));
        if (index >= 0) return { rank: index + 1, group: letter };
    }
    return { rank: 999, group: 'Z' };
}

function resolveRule(rule, context) {
    if (!rule || rule.type === 'empty') return { state: 'empty', label: 'Bez pravidla' };
    const label = ruleLabel(rule);
    if (rule.type === 'manual') {
        const team = context.teamsById.get(Number(context.manualId));
        if (!team) return { state: 'empty', label: 'Vybraný tým chybí' };
        return { state: 'ready', team, label: team.name };
    }
    if (rule.type === 'place' || rule.type === 'fromEnd') {
        if (rule.phase === 'playoff') {
            const key = rule.league || context.leagueName;
            const ranking = (context.playoffRanks && context.playoffRanks[key]) || [];
            const dense = [];
            for (const team of ranking) {
                if (!team) break;
                dense.push(team);
            }
            if (rule.type === 'fromEnd' && dense.length < 2) return { state: 'wait', label };
            const index = rule.type === 'place'
                ? (Number(rule.place) - 1)
                : (dense.length - (Number(rule.offset) || 1));
            const team = dense[index];
            if (!team) return { state: 'wait', label };
            return { state: 'ready', team, label: team.name };
        }
        if (rule.league && !context.tables?.[rule.league]) return { state: 'wait', label };
        const foreign = rule.league ? context.tables[rule.league] : null;
        const teamsByGroup = foreign ? foreign.teamsByGroup : context.teamsByGroup;
        const lockedIds = foreign ? foreign.lockedIds : context.lockedIds;
        const list = groupTeams(teamsByGroup, rule.group || '');
        const index = rule.type === 'place'
            ? (Number(rule.place) - 1)
            : (list.length - (Number(rule.offset) || 1));
        const team = list[index];
        if (!team) return { state: 'wait', label };
        const locked = lockedIds && lockedIds.has(Number(team.id));
        if (!locked) {
            const zone = zoneClaim(team);
            if (zone) return { state: 'zone', team, zone, label: team.name };
            return { state: 'wait', team, label: `${team.name} (${label}, ještě není jistý)` };
        }
        return { state: 'ready', team, label: team.name };
    }
    if (rule.type === 'winner' || rule.type === 'loser') {
        const seriesId = context.savedSlots[rule.of];
        const matchId = parseInt(String(seriesId || '').replace('series-', ''), 10);
        const match = context.matches.find(item => Number(item.id) === matchId);
        const team = seriesWinner(match, context.teamsById, rule.type);
        if (!team) return { state: 'wait', label };
        return { state: 'ready', team, label: team.name };
    }
    if (rule.type === 'seed') {
        const roundIndex = context.slot.roundIndex;
        const previous = roundIndex > 0 ? context.template.columns[roundIndex - 1] : null;
        const ids = previous ? (previous.slots || []).map(id => String(id)).filter(id => id !== columnSideId(previous)) : [];
        if (!ids.length) return { state: 'wait', label };
        const winners = [];
        for (const id of ids) {
            const match = seriesBySlot(context.savedSlots, id, context.matches);
            const team = seriesWinner(match, context.teamsById, 'winner');
            if (!team) return { state: 'wait', label };
            winners.push(team);
        }
        const sorted = winners.slice().sort((a, b) => {
            const seedA = teamSeed(a, context.teamsByGroup);
            const seedB = teamSeed(b, context.teamsByGroup);
            const direction = rule.order === 'lowest' ? -1 : 1;
            if (seedA.rank !== seedB.rank) return (seedA.rank - seedB.rank) * direction;
            return seedA.group.localeCompare(seedB.group) * direction;
        });
        const team = sorted[(Number(rule.rank) || 1) - 1];
        if (!team) return { state: 'wait', label };
        return { state: 'ready', team, label: team.name };
    }
    return { state: 'empty', label: 'Bez pravidla' };
}

function planPlayoffFill(input) {
    const template = prepareTemplate(input.template, input.positionConfig);
    const savedSlots = input.savedSlots || {};
    const teams = input.teams || [];
    const teamsById = new Map(teams.map(team => [Number(team.id), team]));
    const lockedIds = input.lockedIds instanceof Set
        ? new Set([...input.lockedIds].map(id => Number(id)))
        : new Set((input.lockedIds || []).map(id => Number(id)));
    const lines = [];

    listSlots(template).forEach(slot => {
        if (input.onlySlot && input.onlySlot !== slot.id) return;
        const seriesKey = savedSlots[slot.id];
        const context = {
            template,
            slot,
            leagueName: input.leagueName || '',
            teamsByGroup: input.teamsByGroup || {},
            tables: input.tables || {},
            playoffRanks: input.playoffRanks || {},
            teamsById,
            matches: input.matches || [],
            savedSlots,
            lockedIds
        };
        const homeRule = template.rules[slot.id]?.home;
        const awayRule = template.rules[slot.id]?.away;
        const home = resolveRule(template.rules[slot.id]?.home, {
            ...context,
            manualId: savedSlots[`${slot.id}_t1id`]
        });
        const away = resolveRule(template.rules[slot.id]?.away, {
            ...context,
            manualId: savedSlots[`${slot.id}_t2id`]
        });
        const clearSides = [
            { side: 'home', rule: homeRule, resolved: home, suffix: 't1' },
            { side: 'away', rule: awayRule, resolved: away, suffix: 't2' }
        ]
            .filter(({ rule, resolved, suffix }) => {
                if (!['place', 'fromEnd'].includes(rule?.type)) return false;
                const storedId = savedSlots[`${slot.id}_${suffix}id`];
                const storedName = savedSlots[`${slot.id}_${suffix}`];
                if ((storedId === undefined || storedId === null || storedId === '') && !storedName) return false;
                if (resolved.state !== 'ready') return true;
                if (storedId !== undefined && storedId !== null && storedId !== '') {
                    return Number(storedId) !== Number(resolved.team.id) ||
                        (storedName && String(storedName) !== String(resolved.team.name));
                }
                return String(storedName) !== String(resolved.team.name);
            })
            .map(({ side }) => side);

        if (seriesKey && String(seriesKey).startsWith('series-')) {
            const usesRankedPositions = [homeRule, awayRule].some(rule =>
                ['place', 'fromEnd'].includes(rule?.type)
            );
            if (!usesRankedPositions) {
                lines.push({ slotId: slot.id, action: 'keep', message: `${slot.id.toUpperCase()}: série už je připojená.` });
                return;
            }

            const matchId = Number(String(seriesKey).replace(/^series-/, ''));
            const linkedMatch = (input.matches || []).find(match => Number(match.id) === matchId);
            const teamIds = linkedMatch
                ? new Set([Number(linkedMatch.homeTeamId), Number(linkedMatch.awayTeamId)])
                : new Set();
            const expectedRankedIds = [
                { rule: homeRule, resolved: home },
                { rule: awayRule, resolved: away }
            ]
                .filter(({ rule }) => ['place', 'fromEnd'].includes(rule?.type))
                .map(({ resolved }) => resolved.state === 'ready' ? Number(resolved.team.id) : 0);
            const rulesMatchCurrentTeams = [
                { rule: homeRule, resolved: home },
                { rule: awayRule, resolved: away }
            ].every(({ rule, resolved }) => {
                if (!['place', 'fromEnd'].includes(rule?.type)) return true;
                return resolved.state === 'ready' && teamIds.has(Number(resolved.team.id));
            });

            if (linkedMatch &&
                rulesMatchCurrentTeams &&
                expectedRankedIds.length > 0 &&
                expectedRankedIds.every(id => id > 0) &&
                new Set(expectedRankedIds).size === expectedRankedIds.length &&
                expectedRankedIds.every(id => teamIds.has(id))) {
                lines.push({ slotId: slot.id, action: 'keep', message: `${slot.id.toUpperCase()}: série už odpovídá uzamčeným pozicím.` });
                return;
            }

            if (home.state === 'ready' && away.state === 'ready' && Number(home.team.id) !== Number(away.team.id)) {
                lines.push({
                    slotId: slot.id,
                    action: 'create',
                    homeId: home.team.id,
                    awayId: away.team.id,
                    homeName: home.team.name,
                    awayName: away.team.name,
                    homeLeague: home.team.liga || '',
                    awayLeague: away.team.liga || '',
                    replaceStale: true,
                    clearSides,
                    message: `${slot.id.toUpperCase()}: stará série neodpovídá uzamčeným pozicím; přiřadí se ${home.team.name} proti ${away.team.name}.`
                });
            } else {
                lines.push({
                    slotId: slot.id,
                    action: 'clear-stale',
                    clearSides,
                    message: `${slot.id.toUpperCase()}: staré přiřazení se odpojí; série čeká na uzamčení přesných pozic.`
                });
            }
            return;
        }

        if (home.state === 'ready' && away.state === 'ready') {
            if (Number(home.team.id) === Number(away.team.id)) {
                lines.push({ slotId: slot.id, action: 'none', message: `${slot.id.toUpperCase()}: obě strany jsou stejný tým.` });
                return;
            }
            lines.push({
                slotId: slot.id,
                action: seriesKey ? 'keep' : 'create',
                homeId: home.team.id,
                awayId: away.team.id,
                homeName: home.team.name,
                awayName: away.team.name,
                homeLeague: home.team.liga || '',
                awayLeague: away.team.liga || '',
                clearSides,
                message: seriesKey
                    ? `${slot.id.toUpperCase()}: ${home.team.name} proti ${away.team.name}. Série už existuje.`
                    : `${slot.id.toUpperCase()}: ${home.team.name} proti ${away.team.name}. Vytvoří se série.`
            });
            return;
        }

        const fills = [];
        if (home.state === 'ready' && (!savedSlots[`${slot.id}_t1id`] || clearSides.includes('home'))) {
            fills.push({ side: 'home', id: home.team.id, name: home.team.name, league: home.team.liga || '' });
        }
        if (away.state === 'ready' && (!savedSlots[`${slot.id}_t2id`] || clearSides.includes('away'))) {
            fills.push({ side: 'away', id: away.team.id, name: away.team.name, league: away.team.liga || '' });
        }
        const zoneNotes = [home, away]
            .filter(side => side.state === 'zone' && side.team)
            .map(side => `${side.team.name} (${side.zone})`);
        const zoneText = zoneNotes.length ? ` V oblasti: ${zoneNotes.join(', ')}. Série se nezakládá.` : '';
        const waitText = [home, away].filter(side => side.state === 'wait').map(side => side.label).join(', ');
        if (fills.length) {
            lines.push({
                slotId: slot.id,
                action: 'fill',
                clearSides,
                fills,
                message: `${slot.id.toUpperCase()}: doplní se ${fills.map(side => side.name).join(' a ')}.${waitText ? ` Čeká se na ${waitText}.` : ''}${zoneText}`
            });
            return;
        }
        if (waitText || zoneNotes.length) {
            lines.push({
                slotId: slot.id,
                action: clearSides.length ? 'clear-stale' : 'none',
                clearSides,
                message: `${slot.id.toUpperCase()}: ${waitText ? `čeká se na ${waitText}.` : 'místo ještě není zamčené.'}${zoneText}`
            });
            return;
        }
        lines.push({ slotId: slot.id, action: 'none', message: `${slot.id.toUpperCase()}: ${home.label} proti ${away.label}.` });
    });

    return lines;
}

function sortGroupForZone(teams, leagueObj, season, matches, leagueName) {
    const list = (teams || []).slice();
    const miniStats = new Map();
    const pointsGroups = new Map();
    list.forEach(team => {
        const points = Number(team.stats?.[season]?.points) || 0;
        if (!pointsGroups.has(points)) pointsGroups.set(points, []);
        pointsGroups.get(points).push(Number(team.id));
    });

    pointsGroups.forEach(teamIds => {
        const tiedIds = new Set(teamIds);
        const groupStats = new Map(teamIds.map(id => [id, { points: 0, diff: 0, gf: 0 }]));
        (matches || []).forEach(match => {
            if (match.season !== season || match.liga !== leagueName || !match.result || match.isPlayoff) return;
            const homeId = Number(match.homeTeamId);
            const awayId = Number(match.awayTeamId);
            if (!tiedIds.has(homeId) || !tiedIds.has(awayId)) return;
            const homeGoals = Number(match.result?.scoreHome ?? match.scoreHome ?? 0);
            const awayGoals = Number(match.result?.scoreAway ?? match.scoreAway ?? 0);
            const overtime = Boolean(match.result?.ot || match.ot);
            let homePoints = 1;
            let awayPoints = 1;
            if (homeGoals > awayGoals) {
                homePoints = overtime ? 2 : 3;
                awayPoints = overtime ? 1 : 0;
            } else if (awayGoals > homeGoals) {
                awayPoints = overtime ? 2 : 3;
                homePoints = overtime ? 1 : 0;
            }
            const home = groupStats.get(homeId);
            const away = groupStats.get(awayId);
            home.points += homePoints;
            home.diff += homeGoals - awayGoals;
            home.gf += homeGoals;
            away.points += awayPoints;
            away.diff += awayGoals - homeGoals;
            away.gf += awayGoals;
        });
        groupStats.forEach((value, id) => miniStats.set(id, value));
    });

    const directMatchResult = (teamA, teamB) => {
        const match = (matches || []).find(item =>
            item.season === season &&
            item.liga === leagueName &&
            item.result &&
            !item.isPlayoff &&
            ((Number(item.homeTeamId) === Number(teamA.id) && Number(item.awayTeamId) === Number(teamB.id)) ||
                (Number(item.homeTeamId) === Number(teamB.id) && Number(item.awayTeamId) === Number(teamA.id)))
        );
        if (!match) return 0;
        const homeScore = Number(match.result?.scoreHome ?? match.scoreHome ?? 0);
        const awayScore = Number(match.result?.scoreAway ?? match.scoreAway ?? 0);
        const teamAScore = Number(match.homeTeamId) === Number(teamA.id) ? homeScore : awayScore;
        const teamBScore = Number(match.homeTeamId) === Number(teamA.id) ? awayScore : homeScore;
        return teamAScore === teamBScore ? 0 : (teamAScore > teamBScore ? -1 : 1);
    };

    return list.sort((a, b) => {
        const aStats = a.stats?.[season] || {};
        const bStats = b.stats?.[season] || {};
        const pointsA = aStats.points || 0;
        const pointsB = bStats.points || 0;
        if (pointsB !== pointsA) return pointsB - pointsA;
        const tieA = aStats.tiebreaker || 0;
        const tieB = bStats.tiebreaker || 0;
        if (tieA !== tieB) return tieA - tieB;

        const miniA = miniStats.get(Number(a.id)) || { points: 0, diff: 0, gf: 0 };
        const miniB = miniStats.get(Number(b.id)) || { points: 0, diff: 0, gf: 0 };
        if (miniB.points !== miniA.points) return miniB.points - miniA.points;

        const overallDiffA = (Number(aStats.gf) || 0) - (Number(aStats.ga) || 0);
        const overallDiffB = (Number(bStats.gf) || 0) - (Number(bStats.ga) || 0);
        const goalDiffFirst = leagueObj?.tiebreakerPriority === 'goalDiff';
        if (goalDiffFirst && overallDiffA !== overallDiffB) return overallDiffB - overallDiffA;
        if (miniB.diff !== miniA.diff) return miniB.diff - miniA.diff;
        if (miniB.gf !== miniA.gf) return miniB.gf - miniA.gf;

        const headToHead = directMatchResult(a, b);
        if (headToHead) return headToHead;
        return goalDiffFirst ? 0 : overallDiffB - overallDiffA;
    });
}

function refreshStandingsStats(teams, matches, season, bonusData) {
    const statsByTeam = new Map();
    const leagueByTeam = new Map();
    (teams || []).forEach(team => {
        statsByTeam.set(Number(team.id), { points: 0, wins: 0, otWins: 0, otLosses: 0, losses: 0, gf: 0, ga: 0 });
        leagueByTeam.set(Number(team.id), team.liga);
    });

    (matches || []).forEach(match => {
        if (match.season !== season || match.isPlayoff || !match.result) return;
        const homeId = Number(match.homeTeamId);
        const awayId = Number(match.awayTeamId);
        const home = statsByTeam.get(homeId);
        const away = statsByTeam.get(awayId);
        if (!home || !away || match.liga !== leagueByTeam.get(homeId) || match.liga !== leagueByTeam.get(awayId)) return;
        const homeGoals = parseInt(match.result.scoreHome, 10);
        const awayGoals = parseInt(match.result.scoreAway, 10);
        if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return;

        home.gf += homeGoals;
        home.ga += awayGoals;
        away.gf += awayGoals;
        away.ga += homeGoals;

        const overtime = Boolean(match.result.ot);
        if (homeGoals === awayGoals) {
            if (overtime && (match.result.overtimeWinner === 'home' || match.result.overtimeWinner === 'away')) {
                const winner = match.result.overtimeWinner === 'home' ? home : away;
                const loser = winner === home ? away : home;
                winner.points += 2;
                winner.otWins += 1;
                loser.points += 1;
                loser.otLosses += 1;
            } else {
                home.points += 1;
                away.points += 1;
            }
        } else {
            const winner = homeGoals > awayGoals ? home : away;
            const loser = winner === home ? away : home;
            if (overtime) {
                winner.points += 2;
                winner.otWins += 1;
                loser.points += 1;
                loser.otLosses += 1;
            } else {
                winner.points += 3;
                winner.wins += 1;
                loser.losses += 1;
            }
        }
    });

    return (teams || []).map(team => {
        const stats = statsByTeam.get(Number(team.id));
        let bonus = bonusData?.[season]?.[team.liga]?.[team.id] || {};
        if (typeof bonus === 'number') bonus = { points: bonus };
        const seasonStats = {
            ...(team.stats?.[season] || {}),
            ...stats,
            points: stats.points + (Number(bonus.points) || 0),
            gf: stats.gf + (Number(bonus.gf) || 0),
            ga: stats.ga + (Number(bonus.ga) || 0),
            manualGames: Number(bonus.games) || 0,
            tiebreaker: Number(bonus.tiebreaker) || 0
        };
        return {
            ...team,
            stats: {
                ...(team.stats || {}),
                [season]: seasonStats
            }
        };
    });
}

function buildLeagueTable(teams, leagueObj, season, matches, leagueName, calculateClinchStatusesForGroup, clinchMode) {
    const mode = clinchMode === 'strict' || clinchMode === 'cascade'
        ? clinchMode
        : (leagueObj && (leagueObj.clinchMode === 'strict' || leagueObj.clinchMode === 'cascade')
            ? leagueObj.clinchMode
            : 'cascade');
    const teamsByGroup = {};
    (teams || []).forEach(team => {
        const groupNumber = Number(team.group);
        const groupLetter = leagueObj?.isMultigroup && groupNumber
            ? String.fromCharCode(groupNumber + 64)
            : 'X';
        if (!teamsByGroup[groupLetter]) teamsByGroup[groupLetter] = [];
        teamsByGroup[groupLetter].push(team);
    });
    const scores = {};
    (teams || []).forEach(team => {
        const stats = team.stats?.[season] || {};
        scores[team.id] = { gf: stats.gf || 0, ga: stats.ga || 0 };
    });
    const lockedIds = new Set();
    Object.keys(teamsByGroup).forEach(group => {
        teamsByGroup[group] = calculateClinchStatusesForGroup(
            sortGroupForZone(teamsByGroup[group], leagueObj, season, matches, leagueName),
            leagueObj,
            season,
            mode,
            scores,
            matches,
            leagueName
        );
        teamsByGroup[group].forEach(team => {
            if (team._clinchStatus && team._clinchStatus.locked) lockedIds.add(Number(team.id));
        });
    });
    return { teamsByGroup, lockedIds };
}

function zoneFacesForBracket(input) {
    const template = prepareTemplate(input.template, input.positionConfig);
    const savedSlots = input.savedSlots || {};
    const teams = input.teams || [];
    const teamsById = new Map(teams.map(team => [Number(team.id), team]));
    const lockedIds = input.lockedIds instanceof Set
        ? new Set([...input.lockedIds].map(id => Number(id)))
        : new Set((input.lockedIds || []).map(id => Number(id)));
    const faces = {};
    listSlots(template).forEach(slot => {
        if (String(savedSlots[slot.id] || '').startsWith('series-')) return;
        const context = {
            template,
            slot,
            leagueName: input.leagueName || '',
            teamsByGroup: input.teamsByGroup || {},
            tables: input.tables || {},
            playoffRanks: input.playoffRanks || {},
            teamsById,
            matches: input.matches || [],
            savedSlots,
            lockedIds,
            ignoreLock: false
        };
        const pack = (side, ruleSide, suffix) => {
            const resolved = resolveRule(template.rules[slot.id]?.[ruleSide], {
                ...context,
                manualId: savedSlots[`${slot.id}_${suffix}id`]
            });
            if (savedSlots[`${slot.id}_${suffix}id`]) return null;
            if (!resolved.team) return null;
            if (resolved.state === 'ready') {
                const team = resolved.team;
                return {
                    id: team.id,
                    name: team.name,
                    league: team.liga || '',
                    logo: team.logo ? `/logoteamu/${team.logo}` : '',
                    locked: true
                };
            }
            return null;
        };
        const home = pack('home', 'home', 't1');
        const away = pack('away', 'away', 't2');
        if (home || away) faces[slot.id] = { home, away };
    });
    return faces;
}

function collectZonePreview(input) {
    const template = prepareTemplate(input.template, input.positionConfig);
    if (!template || !template.rules || Object.keys(template.rules).length === 0) return null;

    const league = input.league;
    const season = input.season;
    const matches = input.matches || [];
    const calculateClinchStatusesForGroup = input.calculateClinchStatusesForGroup;
    const clinchMode = input.clinchMode;

    let standing = null;
    if (input.teamsByGroup && input.lockedIds) {
        standing = {
            teamsByGroup: input.teamsByGroup,
            lockedIds: input.lockedIds instanceof Set ? input.lockedIds : new Set(input.lockedIds)
        };
    } else {
        const leagueObj = (input.leagues || []).find(item => item.name === league) || input.leagueObj || null;
        standing = buildLeagueTable(
            input.teamsInLeague || input.teams || [],
            leagueObj,
            season,
            matches,
            league,
            calculateClinchStatusesForGroup,
            clinchMode
        );
    }

    const needed = new Set([league]);
    Object.values(template.rules || {}).forEach(sides => {
        ['home', 'away'].forEach(side => {
            const rule = sides?.[side];
            if (!rule) return;
            if (rule.league) needed.add(rule.league);
            if (rule.phase === 'playoff') needed.add(rule.league || league);
        });
    });

    const tables = {};
    const playoffRanks = {};
    needed.forEach(name => {
        if (name === league) {
            tables[name] = standing;
            playoffRanks[name] = playoffRanking(template, input.savedSlots, matches, input.teamsInLeague || input.teams || []);
            return;
        }
        const foreignLeagueObj = (input.leagues || []).find(item => item.name === name) || null;
        const foreignTeams = (input.seasonTeams || input.teams || []).filter(team => team.liga === name);
        tables[name] = buildLeagueTable(
            foreignTeams,
            foreignLeagueObj,
            season,
            matches,
            name,
            calculateClinchStatusesForGroup,
            clinchMode
        );
        const format = foreignLeagueObj?.playoffFormat;
        const foreignTemplate = format && input.templates ? input.templates[format] : null;
        playoffRanks[name] = playoffRanking(
            foreignTemplate,
            input.playoffData?.[season]?.[name] || {},
            matches,
            foreignTeams
        );
    });

    return zoneFacesForBracket({
        template,
        positionConfig: input.positionConfig,
        savedSlots: input.savedSlots || {},
        teams: input.teamsInLeague || input.teams || [],
        teamsByGroup: standing.teamsByGroup,
        tables,
        playoffRanks,
        leagueName: league,
        lockedIds: standing.lockedIds,
        matches
    });
}

function resolveNameIds(savedSlots, teams) {
    const next = { ...(savedSlots || {}) };
    const byName = new Map();
    (teams || []).forEach(team => {
        const name = String(team?.name || '').trim();
        if (!name) return;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(team);
    });
    const unresolved = [];
    let changed = false;
    Object.keys(savedSlots || {}).forEach(key => {
        if (!/_(t1|t2)$/.test(key)) return;
        const name = String(savedSlots[key] || '').trim();
        if (!name) return;
        const idKey = `${key}id`;
        if (next[idKey] !== undefined && next[idKey] !== null && String(next[idKey]) !== '') return;
        const matches = byName.get(name) || [];
        if (matches.length !== 1) {
            unresolved.push(name);
            return;
        }
        next[idKey] = String(matches[0].id);
        changed = true;
    });
    return { slots: next, unresolved: [...new Set(unresolved)], changed };
}

function optionList(items, selected, emptyLabel) {
    const options = [`<option value="">${escapeHtml(emptyLabel || '—')}</option>`];
    items.forEach(item => {
        const value = item.value !== undefined ? item.value : item;
        const label = item.label !== undefined ? item.label : item;
        options.push(`<option value="${escapeHtml(value)}" ${String(selected) === String(value) ? 'selected' : ''}>${escapeHtml(label)}</option>`);
    });
    return options.join('');
}

function ruleFields(prefix, rule, slots, groups, slotId, leagues) {
    const current = rule || blankRule();
    const types = [
        ['empty', 'Nic'],
        ['place', 'Místo v tabulce'],
        ['fromEnd', 'Od konce tabulky'],
        ['winner', 'Vítěz zápasu'],
        ['loser', 'Poražený zápasu'],
        ['seed', 'Seed z předchozího kola'],
        ['manual', 'Vybraný tým']
    ];
    const others = slots.filter(slot => slot.id !== slotId);
    return `
        <label class="pb-field">${prefix === 'home' ? 'Domácí' : 'Hosté'}
            <select name="${prefix}Type" data-rule-type="${prefix}">
                ${types.map(([value, label]) => `<option value="${value}" ${current.type === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
        </label>
        <div class="pb-rule-extra" data-rule-panel="${prefix}" data-show="empty place fromEnd">
            <label class="pb-field">Liga
                <select name="${prefix}League" data-rule-league="${prefix}">
                    <option value="" ${!current.league ? 'selected' : ''}>Tahle liga</option>
                    ${(leagues || []).map(name => `<option value="${escapeHtml(name)}" ${current.league === name ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}
                </select>
            </label>
            <label class="pb-field">Odkud
                <select name="${prefix}Phase" data-rule-phase="${prefix}">
                    <option value="table" ${current.phase !== 'playoff' ? 'selected' : ''}>Základní část</option>
                    <option value="playoff" ${current.phase === 'playoff' ? 'selected' : ''}>Playoff</option>
                </select>
            </label>
            <label class="pb-field" data-show="place">Místo
                <input name="${prefix}Place" type="number" min="1" value="${escapeHtml(current.place || 1)}">
            </label>
            <label class="pb-field" data-show="fromEnd">Od konce
                <input name="${prefix}Offset" type="number" min="1" value="${escapeHtml(current.offset || 1)}">
            </label>
            ${groups.length ? `<label class="pb-field" data-rule-group="${prefix}">Skupina
                <select name="${prefix}Group">
                    <option value="" ${!current.group ? 'selected' : ''}>Celá tabulka</option>
                    ${groups.map(group => `<option value="${escapeHtml(group)}" ${current.group === group ? 'selected' : ''}>${escapeHtml(group)}</option>`).join('')}
                </select>
            </label>` : `<input type="hidden" name="${prefix}Group" value="">`}
        </div>
        <label class="pb-field pb-rule-extra" data-rule-panel="${prefix}" data-show="winner loser">Zápas
            <select name="${prefix}Of">${optionList(others.map(slot => ({ value: slot.id, label: slot.id.toUpperCase() })), current.of, 'Vyber zápas')}</select>
        </label>
        <div class="pb-rule-extra" data-rule-panel="${prefix}" data-show="seed">
            <label class="pb-field">Pořadí
                <input name="${prefix}Rank" type="number" min="1" value="${escapeHtml(current.rank || 1)}">
            </label>
            <label class="pb-field">Který
                <select name="${prefix}Order">
                    <option value="highest" ${current.order !== 'lowest' ? 'selected' : ''}>Nejvyšší seed</option>
                    <option value="lowest" ${current.order === 'lowest' ? 'selected' : ''}>Nejnižší seed</option>
                </select>
            </label>
        </div>`;
}

function editorScript() {
    return `
    <script>
    (function () {
        function refreshRules(root) {
            root.querySelectorAll('[data-rule-type]').forEach(function (select) {
                var prefix = select.getAttribute('data-rule-type');
                var type = select.value;
                root.querySelectorAll('[data-rule-panel="' + prefix + '"]').forEach(function (panel) {
                    var show = (panel.getAttribute('data-show') || '').split(' ');
                    var visible = show.indexOf(type) !== -1;
                    panel.hidden = !visible;
                    panel.querySelectorAll('[data-show]').forEach(function (part) {
                        var partShow = (part.getAttribute('data-show') || '').split(' ');
                        part.hidden = partShow.indexOf(type) === -1;
                    });
                });
                var league = root.querySelector('[data-rule-league="' + prefix + '"]');
                var phase = root.querySelector('[data-rule-phase="' + prefix + '"]');
                var group = root.querySelector('[data-rule-group="' + prefix + '"]');
                if (group) group.hidden = Boolean((league && league.value) || (phase && phase.value === 'playoff'));
            });
        }
        document.querySelectorAll('.pb-inspector').forEach(refreshRules);
        document.addEventListener('change', function (event) {
            if (!event.target.matches('[data-rule-type], [data-rule-league], [data-rule-phase]')) return;
            if (event.target.matches('[data-rule-league], [data-rule-phase]')) {
                var prefix = event.target.getAttribute('data-rule-league') || event.target.getAttribute('data-rule-phase');
                var inspector = event.target.closest('.pb-inspector');
                var typeSelect = inspector && inspector.querySelector('[data-rule-type="' + prefix + '"]');
                var league = inspector && inspector.querySelector('[data-rule-league="' + prefix + '"]');
                var phase = inspector && inspector.querySelector('[data-rule-phase="' + prefix + '"]');
                var foreign = (league && league.value) || (phase && phase.value === 'playoff');
                if (typeSelect && foreign && (typeSelect.value === 'empty' || typeSelect.value === 'seed' || typeSelect.value === 'winner' || typeSelect.value === 'loser' || typeSelect.value === 'manual')) {
                    typeSelect.value = 'place';
                }
            }
            var root = event.target.closest('.pb-inspector');
            if (root) refreshRules(root);
        });
    })();
    </script>`;
}

function renderPlayoffAdminPage(data) {
    const template = data.template ? prepareTemplate(data.template, data.positionConfig) : null;
    const slots = template ? listSlots(template) : [];
    const selected = slots.find(slot => slot.id === data.selectedSlot) || null;
    const groups = data.groups || [];
    const leagueQuery = `league=${encodeURIComponent(data.league)}`;
    const editBase = `/admin/playoff?${leagueQuery}`;
    const bracket = template
        ? renderPlayoffBracket({
            template,
            savedSlots: data.savedSlots || {},
            matches: data.matches || [],
            teams: data.teams || [],
            scores: data.scores || {},
            zoneFaces: data.zoneFaces || null,
            ranks: data.ranks || null,
            selectedSeason: data.season,
            selectedLiga: data.league,
            visible: true,
            heading: `Playoff · ${data.league} ${data.season}`,
            editBase,
            selectedSlot: selected?.id || ''
        })
        : `<p class="pb-missing">Tahle liga ještě nemá formát pavouka. Vyber předlohu a tím formát vznikne.</p>`;

    const hidden = `
        <input type="hidden" name="_csrf" value="${escapeHtml(data.csrf)}">
        <input type="hidden" name="season" value="${escapeHtml(data.season)}">
        <input type="hidden" name="league" value="${escapeHtml(data.league)}">
        <input type="hidden" name="format" value="${escapeHtml(data.formatKey || '')}">`;

    const rounds = template ? template.columns.map((column, index) => ({ value: String(index), label: column.title || `Kolo ${index + 1}` })) : [];
    const presetOptions = presetCatalog().map(item =>
        `<option value="${item.id}">${escapeHtml(item.label)} — ${escapeHtml(item.detail)}</option>`
    ).join('');
    const relegationGroups = `<option value="relegation-groups">Baráž skupin — poslední A proti poslednímu B.</option>`;

    const toolbar = template ? `
        <form class="pb-editor-row" method="POST" action="/admin/playoff/editor">
            ${hidden}
            <input type="hidden" name="action" value="add-round">
            <input name="title" placeholder="Název kola" aria-label="Název kola">
            <button type="submit">Přidat kolo</button>
        </form>
        <form class="pb-editor-row" method="POST" action="/admin/playoff/editor">
            ${hidden}
            <input type="hidden" name="action" value="add-slot">
            <select name="roundIndex">${rounds.map(round => `<option value="${round.value}">${escapeHtml(round.label)}</option>`).join('')}</select>
            <button type="submit">Přidat zápas</button>
        </form>
        <form class="pb-editor-row" method="POST" action="/admin/playoff/editor">
            ${hidden}
            <input type="hidden" name="action" value="density">
            <select name="density">
                <option value="tight" ${template.density === 'tight' ? 'selected' : ''}>Těsné</option>
                <option value="normal" ${template.density === 'normal' ? 'selected' : ''}>Normální</option>
                <option value="loose" ${template.density === 'loose' ? 'selected' : ''}>Volné</option>
            </select>
            <button type="submit">Hustota</button>
        </form>` : '';

    const presets = `
        <form class="pb-editor-row" method="POST" action="/admin/playoff/editor" ${template ? `onsubmit="return confirm('Předloha nahradí tvar tohoto pavouka. Série v sezóně zůstanou.');"` : ''}>
            ${hidden}
            <input type="hidden" name="action" value="preset">
            <select name="preset">${presetOptions}${relegationGroups}</select>
            <button type="submit">Vložit předlohu</button>
        </form>
        ${template ? `<form class="pb-editor-row" method="POST" action="/admin/playoff/editor">
            ${hidden}
            <input type="hidden" name="action" value="duplicate">
            <button type="submit">Duplikovat formát pro tuhle ligu</button>
        </form>` : ''}`;

    const planBlock = data.plan ? `
        <section class="pb-plan">
            <h3>Co se doplní</h3>
            <ul>${data.plan.map(line => `<li>${escapeHtml(line.message)}</li>`).join('') || '<li>Není co doplnit.</li>'}</ul>
            <form method="POST" action="/admin/playoff/fill">
                ${hidden}
                <button type="submit">Doplnit podle pravidel</button>
            </form>
        </section>` : `
        <form method="GET" action="/admin/playoff" class="pb-editor-row">
            <input type="hidden" name="league" value="${escapeHtml(data.league)}">
            <input type="hidden" name="plan" value="1">
            ${selected ? `<input type="hidden" name="slot" value="${escapeHtml(selected.id)}">` : ''}
            <button type="submit">Ukázat, co se doplní</button>
        </form>`;

    let inspector = '';
    if (selected && template) {
        const rule = template.rules[selected.id] || { home: blankRule(), away: blankRule() };
        const column = template.columns[selected.roundIndex];
        const teamOptions = (data.teams || [])
            .filter(team => team.liga === data.league)
            .map(team => ({ value: String(team.id), label: team.name }));
        const slotOptions = slots.filter(slot => slot.id !== selected.id).map(slot => ({ value: slot.id, label: `${slot.id.toUpperCase()} · ${slot.title}` }));
        const seriesOptions = (data.playoffMatches || []).map(match => ({
            value: `series-${match.id}`,
            label: match.label
        }));
        const saved = data.savedSlots || {};
        inspector = `
        <form class="pb-inspector" id="pb-editor" method="POST" action="/admin/playoff/editor">
            ${hidden}
            <input type="hidden" name="slotId" value="${escapeHtml(selected.id)}">
            <h3>${escapeHtml(selected.id.toUpperCase())}</h3>
            <p class="pb-admin-note">U domácích i hostů je hned výběr Ligy a Odkud. Jiná liga platí pro místo v tabulce nebo od konce. Základní část bere tabulku, Playoff bere pořadí playoff té ligy.</p>
            <label class="pb-field">Název kola
                <input name="roundTitle" value="${escapeHtml(column.title || '')}">
            </label>
            ${ruleFields('home', rule.home, slots, groups, selected.id, data.leagueNames || [])}
            <label class="pb-field pb-rule-extra" data-rule-panel="home" data-show="manual">Tým pro tuhle sezónu
                <select name="homeTeam">${optionList(teamOptions, saved[`${selected.id}_t1id`], 'Vyber tým')}</select>
            </label>
            ${ruleFields('away', rule.away, slots, groups, selected.id, data.leagueNames || [])}
            <label class="pb-field pb-rule-extra" data-rule-panel="away" data-show="manual">Tým pro tuhle sezónu
                <select name="awayTeam">${optionList(teamOptions, saved[`${selected.id}_t2id`], 'Vyber tým')}</select>
            </label>
            <label class="pb-field">Série
                <select name="series">${optionList(seriesOptions, saved[selected.id], 'Bez série')}</select>
            </label>
            <label class="pb-check"><input type="checkbox" name="asSide" value="1" ${selected.side ? 'checked' : ''}> Zápas mimo strom, pod sloupcem</label>
            <label class="pb-field">Nadpis vedlejšího zápasu
                <input name="sideTitle" value="${escapeHtml(selected.side ? (column.title2 || '') : '')}" placeholder="O 3. místo">
            </label>
            <div class="pb-editor-row">
                <label class="pb-field">Vítěz jde do
                    <select name="winnerTo">${optionList(slotOptions, '', 'Nepřipojovat')}</select>
                </label>
                <label class="pb-field">jako
                    <select name="winnerSide"><option value="home">domácí</option><option value="away">hosté</option></select>
                </label>
            </div>
            <div class="pb-editor-row">
                <label class="pb-field">Poražený jde do
                    <select name="loserTo">${optionList(slotOptions, '', 'Nepřipojovat')}</select>
                </label>
                <label class="pb-field">jako
                    <select name="loserSide"><option value="home">domácí</option><option value="away">hosté</option></select>
                </label>
            </div>
            <div class="pb-editor-actions">
                <button type="submit" name="action" value="save-slot">Uložit zápas</button>
                <button type="submit" name="action" value="create-series">Vytvořit sérii z jistých týmů</button>
                <button type="submit" name="action" value="clear-slot" onclick="return confirm('Odpojit sérii a vymazat týmy z tohoto slotu? Neodehraná série bez termínu se může odstranit.');">Vymazat týmy / odpojit sérii</button>
                <button type="submit" name="action" value="delete-slot" onclick="return confirm('Odebrat tenhle zápas z pavouka?');">Odebrat zápas</button>
            </div>
        </form>`;
    }

    const jsonBlock = template ? `
        <details class="pb-json">
            <summary>JSON formátu</summary>
            <form method="POST" action="/admin/playoff/editor">
                ${hidden}
                <input type="hidden" name="action" value="import">
                <textarea name="structure">${escapeHtml(JSON.stringify(template, null, 2))}</textarea>
                <button type="submit">Uložit JSON</button>
            </form>
        </details>` : '';

    const users = Number(data.formatUsers || 0);
    const shared = users > 1
        ? `<p class="pb-admin-note">Formát ${escapeHtml(data.formatKey)} používá ${users} lig. Úprava tvaru se projeví u všech. Pro samostatný tvar použij duplikaci.</p>`
        : '';
    const unresolved = Array.isArray(data.unresolved) ? data.unresolved.filter(Boolean) : [];
    const unresolvedNote = unresolved.length
        ? `<p class="pb-admin-note">Tato jména čekajících týmů se nepodařilo převést na id: ${escapeHtml(unresolved.join(', '))}.</p>`
        : '';

    return `
    <section class="pb-admin-preview">
        <p class="pb-admin-note">Klikni na zápas a nastav, odkud bere týmy. Místo může být i z jiné ligy, ze základní části nebo z jejího playoff. Týmy se v pavouku zobrazí až po uzamčení přesné pozice; pouhé jisté umístění v oblasti nestačí. Série vznikne jen tehdy, když jsou uzamčení oba různí soupeři. Seed se zapíše, až je dohrané celé předchozí kolo. Samo při otevření stránky se nic nezakládá.</p>
        ${data.notice ? `<p class="pb-notice">${escapeHtml(data.notice)}</p>` : ''}
        ${shared}
        ${unresolvedNote}
        <div class="pb-editor-tools">${toolbar}${presets}${template ? planBlock : ''}</div>
        ${inspector}
        ${bracket}
        ${jsonBlock}
        <p><a href="/admin/playoff/templates">Seznam formátů</a> · <a href="/admin">Zpět na administraci</a></p>
    </section>
    ${editorScript()}`;
}

module.exports = {
    prepareTemplate,
    addRound,
    addSlot,
    deleteSlot,
    setDensity,
    updateSlot,
    importTemplate,
    presetTemplate,
    presetCatalog,
    planPlayoffFill,
    playoffRanking,
    refreshStandingsStats,
    buildLeagueTable,
    zoneFacesForBracket,
    collectZonePreview,
    renderPlayoffAdminPage,
    listSlots,
    resolveNameIds
};
