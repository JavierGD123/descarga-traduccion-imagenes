const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

puppeteer.use(StealthPlugin());

const COMIC_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

async function scrapeImages(url, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    console.log('Navegando a la página...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

    // Esperar resolución de Cloudflare
    console.log('Esperando resolución de Cloudflare...');
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const title = await page.title();
      if (!title.includes('momento') && !title.includes('moment') && !title.includes('Checking')) {
        console.log('Página cargada:', title.substring(0, 60));
        break;
      }
    }

    // Scroll completo para activar lazy loading
    console.log('Cargando imágenes (scroll)...');
    await page.evaluate(async () => {
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const scrollHeight = document.body.scrollHeight;
      for (let pos = 0; pos < scrollHeight; pos += 400) {
        window.scrollTo(0, pos);
        await delay(200);
      }
      window.scrollTo(0, 0);
      await delay(500);
      for (let pos = 0; pos < scrollHeight; pos += 400) {
        window.scrollTo(0, pos);
        await delay(200);
      }
    });

    await new Promise(r => setTimeout(r, 3000));

    // ESTRATEGIA 1: Buscar imágenes con clase wp-manga-chapter-img (las páginas del comic)
    let imageUrls = await page.evaluate(() => {
      const urls = [];
      document.querySelectorAll('img.wp-manga-chapter-img').forEach(img => {
        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        if (src && !src.startsWith('data:')) urls.push(src);
      });
      return [...new Set(urls)];
    });

    console.log(`Estrategia 1 (clase wp-manga-chapter-img): ${imageUrls.length} imágenes`);

    // ESTRATEGIA 2: Si no se encontraron, buscar por tamaño (imágenes grandes)
    if (imageUrls.length === 0) {
      imageUrls = await page.evaluate(() => {
        const urls = [];
        document.querySelectorAll('img').forEach(img => {
          if (img.naturalWidth > 800 && img.naturalHeight > 400) {
            const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
            if (src && !src.startsWith('data:')) urls.push(src);
          }
        });
        return [...new Set(urls)];
      });
      console.log(`Estrategia 2 (imágenes grandes): ${imageUrls.length} imágenes`);
    }

    // ESTRATEGIA 3: Buscar todas las imágenes de CDN
    if (imageUrls.length === 0) {
      imageUrls = await page.evaluate(() => {
        const urls = [];
        document.querySelectorAll('img').forEach(img => {
          const src = img.src || img.getAttribute('data-src') || '';
          if (src.includes('cdn.') || src.includes('uploads/')) {
            urls.push(src);
          }
        });
        // También de srcset
        document.querySelectorAll('img').forEach(img => {
          const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
          if (srcset) {
            srcset.split(',').forEach(s => {
              const u = s.trim().split(' ')[0];
              if (u && (u.includes('cdn.') || u.includes('uploads/'))) urls.push(u);
            });
          }
        });
        return [...new Set(urls)];
      });
      console.log(`Estrategia 3 (CDN): ${imageUrls.length} imágenes`);
    }

    if (imageUrls.length === 0) {
      console.log('No se encontraron imágenes con ninguna estrategia');
      return [];
    }

    console.log(`\nDescargando ${imageUrls.length} imágenes...`);

    // Descargar imágenes
    const downloadedImages = [];
    for (let i = 0; i < imageUrls.length; i++) {
      try {
        let imgUrl = imageUrls[i];

        // Resolver URLs relativas
        if (imgUrl.startsWith('//')) {
          imgUrl = 'https:' + imgUrl;
        } else if (imgUrl.startsWith('/')) {
          const baseUrl = new URL(url);
          imgUrl = baseUrl.origin + imgUrl;
        }

        if (!imgUrl.startsWith('http')) continue;

        const response = await axios.get(imgUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': url,
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
          },
          maxRedirects: 5
        });

        const data = Buffer.from(response.data);
        if (data.length < 5000) continue; // Skip tiny files

        // Determinar extensión
        const contentType = response.headers['content-type'] || '';
        let ext = '.jpg';
        if (contentType.includes('png')) ext = '.png';
        else if (contentType.includes('webp')) ext = '.webp';
        else {
          const urlExt = path.extname(new URL(imgUrl).pathname).toLowerCase();
          if (COMIC_EXTENSIONS.includes(urlExt)) ext = urlExt;
        }

        const count = downloadedImages.length + 1;
        const filename = `page_${String(count).padStart(3, '0')}${ext}`;
        const filepath = path.join(outputDir, filename);
        fs.writeFileSync(filepath, data);
        downloadedImages.push(filepath);
        console.log(`[${count}/${imageUrls.length}] ${filename} (${(data.length / 1024).toFixed(0)}KB)`);
      } catch (err) {
        console.log(`Error descargando imagen ${i + 1}: ${err.message}`);
      }
    }

    console.log(`\nTotal imágenes descargadas: ${downloadedImages.length}`);
    return downloadedImages;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeImages };
