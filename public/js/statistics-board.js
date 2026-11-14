const DATA = JSON.parse(document.getElementById('statistics-data').textContent);
const PAGES = [
    ['prehled', 'Přehled'],
    ['zebricek', 'Žebříček'],
    ['ligy', 'Ligy'],
    ['hra', 'Tvoje hra'],
    ['souboje', 'Souboje'],
    ['cas', 'Čas'],
    ['zapasy', 'Zápasy'],
    ['tabulky', 'Tabulky'],
    ['rekordy', 'Rekordy']
];
const PAGE_IDS = PAGES.map((p) => p[0]);
const KIND_LABEL = { regular: 'Základní část', bo1: 'Playoff BO1', series: 'Playoff série' };
const DOW = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
const DOW_FULL = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];

const state = {
    page: 'prehled',
    user: DATA.viewer,
    season: DATA.defaultSeason,
    league: 'all',
    kind: 'all',
    sort: 'points',
    dir: -1,
    rival: DATA.users.find((u) => u !== DATA.viewer) || DATA.users[0],
    subject: DATA.viewer,
    matchTab: 'hard',
    openMatch: ''
};

function readHash() {
    const q = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    if (PAGE_IDS.includes(q.get('p'))) state.page = q.get('p');
    state.user = DATA.viewer;
    if (DATA.seasons.includes(q.get('s'))) state.season = q.get('s');
    if (q.get('l')) state.league = q.get('l');
    if (['all', 'regular', 'bo1', 'series'].includes(q.get('k'))) state.kind = q.get('k');
    if (DATA.users.includes(q.get('r'))) state.rival = q.get('r');
    if (DATA.users.includes(q.get('w'))) state.subject = q.get('w');
    if (state.rival === state.user) state.rival = DATA.users.find((u) => u !== state.user) || state.user;
}

function writeHash() {
    const q = new URLSearchParams({
        p: state.page, s: state.season, l: state.league, k: state.kind, r: state.rival || ''
    });
    if (state.subject && state.subject !== DATA.viewer) q.set('w', state.subject);
    history.replaceState(null, '', '#' + q.toString());
}

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}
function num(value) {
    if (value == null || Number.isNaN(value)) return '—';
    return String(Math.round(value * 10) / 10).replace('.', ',');
}
function pct(part, total) {
    if (!total) return '—';
    return (100 * part / total).toFixed(1).replace('.', ',') + ' %';
}
function pctWidth(part, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, 100 * part / total));
}
function czDate(iso) {
    if (!iso || iso.length < 10) return 'bez data';
    const [y, m, d] = iso.split('-');
    return Number(d) + '. ' + Number(m) + '. ' + y;
}
function kindName(kind) {
    return KIND_LABEL[kind] || kind;
}

function emptyKind() {
    return { tips: 0, points: 0, max: 0, hit: 0, exact: 0, deltaSum: 0, deltaN: 0 };
}
function addKind(bucket, tip) {
    bucket.tips += 1;
    bucket.points += tip.points;
    bucket.max += tip.max;
    bucket.hit += tip.hit ? 1 : 0;
    bucket.exact += tip.exact ? 1 : 0;
    if (tip.delta != null) {
        bucket.deltaSum += tip.delta;
        bucket.deltaN += 1;
    }
}
function summarize(list) {
    const sum = {
        tips: 0, points: 0, max: 0, hit: 0, exact: 0, deltaSum: 0, deltaN: 0,
        regular: emptyKind(), bo1: emptyKind(), series: emptyKind(),
        ot: emptyKind(), notOt: emptyKind(), homePick: emptyKind(), awayPick: emptyKind()
    };
    for (const tip of list) {
        addKind(sum, tip);
        addKind(sum[tip.kind] || sum.regular, tip);
        addKind(tip.ot ? sum.ot : sum.notOt, tip);
        if (tip.side === 'home') addKind(sum.homePick, tip);
        if (tip.side === 'away') addKind(sum.awayPick, tip);
    }
    return sum;
}
function streaksOf(list) {
    const arr = list.slice().sort((a, b) => a.time - b.time || a.id - b.id);
    let win = 0;
    let lose = 0;
    let bestW = 0;
    let bestL = 0;
    for (const tip of arr) {
        if (tip.points > 0) {
            win += 1;
            lose = 0;
            if (win > bestW) bestW = win;
        } else {
            lose += 1;
            win = 0;
            if (lose > bestL) bestL = lose;
        }
    }
    const last = arr[arr.length - 1];
    return {
        bestW,
        bestL,
        current: !last ? 0 : (last.points > 0 ? win : -lose),
        form: arr.slice(-10)
    };
}
function leagueList() {
    const set = new Set();
    for (const tip of DATA.tips) if (tip.season === state.season) set.add(tip.league);
    for (const table of DATA.tables) if (table.season === state.season) set.add(table.league);
    const pref = ['TELH', 'MAXA', 'MS', 'MSJ', 'Olympiáda', 'Euro Hockey Tour', 'Spengler Cup'];
    return [...set].sort((a, b) => {
        const ia = pref.indexOf(a);
        const ib = pref.indexOf(b);
        if (ia < 0 && ib < 0) return a.localeCompare(b, 'cs');
        if (ia < 0) return 1;
        if (ib < 0) return -1;
        return ia - ib;
    });
}
function scopeTips(opts) {
    const season = opts && opts.season != null ? opts.season : state.season;
    const league = opts && opts.league != null ? opts.league : state.league;
    const kind = opts && opts.kind != null ? opts.kind : state.kind;
    const user = opts && opts.user;
    return DATA.tips.filter((tip) => {
        if (tip.season !== season) return false;
        if (league !== 'all' && tip.league !== league) return false;
        if (kind !== 'all' && tip.kind !== kind) return false;
        return !user || tip.user === user;
    });
}
function tableExtra(user, season, league) {
    if (state.kind !== 'all') return { correct: null, deviation: null };
    let correct = 0;
    let deviation = 0;
    let any = false;
    for (const table of DATA.tables) {
        if (table.user !== user || table.season !== season || !table.evaluated) continue;
        if (league !== 'all' && table.league !== league) continue;
        any = true;
        correct += table.correct || 0;
        deviation += table.deviation || 0;
    }
    return any ? { correct, deviation } : { correct: null, deviation: null };
}
function rowFrom(user, list) {
    const sum = summarize(list);
    const streak = streaksOf(list);
    const table = tableExtra(user, state.season, state.league);
    return Object.assign({ user, list, table }, sum, streak);
}
function sortValue(row, key) {
    if (key === 'rate') return row.max ? row.points / row.max : -1;
    if (key === 'hitRate') return row.tips ? row.hit / row.tips : -1;
    if (key === 'delta') return row.deltaN ? row.deltaSum / row.deltaN : 99;
    if (key === 'streak') return row.current;
    if (key === 'table') return row.table.correct == null ? -1 : row.table.correct;
    if (key === 'user') return row.user;
    return row[key] || 0;
}
function sortRows(rows) {
    const dir = state.dir;
    rows.sort((a, b) => {
        const av = sortValue(a, state.sort);
        const bv = sortValue(b, state.sort);
        if (av < bv) return -dir;
        if (av > bv) return dir;
        if (b.points !== a.points) return b.points - a.points;
        return a.user.localeCompare(b.user, 'cs');
    });
    rows.forEach((row, index) => { row.rank = index + 1; });
}
function standings(list) {
    const byUser = new Map();
    for (const tip of list) {
        if (!byUser.has(tip.user)) byUser.set(tip.user, []);
        byUser.get(tip.user).push(tip);
    }
    const rows = [];
    for (const [user, tips] of byUser) rows.push(rowFrom(user, tips));
    sortRows(rows);
    return rows;
}
function rankedByPoints(list) {
    const savedSort = state.sort;
    const savedDir = state.dir;
    state.sort = 'points';
    state.dir = -1;
    const rows = standings(list);
    state.sort = savedSort;
    state.dir = savedDir;
    return rows;
}
function previousRank(rows) {
    const dates = [];
    for (const row of rows) {
        for (const tip of row.list) if (tip.date) dates.push(tip.date);
    }
    dates.sort();
    const last = dates[dates.length - 1];
    if (!last) return { last: '', map: new Map() };
    const earlier = [];
    for (const row of rows) {
        const list = row.list.filter((tip) => tip.date && tip.date < last);
        if (list.length) earlier.push(rowFrom(row.user, list));
    }
    const prevSort = state.sort;
    const prevDir = state.dir;
    state.sort = 'points';
    state.dir = -1;
    sortRows(earlier);
    state.sort = prevSort;
    state.dir = prevDir;
    const map = new Map(earlier.map((row) => [row.user, row.rank]));
    return { last, map };
}
function matchBoards(list) {
    const map = new Map();
    for (const tip of list) {
        const key = tip.season + '|' + tip.league + '|' + tip.id;
        let board = map.get(key);
        if (!board) {
            board = {
                key, id: tip.id, season: tip.season, league: tip.league, date: tip.date, time: tip.time,
                home: tip.home, away: tip.away, real: tip.real, realSide: tip.realSide, kind: tip.kind,
                ot: tip.ot, tippers: []
            };
            map.set(key, board);
        }
        board.tippers.push(tip);
    }
    for (const board of map.values()) {
        board.n = board.tippers.length;
        board.hits = board.tippers.filter((tip) => tip.hit).length;
        board.hitRate = board.n ? board.hits / board.n : 0;
        board.points = board.tippers.reduce((sum, tip) => sum + tip.points, 0);
        const sides = {};
        for (const tip of board.tippers) {
            if (!tip.side) continue;
            sides[tip.side] = (sides[tip.side] || 0) + 1;
        }
        let majority = '';
        let majorityN = 0;
        let leadCount = 0;
        for (const side of Object.keys(sides)) {
            if (sides[side] > majorityN) {
                majority = side;
                majorityN = sides[side];
                leadCount = 1;
            } else if (sides[side] === majorityN) {
                leadCount += 1;
            }
        }
        board.majority = majority;
        board.majorityN = majorityN;
        board.majorityStrict = leadCount === 1 && majorityN > board.n / 2;
        board.majorityWrong = Boolean(board.majorityStrict && majority !== board.realSide);
    }
    return [...map.values()];
}
function sideWord(side) {
    if (side === 'home') return 'domácí';
    if (side === 'away') return 'hosté';
    if (side === 'draw') return 'remíza';
    return '—';
}
function minSample() {
    return state.league === 'all' ? 20 : 8;
}
function filterLabel() {
    const league = state.league === 'all' ? 'všechny ligy' : state.league;
    const kind = state.kind === 'all' ? 'všechny typy' : kindName(state.kind);
    return state.season + ' · ' + league + ' · ' + kind;
}

function dots(form) {
    if (!form.length) return '<span class="faint">bez formy</span>';
    return '<span class="dots">' + form.map((tip) => {
        const cls = tip.points === 0 ? 'miss' : (tip.points === tip.max && tip.max > 1 ? 'gold' : 'hit');
        const title = czDate(tip.date) + ' ' + tip.home + ' – ' + tip.away + ' · ' + tip.points + '/' + tip.max;
        return '<i class="dot ' + cls + '" title="' + esc(title) + '"></i>';
    }).join('') + '</span>';
}
function statBox(label, value, sub, extra) {
    return `<div class="user-stat-box ${extra || ''}"><span class="user-stat-label">${label}</span><span class="user-stat-val">${value}</span>${sub ? `<span class="user-stat-sub">${sub}</span>` : ''}</div>`;
}
function bar(part, total, cls) {
    return '<span class="bar ' + (cls || '') + '"><i style="width:' + pctWidth(part, total) + '%"></i></span>';
}
function podium(rows) {
    if (rows.length < 2 || state.sort !== 'points') return '';
    const order = rows.length >= 3 ? [rows[1], rows[0], rows[2]] : [rows[1], rows[0]];
    const cls = rows.length >= 3 ? ['silver', 'gold', 'bronze'] : ['silver', 'gold'];
    const label = rows.length >= 3 ? ['2. místo', '1. místo', '3. místo'] : ['2. místo', '1. místo'];
    const medal = rows.length >= 3 ? ['2', '1', '3'] : ['2', '1'];
    return '<div class="podium-container stb-podium">' + order.map((row, index) => `
        <article class="podium-card ${cls[index]} ${row.user === state.user ? 'is-you' : ''}">
            <div class="medal-icon">${medal[index]}</div>
            <div class="place">${label[index]}</div>
            <div class="podium-user">${esc(row.user)} ${row.user === state.user ? '<em class="you">ty</em>' : ''}</div>
            <div class="podium-points">${row.points}<small> b</small></div>
            <div class="meter" title="${pct(row.points, row.max)}"><i style="width:${pctWidth(row.points, row.max)}%"></i></div>
            <span class="user-stat-pct">${pct(row.points, row.max)} z maxima</span>
        </article>`).join('') + '</div>';
}

function renderNav(rows) {
    const mine = rows.find((row) => row.user === state.user);
    const tabs = document.getElementById('stb-tabs');
    tabs.className = 'nav-pills stb-tabs';
    tabs.innerHTML = PAGES.map(([id, label]) => {
        const mark = id === 'prehled' && mine ? '<small>' + mine.rank + '.</small>' : '';
        return `<button type="button" class="nav-pill ${state.page === id ? 'active' : ''}" data-page="${id}"><span>${label}</span>${mark}</button>`;
    }).join('');
}
function renderFilters() {
    const leagues = leagueList();
    if (state.league !== 'all' && !leagues.includes(state.league)) state.league = 'all';
    const opt = (value, label, current) => `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(label)}</option>`;
    document.getElementById('stb-filters').innerHTML = `
        <div class="field"><label for="f-season">Sezóna</label><select id="f-season" class="modern-select">${DATA.seasons.map((season) => opt(season, season, state.season)).join('')}</select></div>
        <div class="field"><label for="f-league">Liga</label><select id="f-league" class="modern-select">${opt('all', 'Všechny ligy', state.league)}${leagues.map((league) => opt(league, league, state.league)).join('')}</select></div>
        <div class="field"><label for="f-kind">Typ tipu</label><select id="f-kind" class="modern-select">
            ${opt('all', 'Všechno', state.kind)}
            ${opt('regular', 'Základní část', state.kind)}
            ${opt('bo1', 'Playoff na jeden zápas', state.kind)}
            ${opt('series', 'Playoff série', state.kind)}
        </select></div>`;
}

function pagePrehled(rows, boards) {
    const mine = rows.find((row) => row.user === state.user);
    if (!mine) return '<div class="card empty">V tomhle filtru nemáš vyhodnocený tip. Přepni sezónu, ligu nebo typ.</div>';
    const prev = previousRank(rows);
    const old = prev.map.get(state.user);
    let delta = '<span class="delta flat">pořadí podle bodů</span>';
    if (old && prev.last) {
        const diff = old - mine.rank;
        if (state.sort !== 'points') delta = '<span class="delta flat">posun se počítá v řazení podle bodů</span>';
        else if (diff > 0) delta = `<span class="delta up">↑ ${diff} od ${czDate(prev.last)}</span>`;
        else if (diff < 0) delta = `<span class="delta down">↓ ${Math.abs(diff)} od ${czDate(prev.last)}</span>`;
        else delta = `<span class="delta flat">beze změny od ${czDate(prev.last)}</span>`;
    }
    const ahead = rows.find((row) => row.rank === mine.rank - 1);
    const behind = rows.find((row) => row.rank === mine.rank + 1);
    const gap = [];
    if (state.sort === 'points' && ahead) gap.push('Na ' + ahead.user + ' ztrácíš ' + (ahead.points - mine.points) + ' bodů.');
    if (state.sort === 'points' && !ahead && behind) gap.push('Vedeš o ' + (mine.points - behind.points) + ' bodů před ' + behind.user + '.');
    if (state.sort === 'points' && ahead && behind) gap.push('Před ' + behind.user + ' máš ' + (mine.points - behind.points) + ' bodů.');
    const others = rows.filter((row) => row.user !== state.user);
    const fewer = others.filter((row) => row.points < mine.points).length;
    const percentile = others.length ? Math.round(100 * fewer / others.length) : 100;
    const otherTips = scopeTips().filter((tip) => tip.user !== state.user);
    const field = summarize(otherTips);
    const insights = buildInsights(mine, boards, field);
    const last = lastRound(boards);
    const rate = mine.max ? Math.round(1000 * mine.points / mine.max) / 10 : 0;
    return `
        ${banner()}
        <section class="card hero">
            <div class="hero-band">
                <div class="hero-main">
                    <div class="ring" style="--p:${rate}"><span><strong>${pct(mine.points, mine.max).replace(' %', '')}</strong><em>z maxima</em></span></div>
                    <div class="hero-copy">
                        <div class="hero-kicker">${esc(filterLabel())}</div>
                        <div class="rank-line"><span class="rank-no">${mine.rank}</span><span class="rank-meta">. místo z ${rows.length}</span></div>
                        <div class="delta-pill">${delta}</div>
                        <p class="gap-line">${gap.map(esc).join(' ')}</p>
                    </div>
                </div>
                <div class="user-stats-grid hero-stats">
                    ${statBox('Body ze zápasů', mine.points, 'z ' + mine.max, 'highlight')}
                    ${statBox('Trefa vítěze', pct(mine.hit, mine.tips), mine.hit + ' z ' + mine.tips)}
                    ${statBox('Lepší než', percentile + ' %', 'hráčů má míň bodů')}
                    ${statBox('Aktuální série', mine.current > 0 ? mine.current + ' tref' : mine.current < 0 ? Math.abs(mine.current) + ' vedle' : '—', mine.bestW ? 'rekord ' + mine.bestW : '')}
                </div>
            </div>
            <div class="form-line"><span class="user-stat-label">Posledních ${mine.form.length} tipů</span>${dots(mine.form)}</div>
        </section>
        <div class="grid cols-2" style="margin-top:14px">
            <section class="card">
                <h2>Co z toho plyne</h2>
                <div class="chips">${insights.map((line) => `<span class="chip">${esc(line)}</span>`).join('')}</div>
                <h3 style="margin-top:18px">Odkud jsou body</h3>
                ${stackOf(mine)}
                ${kindCompare(mine, field)}
            </section>
            <section class="card">
                <h2>Srdcovka a kat</h2>
                ${teamExtremes(mine.list)}
                <p class="faint">Tým se počítá, když v zápase hrál. Srdcovka a kat až od 5 zápasů, ať o tom nerozhodnou dva tipy.</p>
            </section>
        </div>
        <section class="card" style="margin-top:14px">
            <h2>Poslední kolo${last.date ? ' · ' + czDate(last.date) : ''}</h2>
            ${last.html}
        </section>`;
}

function stackOf(sum) {
    const parts = [
        ['regular', 'var(--accent-blue)', 'Základní část'],
        ['bo1', 'var(--primary)', 'BO1'],
        ['series', 'var(--accent-amber)', 'Série']
    ].filter(([key]) => sum[key].points > 0);
    if (!sum.points) return '<p class="muted">Zatím žádný bod.</p>';
    return `<div class="stack">${parts.map(([key, color]) => `<i style="width:${pctWidth(sum[key].points, sum.points)}%;background:${color}"></i>`).join('')}</div>
        <div class="legend">${parts.map(([key, color, label]) => `<span><i style="background:${color}"></i>${label} ${sum[key].points} b</span>`).join('')}</div>`;
}
function kindCompare(mine, field) {
    const kinds = ['regular', 'bo1', 'series'].filter((kind) => mine[kind].tips || field[kind].tips);
    if (!kinds.length) return '';
    const body = kinds.map((kind) => `
        <tr><td>${kindName(kind)}</td><td>ty</td><td class="num">${mine[kind].points} / ${mine[kind].max}</td><td class="num">${pct(mine[kind].points, mine[kind].max)}</td><td class="num">${pct(mine[kind].hit, mine[kind].tips)}</td></tr>
        <tr><td></td><td class="muted">ostatní</td><td class="num">${field[kind].points} / ${field[kind].max}</td><td class="num">${pct(field[kind].points, field[kind].max)}</td><td class="num">${pct(field[kind].hit, field[kind].tips)}</td></tr>`).join('');
    return `<div class="table-wrap"><table class="modern-table">
        <thead><tr><th>Typ</th><th></th><th class="num">Body</th><th class="num">Úspěšnost bodů</th><th class="num">Trefa vítěze</th></tr></thead>
        <tbody>${body}</tbody></table></div>
        <p class="faint">Úspěšnost bodů je podíl z maxima. Trefa vítěze je jen to, jestli seděl vítěz. U BO1 můžeš mít vítěze a stejně jen 1 bod z 5.</p>`;
}
function teamExtremes(list) {
    const teams = teamTable(list);
    const ready = teams.filter((team) => team.tips >= 5);
    if (!ready.length) return '<p class="muted">Na srdcovku je potřeba aspoň 5 zápasů s týmem. Zatím jich tolik není.</p>';
    const best = ready[0];
    const worst = ready[ready.length - 1];
    const card = (team, label, cls) => `<div class="row"><div><span class="tag ${cls}">${label}</span> <strong>${esc(team.name)}</strong><div class="sub">${team.tips} zápasů · ${team.points} z ${team.max} bodů · vítěz ${pct(team.hit, team.tips)}</div></div><div>${pct(team.points, team.max)}</div></div>`;
    return '<div class="list">' + card(best, 'Srdcovka', 'green') + card(worst, 'Kat', 'red') + '</div>';
}
function teamTable(list) {
    const map = new Map();
    for (const tip of list) {
        for (const name of [tip.home, tip.away]) {
            if (!map.has(name)) map.set(name, { name, tips: 0, points: 0, max: 0, hit: 0 });
            const team = map.get(name);
            team.tips += 1;
            team.points += tip.points;
            team.max += tip.max;
            team.hit += tip.hit ? 1 : 0;
        }
    }
    return [...map.values()].sort((a, b) => (b.max ? b.points / b.max : 0) - (a.max ? a.points / a.max : 0) || b.tips - a.tips);
}
function lastRound(boards) {
    const dated = boards.filter((board) => board.date);
    if (!dated.length) return { date: '', html: '<p class="muted">Zápasy nemají datum.</p>' };
    const date = dated.map((board) => board.date).sort().pop();
    const round = dated.filter((board) => board.date === date).sort((a, b) => a.time - b.time || a.id - b.id);
    let minePoints = 0;
    let mineMax = 0;
    const rows = round.map((board) => {
        const mineTip = board.tippers.find((tip) => tip.user === state.user);
        if (mineTip) {
            minePoints += mineTip.points;
            mineMax += mineTip.max;
        }
        const others = board.tippers.filter((tip) => tip.user !== state.user);
        const otherPoints = others.reduce((sum, tip) => sum + tip.points, 0);
        const otherAvg = others.length ? otherPoints / others.length : null;
        return `<tr class="${mineTip ? '' : ''}">
            <td>${esc(board.home)} – ${esc(board.away)}${board.ot ? ' <span class="faint">prodl.</span>' : ''}<div class="faint">${esc(board.league)} · ${kindName(board.kind)}</div></td>
            <td>${esc(board.real)}</td>
            <td>${mineTip ? esc(mineTip.tip) : '<span class="faint">netipoval</span>'}</td>
            <td class="num">${mineTip ? mineTip.points + ' / ' + mineTip.max : '—'}</td>
            <td class="num">${otherAvg == null ? '—' : num(otherAvg)}</td>
            <td class="num">${board.hits}/${board.n}</td>
        </tr>`;
    }).join('');
    const html = `<p class="muted">Ty ${minePoints} z ${mineMax}. Sloupec ostatní je průměr bodů na hráče, který zápas tipoval.</p>
        <div class="table-wrap"><table class="modern-table"><thead><tr><th>Zápas</th><th>Výsledek</th><th>Tvůj tip</th><th class="num">Body</th><th class="num">Ostatní</th><th class="num">Trefy</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    return { date, html, minePoints };
}

function buildInsights(mine, boards, field) {
    const lines = [];
    const fieldRate = field.max ? field.points / field.max : 0;
    const myRate = mine.max ? mine.points / mine.max : 0;
    if (field.max && mine.max >= 8) {
        const diff = Math.round((myRate - fieldRate) * 1000) / 10;
        if (diff > 0.4) lines.push('Proti ostatním jsi o ' + String(diff).replace('.', ',') + ' bodu procenta výš.');
        else if (diff < -0.4) lines.push('Proti ostatním jsi o ' + String(Math.abs(diff)).replace('.', ',') + ' bodu procenta níž.');
        else lines.push('Jsi v úspěšnosti bodů na úrovni ostatních.');
    }
    const kinds = ['regular', 'bo1', 'series'].filter((kind) => mine[kind].max >= 5);
    if (kinds.length >= 2) {
        kinds.sort((a, b) => mine[b].points / mine[b].max - mine[a].points / mine[a].max);
        lines.push('Nejlíp vychází ' + kindName(kinds[0]).toLowerCase() + ' (' + pct(mine[kinds[0]].points, mine[kinds[0]].max) + '), nejhůř ' + kindName(kinds[kinds.length - 1]).toLowerCase() + ' (' + pct(mine[kinds[kinds.length - 1]].points, mine[kinds[kinds.length - 1]].max) + ').');
    }
    if (mine.current >= 3) lines.push('Jedeš sérii ' + mine.current + ' tref po sobě.');
    if (mine.current <= -3) lines.push('Posledních ' + Math.abs(mine.current) + ' tipů je bez bodu.');
    const teams = teamTable(mine.list).filter((team) => team.tips >= 5);
    if (teams.length >= 2) lines.push('Srdcovka ' + teams[0].name + ' (' + pct(teams[0].points, teams[0].max) + '), kat ' + teams[teams.length - 1].name + ' (' + pct(teams[teams.length - 1].points, teams[teams.length - 1].max) + ').');
    const clutch = clutchCount(boards);
    if (clutch >= 3) lines.push(clutch + ' tref, které měla míň než půlka ostatních.');
    if (mine.bo1.deltaN >= 5) lines.push('Průměrná odchylka skóre u BO1 je ' + num(mine.bo1.deltaSum / mine.bo1.deltaN) + ' gólu.');
    if (mine.table.correct != null) lines.push('Tabulka dala ' + mine.table.correct + ' přesných pozic, odchylka ' + mine.table.deviation + '.');
    if (!lines.length) lines.push('Ve filtru ' + filterLabel() + ' je ' + mine.tips + ' vyhodnocených tipů.');
    return lines.slice(0, 6);
}
function clutchCount(boards) {
    let count = 0;
    for (const board of boards) {
        if (board.n < 3) continue;
        const mine = board.tippers.find((tip) => tip.user === state.user);
        if (!mine || !mine.hit) continue;
        const others = board.tippers.filter((tip) => tip.user !== state.user);
        const hits = others.filter((tip) => tip.hit).length;
        if (others.length && hits / others.length < 0.5) count += 1;
    }
    return count;
}

function pageZebricek(rows) {
    const prev = previousRank(rows);
    const headers = [
        ['rank', '#'],
        ['user', 'Hráč'],
        ['points', 'Body'],
        ['rate', 'Z maxima'],
        ['hitRate', 'Vítěz'],
        ['streak', 'Série'],
        ['delta', 'Odchylka'],
        ['table', 'Tabulka'],
        ['tips', 'Tipy']
    ];
    const head = headers.map(([key, label]) => {
        const mark = state.sort === key ? (state.dir < 0 ? ' ↓' : ' ↑') : '';
        return `<th class="${key === 'user' ? '' : 'num'}" data-sort="${key}">${label}${mark}</th>`;
    }).join('');
    const body = rows.map((row) => {
        const old = prev.map.get(row.user);
        let move = '';
        if (old && state.sort === 'points') {
            const diff = old - row.rank;
            if (diff > 0) move = ` <span class="delta up">↑${diff}</span>`;
            else if (diff < 0) move = ` <span class="delta down">↓${Math.abs(diff)}</span>`;
        }
        const streak = row.current > 0 ? row.current + ' tref' : row.current < 0 ? Math.abs(row.current) + ' vedle' : '—';
        const delta = row.deltaN ? '± ' + num(row.deltaSum / row.deltaN) : '—';
        const table = row.table.correct == null ? '—' : row.table.correct + ' / ' + row.table.deviation;
        return `<tr class="${row.user === state.user ? 'me' : ''}">
            <td class="num">${row.rank}${move}</td>
            <td><strong>${esc(row.user)}</strong> ${row.user === state.user ? '<em class="you">ty</em>' : ''}</td>
            <td class="num">${row.points} / ${row.max}</td>
            <td class="num">${pct(row.points, row.max)}</td>
            <td class="num">${pct(row.hit, row.tips)}</td>
            <td class="num">${streak}</td>
            <td class="num">${delta}</td>
            <td class="num">${table}</td>
            <td class="num">${row.tips}</td>
        </tr>`;
    }).join('');
    return `
        ${banner()}
        <p class="page-intro">Jedna tabulka místo tří grafů se stejnými jmény. Kliknutí na sloupec přeřadí. Posun šipkou je proti minulému kolu, a jen když je řazení podle bodů.</p>
        ${podium(rows)}
        <section class="card">
            <div class="table-wrap"><table class="modern-table"><thead><tr>${head}</tr></thead><tbody>${body || '<tr><td colspan="9">Nikdo tu nemá vyhodnocený tip.</td></tr>'}</tbody></table></div>
            <p class="faint">Odchylka je průměrný součet rozdílů gólů u BO1. Čím míň, tím přesnější skóre. Tabulka je počet přesných pozic a součet odchylek, jen tam, kde už je hodnocení uložené. Do bodů ze zápasů se nezapočítává.</p>
        </section>`;
}

function pageLigy() {
    const leagues = leagueList();
    const cards = leagues.map((league) => {
        const tips = scopeTips({ league, kind: state.kind });
        const rows = rankedByPoints(tips);
        const mine = rows.find((row) => row.user === state.user);
        const sum = summarize(tips);
        const best = rows.slice().sort((a, b) => b.points - a.points)[0];
        const mineRate = mine && mine.max ? Math.round(1000 * mine.points / mine.max) / 10 : 0;
        return `<button class="card league-card" data-set-league="${esc(league)}">
            <div class="league-top">
                <div>
                    <div class="league-kicker">${rows.length} hráčů · ${sum.tips} tipů</div>
                    <h2>${esc(league)}</h2>
                </div>
                <div class="ring ring-sm" style="--p:${mineRate}"><span><strong>${mine ? mine.rank + '.' : '—'}</strong><em>místo</em></span></div>
            </div>
            <div class="user-stats-grid">
                ${statBox('Tvé body', mine ? mine.points : 0, mine ? 'z ' + mine.max : '')}
                ${statBox('Tvoje úspěšnost', mine ? pct(mine.points, mine.max) : '—', '')}
                ${statBox('Pole', pct(sum.points, sum.max), '')}
            </div>
            <div class="league-foot">${best ? 'Nejvíc bodů má ' + esc(best.user) : 'Zatím bez pořadí'}</div>
        </button>`;
    }).join('');
    const headerLeagues = leagues;
    const heatRows = DATA.users.map((user) => {
        const cells = headerLeagues.map((league) => {
            const list = scopeTips({ league, user, kind: state.kind });
            if (!list.length) return '<td class="heat">—</td>';
            const sum = summarize(list);
            const rate = sum.max ? sum.points / sum.max : 0;
            const alpha = 0.15 + 0.7 * rate;
            return `<td class="heat" data-set-league="${esc(league)}" style="background:rgba(255,85,0,${alpha.toFixed(3)})" title="${esc(user)} · ${league} · ${sum.points}/${sum.max}">${Math.round(rate * 100)} %</td>`;
        }).join('');
        return `<tr class="${user === state.user ? 'me' : ''}"><td><strong>${esc(user)}</strong></td>${cells}</tr>`;
    }).join('');
    return `
        ${banner()}
        <p class="page-intro">Kliknutí na ligu ji zapne ve filtru. Barva v heatmapě je úspěšnost bodů, ne pořadí. Někdo s jednou ligou a někdo se čtyřmi se v celkovém součtu potkávají až tady férově vedle sebe.</p>
        <div class="grid cols-2">${cards || '<div class="card empty">V sezóně nejsou vyhodnocené tipy.</div>'}</div>
        <section class="card" style="margin-top:14px">
            <h2>Úspěšnost po ligách</h2>
            <div class="table-wrap"><table class="modern-table"><thead><tr><th>Hráč</th>${headerLeagues.map((league) => `<th>${esc(league)}</th>`).join('')}</tr></thead><tbody>${heatRows}</tbody></table></div>
        </section>`;
}

function subjectPicker() {
    const users = [state.user].concat(DATA.users.filter((user) => user !== state.user));
    const options = users.map((user) => `<option value="${esc(user)}" ${user === state.subject ? 'selected' : ''}>${esc(user)}${user === state.user ? ' (ty)' : ''}</option>`).join('');
    return `<div class="hra-picker">
        <div class="field"><label for="f-subject">Hráč</label><select id="f-subject" class="modern-select">${options}</select></div>
        <p class="faint">Tady se přepíná jen tahle stránka. Přehled, čas a souboje pořád počítají tebe.</p>
    </div>`;
}
function pageHra(rows, boards) {
    const who = state.subject;
    const self = who === state.user;
    const mine = rows.find((row) => row.user === who);
    if (!mine) {
        const empty = self
            ? 'V tomhle filtru nemáš vyhodnocený tip.'
            : esc(who) + ' v tomhle filtru nemá vyhodnocený tip.';
        return subjectPicker() + '<div class="card empty">' + empty + '</div>';
    }
    const buckets = { exact: 0, d1: 0, d2: 0, far: 0, miss: 0 };
    const exacts = [];
    const misses = [];
    for (const tip of mine.list) {
        if (tip.exact && (tip.kind === 'bo1' || tip.kind === 'series')) exacts.push(tip);
        if (tip.max - tip.points > 0) misses.push(tip);
        if (tip.kind !== 'bo1') continue;
        if (!tip.hit) buckets.miss += 1;
        else if (tip.delta === 0) buckets.exact += 1;
        else if (tip.delta === 1) buckets.d1 += 1;
        else if (tip.delta === 2) buckets.d2 += 1;
        else buckets.far += 1;
    }
    exacts.sort((a, b) => b.time - a.time);
    misses.sort((a, b) => (b.max - b.points) - (a.max - a.points) || (b.delta || 0) - (a.delta || 0) || b.time - a.time);
    const bo1n = mine.bo1.tips;
    const bucketRows = [
        ['Přesné skóre', buckets.exact, 'gold', '5 bodů'],
        ['Vedle o 1 gól', buckets.d1, 'green', '4 body'],
        ['Vedle o 2 góly', buckets.d2, 'blue', '3 body'],
        ['Vítěz, skóre dál', buckets.far, 'amber', '1 bod'],
        ['Špatný vítěz', buckets.miss, 'red', '0 bodů']
    ];
    const teams = teamTable(mine.list);
    const ready = teams.filter((team) => team.tips >= 5);
    const heart = ready[0];
    const hex = ready.length > 1 ? ready[ready.length - 1] : null;
    const ordered = teams.slice().sort((a, b) => {
        const aq = a.tips >= 5 ? 1 : 0;
        const bq = b.tips >= 5 ? 1 : 0;
        if (aq !== bq) return bq - aq;
        const ar = a.max ? a.points / a.max : 0;
        const br = b.max ? b.points / b.max : 0;
        if (br !== ar) return br - ar;
        return b.tips - a.tips || a.name.localeCompare(b.name, 'cs');
    });
    const teamRows = ordered.map((team) => {
        let tag = '';
        if (heart && team === heart) tag = ' <span class="tag green">srdcovka</span>';
        else if (hex && team === hex) tag = ' <span class="tag red">kat</span>';
        return `<tr><td>${esc(team.name)}${tag}</td><td class="num">${team.tips}</td><td class="num">${team.points} / ${team.max}</td><td class="num">${pct(team.points, team.max)}</td><td>${bar(team.points, team.max)}</td></tr>`;
    }).join('');
    const clutch = [];
    const solo = [];
    for (const board of boards) {
        const mineTip = board.tippers.find((tip) => tip.user === who);
        if (!mineTip || !mineTip.hit || board.n < 3) continue;
        const others = board.tippers.filter((tip) => tip.user !== who);
        const hits = others.filter((tip) => tip.hit).length;
        if (hits === 0) solo.push(board);
        else if (others.length && hits / others.length < 0.5) clutch.push(board);
    }
    const topWaste = misses.length ? misses[0].max - misses[0].points : 0;
    const waste = mine.max - mine.points;
    const streakNow = mine.current > 0 ? mine.current + ' tref' : mine.current < 0 ? Math.abs(mine.current) + ' vedle' : '—';
    const intro = self
        ? 'Rozpad tvojí hry. Trefa vítěze říká, jestli seděla strana. Body říkají, kolik z maxima jsi z toho zápasu dostal.'
        : 'Rozpad hry hráče ' + who + '. Trefa vítěze říká, jestli seděla strana. Body říkají, kolik z maxima z toho zápasu dostal.';
    const missLead = self
        ? 'Tip, kde jsi nechal nejvíc bodů na stole'
        : 'Tip s nejvíc body nechanými na stole';
    const soloEmpty = self
        ? 'Aspoň dva ostatní vedle a ty vítěze máš.'
        : 'Aspoň dva ostatní vedle a ' + who + ' trefil vítěze.';
    return `
        ${banner()}
        ${subjectPicker()}
        <p class="page-intro">${esc(intro)}</p>
        <div class="user-stats-grid hra-summary">
            ${statBox('Body', mine.points + ' / ' + mine.max, pct(mine.points, mine.max), 'highlight')}
            ${statBox('Trefa vítěze', pct(mine.hit, mine.tips), mine.hit + ' z ' + mine.tips)}
            ${statBox('Přesné trefy', String(mine.exact), 'skóre BO1 a série')}
            ${statBox('Necháno na stole', String(waste), 'bodů z maxima')}
        </div>
        <div class="grid cols-2" style="margin-top:14px">
            <section class="card"><h2>Domácí, hosté, prodloužení</h2><div class="bias">${biasBlock(mine, self)}</div></section>
            <section class="card"><h2>Série</h2>
                <div class="user-stats-grid">
                    ${statBox('Nejdelší trefy', String(mine.bestW), 'v řadě')}
                    ${statBox('Nejdelší vedle', String(mine.bestL), 'v řadě')}
                    ${statBox('Teď', streakNow, mine.form.length + ' posledních tipů')}
                    ${statBox('Série za 3', String(mine.list.filter((tip) => tip.kind === 'series' && tip.exact).length), 'přesný počet výher poraženého')}
                </div>
                <div class="form-line" style="margin-top:12px">${dots(mine.form)}</div>
            </section>
        </div>
        <section class="card" style="margin-top:14px">
            <h2>Playoff na jeden zápas${bo1n ? ' · ' + bo1n + ' tipů' : ''}</h2>
            ${bo1n ? '<div class="buckets">' + bucketRows.map((row) => bucketLine(row[0], row[1], bo1n, row[2], row[3])).join('') + '</div>' : '<p class="muted">V tomhle filtru není playoff na jeden zápas.</p>'}
            ${mine.bo1.deltaN ? `<p class="faint">Průměrná odchylka skóre ± ${num(mine.deltaSum / mine.deltaN)} gólu. Přesných skóre ${buckets.exact}.</p>` : ''}
        </section>
        <div class="grid cols-2" style="margin-top:14px">
            <section class="card"><h2>Týmy · ${teams.length}</h2>
                <p class="faint">Kompletní seznam týmů z tohohle filtru. Srdcovka a kat jsou týmy s aspoň 5 zápasy, seřazené podle úspěšnosti bodů. Výš jsou ty s pěti a víc zápasy.</p>
                <div class="table-wrap team-scroll"><table class="modern-table"><thead><tr><th>Tým</th><th class="num">Zápasy</th><th class="num">Body</th><th class="num">Úspěšnost</th><th></th></tr></thead><tbody>${teamRows || '<tr><td colspan="5">Žádný tým.</td></tr>'}</tbody></table></div>
            </section>
            <section class="card"><h2>Trefy proti proudu</h2>
                ${miniMatches(clutch.slice(0, 6), 'Trefa, kterou mělo míň než půlka ostatních.', who)}
                <h3 style="margin-top:16px">Jediný, kdo trefil vítěze</h3>
                ${miniMatches(solo.slice(0, 6), soloEmpty, who)}
            </section>
        </div>
        <div class="grid cols-2" style="margin-top:14px">
            <section class="card"><h2>Přesné trefy</h2>${tipList(exacts.slice(0, 8), 'Zatím žádné přesné skóre ani přesná série.')}</section>
            <section class="card"><h2>Největší minutí</h2>
                <p class="faint">${esc(missLead)}: maximum minus získané body. Playoff na jeden zápas má maximum 5, série 3, základní část 1. Číslo vpravo je ten rozdíl.${topWaste <= 1 ? ' Tady má tip maximum 1 bod, takže každé minutí stojí stejně a výš je novější.' : ''}</p>
                ${tipList(misses.slice(0, 8), 'Každý tip v tomhle filtru má plný počet bodů.', 'miss')}
            </section>
        </div>`;
}
function bucketLine(label, count, total, cls, hint) {
    const share = total ? Math.round(100 * count / total) : 0;
    return `<div class="bucket"><div class="bucket-top"><span>${esc(label)}</span><b>${count} · ${share} %</b></div>${bar(count, total || 1, cls)}<div class="faint">${esc(hint)}</div></div>`;
}
function biasBlock(mine, self) {
    const lines = [
        [self ? 'Tipuješ domácí' : 'Tipuje domácí', mine.homePick],
        [self ? 'Tipuješ hosty' : 'Tipuje hosty', mine.awayPick],
        ['Šlo to do prodloužení', mine.ot],
        ['Bez prodloužení', mine.notOt]
    ];
    return lines.map(([label, sum]) => `<div class="split"><span>${label}</span>${bar(sum.points, sum.max || 1)}<b>${sum.tips ? pct(sum.points, sum.max) : '—'}</b></div><div class="faint bucket-meta">${sum.tips} tipů · ${sum.points}/${sum.max} bodů · vítěz ${pct(sum.hit, sum.tips)}</div>`).join('');
}
function miniMatches(list, empty, user) {
    const who = user || state.user;
    const tipLabel = who === state.user ? 'tvůj tip' : 'tip';
    if (!list.length) return '<p class="muted">' + esc(empty) + '</p>';
    return '<div class="list">' + list.map((board) => {
        const mine = board.tippers.find((tip) => tip.user === who);
        return `<div class="row"><div><strong>${esc(board.home)} – ${esc(board.away)}</strong><div class="sub">${czDate(board.date)} · výsledek ${esc(board.real)} · ${tipLabel} ${mine ? esc(mine.tip) : '—'} · ${mine ? mine.points + '/' + mine.max + ' b' : ''}</div></div><div>${board.hits}/${board.n}</div></div>`;
    }).join('') + '</div>';
}
function missNote(tip) {
    if (!tip.hit) return 'špatný vítěz';
    if (tip.delta != null && tip.delta > 0) return 'odchylka ' + tip.delta;
    if (tip.kind === 'series') return 'vítěz bez přesné série';
    return 'nevyužité body';
}
function tipList(list, empty, mode) {
    if (!list.length) return '<p class="muted">' + esc(empty) + '</p>';
    return '<div class="list">' + list.map((tip) => {
        const waste = tip.max - tip.points;
        const extra = mode === 'miss'
            ? (missNote(tip) + ' · získáno ' + tip.points + '/' + tip.max)
            : (tip.delta ? 'odchylka ' + tip.delta : '');
        const right = mode === 'miss' ? ('−' + waste) : (tip.points + '/' + tip.max);
        return `<div class="row"><div><strong>${esc(tip.home)} – ${esc(tip.away)}</strong><div class="sub">${czDate(tip.date)} · ${esc(tip.league)} · tip ${esc(tip.tip)} · výsledek ${esc(tip.real)}${extra ? ' · ' + esc(extra) : ''}</div></div><div class="miss-score${mode === 'miss' ? ' is-miss' : ''}">${right}</div></div>`;
    }).join('') + '</div>';
}

function pageSouboje() {
    const rivals = DATA.users.filter((user) => user !== state.user);
    if (!rivals.length) return '<div class="card empty">Na souboj jsou potřeba dva hráči.</div>';
    if (!rivals.includes(state.rival)) state.rival = rivals[0];
    const mineTips = scopeTips({ user: state.user });
    const rivalTips = scopeTips({ user: state.rival });
    const rivalById = new Map(rivalTips.map((tip) => [tip.season + '|' + tip.league + '|' + tip.id, tip]));
    const shared = [];
    for (const tip of mineTips) {
        const other = rivalById.get(tip.season + '|' + tip.league + '|' + tip.id);
        if (other) shared.push({ mine: tip, other });
    }
    shared.sort((a, b) => b.mine.time - a.mine.time);
    let win = 0;
    let lose = 0;
    let draw = 0;
    let bothHit = 0;
    let bothMiss = 0;
    let myPoints = 0;
    let theirPoints = 0;
    const byLeague = new Map();
    for (const pair of shared) {
        myPoints += pair.mine.points;
        theirPoints += pair.other.points;
        if (pair.mine.points > pair.other.points) win += 1;
        else if (pair.mine.points < pair.other.points) lose += 1;
        else {
            draw += 1;
            if (pair.mine.points > 0) bothHit += 1;
            else bothMiss += 1;
        }
        if (!byLeague.has(pair.mine.league)) byLeague.set(pair.mine.league, { n: 0, my: 0, their: 0, win: 0 });
        const bucket = byLeague.get(pair.mine.league);
        bucket.n += 1;
        bucket.my += pair.mine.points;
        bucket.their += pair.other.points;
        if (pair.mine.points > pair.other.points) bucket.win += 1;
    }
    const options = rivals.map((user) => `<option value="${esc(user)}" ${user === state.rival ? 'selected' : ''}>${esc(user)}</option>`).join('');
    const leagueRows = [...byLeague.entries()].sort((a, b) => b[1].n - a[1].n).map(([league, bucket]) => `<tr><td>${esc(league)}</td><td class="num">${bucket.n}</td><td class="num">${bucket.my} : ${bucket.their}</td><td class="num">${bucket.win}</td></tr>`).join('');
    const recent = shared.slice(0, 18).map((pair) => {
        const cls = pair.mine.points > pair.other.points ? 'delta up' : pair.mine.points < pair.other.points ? 'delta down' : 'muted';
        return `<tr><td>${czDate(pair.mine.date)}<div class="faint">${esc(pair.mine.league)}</div></td><td>${esc(pair.mine.home)} – ${esc(pair.mine.away)}<div class="faint">výsledek ${esc(pair.mine.real)}</div></td><td>${esc(pair.mine.tip)}</td><td>${esc(pair.other.tip)}</td><td class="num ${cls}">${pair.mine.points} : ${pair.other.points}</td></tr>`;
    }).join('');
    return `
        ${banner()}
        <p class="page-intro">Souboj jen na zápasech, které jste tipovali oba. Skóre je počet zápasů, kde máš víc bodů, ne rozdíl celkových bodů.</p>
        <section class="card">
            <div class="field" style="max-width:280px"><label for="f-rival">Soupeř</label><select id="f-rival" class="modern-select">${options}</select></div>
            <div class="kpis" style="margin-top:14px">
                <div class="kpi"><b>${win} : ${lose}</b><span>zápasy pro tebe : pro soupeře</span></div>
                <div class="kpi"><b>${draw}</b><span>stejné body, z toho oba trefa ${bothHit}, oba vedle ${bothMiss}</span></div>
                <div class="kpi"><b>${myPoints} : ${theirPoints}</b><span>body na společných zápasech</span></div>
                <div class="kpi"><b>${shared.length}</b><span>společných tipů</span></div>
            </div>
        </section>
        <div class="grid cols-2" style="margin-top:14px">
            <section class="card"><h2>Po ligách</h2><div class="table-wrap"><table class="modern-table"><thead><tr><th>Liga</th><th class="num">Zápasy</th><th class="num">Body</th><th class="num">Vyhrané</th></tr></thead><tbody>${leagueRows || '<tr><td colspan="4">Žádný společný zápas.</td></tr>'}</tbody></table></div></section>
            <section class="card"><h2>Jak číst skóre</h2><p class="muted">1 : 0 u zápasu znamená, že jsi z něj vytěžil víc bodů než soupeř. U základní části je to skoro vždy 1 : 0, nebo 0 : 0 když jste oba vedle. U BO1 rozhoduje i přesnost skóre, takže vítěze můžete trefit oba a stejně vyhraje ten, kdo je blíž výsledku.</p></section>
        </div>
        <section class="card" style="margin-top:14px"><h2>Poslední společné zápasy</h2>
            <div class="table-wrap"><table class="modern-table"><thead><tr><th>Kdy</th><th>Zápas</th><th>Ty</th><th>${esc(state.rival)}</th><th class="num">Body</th></tr></thead><tbody>${recent || '<tr><td colspan="5">Nic společného ve filtru.</td></tr>'}</tbody></table></div>
        </section>`;
}

function pageCas(rows) {
    const mine = rows.find((row) => row.user === state.user);
    const all = scopeTips();
    const mineList = mine ? mine.list : [];
    const months = bucketBy(all, (tip) => tip.date ? tip.date.slice(0, 7) : '');
    const monthKeys = [...months.keys()].filter(Boolean).sort();
    const monthHtml = monthKeys.map((key) => {
        const allSum = summarize(months.get(key));
        const mySum = summarize(months.get(key).filter((tip) => tip.user === state.user));
        const [y, m] = key.split('-');
        return `<div class="split"><span>${Number(m)}. ${y}</span><span>${bar(mySum.points, mySum.max || 1)} <span class="faint">${mySum.tips ? pct(mySum.points, mySum.max) : '—'}</span></span><b class="faint">${pct(allSum.points, allSum.max)}</b></div>`;
    }).join('');
    const dowHtml = [1, 2, 3, 4, 5, 6, 0].map((dow) => {
        const list = all.filter((tip) => tip.dow === dow);
        const mineDow = list.filter((tip) => tip.user === state.user);
        const my = summarize(mineDow);
        const rest = summarize(list.filter((tip) => tip.user !== state.user));
        return `<tr><td>${DOW_FULL[dow]}</td><td class="num">${my.tips}</td><td class="num">${pct(my.points, my.max)}</td><td class="num">${pct(rest.points, rest.max)}</td><td>${bar(my.points, my.max || 1)}</td></tr>`;
    }).join('');
    const bands = [
        ['Dopoledne', 0, 12],
        ['Odpoledne', 12, 17],
        ['Podvečer', 17, 19],
        ['Večer', 19, 22],
        ['Noc', 22, 24]
    ];
    const hourHtml = bands.map(([label, from, to]) => {
        const my = summarize(mineList.filter((tip) => tip.hour != null && tip.hour >= from && tip.hour < to));
        return `<div class="split"><span>${label}</span>${bar(my.points, my.max || 1, 'blue')}<b>${my.tips ? pct(my.points, my.max) : '—'} <span class="faint">${my.tips}</span></b></div>`;
    }).join('');
    const dates = [...new Set(all.map((tip) => tip.date).filter(Boolean))].sort().slice(-16);
    const roundHtml = dates.map((date) => {
        const my = summarize(all.filter((tip) => tip.date === date && tip.user === state.user));
        const restList = all.filter((tip) => tip.date === date && tip.user !== state.user);
        const restUsers = new Set(restList.map((tip) => tip.user)).size || 1;
        const rest = summarize(restList);
        const avg = rest.points / restUsers;
        const maxBar = Math.max(my.points, avg, 1);
        return `<div class="split"><span>${czDate(date).replace(/ \d{4}$/, '')}</span>${bar(my.points, maxBar)}<b>${my.points} <span class="faint">/ ${num(avg)}</span></b></div>`;
    }).join('');
    const seasonCards = DATA.seasons.map((season) => {
        const tips = scopeTips({ season, league: state.league, kind: state.kind });
        const table = rankedByPoints(tips);
        const me = table.find((row) => row.user === state.user);
        const seasonRate = me && me.max ? Math.round(1000 * me.points / me.max) / 10 : 0;
        return `<article class="card season-card ${season === state.season ? 'is-current' : ''}">
            <div class="league-top">
                <div>
                    <div class="league-kicker">${season === state.season ? 'Otevřená sezóna' : 'Sezóna'}</div>
                    <h2>${esc(season)}</h2>
                </div>
                <div class="ring ring-sm" style="--p:${seasonRate}"><span><strong>${me ? me.rank + '.' : '—'}</strong><em>z ${table.length || '—'}</em></span></div>
            </div>
            <div class="meter"><i style="width:${pctWidth(me ? me.points : 0, me ? me.max : 1)}%"></i></div>
            <div class="league-foot">${me ? me.points + ' z ' + me.max + ' bodů · ' + pct(me.points, me.max) : 'Bez tipů'}</div>
        </article>`;
    }).join('');
    return `
        ${banner()}
        <p class="page-intro">Čas je pořád o tobě proti ostatním ve stejném filtru. Oranžová je tvoje úspěšnost bodů, šedé číslo je pole. U kol je vpravo tvoje body a průměr ostatních za ten den.</p>
        <div class="grid cols-4">${seasonCards}</div>
        <div class="grid cols-2" style="margin-top:14px">
            <section class="card"><h2>Měsíce</h2><p class="faint">Vlevo ty, vpravo všichni dohromady.</p>${monthHtml || '<p class="muted">Bez dat.</p>'}</section>
            <section class="card"><h2>Hodina výhozu</h2><p class="faint">Podle času zápasu, ne podle toho, kdy jsi tip ukládal.</p>${hourHtml}</section>
        </div>
        <section class="card" style="margin-top:14px"><h2>Den v týdnu</h2>
            <div class="table-wrap"><table class="modern-table"><thead><tr><th>Den</th><th class="num">Tvé tipy</th><th class="num">Ty</th><th class="num">Ostatní</th><th></th></tr></thead><tbody>${dowHtml}</tbody></table></div>
            <p class="faint">Trefa je tady úspěšnost bodů. Den se bere z data výhozu.</p>
        </section>
        <section class="card" style="margin-top:14px"><h2>Poslední kola</h2>${roundHtml || '<p class="muted">Bez dat.</p>'}</section>`;
}
function bucketBy(list, keyFn) {
    const map = new Map();
    for (const tip of list) {
        const key = keyFn(tip);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(tip);
    }
    return map;
}

function pageZapasy(boards) {
    const tabs = [
        ['hard', 'Nejtěžší'],
        ['upset', 'Mimo konsenzus'],
        ['split', 'Půl na půl'],
        ['solo', 'Jen ty'],
        ['others', 'Jenom ostatní'],
        ['allhit', 'Trefili všichni']
    ];
    const intros = {
        hard: 'Nejtěžší řadí zápasy podle podílu lidí, kteří trefili vítěze. Patří sem i rozštěpené zápasy, kde se tipující neshodli.',
        upset: 'Mimo konsenzus jsou zápasy, kde víc než polovina tipujících zvolila stejnou stranu a ta strana nevyšla.',
        split: 'Půl na půl jsou zápasy, kde vítěze trefilo zhruba 35 až 65 procent tipujících.',
        solo: 'Jen ty ukazuje zápasy, kde jsi vítěze trefil sám. Tipovali aspoň tři lidé.',
        others: 'Jenom ostatní ukazuje zápasy, kde vítěze trefili všichni ostatní a ty jsi vedle, nebo jsi zápas netipoval. Aspoň dva ostatní.',
        allhit: 'Trefili všichni jsou zápasy, kde každý tipující trefil vítěze. Aspoň tři tipující.'
    };
    let list = boards.filter((board) => board.n >= 3);
    if (state.matchTab === 'hard') list = list.slice().sort((a, b) => a.hitRate - b.hitRate || b.n - a.n);
    else if (state.matchTab === 'upset') list = list.filter((board) => board.majorityWrong).sort((a, b) => b.majorityN / b.n - a.majorityN / a.n || b.n - a.n);
    else if (state.matchTab === 'split') list = list.filter((board) => board.hitRate >= 0.35 && board.hitRate <= 0.65).sort((a, b) => Math.abs(0.5 - a.hitRate) - Math.abs(0.5 - b.hitRate));
    else if (state.matchTab === 'solo') list = list.filter((board) => {
        const mine = board.tippers.find((tip) => tip.user === state.user);
        return mine && mine.hit && board.hits === 1;
    });
    else if (state.matchTab === 'others') list = list.filter((board) => {
        const mine = board.tippers.find((tip) => tip.user === state.user);
        const others = board.tippers.filter((tip) => tip.user !== state.user);
        return others.length >= 2 && others.every((tip) => tip.hit) && (!mine || !mine.hit);
    }).sort((a, b) => b.n - a.n || b.time - a.time);
    else list = list.filter((board) => board.hits === board.n).sort((a, b) => b.n - a.n);
    list = list.slice(0, 18);
    const rows = list.map((board) => {
        const open = state.openMatch === board.key;
        const mine = board.tippers.find((tip) => tip.user === state.user);
        const main = `<tr class="click" data-match="${esc(board.key)}">
            <td>${czDate(board.date)}<div class="faint">${esc(board.league)}</div></td>
            <td>${esc(board.home)} – ${esc(board.away)}${board.ot ? ' <span class="faint">p</span>' : ''}<div class="faint">${kindName(board.kind)} · ${esc(board.real)}</div></td>
            <td>${mine ? esc(mine.tip) + ' · ' + mine.points + '/' + mine.max : '<span class="faint">netipoval</span>'}</td>
            <td class="num">${board.hits}/${board.n}</td>
            <td>${board.majorityStrict ? sideWord(board.majority) + ' ' + board.majorityN + '/' + board.n : 'bez většiny'}</td>
        </tr>`;
        if (!open) return main;
        const people = board.tippers.slice().sort((a, b) => b.points - a.points || a.user.localeCompare(b.user, 'cs'));
        const detail = people.map((tip) => `<div class="row"><div><strong>${esc(tip.user)}</strong> ${tip.user === state.user ? '<em class="you">ty</em>' : ''}<div class="sub">tip ${esc(tip.tip)}${tip.delta != null ? ' · odchylka ' + tip.delta : ''}</div></div><div>${tip.points}/${tip.max}</div></div>`).join('');
        return main + `<tr class="detail"><td colspan="5"><div class="list">${detail}</div></td></tr>`;
    }).join('');
    return `
        ${banner()}
        <p class="page-intro">${intros[state.matchTab] || intros.hard} Kliknutí na řádek rozbalí všechny tipy.</p>
        <p class="faint tab-help">Nejtěžší řadí podle podílu trefených vítězů. Mimo konsenzus bere jen zápas, kde se víc než polovina shodla na jedné straně a ta strana nevyšla. Zápas se sem dostane od tří tipujících.</p>
        <div class="tabs">${tabs.map(([id, label]) => `<button class="${state.matchTab === id ? 'on' : ''}" data-mtab="${id}">${label}</button>`).join('')}</div>
        <section class="card"><div class="table-wrap"><table class="modern-table"><thead><tr><th>Kdy</th><th>Zápas</th><th>Ty</th><th class="num">Trefy</th><th>Většina</th></tr></thead><tbody>${rows || '<tr><td colspan="5">V tomhle filtru nic takového není.</td></tr>'}</tbody></table></div></section>`;
}

function pageTabulky() {
    const leagues = [];
    const seen = new Set();
    for (const table of DATA.tables) {
        if (table.season !== state.season) continue;
        if (state.league !== 'all' && table.league !== state.league) continue;
        if (!seen.has(table.league)) {
            seen.add(table.league);
            leagues.push(table.league);
        }
    }
    if (!leagues.length) return banner() + '<div class="card empty">V tomhle filtru nikdo neodevzdal tip tabulky.</div>';
    const blocks = leagues.map((league) => {
        const entries = DATA.tables.filter((table) => table.season === state.season && table.league === league);
        const evaluated = entries.some((entry) => entry.evaluated);
        const ranked = entries.slice().sort((a, b) => {
            if (a.user === state.user) return -1;
            if (b.user === state.user) return 1;
            if (evaluated) return (b.correct || 0) - (a.correct || 0) || (a.deviation || 0) - (b.deviation || 0);
            return a.user.localeCompare(b.user, 'cs');
        });
        const scores = evaluated ? `<div class="user-stats-grid table-scores">${ranked.map((entry) => statBox(
            esc(entry.user) + (entry.user === state.user ? ' · ty' : ''),
            String(entry.correct ?? 0),
            'přesných míst · odchylka ' + (entry.deviation ?? 0),
            entry.user === state.user ? 'highlight' : ''
        )).join('')}</div>` : '';
        const groupKeys = [];
        for (const entry of ranked) {
            for (const group of entry.groups) if (!groupKeys.includes(group.key)) groupKeys.push(group.key);
        }
        const groupsHtml = groupKeys.map((key) => {
            let label = key;
            for (const entry of ranked) {
                const found = entry.groups.find((group) => group.key === key);
                if (found) { label = found.label; break; }
            }
            const maxLen = Math.max(0, ...ranked.map((entry) => {
                const group = entry.groups.find((item) => item.key === key);
                return group ? group.names.length : 0;
            }));
            const body = [];
            for (let pos = 0; pos < maxLen; pos++) {
                const names = ranked.map((entry) => {
                    const group = entry.groups.find((item) => item.key === key);
                    return group && group.names[pos] ? group.names[pos] : '';
                });
                const counts = {};
                for (const name of names) if (name) counts[name] = (counts[name] || 0) + 1;
                const anyAgree = Object.values(counts).some((count) => count >= 2);
                const cells = ranked.map((entry, index) => {
                    const group = entry.groups.find((item) => item.key === key);
                    const name = names[index];
                    const mine = entry.user === state.user ? 'me' : '';
                    if (!group) return `<td class="faint ${mine}">neodevzdal</td>`;
                    if (!name) return `<td class="faint ${mine}">—</td>`;
                    const bits = [mine];
                    if (counts[name] >= 2) bits.push('pos-agree');
                    else if (anyAgree) bits.push('pos-diff');
                    return `<td class="${bits.filter(Boolean).join(' ')}">${esc(name)}</td>`;
                }).join('');
                body.push(`<tr><th class="pos">${pos + 1}.</th>${cells}</tr>`);
            }
            const head = ranked.map((entry) => `<th class="${entry.user === state.user ? 'me' : ''}">${esc(entry.user)}${entry.user === state.user ? ' · ty' : ''}</th>`).join('');
            return `<div class="table-group"><h3>${esc(label)}</h3><div class="table-wrap"><table class="modern-table pos-table"><thead><tr><th></th>${head}</tr></thead><tbody>${body.join('')}</tbody></table></div></div>`;
        }).join('');
        let closest = null;
        if (ranked.length >= 2 && groupKeys.length) {
            for (let i = 0; i < ranked.length; i++) {
                for (let j = i + 1; j < ranked.length; j++) {
                    const left = ranked[i];
                    const right = ranked[j];
                    let diff = 0;
                    let n = 0;
                    let sameTop = 0;
                    let tops = 0;
                    for (const key of groupKeys) {
                        const a = left.groups.find((group) => group.key === key);
                        const b = right.groups.find((group) => group.key === key);
                        if (!a || !b) continue;
                        tops += 1;
                        if (a.names[0] && a.names[0] === b.names[0]) sameTop += 1;
                        const pos = new Map(a.names.map((name, index) => [name, index]));
                        for (let p = 0; p < b.names.length; p++) {
                            if (!pos.has(b.names[p])) continue;
                            diff += Math.abs(pos.get(b.names[p]) - p);
                            n += 1;
                        }
                    }
                    if (!n) continue;
                    const avg = diff / n;
                    if (!closest || avg < closest.avg) closest = { left, right, avg, sameTop, tops };
                }
            }
        }
        const agree = closest
            ? `<p class="faint">Nejblíž k sobě mají ${esc(closest.left.user)} a ${esc(closest.right.user)}: průměrný rozdíl pozic ${num(closest.avg)}, stejný vítěz skupiny ${closest.sameTop}/${closest.tops}.</p>`
            : '';
        return `<section class="card" style="margin-top:14px"><h2>${esc(league)}</h2>
            <p class="muted">${evaluated ? 'Body tabulky jsou uložené zvlášť a do bodů ze zápasů se nepřičítají. Řádek je pořadí, sloupec je hráč.' : 'Tabulka ještě není uzavřená, takže tu nejsou body. Řádek je pořadí a sloupec je hráč.'}</p>
            ${scores}
            <p class="pos-legend"><i class="swatch agree"></i> shoda aspoň dvou <i class="swatch diff"></i> jiná volba vedle shody <i class="swatch you"></i> tvůj sloupec</p>
            ${groupsHtml}
            ${agree}
        </section>`;
    }).join('');
    return banner() + '<p class="page-intro">Tipy tabulek jsou vedle zápasů. Do žebříčku zápasů se nepřičítají, stejně jako v dnešní tipovačce.</p>' + blocks;
}

function pageRekordy(rows, boards) {
    const all = scopeTips();
    const sample = minSample();
    const rateRows = rows.filter((row) => row.tips >= sample);
    const dayMap = new Map();
    for (const tip of all) {
        if (!tip.date) continue;
        const key = tip.user + '|' + tip.date;
        if (!dayMap.has(key)) dayMap.set(key, { user: tip.user, date: tip.date, points: 0, max: 0, tips: 0 });
        const day = dayMap.get(key);
        day.points += tip.points;
        day.max += tip.max;
        day.tips += 1;
    }
    const days = [...dayMap.values()];
    const bestDay = days.slice().sort((a, b) => b.points - a.points)[0];
    const worstDay = days.filter((day) => day.tips >= 3).sort((a, b) => (a.max ? a.points / a.max : 1) - (b.max ? b.points / b.max : 1) || b.max - a.max)[0];
    const fiveMap = new Map();
    const seriesMap = new Map();
    let worstDelta = null;
    for (const tip of all) {
        if (tip.kind === 'bo1' && tip.points === 5) fiveMap.set(tip.user, (fiveMap.get(tip.user) || 0) + 1);
        if (tip.kind === 'series' && tip.exact) seriesMap.set(tip.user, (seriesMap.get(tip.user) || 0) + 1);
        if (tip.delta != null && tip.delta > 0 && (!worstDelta || tip.delta > worstDelta.delta)) worstDelta = tip;
    }
    const soloMap = new Map();
    const loneMissMap = new Map();
    for (const board of boards) {
        if (board.n < 3) continue;
        for (const tip of board.tippers) {
            if (tip.hit && board.hits === 1) soloMap.set(tip.user, (soloMap.get(tip.user) || 0) + 1);
        }
        const missed = board.tippers.filter((tip) => !tip.hit);
        if (missed.length === 1 && board.hits === board.n - 1) {
            loneMissMap.set(missed[0].user, (loneMissMap.get(missed[0].user) || 0) + 1);
        }
    }
    const mapLead = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
    const snipers = rows.filter((row) => row.deltaN >= 5).slice().sort((a, b) => a.deltaSum / a.deltaN - b.deltaSum / b.deltaN);
    const exactLead = rows.slice().sort((a, b) => b.exact - a.exact);
    const clutchMap = new Map();
    for (const board of boards) {
        if (board.n < 3) continue;
        const othersHitRate = (user) => {
            const others = board.tippers.filter((tip) => tip.user !== user);
            if (!others.length) return 1;
            return others.filter((tip) => tip.hit).length / others.length;
        };
        for (const tip of board.tippers) {
            if (!tip.hit || othersHitRate(tip.user) >= 0.5) continue;
            clutchMap.set(tip.user, (clutchMap.get(tip.user) || 0) + 1);
        }
    }
    const clutchLead = [...clutchMap.entries()].sort((a, b) => b[1] - a[1]);
    const cards = [];
    const pointsLead = rows.slice().sort((a, b) => b.points - a.points);
    pushRecord(cards, 'Nejvíc bodů', pointsLead[0], pointsLead[0] && (pointsLead[0].points + ' z ' + pointsLead[0].max), pointsLead[1] && (pointsLead[1].user + ' · ' + pointsLead[1].points));
    pushRecord(cards, 'Nejvyšší úspěšnost', rateRows.slice().sort((a, b) => b.points / b.max - a.points / a.max)[0], null, null, true);
    if (rateRows.length) {
        const bestRate = rateRows.slice().sort((a, b) => b.points / b.max - a.points / a.max)[0];
        cards[cards.length - 1].value = pct(bestRate.points, bestRate.max);
        cards[cards.length - 1].name = bestRate.user;
        const second = rateRows.slice().sort((a, b) => b.points / b.max - a.points / a.max)[1];
        cards[cards.length - 1].second = second ? second.user + ' · ' + pct(second.points, second.max) : 'od ' + sample + ' tipů';
    }
    const winLead = rows.slice().sort((a, b) => b.bestW - a.bestW)[0];
    pushRecord(cards, 'Nejdelší série tref', winLead, winLead && (winLead.bestW + ' v řadě'), null);
    const loseLead = rows.slice().sort((a, b) => b.bestL - a.bestL)[0];
    pushRecord(cards, 'Nejdelší série vedle', loseLead, loseLead && (loseLead.bestL + ' v řadě'), null);
    pushRecord(cards, 'Nejpřesnější skóre', snipers[0], snipers[0] && ('± ' + num(snipers[0].deltaSum / snipers[0].deltaN)), snipers[1] && (snipers[1].user + ' · ± ' + num(snipers[1].deltaSum / snipers[1].deltaN)));
    pushRecord(cards, 'Nejvíc přesných tref', exactLead[0], exactLead[0] && String(exactLead[0].exact), exactLead[1] && (exactLead[1].user + ' · ' + exactLead[1].exact));
    if (clutchLead.length) cards.push({ title: 'Trefy proti většině', name: clutchLead[0][0], value: String(clutchLead[0][1]), second: clutchLead[1] ? clutchLead[1][0] + ' · ' + clutchLead[1][1] : 'aspoň 3 tipující' });
    if (bestDay) cards.push({ title: 'Nejtučnější den', name: bestDay.user, value: bestDay.points + ' bodů', second: czDate(bestDay.date) + ' · z ' + bestDay.max });
    const active = rows.slice().sort((a, b) => b.tips - a.tips)[0];
    pushRecord(cards, 'Nejvíc vyhodnocených tipů', active, active && String(active.tips), null);
    const hitRows = rateRows.slice().sort((a, b) => b.hit / b.tips - a.hit / a.tips);
    pushRecord(cards, 'Nejvyšší trefa vítěze', hitRows[0], hitRows[0] && pct(hitRows[0].hit, hitRows[0].tips), hitRows[1] ? hitRows[1].user + ' · ' + pct(hitRows[1].hit, hitRows[1].tips) : 'od ' + sample + ' tipů');
    const regRows = rows.filter((row) => row.regular.tips >= sample).slice().sort((a, b) => (b.regular.max ? b.regular.points / b.regular.max : -1) - (a.regular.max ? a.regular.points / a.regular.max : -1));
    pushRecord(cards, 'Nejlepší základní část', regRows[0], regRows[0] && pct(regRows[0].regular.points, regRows[0].regular.max), regRows[1] ? regRows[1].user + ' · ' + pct(regRows[1].regular.points, regRows[1].regular.max) : 'od ' + sample + ' tipů');
    const playoffRows = rows.map((row) => ({
        user: row.user,
        tips: row.bo1.tips + row.series.tips,
        points: row.bo1.points + row.series.points,
        max: row.bo1.max + row.series.max
    })).filter((row) => row.tips >= 8 && row.max).sort((a, b) => b.points / b.max - a.points / a.max);
    pushRecord(cards, 'Nejlepší playoff', playoffRows[0], playoffRows[0] && pct(playoffRows[0].points, playoffRows[0].max), playoffRows[1] ? playoffRows[1].user + ' · ' + pct(playoffRows[1].points, playoffRows[1].max) : 'od 8 playoff tipů');
    const otRows = rows.filter((row) => row.ot.tips >= 8 && row.ot.max).slice().sort((a, b) => b.ot.points / b.ot.max - a.ot.points / a.ot.max);
    pushRecord(cards, 'Nejlepší v prodloužení', otRows[0], otRows[0] && pct(otRows[0].ot.points, otRows[0].ot.max), otRows[1] ? otRows[1].user + ' · ' + pct(otRows[1].ot.points, otRows[1].ot.max) : 'od 8 zápasů v prodloužení');
    const wasteRows = rows.filter((row) => row.max - row.points > 0).slice().sort((a, b) => (b.max - b.points) - (a.max - a.points));
    pushRecord(cards, 'Nejvíc bodů na stole', wasteRows[0], wasteRows[0] && ((wasteRows[0].max - wasteRows[0].points) + ' bodů'), wasteRows[1] && (wasteRows[1].user + ' · ' + (wasteRows[1].max - wasteRows[1].points)));
    const fiveLead = mapLead(fiveMap);
    if (fiveLead.length) cards.push({ title: 'Nejvíc pětibodových tipů', name: fiveLead[0][0], value: String(fiveLead[0][1]), second: fiveLead[1] ? fiveLead[1][0] + ' · ' + fiveLead[1][1] : 'přesné skóre BO1' });
    const seriesLead = mapLead(seriesMap);
    if (seriesLead.length) cards.push({ title: 'Nejvíc sérií za 3 body', name: seriesLead[0][0], value: String(seriesLead[0][1]), second: seriesLead[1] ? seriesLead[1][0] + ' · ' + seriesLead[1][1] : 'přesný počet výher poraženého' });
    if (worstDelta) cards.push({ title: 'Největší odchylka v zápase', name: worstDelta.user, value: '± ' + worstDelta.delta, second: worstDelta.home + ' – ' + worstDelta.away + ' · ' + czDate(worstDelta.date) });
    const soloLead = mapLead(soloMap);
    if (soloLead.length) cards.push({ title: 'Nejčastěji jediný správný', name: soloLead[0][0], value: String(soloLead[0][1]), second: soloLead[1] ? soloLead[1][0] + ' · ' + soloLead[1][1] : 'aspoň 3 tipující' });
    const loneLead = mapLead(loneMissMap);
    if (loneLead.length) cards.push({ title: 'Nejčastěji jediný vedle', name: loneLead[0][0], value: String(loneLead[0][1]), second: loneLead[1] ? loneLead[1][0] + ' · ' + loneLead[1][1] : 'ostatní trefili vítěze' });
    if (pointsLead[0] && pointsLead[1]) cards.push({ title: 'Náskok na druhého', name: pointsLead[0].user, value: (pointsLead[0].points - pointsLead[1].points) + ' bodů', second: pointsLead[1].user + ' · ' + pointsLead[1].points });
    if (worstDay) cards.push({ title: 'Nejslabší den', name: worstDay.user, value: pct(worstDay.points, worstDay.max), second: czDate(worstDay.date) + ' · ' + worstDay.points + ' z ' + worstDay.max });
    let bestShift = null;
    for (const row of rows) {
        const arr = row.list.slice().sort((a, b) => a.time - b.time || a.id - b.id);
        const mid = Math.floor(arr.length / 2);
        if (mid < 8 || arr.length - mid < 8) continue;
        const first = summarize(arr.slice(0, mid));
        const secondHalf = summarize(arr.slice(mid));
        if (!first.max || !secondHalf.max) continue;
        const diff = secondHalf.points / secondHalf.max - first.points / first.max;
        if (diff <= 0) continue;
        if (!bestShift || diff > bestShift.diff) bestShift = { user: row.user, first, secondHalf };
    }
    if (bestShift) cards.push({ title: 'Největší zlepšení v druhé půlce', name: bestShift.user, value: pct(bestShift.secondHalf.points, bestShift.secondHalf.max), second: 'první půlka ' + pct(bestShift.first.points, bestShift.first.max) });
    const html = cards.filter((card) => card && card.name).map((card) => `<article class="card rec ${card.name === state.user ? 'is-you' : ''}"><span class="rec-kicker">${esc(card.title)}</span><b>${esc(card.value)}</b><em>${esc(card.name)}${card.name === state.user ? '<span class="you"> ty</span>' : ''}</em>${card.second ? `<div class="rec-second">${esc(card.second)}</div>` : ''}</article>`).join('');
    return `
        ${banner()}
        <p class="page-intro">Rekordy drží filtr. Úspěšnost bodů, trefa vítěze a základní část až od ${sample} tipů. Odchylka skóre až od 5 zápasů na jeden zápas, playoff a prodloužení od 8 tipů, nejslabší den od 3 tipů v jeden den, posun půlek od 8 tipů v každé půlce.</p>
        <div class="recs">${html || '<div class="card empty">Na rekordy je málo dat.</div>'}</div>`;
}
function pushRecord(cards, title, row, value, second) {
    if (!row) return;
    cards.push({ title, name: row.user, value: value || '—', second: second || '' });
}

function banner() {
    return '';
}

function render() {
    try {
        state.user = DATA.viewer;
        if (!DATA.users.includes(state.subject)) state.subject = DATA.viewer;
        if (!leagueList().includes(state.league) && state.league !== 'all') state.league = 'all';
        const tips = scopeTips();
        const rows = standings(tips);
        const boards = matchBoards(tips);
        renderNav(rows);
        renderFilters();
        const view = {
            prehled: () => pagePrehled(rows, boards),
            zebricek: () => pageZebricek(rows),
            ligy: () => pageLigy(),
            hra: () => pageHra(rows, boards),
            souboje: () => pageSouboje(),
            cas: () => pageCas(rows),
            zapasy: () => pageZapasy(boards),
            tabulky: () => pageTabulky(),
            rekordy: () => pageRekordy(rows, boards)
        };
        document.getElementById('stb-view').innerHTML = (view[state.page] || view.prehled)();
        writeHash();
        const pageTitle = (PAGES.find((page) => page[0] === state.page) || PAGES[0])[1];
        const subjectTitle = state.page === 'hra' && state.subject !== state.user ? state.subject + ' · ' : '';
        document.title = subjectTitle + pageTitle + ' · Statistiky';
    } catch (error) {
        const view = document.getElementById('stb-view');
        if (view) view.innerHTML = '<pre class="card">' + esc(error.stack || error.message) + '</pre>';
    }
}

document.addEventListener('change', (event) => {
    const id = event.target.id;
    if (id === 'f-season') state.season = event.target.value;
    else if (id === 'f-league') state.league = event.target.value;
    else if (id === 'f-kind') state.kind = event.target.value;
    else if (id === 'f-rival') state.rival = event.target.value;
    else if (id === 'f-subject') state.subject = event.target.value;
    else return;
    state.openMatch = '';
    render();
});
document.addEventListener('click', (event) => {
    const page = event.target.closest('[data-page]');
    if (page) {
        state.page = page.dataset.page;
        render();
        return;
    }
    const sort = event.target.closest('[data-sort]');
    if (sort) {
        const key = sort.dataset.sort;
        if (key === 'rank') return;
        if (state.sort === key) state.dir *= -1;
        else {
            state.sort = key;
            state.dir = key === 'delta' || key === 'user' ? 1 : -1;
        }
        render();
        return;
    }
    const league = event.target.closest('[data-set-league]');
    if (league) {
        state.league = league.dataset.setLeague;
        render();
        return;
    }
    const tab = event.target.closest('[data-mtab]');
    if (tab) {
        state.matchTab = tab.dataset.mtab;
        state.openMatch = '';
        render();
        return;
    }
    const match = event.target.closest('[data-match]');
    if (match) {
        state.openMatch = state.openMatch === match.dataset.match ? '' : match.dataset.match;
        render();
    }
});

readHash();
render();
