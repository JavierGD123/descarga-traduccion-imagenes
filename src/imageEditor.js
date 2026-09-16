const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

async function getBackgroundColor(imagePath, bbox, imgWidth, imgHeight) {
  const pad = 25;
  const samples = [];

  const points = [
    [Math.max(0, bbox.x0 - pad), Math.max(0, bbox.y0 - pad)],
    [Math.min(imgWidth - 1, bbox.x1 + pad), Math.max(0, bbox.y0 - pad)],
    [Math.max(0, bbox.x0 - pad), Math.min(imgHeight - 1, bbox.y1 + pad)],
    [Math.min(imgWidth - 1, bbox.x1 + pad), Math.min(imgHeight - 1, bbox.y1 + pad)],
    [Math.max(0, bbox.x0 - pad), Math.round((bbox.y0 + bbox.y1) / 2)],
    [Math.min(imgWidth - 1, bbox.x1 + pad), Math.round((bbox.y0 + bbox.y1) / 2)],
    [Math.round((bbox.x0 + bbox.x1) / 2), Math.max(0, bbox.y0 - pad)],
    [Math.round((bbox.x0 + bbox.x1) / 2), Math.min(imgHeight - 1, bbox.y1 + pad)],
    [Math.max(0, bbox.x0 - pad * 2), Math.max(0, bbox.y0 - pad * 2)],
    [Math.min(imgWidth - 1, bbox.x1 + pad * 2), Math.max(0, bbox.y0 - pad * 2)],
    [Math.max(0, bbox.x0 - pad * 2), Math.min(imgHeight - 1, bbox.y1 + pad * 2)],
    [Math.min(imgWidth - 1, bbox.x1 + pad * 2), Math.min(imgHeight - 1, bbox.y1 + pad * 2)],
  ];

  for (const [px, py] of points) {
    try {
      const { data } = await sharp(imagePath)
        .raw()
        .extract({ left: px, top: py, width: 1, height: 1 })
        .toBuffer({ resolveWithObject: true });
      if (data.length >= 3) {
        samples.push([data[0], data[1], data[2]]);
      }
    } catch (e) {}
  }

  if (samples.length === 0) return { r: 255, g: 255, b: 255 };

  const whiteCount = samples.filter(s => s[0] > 220 && s[1] > 220 && s[2] > 220).length;
  if (whiteCount > samples.length * 0.5) {
    return { r: 255, g: 255, b: 255 };
  }

  const blackCount = samples.filter(s => s[0] < 50 && s[1] < 50 && s[2] < 50).length;
  if (blackCount > samples.length * 0.5) {
    return { r: 0, g: 0, b: 0 };
  }

  const avg = [0, 0, 0];
  for (const s of samples) {
    avg[0] += s[0];
    avg[1] += s[1];
    avg[2] += s[2];
  }
  return {
    r: Math.round(avg[0] / samples.length),
    g: Math.round(avg[1] / samples.length),
    b: Math.round(avg[2] / samples.length)
  };
}

function isLightColor(bg) {
  return (bg.r * 0.299 + bg.g * 0.587 + bg.b * 0.114) > 128;
}

function wrapText(text, maxWidth, fontSize) {
  const avgCharWidth = fontSize * 0.52;
  const maxChars = Math.max(5, Math.floor(maxWidth / avgCharWidth));
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    if (testLine.length > maxChars && currentLine.length > 0) {
      lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine.trim().length > 0) lines.push(currentLine.trim());
  return lines;
}

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function editImage(imagePath, blockTranslations, outputDir) {
  const metadata = await sharp(imagePath).metadata();
  const imgWidth = metadata.width;
  const imgHeight = metadata.height;

  if (!blockTranslations || blockTranslations.length === 0) {
    const outName = 'edited_' + path.basename(imagePath);
    const outPath = path.join(outputDir, outName);
    await sharp(imagePath).png().toFile(outPath);
    return { editedPath: outPath, edited: false, count: 0 };
  }

  const overlays = [];
  const MAX_LINES = 4;

  for (const bt of blockTranslations) {
    const bbox = bt.bbox;
    const translated = bt.translated;
    const padX = 20;
    const padY = 18;
    const rx = Math.max(0, bbox.x0 - padX);
    const ry = Math.max(0, bbox.y0 - padY);
    const rw = Math.min(imgWidth, bbox.x1 + padX) - rx;
    const rh = Math.min(imgHeight, bbox.y1 + padY) - ry;

    if (rw < 10 || rh < 8) continue;

    const bgColor = await getBackgroundColor(imagePath, bbox, imgWidth, imgHeight);

    const rectSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + rw + '" height="' + rh + '"><rect width="' + rw + '" height="' + rh + '" fill="rgb(' + bgColor.r + ',' + bgColor.g + ',' + bgColor.b + ')"/></svg>';

    overlays.push({
      input: Buffer.from(rectSvg),
      left: rx,
      top: ry
    });

    const textAreaW = rw - 8;
    const textAreaH = rh - 4;
    let fontSize = Math.max(10, Math.min(22, Math.round(textAreaH * 0.65)));
    let lines = wrapText(translated, textAreaW, fontSize);

    while (lines.length > MAX_LINES && fontSize > 8) {
      fontSize -= 1;
      lines = wrapText(translated, textAreaW, fontSize);
    }

    const lineHeight = fontSize * 1.25;
    const totalTextH = lines.length * lineHeight;
    const startY = ry + (rh - totalTextH) / 2 + fontSize * 0.9;

    const textColor = isLightColor(bgColor) ? 'black' : 'white';

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const charWidth = fontSize * 0.52;
      const textWidth = line.length * charWidth;

      const tLeft = Math.max(0, Math.round(rx + (rw - textWidth) / 2));
      const tTop = Math.max(0, Math.round(startY + idx * lineHeight - fontSize));

      const svgW = Math.min(Math.ceil(textWidth) + 8, imgWidth - tLeft);
      const svgH = fontSize + 8;

      if (svgW < 10 || svgH < 5) continue;

      const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="' + svgW + '" height="' + svgH + '"><text x="' + (svgW / 2) + '" y="' + (fontSize + 2) + '" font-size="' + fontSize + '" font-family="Arial, Helvetica, sans-serif" font-weight="bold" fill="' + textColor + '" text-anchor="middle">' + escapeXml(line) + '</text></svg>';

      overlays.push({
        input: Buffer.from(svgText),
        left: tLeft,
        top: tTop
      });
    }
  }

  if (overlays.length === 0) {
    const outName = 'edited_' + path.basename(imagePath);
    const outPath = path.join(outputDir, outName);
    await sharp(imagePath).png().toFile(outPath);
    return { editedPath: outPath, edited: false, count: 0 };
  }

  const outName = 'edited_' + path.basename(imagePath);
  const outPath = path.join(outputDir, outName);

  await sharp(imagePath)
    .composite(overlays)
    .png()
    .toFile(outPath);

  return { editedPath: outPath, edited: true, count: blockTranslations.length };
}

async function editMultipleImages(ocrResults, translations, outputDir, onProgress) {
  const results = [];
  fs.mkdirSync(outputDir, { recursive: true });

  for (let i = 0; i < ocrResults.length; i++) {
    const ocr = ocrResults[i];
    const trans = translations.find(t => t.filename === ocr.filename);

    if (!trans || !trans.blockTranslations || trans.blockTranslations.length === 0) {
      const outName = 'edited_' + ocr.filename;
      const outPath = path.join(outputDir, outName);
      try {
        await sharp(ocr.image).png().toFile(outPath);
      } catch(e) {}
      results.push({
        image: ocr.image,
        filename: ocr.filename,
        editedPath: outPath,
        edited: false,
        count: 0
      });
    } else {
      const result = await editImage(ocr.image, trans.blockTranslations, outputDir);
      results.push({
        image: ocr.image,
        filename: ocr.filename,
        editedPath: result.editedPath,
        edited: result.edited,
        count: result.count
      });
    }

    if (onProgress) {
      onProgress(i + 1, ocrResults.length, ocr.filename);
    }
  }
  return results;
}

module.exports = { editImage, editMultipleImages };
