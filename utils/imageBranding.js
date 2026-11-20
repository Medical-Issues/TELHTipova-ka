/**
 * Společný vizuální styl všech generovaných obrázků (exportér i notifikace).
 *
 * Každý generátor si řeší jen svůj obsah (zápas, tabulka, pavouk…), ale
 * pozadí, karty, hlavička, loga týmů, tabulkové řádky a vodoznak jdou odsud,
 * aby všechny obrázky vypadaly jako jedna sada.
 */
const path = require('path');
const { loadImage } = require('canvas');

const FONT_FAMILY = 'Arial, sans-serif';

const THEME = {
    bgColor: '#1a1a1a',
    bgBottom: '#080a0d',
    accentColor: '#ff4500',
    awayColor: '#0064ff',
    textColor: '#ffffff',
    watermarkColor: '#888888',
    muted: '#94a3b8',
    soft: '#cbd5e1',
    faint: '#64748b',
    card: 'rgba(255, 255, 255, 0.04)',
    cardStrong: 'rgba(14, 20, 30, 0.88)',
    frame: 'rgba(10, 16, 24, 0.55)',
    tableHeader: 'rgba(255, 255, 255, 0.08)',
    rowEven: 'rgba(255, 255, 255, 0.035)',
    rowOdd: 'rgba(255, 255, 255, 0.012)',
    divider: 'rgba(255, 255, 255, 0.07)',
    gold: '#ffd700',
    silver: '#c3ccd8',
    bronze: '#cd8c60',
    cyan: '#00d4ff',
    danger: '#ff4444',
    success: '#64ff64',
    radius: 18
};

/** Sloučí nastavení brandingu s výchozím motivem. */
function resolveTheme(settings = {}) {
    return {
        ...THEME,
        bgColor: settings.bgColor || THEME.bgColor,
        accentColor: settings.accentColor || THEME.accentColor,
        textColor: settings.textColor || THEME.textColor,
        watermarkColor: settings.watermarkColor || THEME.watermarkColor
    };
}

/** Barva s průhledností; funguje pro #rgb, #rrggbb i #rrggbbaa. */
function withAlpha(color, alpha) {
    if (typeof color !== 'string' || !color.startsWith('#')) return color;
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return color;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function font(size, weight = 'bold') {
    return `${weight} ${Math.round(size)}px ${FONT_FAMILY}`;
}

function resetShadow(ctx) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
}

/**
 * Nastaví font a vrátí text, který se vejde do maxWidth: nejdřív zmenšuje
 * písmo až na minSize, potom text zkrátí výpustkou.
 */
function fitText(ctx, text, maxWidth, size, minSize = size, weight = 'bold') {
    const value = String(text ?? '');
    let current = size;
    ctx.font = font(current, weight);
    while (current > minSize && ctx.measureText(value).width > maxWidth) {
        current -= 1;
        ctx.font = font(current, weight);
    }
    if (ctx.measureText(value).width <= maxWidth) return value;
    let cut = value;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
    return `${cut.trimEnd()}…`;
}

function drawText(ctx, text, x, y, { size = 14, weight = 'bold', color = THEME.textColor, align = 'left', baseline = 'middle', maxWidth = null, minSize = null } = {}) {
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillStyle = color;
    const value = maxWidth ? fitText(ctx, text, maxWidth, size, minSize ?? size, weight) : String(text ?? '');
    if (!maxWidth) ctx.font = font(size, weight);
    ctx.fillText(value, x, y);
    return value;
}

/** Pozadí: barevný přechod, volitelný vlastní obrázek a jemná záře akcentu. */
async function drawBrandedBackground(ctx, width, height, settings = {}) {
    const theme = resolveTheme(settings);
    resetShadow(ctx);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, theme.bgColor);
    gradient.addColorStop(1, theme.bgBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    if (settings.bgImage && typeof settings.bgImage === 'string' && settings.bgImage.startsWith('data:image/')) {
        try {
            const imageData = settings.bgImage.split(',')[1];
            if (!imageData) return;
            const image = await loadImage(Buffer.from(imageData, 'base64'));
            const scale = Math.max(width / image.width, height / image.height);
            const imageWidth = image.width * scale;
            const imageHeight = image.height * scale;
            ctx.drawImage(image, (width - imageWidth) / 2, (height - imageHeight) / 2, imageWidth, imageHeight);
            ctx.fillStyle = 'rgba(4, 7, 12, 0.52)';
            ctx.fillRect(0, 0, width, height);
        } catch (error) {
            console.error('[imageBranding] Vlastní pozadí se nepodařilo načíst:', error);
        }
    }

    // Jemná záře akcentu v horní části – podpis celé sady obrázků.
    const glow = ctx.createRadialGradient(width / 2, -height * 0.15, 0, width / 2, -height * 0.15, Math.max(width, height) * 0.75);
    glow.addColorStop(0, withAlpha(theme.accentColor, 0.16));
    glow.addColorStop(1, withAlpha(theme.accentColor, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    // Akcentová linka na horním okraji.
    const line = ctx.createLinearGradient(0, 0, width, 0);
    line.addColorStop(0, withAlpha(theme.accentColor, 0));
    line.addColorStop(0.5, withAlpha(theme.accentColor, 0.9));
    line.addColorStop(1, withAlpha(theme.accentColor, 0));
    ctx.fillStyle = line;
    ctx.fillRect(0, 0, width, 3);
}

/** Barevná záře za týmem (versus, výsledky, přestupy, vítěz). */
function drawGlow(ctx, cx, cy, radius, color, alpha = 0.16) {
    const glow = ctx.createRadialGradient(cx, cy, radius * 0.05, cx, cy, radius);
    glow.addColorStop(0, withAlpha(color, alpha));
    glow.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
}

/** Karta: poloprůhledný panel se zaoblením a volitelným barevným proužkem. */
function drawCard(ctx, x, y, w, h, { color = null, fill = THEME.card, radius = THEME.radius, stripe = 'top', border = null } = {}) {
    resetShadow(ctx);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.fill();
    if (border) {
        ctx.strokeStyle = border;
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
    if (color && stripe === 'top') {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x + 22, y, w - 44, 3, 2);
        ctx.fill();
    } else if (color && stripe === 'left') {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y + 10, 3, h - 20, 2);
        ctx.fill();
    }
}

/** Rám pro „dokumentové“ obrázky (tabulka, statistiky, pavouk). */
function drawFrame(ctx, width, height, theme, inset = 18) {
    drawCard(ctx, inset, inset, width - inset * 2, height - inset * 2, {
        fill: theme.frame,
        radius: 22,
        stripe: null,
        border: withAlpha(theme.accentColor, 0.22)
    });
}

/**
 * Hlavička: malý štítek (kicker) nad hlavním nadpisem.
 * align 'left' = s akcentovým proužkem vlevo (tabulky), 'center' = na střed (karty).
 * Vrací spodní hranu hlavičky.
 */
function drawHeader(ctx, theme, { x, y, title, kicker = null, align = 'left', maxWidth = 600, titleSize = 28, meta = null, metaX = null }) {
    resetShadow(ctx);
    const hasTitle = title !== null && title !== undefined && title !== '';
    if (align === 'left') {
        const barHeight = hasTitle && kicker ? titleSize + 22 : titleSize + 6;
        ctx.fillStyle = theme.accentColor;
        ctx.beginPath();
        ctx.roundRect(x, y, 5, barHeight, 2);
        ctx.fill();
        let textY = y;
        if (kicker) {
            drawText(ctx, kicker.toLocaleUpperCase('cs-CZ'), x + 18, textY + 7, { size: 11, color: theme.accentColor, maxWidth });
            textY += 18;
        }
        if (hasTitle) {
            drawText(ctx, title, x + 18, textY + titleSize / 2 + 3, { size: titleSize, color: theme.textColor, maxWidth, minSize: Math.max(16, titleSize - 10) });
        }
        if (meta && metaX) {
            drawText(ctx, meta, metaX, y + barHeight / 2, { size: 13, weight: 'normal', color: theme.muted, align: 'right' });
        }
        return y + barHeight;
    }

    let textY = y;
    if (kicker) {
        const label = drawText(ctx, kicker.toLocaleUpperCase('cs-CZ'), x, textY, { size: 13, color: theme.textColor, align: 'center', maxWidth });
        const labelWidth = ctx.measureText(label).width;
        ctx.fillStyle = theme.accentColor;
        ctx.beginPath();
        ctx.roundRect(x - 14, textY + 13, 28, 3, 2);
        ctx.fill();
        // Malé tečky po stranách štítku.
        ctx.beginPath();
        ctx.arc(x - labelWidth / 2 - 14, textY, 3, 0, Math.PI * 2);
        ctx.arc(x + labelWidth / 2 + 14, textY, 3, 0, Math.PI * 2);
        ctx.fill();
        textY += 34;
    }
    if (hasTitle) {
        drawText(ctx, title, x, textY, { size: titleSize, color: theme.textColor, align: 'center', maxWidth, minSize: Math.max(16, titleSize - 10) });
        textY += titleSize;
    }
    return textY;
}

async function loadImageSource(source) {
    if (!source) return null;
    try {
        if (typeof source === 'string' && source.startsWith('data:image/')) {
            const data = source.split(',')[1];
            return data ? await loadImage(Buffer.from(data, 'base64')) : null;
        }
        return await loadImage(source);
    } catch (error) {
        console.error('[imageBranding] Obrázek se nepodařilo načíst:', error.message || error);
        return null;
    }
}

function teamInitials(name) {
    return String(name || '?')
        .split(/\s+/)
        .filter(Boolean)
        .map(word => word[0])
        .join('')
        .slice(0, 3)
        .toUpperCase() || '?';
}

/**
 * Logo týmu vycentrované do čtverce size×size se středem (cx, cy).
 * Pořadí: vlastní logo (base64) → logo z data/images → iniciály v kruhu.
 */
async function drawTeamLogo(ctx, team, cx, cy, size, { color = THEME.accentColor, textColor = THEME.textColor, customLogo = null, glow = false } = {}) {
    let logo = await loadImageSource(customLogo);
    if (!logo && team?.logo && !team?.isCustom) {
        logo = await loadImageSource(path.join(process.cwd(), 'data/images', team.logo));
    }

    if (logo) {
        const scale = Math.min(size / logo.width, size / logo.height);
        const w = logo.width * scale;
        const h = logo.height * scale;
        ctx.save();
        ctx.shadowColor = glow ? withAlpha(color, 0.55) : 'rgba(0, 0, 0, 0.55)';
        ctx.shadowBlur = glow ? 28 : 18;
        ctx.shadowOffsetY = glow ? 6 : 8;
        ctx.drawImage(logo, cx - w / 2, cy - h / 2, w, h);
        ctx.restore();
        return;
    }

    const radius = size * 0.4;
    resetShadow(ctx);
    ctx.fillStyle = withAlpha(color, 0.16);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = withAlpha(color, 0.6);
    ctx.lineWidth = 2;
    ctx.stroke();
    drawText(ctx, teamInitials(team?.name), cx, cy, { size: radius * 0.62, color: textColor, align: 'center' });
}

/** Kulatý odznak uprostřed (VS, šipka přestupu). */
function drawBadge(ctx, cx, cy, radius, theme, label = 'VS') {
    resetShadow(ctx);
    ctx.fillStyle = 'rgba(10, 12, 18, 0.92)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = withAlpha(theme.accentColor, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (label === '→') {
        const len = radius * 0.9;
        ctx.strokeStyle = theme.textColor;
        ctx.fillStyle = theme.textColor;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - len / 2, cy);
        ctx.lineTo(cx + len / 2 - 8, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + len / 2 + 2, cy);
        ctx.lineTo(cx + len / 2 - 12, cy - 10);
        ctx.lineTo(cx + len / 2 - 12, cy + 10);
        ctx.closePath();
        ctx.fill();
        ctx.lineCap = 'butt';
        return;
    }
    drawText(ctx, label, cx, cy + 1, { size: radius * 0.56, color: theme.textColor, align: 'center' });
}

/** Malý pohár kreslený cestou (emoji se v canvasu nevykreslí spolehlivě). */
function drawTrophy(ctx, cx, cy, color, innerColor = '#ffffff') {
    resetShadow(ctx);

    // Miska poháru
    ctx.beginPath();
    ctx.moveTo(cx - 11, cy - 10);
    ctx.lineTo(cx + 11, cy - 10);
    ctx.quadraticCurveTo(cx + 9, cy + 7, cx, cy + 10);
    ctx.quadraticCurveTo(cx - 9, cy + 7, cx - 11, cy - 10);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Levé a pravé ouško
    ctx.beginPath();
    ctx.arc(cx - 12, cy - 4, 5, Math.PI * 0.5, Math.PI * 1.5);
    ctx.arc(cx + 12, cy - 4, 5, Math.PI * 1.5, Math.PI * 0.5);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Lesklý střed
    ctx.fillStyle = innerColor;
    ctx.beginPath();
    ctx.moveTo(cx - 3, cy - 7);
    ctx.lineTo(cx + 1, cy - 7);
    ctx.lineTo(cx - 1, cy + 5);
    ctx.lineTo(cx - 4, cy + 5);
    ctx.closePath();
    ctx.fill();

    // Stopka a podstava
    ctx.fillStyle = color;
    ctx.fillRect(cx - 3, cy + 8, 6, 7);
    ctx.beginPath();
    ctx.roundRect(cx - 9, cy + 14, 18, 4, 2);
    ctx.fillStyle = innerColor;
    ctx.fill();
}

/** Hlavičkový řádek tabulky. */
function drawTableHeaderRow(ctx, x, y, w, h, theme) {
    resetShadow(ctx);
    ctx.fillStyle = theme.tableHeader;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 9);
    ctx.fill();
}

/** Datový řádek tabulky se střídavým podbarvením a oddělovačem. */
function drawTableRow(ctx, x, y, w, h, index, theme, tint = null) {
    ctx.fillStyle = index % 2 === 0 ? theme.rowEven : theme.rowOdd;
    ctx.fillRect(x, y, w, h);
    if (tint) {
        ctx.fillStyle = tint;
        ctx.fillRect(x, y, w, h);
    }
    ctx.fillStyle = theme.divider;
    ctx.fillRect(x, y + h - 1, w, 1);
}

/**
 * Jednotný vodoznak: logo vpravo dole, text (pokud je) vlevo dole.
 * Volá se jako poslední krok každého generátoru.
 */
async function drawWatermark(ctx, width, height, settings = {}) {
    const theme = resolveTheme(settings);
    const padding = 14;
    resetShadow(ctx);

    let logo = await loadImageSource(settings.watermarkLogo && settings.watermarkLogo.startsWith('data:image/') ? settings.watermarkLogo : null);
    if (!logo) logo = await loadImageSource(path.join(process.cwd(), 'public/images/logo.png'));
    if (logo) {
        const size = 36;
        const scale = Math.min(size / logo.width, size / logo.height);
        const w = logo.width * scale;
        const h = logo.height * scale;
        ctx.globalAlpha = 0.9;
        ctx.drawImage(logo, width - w - padding, height - h - padding, w, h);
        ctx.globalAlpha = 1;
    }

    if (settings.watermarkText) {
        ctx.globalAlpha = 0.8;
        drawText(ctx, settings.watermarkText, padding + 4, height - padding - 2, {
            size: 12,
            weight: 'bold',
            color: theme.watermarkColor,
            baseline: 'bottom',
            maxWidth: width / 2
        });
        ctx.globalAlpha = 1;
    }
}

/**
 * Společné rozvržení „tým proti týmu“: versus pro export i notifikace
 * a výsledkový obrázek. Mění se jen střed (VS / skóre) a spodní pruh.
 *
 * opts.center: { type: 'vs' } | { type: 'score', scoreHome, scoreAway, label, note }
 * opts.series: [{ scoreHome, scoreAway, ot }] – políčka jednotlivých zápasů série
 * opts.bottomLines: [{ text, color }] – textové řádky pod kartami
 */
async function drawMatchupLayout(ctx, width, height, homeTeam, awayTeam, theme, opts = {}) {
    const { center = { type: 'vs' }, kicker = null, series = null, seriesLabel = null, bottomLines = [], customHomeLogo = null, customAwayLogo = null, highlight = null } = opts;
    const homeColor = theme.accentColor;
    const awayColor = theme.awayColor;
    const isScore = center.type === 'score';

    const margin = Math.round(width * 0.045);
    const cardW = Math.round(width * (isScore ? 0.3 : 0.355));
    const top = kicker ? 72 : 52;
    const footerReserve = 50;
    const hasSeries = Array.isArray(series) && series.length > 0;
    const bottomHeight = hasSeries ? 92 : bottomLines.length ? bottomLines.length * 26 + 18 : 0;
    const cardH = height - top - footerReserve - bottomHeight;
    const homeCx = margin + cardW / 2;
    const awayCx = width - margin - cardW / 2;
    const midY = top + cardH / 2;

    drawGlow(ctx, homeCx, midY, cardW * 1.2, homeColor, 0.18);
    drawGlow(ctx, awayCx, midY, cardW * 1.2, awayColor, 0.18);

    if (kicker) drawHeader(ctx, theme, { x: width / 2, y: 32, kicker, align: 'center', maxWidth: width * 0.6 });

    const drawSide = async (team, cx, color, customLogo, isWinner) => {
        drawCard(ctx, cx - cardW / 2, top, cardW, cardH, {
            color,
            border: isWinner ? withAlpha(color, 0.65) : null
        });
        const nameBlock = team?.liga ? 62 : 44;
        const logoSize = Math.min(cardW - 90, cardH - nameBlock - 52);
        const logoCy = top + 26 + logoSize / 2 + Math.max(0, (cardH - nameBlock - 52 - logoSize) / 2);
        await drawTeamLogo(ctx, team, cx, logoCy, logoSize, { color, textColor: theme.textColor, customLogo });
        const nameY = top + cardH - nameBlock + 12;
        drawText(ctx, team?.name || '???', cx, nameY, { size: Math.min(25, cardW / 11), minSize: 14, color: theme.textColor, align: 'center', maxWidth: cardW - 36 });
        if (team?.liga) {
            drawText(ctx, team.liga.toLocaleUpperCase('cs-CZ'), cx, nameY + 28, { size: 12, color, align: 'center', maxWidth: cardW - 36 });
        }
    };

    await drawSide(homeTeam, homeCx, homeColor, customHomeLogo, highlight === 'home');
    await drawSide(awayTeam, awayCx, awayColor, customAwayLogo, highlight === 'away');

    if (isScore) {
        const gap = awayCx - cardW / 2 - (homeCx + cardW / 2);
        const panelW = Math.min(gap - 32, 260);
        const panelH = center.note ? 150 : 132;
        const px = width / 2 - panelW / 2;
        const py = midY - panelH / 2;
        drawCard(ctx, px, py, panelW, panelH, { fill: theme.cardStrong, color: theme.accentColor, border: withAlpha(theme.accentColor, 0.35) });
        drawText(ctx, (center.label || 'SKÓRE').toLocaleUpperCase('cs-CZ'), width / 2, py + 26, { size: 11, color: theme.muted, align: 'center', maxWidth: panelW - 20 });
        drawText(ctx, `${center.scoreHome}:${center.scoreAway}`, width / 2, py + 78, { size: 64, minSize: 36, color: theme.textColor, align: 'center', maxWidth: panelW - 24 });
        if (center.note) {
            drawText(ctx, center.note, width / 2, py + panelH - 22, {
                size: 11,
                minSize: 9,
                weight: 'bold',
                color: theme.accentColor,
                align: 'center',
                maxWidth: panelW - 16
            });
        }
    } else {
        drawBadge(ctx, width / 2, midY, 39, theme, 'VS');
    }

    let y = top + cardH + 22;
    if (hasSeries) {
        drawText(ctx, (seriesLabel || 'VÝSLEDKY ZÁPASŮ SÉRIE').toLocaleUpperCase('cs-CZ'), width / 2, y + 2, { size: 12, color: theme.muted, align: 'center', maxWidth: width * 0.6 });
        const boxW = 52;
        const boxH = 32;
        const boxGap = 10;
        const count = series.length;
        const totalW = count * boxW + (count - 1) * boxGap;
        const startX = width / 2 - totalW / 2;
        series.forEach((match, idx) => {
            const bx = startX + idx * (boxW + boxGap);
            const winnerColor = Number(match.scoreHome) > Number(match.scoreAway) ? homeColor : awayColor;
            drawCard(ctx, bx, y + 20, boxW, boxH, { fill: withAlpha(winnerColor, 0.18), radius: 8, stripe: null, border: withAlpha(winnerColor, 0.8) });
            const label = `${match.scoreHome}:${match.scoreAway}${match.ot ? 'p' : ''}`;
            drawText(ctx, label, bx + boxW / 2, y + 20 + boxH / 2 + 1, { size: 15, color: theme.textColor, align: 'center', maxWidth: boxW - 6, minSize: 11 });
        });
        y += 66;
    }
    bottomLines.forEach(line => {
        drawText(ctx, line.text, width / 2, y, { size: line.size || 16, color: line.color || theme.textColor, align: 'center', maxWidth: width * 0.8 });
        y += 26;
    });
}

/**
 * Společné rozvržení vítěze (export i notifikace o konci ligy).
 */
async function drawWinnerLayout(ctx, width, height, team, theme, { title = 'VÍTĚZ', showTrophy = true, accentColor = null } = {}) {
    const color = accentColor || theme.accentColor;
    const cardW = Math.min(420, width * 0.52);
    const cardX = width / 2 - cardW / 2;
    const cardY = 26;
    const cardH = height - cardY - 40;

    drawGlow(ctx, width / 2, height / 2, width * 0.42, color, 0.22);
    drawCard(ctx, cardX, cardY, cardW, cardH, { fill: 'rgba(10, 16, 24, 0.68)', color, border: withAlpha(color, 0.4) });

    const titleY = cardY + 34;
    const label = drawText(ctx, title.toLocaleUpperCase('cs-CZ'), width / 2, titleY, { size: 22, minSize: 14, color: theme.textColor, align: 'center', maxWidth: cardW - 80 });
    if (showTrophy) {
        const labelW = ctx.measureText(label).width;
        drawTrophy(ctx, width / 2 - labelW / 2 - 28, titleY - 2, color, theme.textColor);
        drawTrophy(ctx, width / 2 + labelW / 2 + 28, titleY - 2, color, theme.textColor);
    }

    const nameY = cardY + cardH - 34;
    const logoTop = titleY + 26;
    const logoSize = Math.min(cardW - 120, nameY - 30 - logoTop);
    await drawTeamLogo(ctx, team, width / 2, logoTop + logoSize / 2, logoSize, { color, textColor: theme.textColor, glow: true });

    drawText(ctx, (team?.name || '???').toLocaleUpperCase('cs-CZ'), width / 2, nameY, { size: 34, minSize: 18, color: theme.textColor, align: 'center', maxWidth: cardW - 40 });
}

module.exports = {
    THEME,
    FONT_FAMILY,
    resolveTheme,
    withAlpha,
    font,
    fitText,
    drawText,
    resetShadow,
    drawBrandedBackground,
    drawGlow,
    drawCard,
    drawFrame,
    drawHeader,
    loadImageSource,
    teamInitials,
    drawTeamLogo,
    drawBadge,
    drawTrophy,
    drawTableHeaderRow,
    drawTableRow,
    drawWatermark,
    drawMatchupLayout,
    drawWinnerLayout
};
