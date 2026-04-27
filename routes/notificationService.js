const webpush = require('web-push');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage } = require('canvas');
const { Users, Matches, Teams } = require('../utils/mongoDataAccess');
require('dotenv').config();

// --- NASTAVENÍ KLÍČŮ ---
const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (!publicVapidKey || !privateVapidKey) {
    console.error("CHYBA: VAPID klíče nejsou nastaveny v souboru .env!");
}

const vapidSubject = process.env.SERVER_ORIGIN || 'mailto:veselsky.honza@gmail.com';
webpush.setVapidDetails(
    vapidSubject,
    publicVapidKey,
    privateVapidKey
);

// --- POMOCNÉ FUNKCE PRO ČTENÍ DAT ---
const getUsers = async () => {
    try { return await Users.findAll(); }
    catch (e) { return []; }
};
const getMatches = async () => {
    try { return await Matches.findAll(); }
    catch (e) { return []; }
};
const getTeams = async () => {
    try { return await Teams.findAll(); }
    catch (e) { return []; }
};

// --- FUNKCE PRO ZPRACOVÁNÍ CUSTOM OBRÁZKŮ PRO NOTIFIKACE ---
// Custom obrázky (uploady/galerie) mohou mít jakýkoliv poměr stran
// Tato funkce přidá padding aby měly 2:1 poměr pro lepší zobrazení v notifikacích
async function processCustomImageForNotification(imageUrl) {
    try {
        // Získat cestu k souboru z URL
        const urlPath = imageUrl.replace('/logoteamu/', 'data/images/').replace('/images/notifications/', 'public/images/notifications/');
        const fullPath = path.join(process.cwd(), urlPath);
        
        // Kontrola WebP - canvas nepodporuje WebP, vrátit původní URL
        // (moderní prohlížeče WebP v notifikacích podporují)
        if (fullPath.toLowerCase().endsWith('.webp')) {
            return imageUrl;
        }
        
        // Načíst obrázek
        const img = await loadImage(fullPath);
        const imgWidth = img.width;
        const imgHeight = img.height;
        
        // Cílový poměr 2:1 (800x400) pro notifikace
        const targetRatio = 2;
        const currentRatio = imgWidth / imgHeight;
        
        let canvasWidth, canvasHeight, drawX, drawY;
        
        if (currentRatio > targetRatio) {
            // Obrázek je širší než 2:1 -> přidáme padding nahoře a dole
            canvasWidth = imgWidth;
            canvasHeight = imgWidth / targetRatio;
            drawX = 0;
            drawY = (canvasHeight - imgHeight) / 2;
        } else if (currentRatio < targetRatio) {
            // Obrázek je užší než 2:1 -> přidáme padding po stranách
            canvasHeight = imgHeight;
            canvasWidth = imgHeight * targetRatio;
            drawX = (canvasWidth - imgWidth) / 2;
            drawY = 0;
        } else {
            // Obrázek už má správný poměr 2:1
            return imageUrl;
        }
        
        // Vytvořit canvas s paddingem
        const canvas = createCanvas(canvasWidth, canvasHeight);
        const ctx = canvas.getContext('2d');
        
        // Vyplnit pozadí tmavou barvou
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        
        // Vykreslit obrázek uprostřed
        ctx.drawImage(img, drawX, drawY, imgWidth, imgHeight);
        
        // Uložit výsledek
        const outDir = path.join(process.cwd(), 'public/images/notifications');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        
        const timestamp = Date.now();
        const filename = `custom-processed-${timestamp}.png`;
        const outPath = path.join(outDir, filename);
        
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(outPath, buffer);
        
        console.log(`[processCustomImage] Upraven custom obrázek: ${imageUrl} -> ${filename} (${canvasWidth}x${canvasHeight})`);
        return `/images/notifications/${filename}`;
        
    } catch (err) {
        console.error('[processCustomImage] Chyba při zpracování obrázku:', err);
        // Vrátit původní URL v případě chyby
        return imageUrl;
    }
}

// --- FUNKCE PRO VYTVOŘENÍ "VERSUS" OBRÁZKU ---
async function createVersusImage(homeTeam, awayTeam, matchId, scoreHome = null, scoreAway = null, seriesMatches = null) {
    console.log(`[createVersusImage] START - matchId=${matchId}, teams=${homeTeam?.name} vs ${awayTeam?.name}`);
    if (!homeTeam || !awayTeam) {
        console.log('[createVersusImage] ERROR: Missing teams');
        return null;
    }

    const outDir = path.join(__dirname, '../public/images/notifications');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, `match-${matchId}.png`);
    const publicUrl = `/images/notifications/match-${matchId}.png`;

    const width = 800; const height = 500;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. POZADÍ - Moderní tmavý gradient
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#1a1a1a');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // 2. DEKORACE - Oranžové dynamické linky
    ctx.strokeStyle = 'rgba(255, 69, 0, 0.15)';
    ctx.lineWidth = 3;
    for (let i = -100; i < width; i += 40) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 200, height);
        ctx.stroke();
    }

    // 3. FUNKCE PRO VYKRESLENÍ LOGA SE STÍNEM A BAREVNÝM PODSVÍCENÍM
    const drawLogo = async (team, x, y, teamColor, size = 200) => {
        const logoName = team?.logo;
        const teamName = team?.name || '???';

        // BAREVNÉ PODSVÍCENÍ pod logem
        ctx.fillStyle = teamColor + '40'; // 40 = 25% průhlednost
        ctx.beginPath();
        ctx.roundRect(x - 10, y - 10, size + 20, size + 20, 20);
        ctx.fill();

        // BAREVNÝ RÁMEČEK kolem loga
        ctx.strokeStyle = teamColor;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.roundRect(x - 10, y - 10, size + 20, size + 20, 20);
        ctx.stroke();

        // Stín pod logem
        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        ctx.shadowBlur = 20;
        ctx.shadowOffsetX = 5;
        ctx.shadowOffsetY = 10;

        if (logoName) {
            try {
                const imgPath = path.join(process.cwd(), 'data/images', logoName);
                const img = await loadImage(imgPath);
                const ratio = Math.min(size / img.width, size / img.height);
                const nw = img.width * ratio;
                const nh = img.height * ratio;
                ctx.drawImage(img, x + (size - nw) / 2, y + (size - nh) / 2, nw, nh);
            } catch (e) {
                const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
                ctx.fillStyle = teamColor;
                ctx.beginPath();
                ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = `bold ${Math.floor(size * 0.4)}px Arial`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(initials, x + size / 2, y + size / 2);
            }
        } else {
            const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
            ctx.fillStyle = teamColor;
            ctx.beginPath();
            ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.floor(size * 0.4)}px Arial`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(initials, x + size / 2, y + size / 2);
        }
        ctx.shadowBlur = 0;
    };

    // Barvy týmů: domácí = oranžová, hosté = modrá
    const homeColor = '#ff4500';
    const awayColor = '#0064ff';

    await drawLogo(homeTeam, 40, 60, homeColor, 200);   // Domácí vlevo s oranžovým podsvícením
    await drawLogo(awayTeam, 560, 60, awayColor, 200);  // Hosté vpravo s modrým podsvícením

    // 4. PROSTŘEDNÍ PANEL (Score nebo VS)
    const isResult = scoreHome !== null && scoreAway !== null;

    // Vždy nastavíme textAlign a textBaseline před vykreslením
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Skleněný efekt pod textem
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.beginPath();
    ctx.roundRect(width/2 - 100, height/2 - 60, 200, 120, 20);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 69, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.shadowColor = 'rgba(255, 69, 0, 0.5)';
    ctx.shadowBlur = 10;

    if (isResult) {
        // Vykreslení SKÓRE
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 90px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${scoreHome}:${scoreAway}`, width / 2, height / 2 + 5); // +5 pro lepší centrování

        ctx.fillStyle = '#ff4500';
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('KONEČNÝ VÝSLEDEK', width / 2, height / 2 + 85);
    } else {
        // Vykreslení VS - lepší centrování
        ctx.fillStyle = '#ff4500';
        ctx.font = 'bold 100px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('VS', width / 2, height / 2 + 5); // +5 pro optické centrování
    }

    ctx.shadowBlur = 0;

    // 5. VYKRESLENÍ SÉRIE ZÁPASŮ (pokud jsou předány)
    if (seriesMatches && Array.isArray(seriesMatches) && seriesMatches.length > 0) {
        const startY = 380;
        const boxWidth = 45;
        const boxHeight = 35;
        const gap = 10;
        const totalWidth = seriesMatches.length * (boxWidth + gap) - gap;
        let startX = (width - totalWidth) / 2;

        // Nadpis
        ctx.fillStyle = '#888';
        ctx.font = 'bold 14px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('VÝSLEDKY ZÁPASŮ SÉRIE', width / 2, startY - 25);

        seriesMatches.forEach((match, idx) => {
            const x = startX + idx * (boxWidth + gap);

            // Barva podle vítěze v TOMTO zápase (ne v sérii)
            // Domácí vyhraje → oranžová, Hosté vyhráli → modrá
            const homeWonThisMatch = match.scoreHome > match.scoreAway;
            const winnerColor = homeWonThisMatch ? homeColor : awayColor;

            ctx.fillStyle = winnerColor + '40'; // 40 = 25% průhlednost
            ctx.beginPath();
            ctx.roundRect(x, startY, boxWidth, boxHeight, 8);
            ctx.fill();
            ctx.strokeStyle = winnerColor;
            ctx.lineWidth = 2;
            ctx.stroke();

            // Skóre se zobrazuje tak jak je v databázi - z pohledu domácího týmu v daném zápase
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 18px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const scoreText = match.ot ? `${match.scoreHome}:${match.scoreAway}p` : `${match.scoreHome}:${match.scoreAway}`;
            ctx.fillText(scoreText, x + boxWidth/2, startY + boxHeight/2);
        });

        // Stav série pod boxy
        const seriesWinsH = seriesMatches.filter(m => m.sideSwap ? m.scoreAway > m.scoreHome : m.scoreHome > m.scoreAway).length;
        const seriesWinsA = seriesMatches.filter(m => m.sideSwap ? m.scoreHome > m.scoreAway : m.scoreAway > m.scoreHome).length;
        ctx.fillStyle = '#ff4500';
        ctx.font = 'bold 18px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`Stav série: ${seriesWinsH}:${seriesWinsA}`, width / 2, startY + boxHeight + 25);
    }

    let buffer;
    try {
        buffer = canvas.toBuffer('image/png');
        console.log(`[createVersusImage] Buffer created: ${buffer ? buffer.length : 0} bytes`);
    } catch (err) {
        console.error('[createVersusImage] ERROR při vytváření bufferu:', err);
        return null;
    }
    
    if (!buffer) {
        console.error('[createVersusImage] ERROR: canvas.toBuffer vrátil undefined!');
        return null;
    }
    
    // Pokud je matchId null, vrátíme jen buffer (pro export)
    if (matchId === null || matchId === undefined) {
        console.log('[createVersusImage] Export mode - vracím buffer bez uložení souboru');
        return buffer;
    }
    
    // Pro notifikace uložíme soubor a vrátíme URL
    try {
        fs.writeFileSync(outPath, buffer);
        console.log(`[createVersusImage] SUCCESS - saved to ${outPath}`);
        return publicUrl;
    } catch (err) {
        console.error('[createVersusImage] ERROR při ukládání souboru:', err);
        return null;
    }
}

// --- FUNKCE PRO VYTVOŘENÍ "VERSUS" OBRÁZKU PRO EXPORTER ---
async function createVersusImageForExport(homeTeam, awayTeam) {
    console.log(`[createVersusImageForExport] START - teams=${homeTeam?.name} vs ${awayTeam?.name}`);
    if (!homeTeam || !awayTeam) {
        console.log('[createVersusImageForExport] ERROR: Missing teams');
        return null;
    }

    const width = 800;
    const height = 500;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#1a1a1a');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255, 69, 0, 0.15)';
    ctx.lineWidth = 3;
    for (let i = -100; i < width; i += 40) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 200, height);
        ctx.stroke();
    }

    const drawLogo = async (team, teamColor, isLeft) => {
        const logoName = team?.logo;
        const teamName = team?.name || '???';
        const logoHeight = 450;
        const visibleWidth = 220;
        const y = (height - logoHeight) / 2;

        ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
        ctx.shadowBlur = 20;
        ctx.shadowOffsetX = 5;
        ctx.shadowOffsetY = 10;

        if (logoName) {
            try {
                const imgPath = path.join(__dirname, '../data/images', logoName);
                const img = await loadImage(imgPath);
                const ratio = logoHeight / img.height;
                const nw = img.width * ratio;
                const nh = logoHeight;
                const offset = 0;
                const drawX = isLeft ? offset + visibleWidth - nw : 800 - offset - visibleWidth;
                const visibleX = isLeft ? offset : 800 - offset - visibleWidth;

                ctx.fillStyle = teamColor + '40';
                ctx.beginPath();
                ctx.roundRect(visibleX - 10, y - 10, visibleWidth + 20, nh + 20, 20);
                ctx.fill();

                ctx.strokeStyle = teamColor;
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.roundRect(visibleX - 10, y - 10, visibleWidth + 20, nh + 20, 20);
                ctx.stroke();

                ctx.drawImage(img, drawX, y, nw, nh);
            } catch (e) {
                const offset = 0;
                const visibleX = isLeft ? offset : 800 - offset - visibleWidth;
                ctx.fillStyle = teamColor + '40';
                ctx.beginPath();
                ctx.roundRect(visibleX - 10, y - 10, visibleWidth + 20, logoHeight + 20, 20);
                ctx.fill();
                ctx.strokeStyle = teamColor;
                ctx.lineWidth = 4;
                ctx.beginPath();
                ctx.roundRect(visibleX - 10, y - 10, visibleWidth + 20, logoHeight + 20, 20);
                ctx.stroke();
                ctx.fillStyle = teamColor;
                ctx.beginPath();
                ctx.arc(isLeft ? visibleWidth/2 : 800 - visibleWidth/2, y + logoHeight/2, logoHeight/2, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 100px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
                const textX = isLeft ? visibleWidth/2 : 800 - visibleWidth/2;
                ctx.fillText(initials, textX, y + logoHeight/2);
            }
        } else {
            const offset = 0;
            const visibleX = isLeft ? offset : 800 - offset - visibleWidth;
            ctx.fillStyle = teamColor + '40';
            ctx.beginPath();
            ctx.roundRect(visibleX - 10, y - 10, visibleWidth + 20, logoHeight + 20, 20);
            ctx.fill();
            ctx.strokeStyle = teamColor;
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.roundRect(visibleX - 10, y - 10, visibleWidth + 20, logoHeight + 20, 20);
            ctx.stroke();
            ctx.fillStyle = teamColor;
            ctx.beginPath();
            ctx.arc(isLeft ? visibleWidth/2 : 800 - visibleWidth/2, y + logoHeight/2, logoHeight/2, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 100px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
            const textX = isLeft ? visibleWidth/2 : 800 - visibleWidth/2;
            ctx.fillText(initials, textX, y + logoHeight/2);
        }
        ctx.shadowBlur = 0;
    };

    const homeColor = '#ff4500';
    const awayColor = '#0064ff';

    await drawLogo(homeTeam, homeColor, true);
    await drawLogo(awayTeam, awayColor, false);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.beginPath();
    ctx.roundRect(width/2 - 100, height/2 - 60, 200, 120, 20);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 69, 0, 0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.shadowColor = 'rgba(255, 69, 0, 0.5)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ff4500';
    ctx.font = 'bold 100px Arial';
    ctx.fillText('VS', width / 2, height / 2 + 5);
    ctx.shadowBlur = 0;

    let buffer;
    try {
        buffer = canvas.toBuffer('image/png');
        console.log(`[createVersusImageForExport] Buffer created: ${buffer ? buffer.length : 0} bytes`);
    } catch (err) {
        console.error('[createVersusImageForExport] ERROR při vytváření bufferu:', err);
        return null;
    }
    
    if (!buffer) {
        console.error('[createVersusImageForExport] ERROR: canvas.toBuffer vrátil undefined!');
        return null;
    }
    
    return buffer;
}

// ... TVOJE ODESÍLACÍ FUNKCE A NOTIFY FUNKCE TADY ZŮSTÁVAJÍ (nechal jsem je beze změny) ...

// --- FUNKCE PRO VYTVOŘENÍ OBRÁZKU VÍTĚZE LIGY ---
async function createLeagueWinnerImage(winnerTeam, liga) {
    if (!winnerTeam) return null;
    
    const outDir = path.join(__dirname, '../public/images/notifications');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const timestamp = Date.now();
    const outPath = path.join(outDir, `winner-${liga}-${timestamp}.webp`);
    const publicUrl = `/images/notifications/winner-${liga}-${timestamp}.webp`;

    const width = 800; const height = 400;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // 1. POZADÍ - Zlatý vítězný gradient
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#1a0f00');
    grad.addColorStop(0.5, '#2d1f00');
    grad.addColorStop(1, '#0d0d0d');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    // 2. DEKORACE - Zlaté zářící linky
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.2)';
    ctx.lineWidth = 3;
    for (let i = -100; i < width; i += 50) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i + 150, height);
        ctx.stroke();
    }
    
    // Radiální záře za logem
    const glowGrad = ctx.createRadialGradient(width/2, height/2, 50, width/2, height/2, 250);
    glowGrad.addColorStop(0, 'rgba(255, 215, 0, 0.15)');
    glowGrad.addColorStop(1, 'rgba(255, 215, 0, 0)');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(0, 0, width, height);

    // 3. NÁPIS VÍTĚZ
    ctx.fillStyle = '#ffd700';
    ctx.font = 'bold 30px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(255, 215, 0, 0.8)';
    ctx.shadowBlur = 20;
    ctx.fillText(`🏆 VÍTĚZ ${liga}`, width / 2, 50);
    ctx.shadowBlur = 0;

    // 4. VYKRESLENÍ LOGA VÍTĚZE (velké, uprostřed)
    const drawWinnerLogo = async () => {
        const logoName = winnerTeam?.logo;
        const teamName = winnerTeam?.name || '???';
        const x = 270; // Střed pro velké logo (260px)
        const y = 130;
        const size = 260;
        
        // Zlatý stín pod logem
        ctx.shadowColor = 'rgba(255, 215, 0, 0.5)';
        ctx.shadowBlur = 30;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 10;
        
        if (logoName) {
            try {
                const imgPath = path.join(__dirname, '../data/images', logoName);
                const img = await loadImage(imgPath);
                const ratio = Math.min(size / img.width, size / img.height);
                const nw = img.width * ratio;
                const nh = img.height * ratio;
                ctx.drawImage(img, x + (size - nw) / 2, y + (size - nh) / 2, nw, nh);
            } catch (e) {
                // Fallback - iniciály
                const centerX = x + size / 2;
                const centerY = y + size / 2;
                const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
                
                ctx.fillStyle = '#ffd700';
                ctx.beginPath();
                ctx.arc(centerX, centerY, 100, 0, Math.PI * 2);
                ctx.fill();
                
                ctx.fillStyle = '#000000';
                ctx.font = 'bold 80px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(initials, centerX, centerY);
            }
        } else {
            // Fallback - iniciály
            const centerX = x + size / 2;
            const centerY = y + size / 2;
            const initials = teamName.split(' ').map(w => w[0]).join('').slice(0, 3).toUpperCase();
            
            ctx.fillStyle = '#ffd700';
            ctx.beginPath();
            ctx.arc(centerX, centerY, 100, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.fillStyle = '#000000';
            ctx.font = 'bold 80px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(initials, centerX, centerY);
        }
        ctx.shadowBlur = 0;
    };

    await drawWinnerLogo();

    // 5. NÁZEV TÝMU DOLE
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(winnerTeam.name.toUpperCase(), width / 2, 360);

    let buffer;
    try {
        buffer = canvas.toBuffer('image/png');
    } catch (err) {
        console.error('[createLeagueWinnerImage] ERROR při vytváření bufferu:', err);
        return null;
    }
    
    if (!buffer) {
        console.error('[createLeagueWinnerImage] ERROR: canvas.toBuffer vrátil undefined!');
        return null;
    }
    
    try {
        fs.writeFileSync(outPath, buffer);
        console.log(`[createLeagueWinnerImage] Obrázek uložen: ${outPath}`);
        return publicUrl;
    } catch (err) {
        console.error('[createLeagueWinnerImage] ERROR při ukládání souboru:', err);
        return null;
    }
}

const sendToUserDevices = (user, payload) => {
    // Přidáme server origin do payloadu pro identifikaci zdroje (bez trailing slash)
    payload.serverOrigin = (process.env.SERVER_ORIGIN || 'unknown').replace(/\/$/, '');

    let hasChanges = false;
    let activeSubscriptions = [];

    // 1. Podpora pro starý formát (jeden objekt)
    if (user.subscription && !user.subscriptions) {
        user.subscriptions = [user.subscription];
        delete user.subscription;
        hasChanges = true;
    }

    if (!user.subscriptions || user.subscriptions.length === 0) return;
    const options = {
        // Pokud payload obsahuje ttl (v sekundách), použijeme ho. Jinak dáme default 24 hodin (86400)
        TTL: payload.ttl || 86400,
        // Urgency 'high' zajistí okamzite doruceni i pri uspornem rezimu na Androidu
        urgency: 'high'
    };
    // 2. Projdeme všechna zařízení uživatele a odešleme notifikaci
    const promises = user.subscriptions.map(sub => {
        return webpush.sendNotification(sub, JSON.stringify(payload), options)
            .then(() => {
                activeSubscriptions.push(sub); // Odeslání úspěšné, ponecháme
            })
            .catch(err => {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    console.log(`[Push] Odběr expiroval pro uživatele ${user.username}, mažu jej.`);
                    hasChanges = true;
                } else {
                    console.error(`[Push] Chyba při odesílání pro ${user.username}:`, err);
                    activeSubscriptions.push(sub); // Pro jiné chyby zatím ponecháme
                }
            });
    });

    // 3. Počkáme na odeslání na všechna zařízení a případně promažeme neplatné
    Promise.all(promises).then(async () => {
        if (hasChanges) {
            user.subscriptions = activeSubscriptions;
            const users = await getUsers();
            const userIndex = users.findIndex(u => u.username === user.username);
            if (userIndex !== -1) {
                users[userIndex].subscriptions = activeSubscriptions;
                // Úklid starého klíče, pokud existoval
                delete users[userIndex].subscription;
                await Users.updateAll(users);
            }
        }
    });
};

// --- NOTIFIKAČNÍ FUNKCE PRO RŮZNÉ UDÁLOSTI ---

const notifyNewMatches = async () => {
    const payload = {
        title: "🏒 Nové zápasy k tipování!",
        body: "Byly vypsány nové zápasy nebo série. Nezapomeň si tipnout co nejdříve!",
        icon: '/images/logo.png',
        vibrate: [100, 100, 250, 500, 100, 100, 250],
        url: '/',
        requireInteraction: true,
        actions: [
            { action: 'open_match', title: 'Jdu tipnout! 🚀' },
            { action: 'close', title: 'Zavřít' }
        ]
    };
    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

const notifyResult = async (matchId, scoreHome, scoreAway) => {
    const matches = await getMatches();
    const match = matches.find(m => m.id === parseInt(matchId));
    if (!match) return;

    const teams = await getTeams();
    const homeTeam = teams.find(t => t.id === match.homeTeamId);
    const awayTeam = teams.find(t => t.id === match.awayTeamId);
    if (!homeTeam || !awayTeam) return;

    const isSeries = match.isPlayoff && match.bo > 1;

    let title, body;
    if (isSeries) {
        title = "🏆 Konec série!";
        body = `Série ${homeTeam.name} vs ${awayTeam.name} skončila. Konečný stav: ${scoreHome}:${scoreAway}`;
    } else {
        title = "🏒 Zápas vyhodnocen!";
        const otText = match.result && match.result.ot ? " (pp/sn)" : "";
        body = `Výsledek: ${homeTeam.name} ${scoreHome}:${scoreAway}${otText} ${awayTeam.name}`;
    }

    // VYGENEROVÁNÍ DYNAMICKÉHO OBRÁZKU
    let heroImageUrl = null;
    try {
        // Pro série načteme všechny zápasy série pro zobrazení v obrázku
        let seriesMatches = null;
        if (isSeries && match.playedMatches) {
            seriesMatches = match.playedMatches;
        }
        heroImageUrl = await createVersusImage(homeTeam, awayTeam, match.id, scoreHome, scoreAway, seriesMatches);
        console.log(`[notifyResult] Generated heroImageUrl: ${heroImageUrl}`);
    } catch (err) {
        console.error("Chyba při generování Versus obrázku:", err);
    }

    const payload = {
        title,
        body,
        icon: '/images/logo.png',
        image: heroImageUrl,
        vibrate: [200, 200, 200, 400, 100, 100, 100, 100, 100],
        url: `/?liga=${encodeURIComponent(match.liga)}`,
        tag: `vyhodnoceni-${match.id}`,
        requireInteraction: true,
        actions: [
            { action: 'open_match', title: 'Kouknout na tabulku' },
            { action: 'close', title: 'Zavřít' }
        ]
    };

    console.log(`[notifyResult] Sending payload with image: ${payload.image}`);
    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

// PRŮBĚŽNÝ STAV SÉRIE - přijímá buď matchId nebo celý match objekt
const notifySeriesProgress = async (matchOrId, matchIndex, scoreHome, scoreAway, ot, seriesScoreH, seriesScoreA, seriesMatches = null) => {
    let match;
    if (typeof matchOrId === 'object' && matchOrId !== null) {
        match = matchOrId;
        console.log(`[notifySeriesProgress] Received match object id=${match.id}`);
    } else {
        const matchId = matchOrId;
        console.log(`[notifySeriesProgress] CALLED matchId=${matchId}, matchIndex=${matchIndex}, score=${scoreHome}:${scoreAway}`);
        const matches = await getMatches();
        match = matches.find(m => m.id === parseInt(matchId));
    }
    
    if (!match) {
        console.log(`[notifySeriesProgress] ERROR: Match not found`);
        return;
    }

    const teams = await getTeams();
    const homeTeam = teams.find(t => t.id === match.homeTeamId);
    const awayTeam = teams.find(t => t.id === match.awayTeamId);
    if (!homeTeam || !awayTeam) return;

    // VYGENEROVÁNÍ DYNAMICKÉHO OBRÁZKU
    let heroImageUrl = null;
    try {
        heroImageUrl = await createVersusImage(homeTeam, awayTeam, match.id, scoreHome, scoreAway, seriesMatches);
    } catch (err) {
        console.error("Chyba při generování Versus obrázku:", err);
    }

    const otText = ot ? " pp" : "";
    const payload = {
        title: `🏒 Playoff: ${homeTeam.name} vs ${awayTeam.name}`,
        body: `${matchIndex}. zápas: ${scoreHome}:${scoreAway}${otText} | Průběžný stav série: ${seriesScoreH}:${seriesScoreA}`,
        icon: '/images/logo.png',
        image: heroImageUrl, // PŘIDANÝ OBRÁZEK
        vibrate: [200, 200, 200, 400, 100, 100, 100, 100, 100],
        url: `/?liga=${encodeURIComponent(match.liga)}`,
        tag: `serie-progress-${match.id}`,
        actions: [
            { action: 'open_match', title: 'Zobrazit pavouka' },
            { action: 'close', title: 'Zavřít' }
        ]
    };

    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

const notifyMatchUpdate = async (matchId, details) => {
    const matches = await getMatches();
    const match = matches.find(m => m.id === parseInt(matchId));
    if (!match) return;

    const teams = await getTeams();
    const homeTeam = teams.find(t => t.id === match.homeTeamId);
    const awayTeam = teams.find(t => t.id === match.awayTeamId);

    if (!homeTeam || !awayTeam) return;

    // VYGENEROVÁNÍ DYNAMICKÉHO OBRÁZKU
    let heroImageUrl = null;
    try {
        heroImageUrl = await createVersusImage(homeTeam, awayTeam, match.id);
    } catch (err) {
        console.error("Chyba při generování Versus obrázku:", err);
    }

    const matchTypeStr = (match.isPlayoff && match.bo > 1) ? "série" : "zápasu";

    const payload = {
        title: `⚠️ Změna u ${matchTypeStr}!`,
        body: `${homeTeam.name} vs ${awayTeam.name}\nDetaily: ${details}`,
        icon: '/images/logo.png',
        image: heroImageUrl, // PŘIDANÝ OBRÁZEK
        vibrate: [50, 50, 50, 50, 50, 50], // Rychlý poplach
        url: `/?liga=${encodeURIComponent(match.liga)}`,
        tag: `update-${match.id}`
    };

    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

// ZMĚNA: Přidáno async a parametr involvedTeams + customImageUrl
const notifyTransfer = async (message, involvedTeams = [], customImageUrl = null) => {
    let heroImageUrl = null;
    
    // Pokud je předán vlastní obrázek, zpracujeme ho pro notifikace
    if (customImageUrl) {
        // Custom obrázky (upload/galerie) upravíme aby byly viditelné v notifikacích
        heroImageUrl = await processCustomImageForNotification(customImageUrl);
    }
    // Pokud se měnil jen 1 tým, použijeme jeho logo a zpracujeme pro notifikace
    else if (involvedTeams.length === 1 && involvedTeams[0].logo) {
        const logoUrl = `/logoteamu/${encodeURIComponent(involvedTeams[0].logo)}`;
        heroImageUrl = await processCustomImageForNotification(logoUrl);
    }
    // Pokud se měnily přesně 2 týmy, zobrazíme jen logo prvního týmu
    else if (involvedTeams.length === 2) {
        // Pro přestup mezi dvěma týmy zobrazíme jen logo prvního ovlivněného týmu
        if (involvedTeams[0].logo) {
            const logoUrl = `/logoteamu/${encodeURIComponent(involvedTeams[0].logo)}`;
            heroImageUrl = await processCustomImageForNotification(logoUrl);
        }
    }
    // Pokud je týmů více (např. jsi uložil změny u 5 týmů najednou), obrázek necháme null
    // (Případně sem později můžeš dopsat: heroImageUrl = '/images/notifications/general-transfer.jpg';)

    const payload = {
        title: "🔄 Nové pohyby v kádru!",
        body: message,
        icon: '/images/logo.png',
        image: heroImageUrl, // PŘIDÁNO LOKÁLNÍ LOGO / VYGENEROVANÝ OBRÁZEK
        vibrate: [200, 100, 200, 100, 200], // Speciální "dvojité" vrnění
        url: '/prestupy',
        requireInteraction: true,
        actions: [
            { action: 'open_transfers', title: 'Kouknout na tabulku přestupů 👀' },
            { action: 'close', title: 'Zavřít' }
        ]
    };
    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

const notifyLeagueEnd = async (liga, winnerTeam = null) => {
    // VYGENEROVÁNÍ OBRÁZKU VÍTĚZE (pokud je předán)
    let heroImageUrl = null;
    if (winnerTeam) {
        try {
            heroImageUrl = await createLeagueWinnerImage(winnerTeam, liga);
            console.log(`[LeagueEnd] Vytvořen obrázek vítěze: ${heroImageUrl}`);
        } catch (err) {
            console.error("Chyba při generování obrázku vítěze:", err);
        }
    }

    const payload = {
        title: `🏁 Základní část ${liga} skončila!`,
        body: winnerTeam 
            ? `🏆 Vítěz: ${winnerTeam.name}! Základní část ligy ${liga} byla ukončena. Běž se podívat na konečné pořadí!`
            : `Základní část ligy ${liga} byla právě ukončena. Běž se podívat na konečné pořadí a zkontroluj, kolik bodů jsi získal za svůj tip tabulky! 🏆`,
        icon: '/images/logo.png',
        image: heroImageUrl, // OBRÁZEK VÍTĚZE

        vibrate: [300, 100, 300, 100, 300, 400, 200, 200, 200], // Slavnostní dlouhé vibrace (fanfára/skandování)

        // Chování
        url: `/history/table/?liga=${encodeURIComponent(liga)}`,
        tag: `konec-ligy-${liga}`,
        requireInteraction: true, // Tohle nesmí uživatel minout, zpráva nezmizí sama

        // Tlačítka
        actions: [
            { action: 'open_table', title: 'Ukázat konečnou tabulku 🏆' },
            { action: 'close', title: 'Zavřít' }
        ]
    };

    const users = await getUsers();
    users.forEach(u => sendToUserDevices(u, payload));
};

// --- AUTOMATICKÉ NOTIFIKACE (CRON) ---
// Změna: přidali jsme 'async' před callback funkci
cron.schedule('0 * * * *', async () => {
    const now = new Date();
    // Použijeme českou časovou zónu pro konzistenci se zbytkem aplikace
    const currentPragueTime = new Date(now.toLocaleString('sv-SE', {timeZone: 'Europe/Prague'}));
    const matches = await getMatches();
    const users = await getUsers();

    if (!users || users.length === 0) return;

    const targetTimes = [
        { diffMs: 4 * 60 * 60 * 1000, type: "4h" },
        { diffMs: 60 * 60 * 1000, type: "1h" }
    ];

    for (const { diffMs, type } of targetTimes) {
        const targetTime = new Date(currentPragueTime.getTime() + diffMs);

        const upcomingMatches = matches.filter(m => {
            if (m.result || m.postponed || m.locked) return false;
            const matchDate = new Date(m.datetime);
            return (
                matchDate.getFullYear() === targetTime.getFullYear() &&
                matchDate.getMonth() === targetTime.getMonth() &&
                matchDate.getDate() === targetTime.getDate() &&
                matchDate.getHours() === targetTime.getHours()
            );
        });

        if (upcomingMatches.length === 0) continue;

        const teams = await getTeams();

        // Změna: Používáme for...of místo forEach, abychom mohli počkat na obrázek
        for (const match of upcomingMatches) {
            const homeTeam = teams.find(t => t.id === match.homeTeamId);
            const awayTeam = teams.find(t => t.id === match.awayTeamId);

            const homeName = homeTeam?.name || 'Neznámý tým';
            const awayName = awayTeam?.name || 'Neznámý tým';

            const isSeries = match.isPlayoff && match.bo > 1;
            const matchTypeStr = isSeries ? "sérii" : "zápas";
            const matchTypeSubj = isSeries ? "série" : "zápas";

            // VYGENERUJEME OBRÁZEK PRO TENTO ZÁPAS
            let heroImageUrl = null;
            try {
                heroImageUrl = await createVersusImage(homeTeam, awayTeam, match.id);
            } catch (err) {
                console.error("Chyba při generování Versus obrázku:", err);
            }

            users.forEach(u => {
                if (!u.subscriptions || u.subscriptions.length === 0) return;

                const userTipsForSeason = u.tips?.[match.season]?.[match.liga] || [];
                const hasTip = userTipsForSeason.find(t => Number(t.matchId) === Number(match.id));

                if (!hasTip) {
                    const timeText = type === "4h" ? "4 hodiny" : "hodinu";
                    console.log(`[CRON] Posílám ${type} upozornění že nemá tip: ${u.username} (${homeName} vs ${awayName})`);
                    sendToUserDevices(u, {
                        title: type === "4h" ? "🔔 Nezapomeň si tipnout!" : "⏳ Poslední šance!",
                        TTL: type === "4h" ? 14400 : 3600,
                        body: `Za ${timeText} začíná ${matchTypeSubj} ${homeName} vs ${awayName}. Ještě nemáš tipnuto na tuto ${matchTypeStr}!`,
                        icon: '/images/logo.png',
                        image: heroImageUrl, // PŘIDANÝ VYGENEROVANÝ OBRÁZEK
                        vibrate: [50, 50, 50, 50, 50, 50, 50, 50],
                        url: `/?liga=${encodeURIComponent(match.liga)}`,
                        tag: `zapas-${match.id}`,
                        requireInteraction: true,
                        actions: [
                            { action: 'open_match', title: 'Jdu tipnout! 🚀' },
                            { action: 'close', title: 'Zavřít' }
                        ]
                    });
                } else if (hasTip && type === "1h") {
                    console.log(`[CRON] Posílám ${type} upozornění že začíná zápas: ${u.username} (${homeName} vs ${awayName})`);
                    sendToUserDevices(u, {
                        title: "⏳ Za hodinu už si nezměníš tip!",
                        body: `Za hodinu začíná ${matchTypeSubj} ${homeName} vs ${awayName}.`,
                        icon: '/images/logo.png',
                        image: heroImageUrl, // PŘIDANÝ VYGENEROVANÝ OBRÁZEK
                        vibrate: [100, 100, 250, 500, 100, 100, 250],
                        url: `/?liga=${encodeURIComponent(match.liga)}`,
                        tag: `zapas-${match.id}`,
                        requireInteraction: false,
                        actions: [
                            { action: 'open_match', title: 'Kouknout na tabulku' },
                            { action: 'close', title: 'Zavřít' }
                        ]
                    });
                }
            });
        }
    }
});

// ==========================================
// AUTOMATICKÝ ÚKLID STARÝCH OBRÁZKŮ
// ==========================================
cron.schedule('0 3 * * *', () => { // Spustí se každý den ve 3:00 ráno
    const dir = path.join(__dirname, '../public/images/notifications');
    if (!fs.existsSync(dir)) return;

    fs.readdir(dir, (err, files) => {
        if (err) {
            console.error("[ÚKLID] Chyba při čtení složky notifikací:", err);
            return;
        }

        const now = Date.now();
        const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 dny v milisekundách

        files.forEach(file => {
            // Chceme mazat JEN dynamicky generované soubory (zápasy a přestupy)
            if (file.startsWith('match-') || file.startsWith('transfer-')) {
                const filePath = path.join(dir, file);

                fs.stat(filePath, (err, stats) => {
                    if (err) return;

                    // Pokud je soubor starší než 3 dny, smažeme ho
                    if (now - stats.mtimeMs > MAX_AGE_MS) {
                        fs.unlink(filePath, err => {
                            if (!err) console.log(`[ÚKLID] Smazán starý notifikační obrázek: ${file}`);
                        });
                    }
                });
            }
        });
    });
});

module.exports = {
    notifyNewMatches,
    notifyResult,
    notifySeriesProgress,
    notifyMatchUpdate,
    notifyTransfer,
    notifyLeagueEnd,
    sendToUserDevices,
    createVersusImageForExport
};
