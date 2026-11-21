/**
 * Livesport.cz API Service
 * Stahuje data o zápasech z livesport.cz API
 */
const axios = require('axios');

// Pokusíme se načíst puppeteer-core a chromium pro hosting
let puppeteer;
let chromium;
try {
    puppeteer = require('puppeteer-core');
} catch (e) {
    puppeteer = null;
}
try {
    chromium = require('@sparticuz/chromium');
} catch (e) {
    chromium = null;
}

// Liga ID mapování pro Livesport
const LEAGUE_ID_MAP = {
    'TELH': { id: 'UCEL8Q9b', name: 'Tipsport extraliga' },
    'Tipsport extraliga': { id: 'UCEL8Q9b', name: 'Tipsport extraliga' },
    'Extraliga': { id: 'UCEL8Q9b', name: 'Tipsport extraliga' },
    '1. liga': { id: 'OtdS9pLC', name: 'První liga' },
    'Chance liga': { id: 'OtdS9pLC', name: 'Chance liga' },
    'CHANCE LIGA': { id: 'OtdS9pLC', name: 'Chance liga' },
    // MAXA liga (2. česká liga)
    'MAXA liga': { id: '4O3WGPDF', name: 'MAXA liga' },
    '2. liga': { id: '4O3WGPDF', name: 'MAXA liga' },
    // MS v hokeji
    'MS': { id: 'YJWat7oe', name: 'Mistrovství světa' },
    'Mistrovstvi sveta': { id: 'YJWat7oe', name: 'Mistrovství světa' },
    'MS v hokeji': { id: 'YJWat7oe', name: 'Mistrovství světa' },
    'IIHF': { id: 'YJWat7oe', name: 'Mistrovství světa' },
    // Spengler Cup
    'Spengler Cup': { id: 'neznámé', name: 'Spengler Cup' },
    'Spengler': { id: 'neznámé', name: 'Spengler Cup' },
    // Olympiáda
    'Olympiada': { id: 'neznámé', name: 'Olympijské hry' },
    'Olympijske hry': { id: 'neznámé', name: 'Olympijské hry' },
    'ZOH': { id: 'neznámé', name: 'Olympijské hry' },
};

/**
 * Extrahuje liga ID z URL - univerzální pro jakoukoliv ligu
 * Podporuje různé formáty:
 * - /zapasy/2025-2026/telh-UCEL8Q9b/
 * - /hokej/svet/mistrovstvi-sveta/program/
 * - /hokej/cesko/tipsport-extraliga/zapasy/
 */
function getLeagueId(ligaName, url = null) {
    if (!url) return null;

    // Formát 1: Kategorie URL bez ID (např. /hokej/svet/mistrovstvi-sveta/program/)
    // Toto musí být PRVNÍ, jinak by Formát 2 vzal "program" jako ID
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(p => p);
        // Path: ['hokej', 'svet', 'mistrovstvi-sveta', 'program']
        if (pathParts.length >= 3 && pathParts[0] === 'hokej') {
            const categoryName = pathParts[2]; // 'mistrovstvi-sveta'
            // Vyloučíme 'program', 'zapasy', 'vysledky'
            if (categoryName && !['program', 'zapasy', 'vysledky'].includes(categoryName)) {
                // Zkusíme najít ID v mapě lig podle názvu kategorie
                // Normalizujeme název pro porovnání (převést pomlčky na mezery, lowercase)
                const normalizedCategory = categoryName.replace(/-/g, ' ').toLowerCase();
                
                // Hledáme shodu v LEAGUE_ID_MAP
                for (const [key, value] of Object.entries(LEAGUE_ID_MAP)) {
                    const normalizedKey = key.replace(/-/g, ' ').toLowerCase();
                    const normalizedValue = value.name.replace(/-/g, ' ').toLowerCase();
                    if (normalizedKey === normalizedCategory || normalizedValue === normalizedCategory) {
                        return value.id;
                    }
                }
                
                // Pokud nenalezeno v mapě, vrátíme název kategorie (staré chování)
                return categoryName;
            }
        }
    } catch (e) {
        console.error('❌ URL parsing selhal:', e.message);
    }

    // Formát 2: Standardní livesport s ID v URL
    // /zapasy/2025-2026/telh-UCEL8Q9b/
    const standardMatch = url.match(/[-/]([A-Za-z0-9]{6,10})[/?#]?$/);
    if (standardMatch) {
        const id = standardMatch[1];
        // Vyloučíme běžná slova která nejsou ID
        if (!['program', 'zapasy', 'vysledky'].includes(id)) {
            return id;
        }
    }

    // Fallback na mapu známých lig
    if (LEAGUE_ID_MAP[ligaName]) {
        return LEAGUE_ID_MAP[ligaName].id;
    }

    return null;
}

/**
 * Extrahuje sezónu z URL nebo vrátí výchozí
 */
function getSeasonFromUrl(url) {
    if (!url) return null;

    // Livesport URL formáty:
    // https://www.livesport.cz/zapasy/2024-2025/telh-UCEL8Q9b/
    // https://www.livesport.cz/liga/telh-UCEL8Q9b/
    const seasonMatch = url.match(/zapasy\/(\d{4})-?\d{0,4}/);
    if (seasonMatch) {
        const year = parseInt(seasonMatch[1]);
        const nextYear = year + 1;
        return `${String(year).slice(-2)}/${String(nextYear).slice(-2)}`;
    }

    return null;
}

/**
 * Normalizuje název týmu pro porovnání
 * Pouze základní normalizace - kompletní matching řeší dynamické aliasy
 */
function normalizeTeamName(name) {
    if (!name) return '';
    return name
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

/**
 * Najde tým v databázi podle názvu z Livesportu
 */
function findTeamInDatabase(teamName, dbTeams, liga) {
    const normalizedName = normalizeTeamName(teamName);

    // Filtrovat týmy jen z dané ligy
    const leagueTeams = dbTeams.filter(t => t.liga === liga);

    // 1. Přesná shoda na normalizovaném názvu
    let found = leagueTeams.find(t => {
        return normalizeTeamName(t.name) === normalizedName;
    });

    if (found) return Number(found.id);

    // 2. Shoda v aliasech týmu
    found = leagueTeams.find(t => {
        if (t.aliases && Array.isArray(t.aliases)) {
            const normalizedAliases = t.aliases.map(a => normalizeTeamName(a));
            return normalizedAliases.includes(normalizedName);
        }
        return false;
    });

    if (found) return Number(found.id);

    // 3. Partial match - jeden obsahuje druhý
    found = leagueTeams.find(t => {
        const dbNorm = normalizeTeamName(t.name);
        return dbNorm.includes(normalizedName) || normalizedName.includes(dbNorm);
    });

    if (found) return Number(found.id);

    // 4. Partial match v aliasech
    found = leagueTeams.find(t => {
        if (t.aliases && Array.isArray(t.aliases)) {
            const normalizedAliases = t.aliases.map(a => normalizeTeamName(a));
            return normalizedAliases.some(alias =>
                alias.includes(normalizedName) || normalizedName.includes(alias)
            );
        }
        return false;
    });

    if (found) return Number(found.id);

    // 5. Shoda na prvních 5 znacích (pro případy jako "Mountfield HK" vs "Mountfield")
    found = leagueTeams.find(t => {
        const dbNorm = normalizeTeamName(t.name);
        return dbNorm.substring(0, 5) === normalizedName.substring(0, 5);
    });

    if (found) return Number(found.id);

    return null;
}

/**
 * Parsovat datum a čas z Livesport formátu
 * Livesport vrací: "time":"19:00" a date je součástí event struktury
 */
function parseDateTime(dateStr, timeStr, season) {
    try {
        const [hours, minutes] = timeStr.split(':').map(Number);

        // Rozparsujeme datum - Livesport vrací různé formáty
        let day, month, year;

        if (dateStr.includes('.')) {
            // Český formát: "12. 3. 2025" nebo "12.3.2025"
            const parts = dateStr.replace(/\s/g, '').split('.');
            day = parseInt(parts[0]);
            month = parseInt(parts[1]);
            year = parts[2] ? parseInt(parts[2]) : null;
        } else if (dateStr.includes('-')) {
            // ISO formát: "2025-03-12"
            const parts = dateStr.split('-');
            year = parseInt(parts[0]);
            month = parseInt(parts[1]);
            day = parseInt(parts[2]);
        }

        if (!year && season) {
            // Vypočítáme rok podle sezóny a měsíce
            const seasonYears = season.split('/');
            const startYear = 2000 + parseInt(seasonYears[0]);
            const endYear = 2000 + parseInt(seasonYears[1]);
            year = month >= 8 ? startYear : endYear;
        }

        const paddedDay = String(day).padStart(2, '0');
        const paddedMonth = String(month).padStart(2, '0');
        const paddedHours = String(hours).padStart(2, '0');
        const paddedMinutes = String(minutes).padStart(2, '0');

        return {
            date: `${year}-${paddedMonth}-${paddedDay}`,
            time: `${paddedHours}:${paddedMinutes}`,
            datetime: `${year}-${paddedMonth}-${paddedDay}T${paddedHours}:${paddedMinutes}`
        };
    } catch (error) {
        console.error('Chyba při parsování data:', error, { dateStr, timeStr });
        return null;
    }
}

/**
 * Extrahuje tabulku (standings) z hokej.cz HTML stránky
 * hokej.cz má specifickou strukturu HTML
 */
function extractStandingsFromHokejCz(html, dbTeams, liga) {
    const standings = [];
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);

    // hokej.cz má tabulku s třídou .table nebo .standings-table
    const table = $('.table, .standings-table, table').first();
    
    if (!table || table.length === 0) {
        return [];
    }

    // Projdeme řádky tabulky
    table.find('tr').each((i, row) => {
        const $row = $(row);
        const cells = $row.find('td');

        if (cells.length < 5) return; // Příliš málo sloupců

        // hokej.cz má často: pořadí | tým | zápasy | body | skóre | ...
        let teamName = '';
        let points = 0, games = 0, gf = 0, ga = 0;

        cells.each((j, cell) => {
            const $cell = $(cell);
            const text = $cell.text().trim();
            
            // Tým je často v buňce s odkazem nebo obrázkem
            const link = $cell.find('a').first();
            if (link.length > 0 && !teamName) {
                teamName = link.text().trim();
            }
            
            // Pokud není tým, zkusíme text přímo
            if (!teamName && j > 0 && !/^\d+$/.test(text) && !text.includes(':')) {
                teamName = text;
            }

            // Body jsou často v sloupci s třídou obsahující "body" nebo "pts"
            const cellClass = $cell.attr('class') || '';
            if (cellClass.includes('body') || cellClass.includes('pts') || cellClass.includes('point')) {
                points = parseInt(text, 10) || 0;
            }

            // Zápasy jsou často v sloupci s třídou obsahující "zap" nebo "game"
            if (cellClass.includes('zap') || cellClass.includes('game') || cellClass.includes('match')) {
                games = parseInt(text, 10) || 0;
            }

            // Skóre je často ve formátu "vstřelené:inkasované"
            if (text.includes(':')) {
                const scoreMatch = text.match(/(\d+):(\d+)/);
                if (scoreMatch) {
                    gf = parseInt(scoreMatch[1], 10);
                    ga = parseInt(scoreMatch[2], 10);
                }
            }
        });

        if (!teamName) return;

        const teamId = findTeamInDatabase(teamName, dbTeams, liga);
        if (!teamId) {
            console.log(`⚠️ Tým nenalezen v DB: ${teamName}`);
            return;
        }

        standings.push({
            teamId,
            teamName,
            points,
            games,
            gf,
            ga
        });
    });

    console.log(`✅ Extrahováno ${standings.length} týmů z hokej.cz`);
    return standings;
}

/**
 * Extrahuje tabulku (standings) z Livesport HTML stránky
 * Vrací pole objektů s názvem týmu, body, zápasy, góly
 */
function extractStandingsFromHtml(html, dbTeams, liga) {
    const standings = [];
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);

    // Livesport používá různé selektory pro tabulky
    const tableSelectors = [
        '.standings__table',
        '.table__standings',
        'table.standings',
        '[class*="standings"] table',
        '.tournament-table',
        'table[class*="table"]',
        '.ui-table',
        'table'
    ];

    let table = null;
    for (const selector of tableSelectors) {
        table = $(selector).first();
        if (table.length > 0) {
            console.log(`✅ Nalezena tabulka pomocí selektoru: ${selector}`);
            break;
        }
    }

    if (!table || table.length === 0) {
        console.log('⚠️ Tabulka nenalezena v HTML');
        return [];
    }

    // Projdeme řádky tabulky
    table.find('tr').each((i, row) => {
        const $row = $(row);
        const cells = $row.find('td, th');

        if (cells.length < 3) return; // Příliš málo sloupců

        // Zkusíme extrahovat název týmu
        let teamName = '';
        const nameCell = cells.find('[class*="name"], .participant, .team-name, [class*="team"]').first();
        if (nameCell.length > 0) {
            teamName = nameCell.text().trim();
        } else {
            // Fallback - první sloupec nebo sloupec s třídou obsahující "team"
            for (let j = 0; j < cells.length; j++) {
                const cellText = $(cells[j]).text().trim();
                if (cellText.length > 2 && !/^\d+$/.test(cellText) && !cellText.includes(':')) {
                    teamName = cellText;
                    break;
                }
            }
        }

        if (!teamName) return;

        // Najdeme tým v databázi
        const teamId = findTeamInDatabase(teamName, dbTeams, liga);
        if (!teamId) {
            console.log(`⚠️ Tým nenalezen v DB: ${teamName}`);
            return;
        }

        // Extrahujeme statistiky - Livesport má různé formáty
        let points = 0, games = 0, gf = 0, ga = 0;

        // Procházíme buňky a hledáme číselné hodnoty
        cells.each((j, cell) => {
            const $cell = $(cell);
            const text = $cell.text().trim();
            const num = parseInt(text, 10);

            if (isNaN(num)) return;

            // Detekce typu sloupce podle tříd nebo pozice
            const cellClass = $cell.attr('class') || '';
            
            if (cellClass.includes('points') || cellClass.includes('pts')) {
                points = num;
            } else if (cellClass.includes('matches') || cellClass.includes('games') || cellClass.includes('played')) {
                games = num;
            } else if (cellClass.includes('goals') || cellClass.includes('score') || cellClass.includes('gf')) {
                gf = num;
            } else if (cellClass.includes('against') || cellClass.includes('ga') || cellClass.includes('conceded')) {
                ga = num;
            }
        });

        // Pokud se nepodařilo detekovat přesné sloupce, zkusíme heuristiku podle pozice
        if (points === 0 || games === 0) {
            const values = [];
            cells.each((j, cell) => {
                const text = $(cell).text().trim();
                const num = parseInt(text, 10);
                if (!isNaN(num)) values.push(num);
            });

            // Heuristika: poslední sloupec je často body, předposlední zápasy
            if (values.length >= 3) {
                points = values[values.length - 1] || 0;
                games = values[values.length - 2] || 0;
                // Góly jsou často ve formátu "vstřelené:inkasované"
                const scoreCell = cells.find('[class*="score"], [class*="goals"]').first();
                if (scoreCell.length > 0) {
                    const scoreText = scoreCell.text().trim();
                    const scoreMatch = scoreText.match(/(\d+):(\d+)/);
                    if (scoreMatch) {
                        gf = parseInt(scoreMatch[1], 10);
                        ga = parseInt(scoreMatch[2], 10);
                    }
                }
            }
        }

        standings.push({
            teamId,
            teamName,
            points,
            games,
            gf,
            ga
        });
    });

    console.log(`✅ Extrahováno ${standings.length} týmů z tabulky`);
    return standings;
}

/**
 * Extrahuje zápasy přímo z cjs.initialFeeds v HTML stránky (bez nutnosti spouštět Puppeteer/Chrome)
 * Livesport servíruje data v cjs.initialFeeds přímo v HTML odpovědi.
 */
function extractEventsFromInitialFeeds(html) {
    if (!html || typeof html !== 'string') return [];

    const events = [];
    const seen = new Set();
    const feedKeys = ['fixtures', 'summary-fixtures', 'results', 'summary-results'];

    for (const key of feedKeys) {
        const keyIdx = html.indexOf(`initialFeeds['${key}']`) !== -1 
            ? html.indexOf(`initialFeeds['${key}']`) 
            : html.indexOf(`initialFeeds["${key}"]`);

        if (keyIdx === -1) continue;

        const dataIdx = html.indexOf('data:', keyIdx);
        if (dataIdx === -1 || (dataIdx - keyIdx) > 300) continue;

        const quoteMatch = html.slice(dataIdx + 5, dataIdx + 20).match(/[`'"]/);
        if (!quoteMatch) continue;

        const quoteChar = quoteMatch[0];
        const quoteStart = html.indexOf(quoteChar, dataIdx + 5);
        const quoteEnd = html.indexOf(quoteChar, quoteStart + 1);
        if (quoteEnd === -1) continue;

        const feedData = html.slice(quoteStart + 1, quoteEnd);
        const matchBlocks = feedData.split('~AA÷');

        for (let i = 1; i < matchBlocks.length; i++) {
            const block = matchBlocks[i];
            const parts = block.split('¬');
            let homeTeam = '';
            let awayTeam = '';
            let timestamp = '';

            for (const part of parts) {
                if (part.startsWith('CX÷')) {
                    homeTeam = part.substring(3).trim();
                } else if (part.startsWith('AF÷')) {
                    awayTeam = part.substring(3).trim();
                } else if (part.startsWith('AD÷')) {
                    timestamp = part.substring(3).trim();
                }
            }

            if (homeTeam && awayTeam && timestamp) {
                const uniqueKey = `${homeTeam}_${awayTeam}_${timestamp}`;
                if (seen.has(uniqueKey)) continue;
                seen.add(uniqueKey);

                // Převod timestamp na středoevropský čas (Europe/Prague)
                const d = new Date(parseInt(timestamp, 10) * 1000);
                const pragueParts = new Intl.DateTimeFormat('cs-CZ', {
                    timeZone: 'Europe/Prague',
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', hour12: false
                }).formatToParts(d);
                const map = Object.fromEntries(pragueParts.map(p => [p.type, p.value]));

                events.push({
                    homeTeam,
                    awayTeam,
                    date: `${map.year}-${map.month}-${map.day}`,
                    time: `${map.hour}:${map.minute}`,
                    status: 'scheduled'
                });
            }
        }

        if (events.length > 0 && (key === 'fixtures' || key === 'results')) {
            break;
        }
    }

    return events;
}

/**
 * Extrahuje tabulku (standings) z cjs.initialFeeds v HTML
 * Livesport servíruje data v cjs.initialFeeds přímo v HTML odpovědi
 */
function extractStandingsFromInitialFeeds(html, dbTeams, liga) {
    const standings = [];
    
    // Hledáme standings feed v cjs.initialFeeds - Livesport používá různé klíče
    const feedKeys = [
        'standings', 
        'table', 
        'summary-standings',
        'tournamentTable',
        'leagueTable',
        'competitionTable'
    ];

    for (const key of feedKeys) {
        const keyIdx = html.indexOf(`initialFeeds['${key}']`) !== -1 
            ? html.indexOf(`initialFeeds['${key}']`) 
            : html.indexOf(`initialFeeds["${key}"]`);

        if (keyIdx === -1) continue;

        const dataIdx = html.indexOf('data:', keyIdx);
        if (dataIdx === -1 || (dataIdx - keyIdx) > 500) continue;

        const quoteMatch = html.slice(dataIdx + 5, dataIdx + 20).match(/[`'"]/);
        if (!quoteMatch) continue;

        const quoteChar = quoteMatch[0];
        const quoteStart = html.indexOf(quoteChar, dataIdx + 5);
        const quoteEnd = html.indexOf(quoteChar, quoteStart + 1);
        if (quoteEnd === -1) continue;

        const feedData = html.slice(quoteStart + 1, quoteEnd);
        const teamBlocks = feedData.split('~AA÷');

        for (let i = 1; i < teamBlocks.length; i++) {
            const block = teamBlocks[i];
            const parts = block.split('¬');
            let teamName = '';
            let points = 0, games = 0, gf = 0, ga = 0;

            for (const part of parts) {
                if (part.startsWith('CX÷')) {
                    teamName = part.substring(3).trim();
                } else if (part.startsWith('PO÷')) {
                    points = parseInt(part.substring(3), 10) || 0;
                } else if (part.startsWith('PL÷')) {
                    games = parseInt(part.substring(3), 10) || 0;
                } else if (part.startsWith('GF÷')) {
                    gf = parseInt(part.substring(3), 10) || 0;
                } else if (part.startsWith('GA÷')) {
                    ga = parseInt(part.substring(3), 10) || 0;
                }
            }

            if (teamName) {
                const teamId = findTeamInDatabase(teamName, dbTeams, liga);
                if (teamId) {
                    standings.push({
                        teamId,
                        teamName,
                        points,
                        games,
                        gf,
                        ga
                    });
                }
            }
        }

        if (standings.length > 0) {
            console.log(`✅ Extrahováno ${standings.length} týmů z initialFeeds (${key})`);
            return standings;
        }
    }

    return standings;
}

/**
 * Extrahuje tabulku (standings) z Livesport API odpovědi
 * Vrací pole objektů s názvem týmu, body, zápasy, góly
 */
function extractStandingsFromApi(apiData, dbTeams, liga) {
    const standings = [];

    if (!apiData) return standings;

    // Livesport API může vracet data v různých formátech
    const rows = apiData.rows || apiData.standings || apiData.table || [];

    for (const row of rows) {
        if (!row) continue;

        // Extrahujeme název týmu
        const teamName = row.name || row.team || row.participant || row.teamName;
        if (!teamName) continue;

        // Najdeme tým v databázi
        const teamId = findTeamInDatabase(teamName, dbTeams, liga);
        if (!teamId) {
            console.log(`⚠️ Tým nenalezen v DB: ${teamName}`);
            continue;
        }

        // Extrahujeme statistiky
        const points = row.points || row.pts || 0;
        const games = row.matches || row.played || row.games || 0;
        const gf = row.goalsFor || row.gf || row.scored || 0;
        const ga = row.goalsAgainst || row.ga || row.conceded || 0;

        standings.push({
            teamId,
            teamName,
            points,
            games,
            gf,
            ga
        });
    }

    console.log(`✅ Extrahováno ${standings.length} týmů z API`);
    return standings;
}

/**
 * Parsuje standings feed z flashscore.ninja (/x/feed/to_*).
 * Formát: pole oddělená ¬, klíč-hodnota oddělené ÷.
 * Týmové bloky začínají ~TR÷, končí ~LMS÷ nebo jiným ~ markerem.
 */
function parseStandingsFeed(feedText, dbTeams, liga) {
    const standings = [];
    const fields = feedText.split('¬');

    let currentTeam = null;
    let inTeamBlock = false;

    for (const field of fields) {
        if (field.startsWith('~TR÷')) {
            if (currentTeam && currentTeam.teamName) {
                standings.push(currentTeam);
            }
            currentTeam = {};
            inTeamBlock = true;
            continue;
        }

        if (field.startsWith('~') && !field.startsWith('~TR')) {
            if (currentTeam && currentTeam.teamName) {
                standings.push(currentTeam);
            }
            currentTeam = null;
            inTeamBlock = false;
            continue;
        }

        if (!inTeamBlock || !currentTeam) continue;

        const divIdx = field.indexOf('÷');
        if (divIdx === -1) continue;

        const key = field.substring(0, divIdx);
        const value = field.substring(divIdx + 1);

        switch (key) {
            case 'TN': currentTeam.teamName = value; break;
            case 'TI': currentTeam.teamId = value; break;
            case 'TM': currentTeam.games = parseInt(value, 10); break;
            case 'TW': currentTeam.wins = parseInt(value, 10); break;
            case 'TL': currentTeam.losses = parseInt(value, 10); break;
            case 'TG': {
                const parts = value.split(':');
                currentTeam.gf = parseInt(parts[0], 10) || 0;
                currentTeam.ga = parseInt(parts[1], 10) || 0;
                break;
            }
            case 'TP': currentTeam.points = parseInt(value, 10); break;
        }
    }

    if (currentTeam && currentTeam.teamName) {
        standings.push(currentTeam);
    }

    const result = [];
    for (const t of standings) {
        const dbTeamId = findTeamInDatabase(t.teamName, dbTeams, liga);
        if (dbTeamId) {
            result.push({
                teamId: dbTeamId,
                teamName: t.teamName,
                points: t.points || 0,
                games: t.games || 0,
                gf: t.gf || 0,
                ga: t.ga || 0
            });
        } else {
            console.log(`⚠️ Tým nenalezen v DB: ${t.teamName}`);
        }
    }

    console.log(`✅ Extrahováno ${result.length} týmů z feedu`);
    return result;
}

/**
 * Extrahuje tournamentId a stageId z Livesport HTML stránky.
 * Livesport nově používá window.tournamentId a tournamentStageId v leaguePageHeaderData.
 */
function extractTournamentIds(html) {
    const result = { tournamentId: null, stageId: null, feedSign: null };

    // window.tournamentId = "..."
    const tidMatch = html.match(/window\.tournamentId\s*=\s*"([^"]+)"/);
    if (tidMatch) result.tournamentId = tidMatch[1];

    // tournamentId: "..." v leaguePageHeaderData
    if (!result.tournamentId) {
        const tidMatch2 = html.match(/tournamentId["'\s:]+([A-Za-z0-9]{6,})/);
        if (tidMatch2) result.tournamentId = tidMatch2[1];
    }

    // tournamentStageId: "..."
    const sidMatch = html.match(/tournamentStageId["'\s:]+([A-Za-z0-9]{6,})/);
    if (sidMatch) result.stageId = sidMatch[1];

    // feed_sign pro x-fsign header
    const fsMatch = html.match(/feed_sign["'\s:]+([A-Za-z0-9]+)/);
    if (fsMatch) result.feedSign = fsMatch[1];

    return result;
}

/**
 * Stáhne a parsuje standings feed z flashscore.ninja.
 * Feed URL: https://1.flashwall.ninja/1/x/feed/to_{tournamentId}_{stageId}_1
 */
async function fetchStandingsFromFeed(tournamentId, stageId, dbTeams, liga, refererUrl, feedSign) {
    const feedUrl = `https://1.flashscore.ninja/1/x/feed/to_${tournamentId}_${stageId}_1`;

    try {
        const response = await axios.get(feedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*',
                'Referer': refererUrl || 'https://www.livesport.cz/',
                'x-fsign': feedSign || 'SW9D1eZo'
            },
            timeout: 15000
        });

        if (response.data && typeof response.data === 'string') {
            return parseStandingsFeed(response.data, dbTeams, liga);
        }
    } catch (err) {
        console.log(`⚠️ Feed request selhal: ${feedUrl} - ${err.message}`);
    }

    return [];
}

/**
 * Hlavní funkce pro stažení tabulky (standings) z Livesportu
 * @param {Object} options - Konfigurační objekt
 * @param {string} options.url - URL stránky s tabulkou na Livesportu
 * @param {string} options.liga - Název ligy
 * @param {Array} options.dbTeams - Pole týmů z databáze
 * @returns {Promise<Object>} - Výsledek importu
 */
async function fetchStandingsFromLivesport(options) {
    let { url, liga, dbTeams } = options;

    if (!url) {
        return {
            success: false,
            error: 'URL je povinná',
            standings: []
        };
    }

    // Očištění URL
    url = url.trim();
    if (url.includes('/C:') || url.includes('//C:')) {
        url = url.split(/\/+C:/i)[0];
        if (!url.endsWith('/')) url += '/';
    }
    
    // Pokud URL obsahuje hash (#), odstraníme ho
    url = url.split('#')[0];

    try {
        // 1. Pokud URL je hokej.cz, použijeme specifickou extrakci
        if (url.includes('hokej.cz')) {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.9'
                },
                timeout: 30000
            });

            const html = response.data;
            const standings = extractStandingsFromHokejCz(html, dbTeams, liga);
            
            if (standings.length > 0) {
                return {
                    success: true,
                    standings,
                    count: standings.length
                };
            }
        }

        // 2. Pokud URL není Livesport ani hokej.cz, zkusíme přímou extrakci (isport.blesk.cz mají statické tabulky)
        if (!url.includes('livesport.cz') && !url.includes('flashscore.com')) {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.9'
                },
                timeout: 30000
            });

            const html = response.data;
            const standings = extractStandingsFromHtml(html, dbTeams, liga);
            
            if (standings.length > 0) {
                return {
                    success: true,
                    standings,
                    count: standings.length
                };
            }
        }

        // 2. Zkusíme URL /tabulka/ - Livesport má samostatnou stránku pro tabulky
        const standingsUrl = url.replace(/\/$/, '') + '/tabulka/';
        
        try {
            const standingsResponse = await axios.get(standingsUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.9'
                },
                timeout: 30000
            });

            const standingsHtml = standingsResponse.data;
            
            // Zkusíme feed API z tabulka stránky - to je klíčové!
            const { tournamentId: feedTid, stageId: feedSid, feedSign } = extractTournamentIds(standingsHtml);
            if (feedTid && feedSid) {
                console.log(`🔍 Feed IDs z tabulka: tournament=${feedTid}, stage=${feedSid}`);
                const feedStandings = await fetchStandingsFromFeed(feedTid, feedSid, dbTeams, liga, standingsUrl, feedSign);
                if (feedStandings.length > 0) {
                    return {
                        success: true,
                        standings: feedStandings,
                        count: feedStandings.length
                    };
                }
            }
            
            // Fallback na HTML extrakci z tabulka stránky
            const standingsFromHtml = extractStandingsFromHtml(standingsHtml, dbTeams, liga);
            if (standingsFromHtml.length > 0) {
                return {
                    success: true,
                    standings: standingsFromHtml,
                    count: standingsFromHtml.length
                };
            }
        } catch (standingsErr) {
            console.log(`⚠️ /tabulka/ endpoint selhal: ${standingsErr.message}`);
        }

        // 2. Nejprve zkusíme HTML - pro starší stránky
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'cs,en;q=0.9'
            },
            timeout: 30000
        });

        const html = response.data;

        // Logování všech initialFeeds klíčů pro debug
        const feedMatches = html.match(/initialFeeds\[['"][^'"]+['"]/g);
        if (feedMatches) {
            console.log('🔍 Nalezené initialFeeds klíče:', [...new Set(feedMatches)]);
        }

        // Zkusíme extrahovat tournament ID z HTML
        const tournamentMatch = html.match(/"tournament"\s*:\s*"([^"]+)"/) || 
                               html.match(/"tournamentId"\s*:\s*"([^"]+)"/) ||
                               html.match(/tournament["\s:]+([A-Za-z0-9]+)/);

        let tournamentId = null;
        if (tournamentMatch) {
            tournamentId = tournamentMatch[1];
        }

        // 2. Pokud máme tournament ID, zkusíme API
        if (tournamentId) {
            console.log(`🔍 Nalezeno tournament ID: ${tournamentId}`);
            
            const apiUrls = [
                `https://www.livesport.cz/api/v1/tournament/${tournamentId}/standings`,
                `https://www.livesport.cz/api/v2/tournament/${tournamentId}/standings`,
                `https://1.flashscore.ninja/api/v1/tournament/${tournamentId}/standings`
            ];

            for (const apiUrl of apiUrls) {
                try {
                    const apiResponse = await axios.get(apiUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'application/json',
                            'Referer': url
                        },
                        timeout: 10000
                    });

                    if (apiResponse.data) {
                        const standings = extractStandingsFromApi(apiResponse.data, dbTeams, liga);
                        if (standings.length > 0) {
                            return {
                                success: true,
                                standings,
                                count: standings.length
                            };
                        }
                    }
                } catch (apiErr) {
                    console.log(`⚠️ API request selhal: ${apiUrl} - ${apiErr.message}`);
                }
            }
        }

        // 3. Zkusíme extrakci z cjs.initialFeeds
        console.log('⚠️ API selhalo, zkouším initialFeeds extrakci');
        const standingsFromFeeds = extractStandingsFromInitialFeeds(html, dbTeams, liga);
        
        if (standingsFromFeeds.length > 0) {
            return {
                success: true,
                standings: standingsFromFeeds,
                count: standingsFromFeeds.length
            };
        }

        // 4. Fallback na HTML extrakci
        console.log('⚠️ initialFeeds selhalo, zkouším HTML extrakci');
        const standings = extractStandingsFromHtml(html, dbTeams, liga);
        
        if (standings.length > 0) {
            return {
                success: true,
                standings,
                count: standings.length
            };
        }

        // 5. Puppeteer fallback - načteme stránku a počkáme na vykreslení tabulky
        if (puppeteer) {
            console.log('⚠️ HTML extrakce selhala, zkouším Puppeteer');
            let browser;
            try {
                let executablePath;
                let args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
                
                const fs = require('fs');
                const possiblePaths = [
                    process.env.PUPPETEER_EXECUTABLE_PATH,
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    '/usr/bin/google-chrome-stable',
                    '/usr/bin/chromium-browser',
                    '/usr/bin/chromium',
                ];
                
                for (const path of possiblePaths) {
                    if (path) {
                        const exists = fs.existsSync(path);
                        if (exists) {
                            executablePath = path;
                            break;
                        }
                    }
                }
                
                if (!executablePath && chromium) {
                    executablePath = await chromium.executablePath();
                    args = chromium.args;
                }
                
                if (executablePath) {
                    browser = await puppeteer.launch({
                        headless: chromium ? chromium.headless : 'new',
                        executablePath,
                        args
                    });
                    const page = await browser.newPage();
                    await page.emulateTimezone('Europe/Prague');
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                    
                    // Počkáme na tabulku - déle
                    await page.waitForSelector('table, [class*="standings"], [class*="table"]', { timeout: 60000 }).catch(() => {});
                    
                    // Pokud je záložka standings, klikni na ni
                    try {
                        const standingsTab = await page.$('[class*="standings"], [data-tab="standings"], a[href*="standings"]');
                        if (standingsTab) {
                            await standingsTab.click();
                            await page.waitForTimeout(3000);
                        }
                    } catch (e) {
                        // Ignorujeme chybu
                    }
                    
                    const puppeteerHtml = await page.content();
                    
                    // Logování pro debug - co Puppeteer vidí v tabulce
                    const tableContent = await page.evaluate(() => {
                        const table = document.querySelector('table, [class*="standings"], [class*="table"]');
                        if (table) {
                            return table.innerHTML.substring(0, 2000);
                        }
                        return 'Žádná tabulka';
                    });
                    console.log('🔍 Puppeteer tabulka obsah (prvních 2000 znaků):', tableContent.substring(0, 500));
                    
                    const puppeteerStandings = extractStandingsFromHtml(puppeteerHtml, dbTeams, liga);
                    
                    if (puppeteerStandings.length > 0) {
                        return {
                            success: true,
                            standings: puppeteerStandings,
                            count: puppeteerStandings.length
                        };
                    }
                }
            } catch (puppeteerErr) {
                console.error(`❌ Puppeteer selhal: ${puppeteerErr.message}`);
            } finally {
                if (browser) await browser.close();
            }
        }

        return {
            success: false,
            error: 'Nepodařilo se extrahovat tabulku - Livesport používá dynamické načítání. Zkuste použít jinou stránku nebo zadejte hodnoty ručně.',
            standings: []
        };

    } catch (error) {
        console.error('❌ Chyba při stahování tabulky z Livesport:', error.message);
        return {
            success: false,
            error: error.message,
            standings: []
        };
    }
}

/**
 * Hlavní funkce pro stažení zápasů z Livesportu
 * @param {Object} options - Konfigurační objekt
 * @param {string} options.url - URL stránky se zápasy na Livesportu
 * @param {string} options.liga - Název ligy
 * @param {string} options.season - Sezóna (např. "25/26")
 * @param {string} options.dateFrom - Datum od (YYYY-MM-DD)
 * @param {string} options.dateTo - Datum do (YYYY-MM-DD)
 * @param {Array} options.dbTeams - Pole týmů z databáze
 * @returns {Promise<Object>} - Výsledek importu
 */
async function fetchMatchesFromLivesport(options) {
    let { url, liga, season, dateFrom, dateTo, dbTeams } = options;

    // Očištění URL od bílých znaků a nechtěně vložených cest k souborům z IDE
    if (url) {
        url = url.trim();
        if (url.includes('/C:') || url.includes('//C:')) {
            url = url.split(/\/+C:/i)[0];
            if (!url.endsWith('/')) url += '/';
        }
    }

    const notFoundTeams = new Set();
    const matches = [];
    let outOfRangeCount = 0;

    try {
        // 1. Získáme tournament ID
        const tournamentId = getLeagueId(liga, url);
        
        if (!tournamentId) {
            console.error(`❌ Nepodařilo se zjistit ID ligy pro: ${liga}`);
            return {
                success: false,
                error: `Nepodařilo se zjistit ID ligy pro: ${liga}. Zkontrolujte URL.`,
                matches: [],
                notFoundTeams: []
            };
        }

        // 2. Určíme sezónu z URL nebo použijeme poskytnutou
        const seasonToUse = getSeasonFromUrl(url) || season;

        // 3. Stažení stránky
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'cs,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 30000
        });
        
        const html = response.data;
        
        // Hledáme tournament ID v HTML - toto je skutečné Livesport ID
        // POUZE pokud nemáme ID z mapy lig (LEAGUE_ID_MAP)
        let realTournamentId = null;
        const isMappedId = Object.values(LEAGUE_ID_MAP).some(l => l.id === tournamentId);
        
        if (!isMappedId) {
            const tournamentMatch = html.match(/"tournamentId"\s*:\s*"([^"]+)"/) || 
                                   html.match(/"id"\s*:\s*"([A-Za-z0-9]{6,})"/);
            if (tournamentMatch) {
                realTournamentId = tournamentMatch[1];
            }
        } else {
            realTournamentId = tournamentId;
        }

        // 4. Extrakce dat
        let events = [];

        // Pokus 0: Extrakce z cjs.initialFeeds přímo v HTML (nejrychlejší, funguje na hostingu bez Chrome)
        try {
            events = extractEventsFromInitialFeeds(html);
            if (events.length > 0) {
                console.log(`✅ Úspěšně extrahováno ${events.length} zápasů přímo z initialFeeds v HTML`);
            }
        } catch (feedErr) {
            console.error('⚠️ Chyba při extrakci z initialFeeds:', feedErr.message);
        }

        // Pokus 1: Hledáme JSON v <script> tagu - rozšířené patterny (fallback)
        if (events.length === 0) {
            const scriptPatterns = [
                /window\.__INITIAL_STATE__\s*=\s*(\{.*?});/s,
                /window\.__DATA__\s*=\s*(\{.*?});/s,
                /var\s+initialData\s*=\s*(\[.*?]);/s,
                /window\.__APP__\s*=\s*(\{.*?});/s,
                /window\.__CONFIG__\s*=\s*(\{.*?});/s,
                /"fixtures":\s*(\[.*?]),?/s,
                /"events":\s*(\[.*?]),?/s,
                /"tournament":\s*(\{.*?}),?/s
            ];

            let scriptMatch = null;
            for (const pattern of scriptPatterns) {
                const match = html.match(pattern);
                if (match) {
                    scriptMatch = match;
                    break;
                }
            }

            if (scriptMatch) {
                try {
                    const jsonData = JSON.parse(scriptMatch[1]);
                    events = jsonData.events || jsonData.matches || jsonData.data?.events || [];
                } catch (e) {
                    console.error('❌ JSON parse selhal:', e.message);
                }
            }
        }

        // Pokus 2: Přímé volání API - použijeme reálné ID z HTML nebo kategorii
        const apiId = realTournamentId || tournamentId;
        if (events.length === 0 && apiId) {
            const seasonYear = seasonToUse ? `20${seasonToUse.split('/')[0]}-20${seasonToUse.split('/')[1]}` : '2025-2026';
            
            const apiUrls = [
                `https://www.livesport.cz/api/v1/tournament/${apiId}/fixtures`,
                `https://www.livesport.cz/api/v1/tournament/${apiId}/events`,
                `https://www.livesport.cz/api/v2/tournament/${apiId}/fixtures`,
                `https://www.livesport.cz/zapasy/${seasonYear}/${apiId}/`,
                `https://www.livesport.cz/zapasy/${seasonYear}/ms-${apiId}/`,
                `https://www.livesport.cz/zapasy/${seasonYear}/mistrovstvi-sveta-${apiId}/`,
            ];
            
            for (const apiUrl of apiUrls) {
                try {
                    const apiResponse = await axios.get(apiUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'application/json, text/html',
                            'X-Requested-With': 'XMLHttpRequest',
                            'Referer': url
                        },
                        timeout: 10000
                    });
                    
                    const contentType = apiResponse.headers['content-type'] || '';
                    
                    if (contentType.includes('json')) {
                        if (apiResponse.data && (apiResponse.data.fixtures || apiResponse.data.events || Array.isArray(apiResponse.data))) {
                            events = apiResponse.data.fixtures || apiResponse.data.events || apiResponse.data;
                            break;
                        }
                    } else {
                        const htmlApi = apiResponse.data;
                        const scriptMatch = htmlApi.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?});/s) ||
                                           htmlApi.match(/window\.__DATA__\s*=\s*(\{.*?});/s);
                        if (scriptMatch) {
                            const jsonData = JSON.parse(scriptMatch[1]);
                            events = jsonData.events || jsonData.matches || jsonData.data?.events || [];
                            if (events.length > 0) {
                                break;
                            }
                        }
                    }
                } catch (apiErr) {
                    // API request selhal - tiše pokračujeme
                }
            }
        }

        // Pokus 3: Scraping z HTML struktury jako fallback
        if (events.length === 0) {
            const cheerio = require('cheerio');
            const $ = cheerio.load(html);

            const matchSelectors = '.event__match, .match, [class*="event"]';
            $(matchSelectors).each((i, el) => {
                const $el = $(el);

                const homeTeam = $el.find('.event__homeParticipant [class*="name"]').first().text().trim() ||
                               $el.find('.wcl-participant').first().find('[class*="name"]').first().text().trim();
                const awayTeam = $el.find('.event__awayParticipant [class*="name"]').first().text().trim() ||
                               $el.find('.wcl-participant').last().find('[class*="name"]').first().text().trim();

                const timeText = $el.find('.event__time').first().text().trim();

                let dateText = $el.closest('[class*="round"]').find('[class*="date"]').first().text().trim() ||
                              $el.attr('data-date');

                if (timeText && timeText.includes('.')) {
                    const parts = timeText.split(' ');
                    if (parts.length >= 1) {
                        dateText = parts[0] + '.' + (seasonToUse ? seasonToUse.split('/')[0] : '2025');
                    }
                }

                if (homeTeam && awayTeam) {
                    events.push({
                        homeTeam,
                        awayTeam,
                        time: timeText,
                        date: dateText,
                        status: 'scheduled'
                    });
                }
            });

            if (events.length === 0) {
                const programSelectors = 'table tr, .program__row, [class*="program"]';
                $(programSelectors).each((i, el) => {
                    const $el = $(el);
                    const cells = $el.find('td, .team, [class*="team"], .participant');
                    if (cells.length >= 2) {
                        const homeTeam = $(cells[0]).text().trim();
                        const awayTeam = $(cells[1]).text().trim();
                        const timeText = $el.find('[class*="time"], .time, td:nth-child(3)').first().text().trim() ||
                                        $el.attr('data-time') || '17:00';
                        const dateText = $el.attr('data-date') ||
                                        $el.closest('[class*="date"], .date, [class*="round"]').find('[class*="date"], .date-header').first().text().trim();

                        if (homeTeam && awayTeam && homeTeam !== awayTeam) {
                            events.push({
                                homeTeam,
                                awayTeam,
                                time: timeText,
                                date: dateText,
                                status: 'scheduled'
                            });
                        }
                    }
                });
            }
        }

        // Pokus 4: Puppeteer pro dynamicky načítané stránky (pouze jako poslední záchrana)
        if (events.length === 0 && puppeteer) {
            let browser;
            try {
                let executablePath;
                let args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];
                
                const fs = require('fs');
                const possiblePaths = [
                    process.env.PUPPETEER_EXECUTABLE_PATH,
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    '/usr/bin/google-chrome-stable',
                    '/usr/bin/chromium-browser',
                    '/usr/bin/chromium',
                ];
                
                for (const path of possiblePaths) {
                    if (path) {
                        const exists = fs.existsSync(path);
                        if (exists) {
                            executablePath = path;
                            break;
                        }
                    }
                }
                
                if (!executablePath && chromium) {
                    executablePath = await chromium.executablePath();
                    args = chromium.args;
                }
                
                if (executablePath) {
                    browser = await puppeteer.launch({
                        headless: chromium ? chromium.headless : 'new',
                        executablePath,
                        args
                    });
                    const page = await browser.newPage();
                    await page.emulateTimezone('Europe/Prague');
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
                    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                    
                    await page.waitForFunction(() => {
                        return window.cjs && window.cjs.initialFeeds && window.cjs.initialFeeds['fixtures'];
                    }, { timeout: 30000 }).catch(() => {});
                    
                    events = await page.evaluate(() => {
                        const matches = [];
                        if (window.cjs && window.cjs.initialFeeds && window.cjs.initialFeeds['fixtures']) {
                            const feed = window.cjs.initialFeeds['fixtures'];
                            if (feed.data && typeof feed.data === 'string') {
                                const data = feed.data;
                                const matchBlocks = data.split('~AA÷');
                                
                                matchBlocks.forEach((block, index) => {
                                    if (!block || index === 0) return;
                                    const parts = block.split('¬');
                                    let homeTeam = '';
                                    let awayTeam = '';
                                    let timestamp = '';
                                    
                                    parts.forEach(part => {
                                        if (part.startsWith('CX÷')) {
                                            homeTeam = part.substring(3);
                                        } else if (part.startsWith('AD÷')) {
                                            timestamp = part.substring(3);
                                        } else if (part.startsWith('AF÷')) {
                                            awayTeam = part.substring(3);
                                        }
                                    });
                                    
                                    if (homeTeam && awayTeam && timestamp) {
                                        const date = new Date(parseInt(timestamp) * 1000);
                                        const dateStr = date.toISOString().split('T')[0];
                                        const timeStr = date.toTimeString().split(' ')[0].substring(0, 5);
                                        
                                        matches.push({
                                            homeTeam,
                                            awayTeam,
                                            time: timeStr,
                                            date: dateStr
                                        });
                                    }
                                });
                                
                                return matches;
                            }
                        }
                        
                        document.querySelectorAll('.event__match, [class*="event-row"], .match').forEach(el => {
                            const homeTeam = el.querySelector('[class*="home"] [class*="name"], .event__homeParticipant')?.textContent?.trim() ||
                                           el.querySelector('.participant:first-child [class*="name"]')?.textContent?.trim();
                            const awayTeam = el.querySelector('[class*="away"] [class*="name"], .event__awayParticipant')?.textContent?.trim() ||
                                           el.querySelector('.participant:last-child [class*="name"]')?.textContent?.trim();
                            const timeText = el.querySelector('[class*="time"], .event__time')?.textContent?.trim();

                            if (homeTeam && awayTeam && timeText) {
                                const parts = timeText.split(' ');
                                const datePart = parts[0] || '';
                                const timePart = parts[1] || timeText;
                                
                                matches.push({
                                    homeTeam, 
                                    awayTeam, 
                                    time: timePart,
                                    date: datePart
                                });
                            }
                        });
                        
                        return matches;
                    });
                }
            } catch (puppeteerErr) {
                console.error(`❌ Puppeteer selhal: ${puppeteerErr.message}`);
            } finally {
                if (browser) await browser.close();
            }
        }

        // 5. Zpracování zápasů
        let skippedTeams = 0;
        let skippedDate = 0;
        
        for (const event of events) {
            const homeTeamName = event.homeTeam?.name || event.homeTeam || event.team1;
            const awayTeamName = event.awayTeam?.name || event.awayTeam || event.team2;
            const timeStr = event.time || event.startTime || '17:00';
            const dateStr = event.date || event.startDate || event.formattedDate;

            if (!homeTeamName || !awayTeamName) continue;

            const homeTeamId = findTeamInDatabase(homeTeamName, dbTeams, liga);
            const awayTeamId = findTeamInDatabase(awayTeamName, dbTeams, liga);

            if (!homeTeamId) {
                notFoundTeams.add(`${homeTeamName}`);
                skippedTeams++;
            }
            if (!awayTeamId) {
                notFoundTeams.add(`${awayTeamName}`);
                skippedTeams++;
            }

            if (!homeTeamId || !awayTeamId) continue;

            const parsedDateTime = parseDateTime(dateStr, timeStr, seasonToUse);
            if (!parsedDateTime) {
                console.error(`❌ Nelze parsovat datum: ${dateStr} ${timeStr}`);
                skippedDate++;
                continue;
            }

            if (dateFrom && parsedDateTime.date < dateFrom) {
                outOfRangeCount++;
                continue;
            }
            if (dateTo && parsedDateTime.date > dateTo) {
                outOfRangeCount++;
                continue;
            }

            matches.push({
                homeTeamId,
                awayTeamId,
                homeTeamName,
                awayTeamName,
                datetime: parsedDateTime.datetime,
                date: parsedDateTime.date,
                time: parsedDateTime.time
            });
        }

        return {
            success: true,
            matches,
            notFoundTeams: Array.from(notFoundTeams),
            stats: {
                totalFound: events.length,
                parsed: matches.length,
                outOfRange: outOfRangeCount
            }
        };

    } catch (error) {
        console.error('❌ Chyba při stahování z Livesport:', error.message);
        return {
            success: false,
            error: error.message,
            matches: [],
            notFoundTeams: Array.from(notFoundTeams)
        };
    }
}

module.exports = {
    fetchMatchesFromLivesport,
    fetchStandingsFromLivesport,
    LEAGUE_ID_MAP
};
