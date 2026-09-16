const pptxgen = require('pptxgenjs');
const path = require('path');
const fs = require('fs');

async function generatePptx(images, translations, outputDir) {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'Descargador de Imagenes';
  pptx.title = 'Presentacion de Imagenes';

  for (let i = 0; i < images.length; i++) {
    const slide = pptx.addSlide();
    const imagePath = images[i];

    slide.background = { fill: '000000' };

    try {
      const imgData = fs.readFileSync(imagePath);
      const base64 = imgData.toString('base64');
      const ext = path.extname(imagePath).toLowerCase();
      const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';

      slide.addImage({
        data: 'data:' + contentType + ';base64,' + base64,
        x: 0,
        y: 0,
        w: '100%',
        h: '100%',
        sizing: { type: 'cover', w: '100%', h: '100%' }
      });
    } catch (err) {
      slide.addText('[Error: ' + path.basename(imagePath) + ']', {
        x: 1, y: 1, w: '80%', h: '40%',
        fontSize: 14, color: 'FF0000', align: 'center'
      });
    }

    slide.addText((i + 1) + '/' + images.length, {
      x: '92%', y: '95%', w: '6%', h: '4%',
      fontSize: 9, color: 'FFFFFF', align: 'center',
      transparency: 50
    });
  }

  const pptxPath = path.join(outputDir, 'presentacion.pptx');
  await pptx.writeFile({ fileName: pptxPath });
  console.log('PowerPoint generado: ' + pptxPath);
  return pptxPath;
}

module.exports = { generatePptx };
