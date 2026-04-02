const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createCanvas, loadImage } = require('canvas');

// Lazy load sharp pouze pokud je potřeba pro WebP
let sharp;
try {
    sharp = require('sharp');
} catch (e) {
    sharp = null;
}

async function convertIfWebP(imagePath) {
    const ext = path.extname(imagePath).toLowerCase();
    if (ext === '.webp') {
        if (!sharp) {
            throw new Error('WebP support requires "sharp" package. Install: npm install sharp');
        }
        const buffer = await sharp(imagePath).png().toBuffer();
        return loadImage(buffer);
    }
    return loadImage(imagePath);
}

async function generatePerceptualHash(imagePath) {
    try {
        const img = await convertIfWebP(imagePath);
        
        // Vytvoříme malý grayscale obrázek (32x32 pro DCT)
        const size = 32;
        const canvas = createCanvas(size, size);
        const ctx = canvas.getContext('2d');
        
        // Vykreslíme obrázek v šedé stupnici
        ctx.drawImage(img, 0, 0, size, size);
        const imageData = ctx.getImageData(0, 0, size, size);
        const data = imageData.data;
        
        // Konvertujeme na grayscale (průměr RGB)
        const gray = [];
        for (let i = 0; i < data.length; i += 4) {
            const avg = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
            gray.push(avg);
        }
        
        // Aplikujeme DCT (Discrete Cosine Transform) - zjednodušená verze
        // Pro 32x32 použijeme 8x8 low-frequency komponenty
        const dctSize = 8;
        const dct = computeDCT(gray, size);
        
        // Vezmeme horní levý 8x8 blok (low frequencies)
        const dctLow = [];
        for (let y = 0; y < dctSize; y++) {
            for (let x = 0; x < dctSize; x++) {
                dctLow.push(dct[y * size + x]);
            }
        }
        
        // Vypočítáme průměr (ignorujeme DC komponentu na pozici 0)
        let sum = 0;
        for (let i = 1; i < dctLow.length; i++) {
            sum += dctLow[i];
        }
        const avg = sum / (dctLow.length - 1);
        
        // Vytvoříme hash - každý bit je 1 pokud je hodnota nad průměrem
        let hash = '';
        for (let i = 1; i < dctLow.length; i++) {
            hash += dctLow[i] > avg ? '1' : '0';
        }
        
        // Převedeme binární řetězec na hex
        return binaryToHex(hash);
    } catch (err) {
        console.error(`Chyba při generování pHash pro ${imagePath}:`, err.message);
        return null;
    }
}

/**
 * Zjednodušená DCT implementace
 */
function computeDCT(pixels, size) {
    const result = new Array(size * size).fill(0);
    
    for (let v = 0; v < size; v++) {
        for (let u = 0; u < size; u++) {
            let sum = 0;
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const cosX = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size));
                    const cosY = Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
                    sum += pixels[y * size + x] * cosX * cosY;
                }
            }
            const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
            const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
            result[v * size + u] = (2 / size) * cu * cv * sum;
        }
    }
    
    return result;
}

/**
 * Převede binární řetězec na hex
 */
function binaryToHex(binary) {
    let hex = '';
    for (let i = 0; i < binary.length; i += 4) {
        const chunk = binary.slice(i, i + 4).padEnd(4, '0');
        hex += parseInt(chunk, 2).toString(16);
    }
    return hex;
}

/**
 * Vypočítá Hammingovu vzdálenost mezi dvěma hashe
 * @param {string} hash1 - První hex hash
 * @param {string} hash2 - Druhý hex hash
 * @returns {number} - Počet rozdílných bitů
 */
function hammingDistance(hash1, hash2) {
    if (hash1.length !== hash2.length) return Infinity;
    
    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
        const b1 = parseInt(hash1[i], 16);
        const b2 = parseInt(hash2[i], 16);
        const xor = b1 ^ b2;
        // Spočítáme bity v xor
        distance += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
    }
    return distance;
}

/**
 * Vytvoří MD5 hash souboru pro detekci identických souborů
 * @param {string} filePath - Cesta k souboru
 * @returns {string} - MD5 hash
 */
function generateFileHash(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
}

/**
 * Naskenuje všechny obrázky ve složce a vrátí jejich hashe
 * @param {string} imagesDir - Cesta ke složce s obrázky
 * @returns {Promise<Array>} - Pole objektů {filename, fileHash, perceptualHash, size}
 */
async function scanImageHashes(imagesDir) {
    if (!fs.existsSync(imagesDir)) {
        return [];
    }
    
    const files = fs.readdirSync(imagesDir)
        .filter(f => f.match(/\.(jpg|jpeg|png|gif|webp)$/i));
    
    const results = [];
    
    for (const file of files) {
        const filePath = path.join(imagesDir, file);
        const stats = fs.statSync(filePath);
        
        try {
            const fileHash = generateFileHash(filePath);
            const perceptualHash = await generatePerceptualHash(filePath);
            
            results.push({
                filename: file,
                fileHash,
                perceptualHash,
                size: stats.size,
                modified: stats.mtime
            });
        } catch (err) {
            console.error(`Chyba při zpracování ${file}:`, err.message);
        }
    }
    
    return results;
}

/**
 * Najde duplicity mezi obrázky
 * @param {Array} imageHashes - Pole objektů s hashi
 * @param {Object} options - Nastavení detekce
 * @returns {Object} - {exact: [], similar: [], filenameConflicts: []}
 */
function findDuplicates(imageHashes, options = {}) {
    const { 
        similarThreshold = 1,  // ULTRA STRICT: pouze 98%+ shoda (téměř identické)
        checkFilename = true 
    } = options;
    
    const exact = [];       // Identické soubory (MD5 match)
    const similar = [];     // Vizuelně podobné (perceptual hash)
    const filenameConflicts = []; // Stejný název souboru
    
    // Kontrola identických souborů (MD5)
    const fileHashMap = new Map();
    for (const img of imageHashes) {
        if (fileHashMap.has(img.fileHash)) {
            exact.push({
                type: 'exact',
                original: fileHashMap.get(img.fileHash).filename,
                duplicate: img.filename,
                reason: 'Identický obsah (MD5 match)'
            });
        } else {
            fileHashMap.set(img.fileHash, img);
        }
    }
    
    // Kontrola vizuální podobnosti (perceptual hash)
    if (imageHashes.length > 0 && imageHashes[0].perceptualHash) {
        for (let i = 0; i < imageHashes.length; i++) {
            for (let j = i + 1; j < imageHashes.length; j++) {
                const img1 = imageHashes[i];
                const img2 = imageHashes[j];
                
                if (img1.perceptualHash && img2.perceptualHash) {
                    const distance = hammingDistance(img1.perceptualHash, img2.perceptualHash);
                    
                    if (distance <= similarThreshold) {
                        similar.push({
                            type: 'similar',
                            image1: img1.filename,
                            image2: img2.filename,
                            distance,
                            similarity: Math.round((1 - distance / 64) * 100),
                            reason: `Vizuálně podobné (${distance}/64 bitů rozdíl, ${Math.round((1 - distance / 64) * 100)}% shoda)`
                        });
                    }
                }
            }
        }
    }
    
    // Kontrola konfliktů názvů (case-insensitive)
    if (checkFilename) {
        const filenameMap = new Map();
        for (const img of imageHashes) {
            const lowerName = img.filename.toLowerCase();
            if (filenameMap.has(lowerName)) {
                filenameConflicts.push({
                    type: 'filename',
                    original: filenameMap.get(lowerName).filename,
                    duplicate: img.filename,
                    reason: 'Stejný název souboru (case-insensitive)'
                });
            } else {
                filenameMap.set(lowerName, img);
            }
        }
    }
    
    return { exact, similar, filenameConflicts };
}

/**
 * Kontroluje zda nový soubor je duplicitní vůči existujícím
 * @param {string} newFilePath - Cesta k novému souboru
 * @param {Array} existingImages - Pole existujících obrázků s hashi
 * @param {Object} options - Nastavení
 * @returns {Promise<Object>} - Výsledek kontroly {isDuplicate, conflicts: []}
 */
async function checkNewFileDuplicate(newFilePath, existingImages, options = {}) {
    const { 
        similarThreshold = 1,  // ULTRA STRICT - pouze 98%+ shoda (téměř identické)
        checkFilename = true 
    } = options;
    
    const conflicts = [];
    const filename = path.basename(newFilePath);
    
    // Kontrola názvu souboru
    if (checkFilename) {
        const nameConflict = existingImages.find(img => 
            img.filename.toLowerCase() === filename.toLowerCase()
        );
        if (nameConflict) {
            conflicts.push({
                type: 'filename',
                filename: nameConflict.filename,
                reason: 'Soubor se stejným názvem již existuje'
            });
        }
    }
    
    // Kontrola obsahu (MD5)
    const newFileHash = generateFileHash(newFilePath);
    const exactMatch = existingImages.find(img => img.fileHash === newFileHash);
    if (exactMatch) {
        conflicts.push({
            type: 'exact',
            filename: exactMatch.filename,
            reason: 'Identický obsah souboru (MD5 match)'
        });
    }
    
    // Kontrola vizuální podobnosti
    const newPerceptualHash = await generatePerceptualHash(newFilePath);
    if (newPerceptualHash) {
        for (const existing of existingImages) {
            if (existing.perceptualHash) {
                const distance = hammingDistance(newPerceptualHash, existing.perceptualHash);
                if (distance <= similarThreshold) {
                    conflicts.push({
                        type: 'similar',
                        filename: existing.filename,
                        distance,
                        similarity: Math.round((1 - distance / 64) * 100),
                        reason: `Vizuálně podobný obrázek (${Math.round((1 - distance / 64) * 100)}% shoda)`
                    });
                }
            }
        }
    }
    
    return {
        isDuplicate: conflicts.length > 0,
        conflicts,
        perceptualHash: newPerceptualHash,
        fileHash: newFileHash
    };
}

/**
 * Uloží hashe obrázků do MongoDB pro rychlejší kontrolu
 * @param {Object} db - MongoDB databáze
 * @param {string} imagesDir - Cesta ke složce s obrázky
 */
async function syncImageHashesToDatabase(db, imagesDir) {
    const collection = db.collection('image_hashes');
    const hashes = await scanImageHashes(imagesDir);
    
    // Aktualizujeme nebo vložíme hashe
    for (const hash of hashes) {
        await collection.updateOne(
            { filename: hash.filename },
            { $set: { ...hash, updatedAt: new Date() } },
            { upsert: true }
        );
    }
    
    // Smažeme záznamy pro smazané soubory
    const filenames = hashes.map(h => h.filename);
    await collection.deleteMany({ filename: { $nin: filenames } });
    
    return hashes.length;
}

module.exports = {
    scanImageHashes,
    findDuplicates,
    checkNewFileDuplicate,
    syncImageHashesToDatabase
};
