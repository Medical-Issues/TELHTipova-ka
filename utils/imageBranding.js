const { loadImage } = require('canvas');

async function drawBrandedBackground(ctx, width, height, settings = {}) {
    const bgColor = settings.bgColor || '#1a1a1a';
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, bgColor);
    gradient.addColorStop(1, '#080a0d');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    if (!settings.bgImage || typeof settings.bgImage !== 'string' || !settings.bgImage.startsWith('data:image/')) return;

    try {
        const imageData = settings.bgImage.split(',')[1];
        if (!imageData) {
            console.error('[imageBranding] Neplatný formát obrázku na pozadí.');
            return;
        }
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

module.exports = { drawBrandedBackground };
