/**
 * Livesport.cz API Service
 * Stahuje data o zápasech z livesport.cz API
 */
const axios = require('axios');

// Livesport API endpointy
const LIVESPORT_BASE_URL = 'https://www.livesport.cz';

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

    // Formát 1: Standardní livesport s ID v URL
    // /zapasy/2025-2026/telh-UCEL8Q9b/
    const standardMatch = url.match(/[-/]([A-Za-z0-9]{6,10})[/?#]?$/);
    if (standardMatch) {
        return standardMatch[1];
    }

    // Formát 2: Kategorie URL bez ID (např. /hokej/svet/mistrovstvi-sveta/zapasy/)
    // Extrahujeme název soutěže z cesty
    const categoryMatch = url.match(/\/hokej\/[^/]+\/([^/]+)(?:\/zapasy|\/program)?/);
    if (categoryMatch) {
        // Vrátíme název kategorie jako identifikátor
        return categoryMatch[1];
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
 */
function normalizeTeamName(name) {
    if (!name) return '';
    return name
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/^HC\s+/i, '')
        .replace(/^Rytíři\s+/i, '')
        .replace(/^Bílí\s+Tygři\s+/i, '')
        .replace(/^Oceláři\s+/i, '')
        .replace(/^Piráti\s+/i, '')
        .replace(/^Dynamo\s+/i, '')
        .replace(/^Mountfield\s+/i, '')
        .replace(/^Energie\s+/i, '')
        .replace(/^Verva\s+/i, '')
        .replace(/^Kometa\s+/i, '')
        .replace(/^Vítkovice\s+/i, '')
        .replace(/^Zlín\s+/i, '')
        .replace(/^Olomouc\s+/i, '')
        .replace(/^Mladá\s+Boleslav\s+/i, '')
        .replace(/^Liberec\s+/i, '')
        .replace(/^Sparta\s+/i, '')
        .replace(/^Plzeň\s+/i, '')
        .replace(/^Pardubice\s+/i, '')
        .replace(/^Třinec\s+/i, '')
        .replace(/^Litvínov\s+/i, '')
        .replace(/^Kladno\s+/i, '')
        .replace(/^K.\s+/i, 'Karlovy ')
        .replace(/^Č.\s+/i, 'České ')
        .replace(/\s+B$/, '')
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

    // 2. Partial match - jeden obsahuje druhý
    found = leagueTeams.find(t => {
        const dbNorm = normalizeTeamName(t.name);
        return dbNorm.includes(normalizedName) || normalizedName.includes(dbNorm);
    });

    if (found) return Number(found.id);

    // 3. Shoda na prvních 5 znacích (pro případy jako "Mountfield HK" vs "Mountfield")
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
    const { url, liga, season, dateFrom, dateTo, dbTeams } = options;

    const notFoundTeams = new Set();
    const matches = [];
    let outOfRangeCount = 0;

    try {
        // 1. Získáme tournament ID
        const tournamentId = getLeagueId(liga, url);
        if (!tournamentId) {
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
        console.log(`📥 Stahuji data z: ${url}`);

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
        console.log(`📄 Staženo ${html.length} znaků HTML`);
        console.log(`🔍 Prvních 500 znaků: ${html.substring(0, 500)}`);

        // 4. Extrakce dat - Livesport embeduje data v JSON ve skriptech nebo v atributech
        // Hledáme "initialData" nebo podobné struktury
        let events = [];

        // Pokus 1: Hledáme JSON v <script> tagu - rozšířené patterny
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
                console.log(`✅ Pattern match: ${pattern.toString().substring(0, 50)}...`);
                break;
            }
        }

        console.log(`🔎 Script match nalezen: ${scriptMatch ? 'ANO' : 'NE'}`);

        if (scriptMatch) {
            try {
                const jsonData = JSON.parse(scriptMatch[1]);
                console.log(`📊 JSON klíče: ${Object.keys(jsonData).join(', ')}`);
                // Livesport má různé struktury podle verze
                events = jsonData.events || jsonData.matches || jsonData.data?.events || [];
                console.log(`✅ JSON parse: nalezeno ${events.length} events`);
            } catch (e) {
                console.log('Nepodařilo se parsovat JSON z script tagu:', e.message);
            }
        }

        // Pokus 2: Přímé volání API endpointu pro zápasy
        if (events.length === 0 && tournamentId) {
            try {
                // Vytvoříme URL pro API - pro /program/ stránky použijeme tournament ID z URL
                const apiUrl = `https://www.livesport.cz/api/v1/tournament/${tournamentId}/fixtures`;
                console.log(`🌐 Zkouším API: ${apiUrl}`);

                const apiResponse = await axios.get(apiUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'Referer': url
                    },
                    timeout: 15000
                });

                console.log(`📡 API response keys: ${Object.keys(apiResponse.data || {}).join(', ')}`);

                if (apiResponse.data) {
                    // Různé struktury odpovědi
                    if (apiResponse.data.fixtures) {
                        events = apiResponse.data.fixtures;
                    } else if (apiResponse.data.events) {
                        events = apiResponse.data.events;
                    } else if (Array.isArray(apiResponse.data)) {
                        events = apiResponse.data;
                    }
                    console.log(`✅ API: nalezeno ${events.length} zápasů`);
                }
            } catch (apiErr) {
                console.log(`❌ API selhalo: ${apiErr.message}`);
            }
        }

        // Pokus 3: Hledáme data v atributech HTML (novější verze Livesportu)
        if (events.length === 0) {
            // Hledáme API endpoint ve skriptech
            const apiMatch = html.match(/\/api\/v\d+\/[^"']*?tournament\/[A-Za-z0-9]+[^"']*/);
            if (apiMatch) {
                const apiUrl = `${LIVESPORT_BASE_URL}${apiMatch[0]}`;
                try {
                    const apiResponse = await axios.get(apiUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest'
                        },
                        timeout: 15000
                    });

                    if (apiResponse.data && apiResponse.data.events) {
                        events = apiResponse.data.events;
                    }
                } catch (apiErr) {
                    console.log('API fetch selhal:', apiErr.message);
                }
            }
        }

        // Pokus 3: Scraping z HTML struktury jako fallback
        if (events.length === 0) {
            const cheerio = require('cheerio');
            const $ = cheerio.load(html);

            console.log(`🔍 Po Pokusu 1 a 2: ${events.length} events`);

            // Selektory pro stránku "Zápasy"
            const matchSelectors = '.event__match, .match, [class*="event"]';
            const matchElements = $(matchSelectors);
            console.log(`🎯 Nalezeno ${matchElements.length} elementů se selektorem "${matchSelectors}"`);
            
            // Debug: ukážeme HTML prvních 3 elementů
            matchElements.each((i, el) => {
                if (i < 3) {
                    const $el = $(el);
                    console.log(`\n--- Element ${i} ---`);
                    console.log(`Tag: ${el.tagName}`);
                    console.log(`Class: ${$el.attr('class')}`);
                    console.log(`Text: ${$el.text().substring(0, 100)}`);
                }
            });
            
            $('.event__match, .match, [class*="event"]').each((i, el) => {
                const $el = $(el);

                // Extrakce týmů - podle skutečné struktury z screenshotu
                const homeTeam = $el.find('.event__participant--home').first().text().trim() ||
                               $el.find('[class*="participant"]').first().text().trim();
                const awayTeam = $el.find('.event__participant--away').first().text().trim() ||
                               $el.find('[class*="participant"]').last().text().trim();

                // Extrakce času - např. "16.05. 12:20"
                const timeText = $el.find('.event__time').first().text().trim();

                // Extrakce data - z času nebo z atributu
                let dateText = $el.closest('[class*="round"]').find('[class*="date"]').first().text().trim() ||
                              $el.attr('data-date');

                // Pokud máme čas ve formátu "16.05. 12:20", extrahujeme datum
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

            // Selektory pro stránku "Program" (tabulkový formát)
            if (events.length === 0) {
                const programSelectors = 'table tr, .program__row, [class*="program"]';
                const programElements = $(programSelectors);
                console.log(`📋 Nalezeno ${programElements.length} elementů pro "Program"`);

                programElements.each((i, el) => {
                    if (i > 5) return false; // Debug: ukážeme jen prvních 6
                    const $el = $(el);

                    // Hledáme buňky s týmy
                    const cells = $el.find('td, .team, [class*="team"], .participant');
                    if (cells.length >= 2) {
                        const homeTeam = $(cells[0]).text().trim();
                        const awayTeam = $(cells[1]).text().trim();

                        // Čas může být v další buňce nebo atributu
                        const timeText = $el.find('[class*="time"], .time, td:nth-child(3)').first().text().trim() ||
                                        $el.attr('data-time') || '17:00';

                        // Datum z atributu nebo nadpisu sekce
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
                            console.log(`✅ Zápas nalezen: ${homeTeam} vs ${awayTeam}`);
                        }
                    }
                });
                console.log(`📋 Program scraper: nalezeno ${events.length} zápasů`);
            }
        }

        console.log(`✅ Nalezeno ${events.length} zápasů v datech`);

        // 5. Zpracování zápasů
        for (const event of events) {
            // Různé struktury dat podle zdroje
            const homeTeamName = event.homeTeam?.name || event.homeTeam || event.team1;
            const awayTeamName = event.awayTeam?.name || event.awayTeam || event.team2;
            const timeStr = event.time || event.startTime || '17:00';
            const dateStr = event.date || event.startDate || event.formattedDate;

            if (!homeTeamName || !awayTeamName) continue;

            // Najdeme ID týmů
            const homeTeamId = findTeamInDatabase(homeTeamName, dbTeams, liga);
            const awayTeamId = findTeamInDatabase(awayTeamName, dbTeams, liga);

            if (!homeTeamId) {
                notFoundTeams.add(`${homeTeamName}`);
            }
            if (!awayTeamId) {
                notFoundTeams.add(`${awayTeamName}`);
            }

            if (!homeTeamId || !awayTeamId) continue;

            // Parsování data a času
            const parsedDateTime = parseDateTime(dateStr, timeStr, seasonToUse);
            if (!parsedDateTime) continue;

            // Kontrola rozsahu dat
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
        console.error('❌ Chyba při stahování z Livesport:', error);
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
    LEAGUE_ID_MAP
};
