const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const path = require('path');

function cleanOcrText(rawText) {
  if (!rawText) return '';
  const lines = rawText.split('\n');
  const cleanLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const alphaNum = (trimmed.match(/[a-zA-Z0-9áéíóúñüÁÉÍÓÚÑÜ.,!?¿¡'":;\-\s]/g) || []).length;
    const total = trimmed.length;
    if (total > 0 && alphaNum / total > 0.5) {
      let cleaned = trimmed
        .replace(/[|\\\/\[\]{}<>]/g, ' ')
        .replace(/[_=+~`^]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (cleaned.length > 2) {
        cleanLines.push(cleaned);
      }
    }
  }
  return cleanLines.join(' ').trim();
}

function groupWordsIntoBlocks(words) {
  if (!words || words.length === 0) return [];

  const sorted = words.slice().sort((a, b) => {
    if (Math.abs(a.bbox.y0 - b.bbox.y0) < 15) return a.bbox.x0 - b.bbox.x0;
    return a.bbox.y0 - b.bbox.y0;
  });

  const blocks = [];
  let currentBlock = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    const sameLine = Math.abs(curr.bbox.y0 - prev.bbox.y0) < 15;
    const closeHorizontally = curr.bbox.x0 - prev.bbox.x1 < 80;

    if (sameLine && closeHorizontally) {
      currentBlock.push(curr);
    } else {
      if (currentBlock.length > 0) blocks.push(currentBlock);
      currentBlock = [curr];
    }
  }
  if (currentBlock.length > 0) blocks.push(currentBlock);

  return blocks.map(words => {
    const x0 = Math.min(...words.map(w => w.bbox.x0)) - 5;
    const y0 = Math.min(...words.map(w => w.bbox.y0)) - 5;
    const x1 = Math.max(...words.map(w => w.bbox.x1)) + 5;
    const y1 = Math.max(...words.map(w => w.bbox.y1)) + 5;
    const text = words.map(w => w.text).join(' ');
    return { bbox: { x0, y0, x1, y1 }, text };
  });
}

function filterTextBlocks(blocks, imgWidth, imgHeight) {
  return blocks.filter(b => {
    const w = b.bbox.x1 - b.bbox.x0;
    const h = b.bbox.y1 - b.bbox.y0;

    if (w < 15 || h < 10) return false;

    if (w > imgWidth * 0.85) return false;

    if (h > w * 6) return false;

    if (b.text.trim().length < 2) return false;

    const aNum = (b.text.match(/[a-zA-Z0-9áéíóúñü.,!?¿¡'":;\-\s]/g) || []).length;
    if (aNum / b.text.length < 0.4) return false;

    return true;
  });
}

async function extractTextFromImages(imagePaths, onProgress) {
  const results = [];
  const total = imagePaths.length;

  console.log('\nIniciando OCR en ' + total + ' imagenes...');

  for (let i = 0; i < total; i++) {
    const imagePath = imagePaths[i];

    try {
      const metadata = await sharp(imagePath).metadata();
      const imgWidth = metadata.width;
      const imgHeight = metadata.height;

      const { data } = await Tesseract.recognize(imagePath, 'eng', {
        logger: () => {}
      });

      const cleanText = cleanOcrText(data.text);
      const blocks = groupWordsIntoBlocks(data.words);
      const textBlocks = filterTextBlocks(blocks, imgWidth, imgHeight);

      results.push({
        image: imagePath,
        text: cleanText,
        filename: path.basename(imagePath),
        textBlocks
      });
    } catch (error) {
      results.push({
        image: imagePath,
        text: '',
        filename: path.basename(imagePath),
        textBlocks: []
      });
    }

    if (onProgress) {
      onProgress(i + 1, total, path.basename(imagePath));
    }
  }

  console.log('\n');
  return results;
}

module.exports = { extractTextFromImages };
