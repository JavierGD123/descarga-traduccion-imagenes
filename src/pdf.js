const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

async function generatePdf(images, translations, outputDir) {
  return new Promise((resolve, reject) => {
    const pdfPath = path.join(outputDir, 'presentacion.pdf');
    const doc = new PDFDocument({
      size: 'letter',
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      info: {
        Title: 'Presentacion de Imagenes',
        Author: 'Descargador de Imagenes'
      }
    });

    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    const PW = doc.page.width;
    const PH = doc.page.height;

    for (let i = 0; i < images.length; i++) {
      if (i > 0) doc.addPage();

      const imagePath = images[i];

      try {
        doc.image(imagePath, 0, 0, {
          width: PW,
          height: PH,
          align: 'center',
          valign: 'center'
        });
      } catch (err) {
        doc.fontSize(12)
           .fillColor('#FF0000')
           .text('Error cargando imagen: ' + path.basename(imagePath), 50, 50);
      }

      doc.fontSize(8)
         .fillColor('#FFFFFF')
         .text((i + 1) + ' / ' + images.length, PW - 60, PH - 25, {
           width: 50,
           align: 'right'
         });
    }

    doc.end();
    stream.on('finish', () => {
      console.log('PDF generado: ' + pdfPath);
      resolve(pdfPath);
    });
    stream.on('error', reject);
  });
}

module.exports = { generatePdf };
