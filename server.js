const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { scrapeImages } = require('./src/scraper');
const { extractTextFromImages } = require('./src/ocr');
const { translateTexts } = require('./src/translator');
const { editMultipleImages } = require('./src/imageEditor');
const { generatePptx } = require('./src/pptx');
const { generatePdf } = require('./src/pdf');
const {
  downloadVideo, extractAudio, transcribeAudio,
  translateSrt, embedSubtitles, parseSrt, srtToVtt, detectLanguage
} = require('./src/subtitle');

const app = express();
const PORT = 3003;
const TEMP_DIR = path.join(__dirname, 'temp');
const SAVED_DIR = path.join(__dirname, 'saved');

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(SAVED_DIR, { recursive: true });

const sseClients = new Map();

function createSSE(jobId, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(':\n\n');
  sseClients.set(jobId, res);
  res.on('close', () => sseClients.delete(jobId));
}

function sendProgress(jobId, step, total, message, detail) {
  const client = sseClients.get(jobId);
  const payload = JSON.stringify({ step, total, message, detail: detail || '' });
  console.log('[' + jobId + '] ' + step + '/' + total + ': ' + message + (detail ? ' (' + detail + ')' : ''));
  if (client) {
    client.write('data: ' + payload + '\n\n');
  }
}

function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (/mp4|mkv|avi|mov|webm|flv|wmv/.test(ext)) cb(null, true);
    else cb(new Error('Formato no soportado'));
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/files', express.static(SAVED_DIR));

function cleanTemp() {
  if (fs.existsSync(TEMP_DIR)) {
    fs.readdirSync(TEMP_DIR).forEach(f => {
      try { fs.rmSync(path.join(TEMP_DIR, f), { recursive: true, force: true }); } catch(e) {}
    });
  }
}
cleanTemp();

app.get('/api/progress/:jobId', (req, res) => {
  createSSE(req.params.jobId, res);
});

// ========== IMAGENES ==========
app.post('/api/process', async (req, res) => {
  const { url, saveFiles, clientId } = req.body;
  if (!url) return res.status(400).json({ error: 'URL es requerida' });

  const jobId = clientId || ('job_' + Date.now());
  const workDir = path.join(TEMP_DIR, jobId);
  const editedDir = path.join(workDir, 'edited');
  fs.mkdirSync(editedDir, { recursive: true });
  const TOTAL = 6;

  try {
    await waitMs(500);
    sendProgress(jobId, 1, TOTAL, 'Conectando con la pagina web...');
    const images = await scrapeImages(url, workDir);
    if (images.length === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      return res.status(404).json({ error: 'No se encontraron imagenes' });
    }

    sendProgress(jobId, 2, TOTAL, 'Leyendo texto de ' + images.length + ' imagenes (OCR)...');
    const ocrResults = await extractTextFromImages(images, (i, total, filename) => {
      sendProgress(jobId, 2, TOTAL, 'OCR: imagen ' + i + ' de ' + total, filename);
    });
    const withText = ocrResults.filter(r => r.text.length > 0).length;

    sendProgress(jobId, 3, TOTAL, 'Traduciendo ' + withText + ' imagenes con texto...');
    const translatedResults = await translateTexts(ocrResults, (i, total, filename) => {
      sendProgress(jobId, 3, TOTAL, 'Traduccion: imagen ' + i + ' de ' + total, filename);
    });
    const translated = translatedResults.filter(r => r.originalText !== r.translatedText).length;

    sendProgress(jobId, 4, TOTAL, 'Editando imagenes: borrando ingles, agregando espanol...');
    const editedResults = await editMultipleImages(ocrResults, translatedResults, editedDir, (i, total, filename) => {
      sendProgress(jobId, 4, TOTAL, 'Edicion: imagen ' + i + ' de ' + total, filename);
    });

    const editedImages = editedResults.map(r => r.editedPath);
    const totalEdits = editedResults.reduce((sum, r) => sum + (r.count || 0), 0);

    sendProgress(jobId, 5, TOTAL, 'Generando PowerPoint con ' + images.length + ' paginas...');
    await generatePptx(editedImages, translatedResults, workDir);

    sendProgress(jobId, 6, TOTAL, 'Generando PDF...');
    await generatePdf(editedImages, translatedResults, workDir);

    const finalDir = path.join(SAVED_DIR, jobId);
    fs.mkdirSync(finalDir, { recursive: true });

    if (saveFiles) {
      fs.cpSync(workDir, finalDir, { recursive: true });
    } else {
      fs.copyFileSync(path.join(workDir, 'presentacion.pptx'), path.join(finalDir, 'presentacion.pptx'));
      fs.copyFileSync(path.join(workDir, 'presentacion.pdf'), path.join(finalDir, 'presentacion.pdf'));

      fs.mkdirSync(path.join(finalDir, 'edited'), { recursive: true });
      for (const f of fs.readdirSync(editedDir)) {
        fs.copyFileSync(path.join(editedDir, f), path.join(finalDir, 'edited', f));
      }

      fs.mkdirSync(path.join(finalDir, 'originals'), { recursive: true });
      for (const img of images) {
        const fname = path.basename(img);
        const src = path.join(workDir, fname);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(finalDir, 'originals', fname));
        }
      }
    }

    fs.rmSync(workDir, { recursive: true, force: true });
    if (!saveFiles) {
      setTimeout(() => { try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch(e) {} }, 10 * 60 * 1000);
    }

    sendProgress(jobId, TOTAL, TOTAL, 'Listo! ' + images.length + ' imagenes, ' + totalEdits + ' textos traducidos en imagenes');

    const originalUrls = images.map(f => '/files/' + jobId + '/originals/' + path.basename(f));
    const editedUrls = images.map(f => '/files/' + jobId + '/edited/edited_' + path.basename(f));

    res.json({
      success: true, jobId, imageCount: images.length,
      pptxUrl: '/files/' + jobId + '/presentacion.pptx',
      pdfUrl: '/files/' + jobId + '/presentacion.pdf',
      translations: translatedResults,
      originalImages: originalUrls,
      editedImages: editedUrls,
      editCount: totalEdits
    });
  } catch (error) {
    console.error('Error:', error);
    sendProgress(jobId, 0, TOTAL, 'Error: ' + error.message);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/regenerate/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { useEdited } = req.body;
  const workDir = path.join(SAVED_DIR, jobId);

  if (!fs.existsSync(workDir)) return res.status(404).json({ error: 'Job no encontrado' });

  try {
    const editedDir = path.join(workDir, 'edited');
    const origDir = path.join(workDir, 'originals');
    const hasEdited = fs.existsSync(editedDir);

    let images;
    if (useEdited && hasEdited) {
      images = fs.readdirSync(editedDir)
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .map(f => path.join(editedDir, f));
    } else {
      images = fs.readdirSync(origDir)
        .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
        .map(f => path.join(origDir, f));
    }

    if (images.length === 0) return res.status(404).json({ error: 'No hay imagenes' });

    const dummyTranslations = images.map(img => ({
      image: img,
      filename: path.basename(img),
      originalText: '',
      translatedText: ''
    }));

    await generatePptx(images, dummyTranslations, workDir);
    await generatePdf(images, dummyTranslations, workDir);

    res.json({
      success: true,
      pptxUrl: '/files/' + jobId + '/presentacion.pptx',
      pdfUrl: '/files/' + jobId + '/presentacion.pdf'
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== SUBTITULOS ==========

app.post('/api/subtitle/download', async (req, res) => {
  const { url, clientId } = req.body;
  if (!url) return res.status(400).json({ error: 'URL es requerida' });

  const jobId = clientId || ('sub_' + Date.now());
  const workDir = path.join(TEMP_DIR, jobId);

  try {
    fs.mkdirSync(workDir, { recursive: true });
    sendProgress(jobId, 1, 2, 'Descargando video desde URL...');
    const videoPath = await downloadVideo(url, workDir);
    sendProgress(jobId, 2, 2, 'Video descargado');

    const videoFiles = fs.readdirSync(workDir).filter(f => /^video\.\w+$/.test(f));
    const videoUrl = '/api/video/' + jobId;

    res.json({ success: true, jobId, videoUrl, filename: videoFiles[0] || 'video.mp4' });
  } catch (error) {
    console.error('Error:', error);
    sendProgress(jobId, 0, 2, 'Error: ' + error.message);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/subtitle/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subio ningun archivo' });

  const jobId = req.body.clientId || ('sub_' + Date.now());
  const workDir = path.join(TEMP_DIR, jobId);

  try {
    fs.mkdirSync(workDir, { recursive: true });
    const ext = path.extname(req.file.originalname) || '.mp4';
    const videoPath = path.join(workDir, 'video' + ext);
    fs.renameSync(req.file.path, videoPath);

    const videoUrl = '/api/video/' + jobId;
    res.json({ success: true, jobId, videoUrl, filename: req.file.originalname });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/video/:jobId', (req, res) => {
  const { jobId } = req.params;
  const workDir = path.join(TEMP_DIR, jobId);
  const savedDir = path.join(SAVED_DIR, jobId);

  let dir = workDir;
  if (!fs.existsSync(dir)) dir = savedDir;
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Video no encontrado' });

  const videoFiles = fs.readdirSync(dir).filter(f => /^video\.\w+$/.test(f));
  if (videoFiles.length === 0) return res.status(404).json({ error: 'Video no encontrado' });

  const videoPath = path.join(dir, videoFiles[0]);
  const stat = fs.statSync(videoPath);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    const file = fs.createReadStream(videoPath, { start, end });
    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4'
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'video/mp4'
    });
    fs.createReadStream(videoPath).pipe(res);
  }
});

app.post('/api/subtitle/generate', async (req, res) => {
  const { jobId, engine } = req.body;
  if (!jobId) return res.status(400).json({ error: 'jobId es requerido' });

  const workDir = path.join(TEMP_DIR, jobId);
  if (!fs.existsSync(workDir)) return res.status(404).json({ error: 'Job no encontrado' });

  const TOTAL = 3;

  try {
    sendProgress(jobId, 1, TOTAL, 'Extrayendo audio del video...');
    const videoFiles = fs.readdirSync(workDir).filter(f => /^video\.\w+$/.test(f));
    if (videoFiles.length === 0) throw new Error('No se encontro el video');
    const audioPath = await extractAudio(path.join(workDir, videoFiles[0]), workDir);

    const engineName = engine === 'vosk' ? 'LibVosk' : 'Whisper';
    sendProgress(jobId, 2, TOTAL, 'Transcribiendo con ' + engineName + '...');
    const srtContent = await transcribeAudio(audioPath, engine);

    const entries = parseSrt(srtContent);
    const detectedLang = detectLanguage(srtContent);

    fs.writeFileSync(path.join(workDir, 'subtitles.srt'), srtContent, 'utf8');

    sendProgress(jobId, 3, TOTAL, 'Subtitulos generados: ' + entries.length + ' bloques');

    res.json({
      success: true, jobId, detectedLang,
      subtitleCount: entries.length,
      srtContent
    });
  } catch (error) {
    console.error('Error:', error);
    sendProgress(jobId, 0, TOTAL, 'Error: ' + error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/subtitle/translate', async (req, res) => {
  const { jobId, srtContent, targetLang } = req.body;
  if (!jobId || !srtContent) return res.status(400).json({ error: 'Datos requeridos' });

  const workDir = path.join(TEMP_DIR, jobId);
  const TOTAL = 2;

  try {
    sendProgress(jobId, 1, TOTAL, 'Traduciendo subtitulos...');
    const finalSrt = await translateSrt(srtContent, targetLang || 'es');

    fs.writeFileSync(path.join(workDir, 'translated.srt'), finalSrt, 'utf8');

    sendProgress(jobId, 2, TOTAL, 'Traduccion completada');

    res.json({
      success: true, jobId,
      srtContent: finalSrt,
      translatedSrtUrl: '/api/srt/' + jobId + '/translated',
      originalSrtUrl: '/api/srt/' + jobId + '/original'
    });
  } catch (error) {
    console.error('Error:', error);
    sendProgress(jobId, 0, TOTAL, 'Error: ' + error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/srt/:jobId/:type', (req, res) => {
  const { jobId, type } = req.params;

  let dir = path.join(TEMP_DIR, jobId);
  let file = type === 'translated' ? 'translated.srt' : 'subtitles.srt';

  if (!fs.existsSync(path.join(dir, file))) {
    dir = path.join(SAVED_DIR, jobId);
  }

  const srtPath = path.join(dir, file);
  if (!fs.existsSync(srtPath)) return res.status(404).json({ error: 'SRT no encontrado' });

  res.type('text/srt').send(fs.readFileSync(srtPath, 'utf8'));
});

app.get('/api/vtt/:jobId/:type', (req, res) => {
  const { jobId, type } = req.params;

  let dir = path.join(TEMP_DIR, jobId);
  let file = type === 'translated' ? 'translated.srt' : 'subtitles.srt';

  if (!fs.existsSync(path.join(dir, file))) {
    dir = path.join(SAVED_DIR, jobId);
  }

  const srtPath = path.join(dir, file);
  if (!fs.existsSync(srtPath)) return res.status(404).json({ error: 'SRT no encontrado' });

  const srtContent = fs.readFileSync(srtPath, 'utf8');
  const vttContent = srtToVtt(srtContent);

  res.type('text/vtt').send(vttContent);
});

app.get('/api/subtitle/export-video/:jobId/:srtType', async (req, res) => {
  const { jobId, srtType } = req.params;
  const workDir = path.join(TEMP_DIR, jobId);

  if (!fs.existsSync(workDir)) return res.status(404).json({ error: 'Job no encontrado' });

  try {
    const videoFiles = fs.readdirSync(workDir).filter(f => /^video\.\w+$/.test(f));
    if (videoFiles.length === 0) return res.status(404).json({ error: 'Video no encontrado' });

    const srtFile = srtType === 'translated' ? 'translated.srt' : 'subtitles.srt';
    const srtPath = path.join(workDir, srtFile);
    if (!fs.existsSync(srtPath)) return res.status(404).json({ error: 'SRT no encontrado' });

    const outputPath = path.join(workDir, 'video_subtitled_' + srtType + '.mp4');

    fs.copyFileSync(srtPath, path.join(workDir, 'subs.srt'));

    await embedSubtitles(path.join(workDir, videoFiles[0]), fs.readFileSync(srtPath, 'utf8'), workDir);

    const finalDir = path.join(SAVED_DIR, jobId);
    fs.mkdirSync(finalDir, { recursive: true });
    fs.copyFileSync(path.join(workDir, 'video_subtitled.mp4'), path.join(finalDir, 'video_subtitled_' + srtType + '.mp4'));

    res.json({
      success: true,
      videoUrl: '/files/' + jobId + '/video_subtitled_' + srtType + '.mp4'
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/subtitle/export-srt/:jobId/:srtType', (req, res) => {
  const { jobId, srtType } = req.params;

  let dir = path.join(TEMP_DIR, jobId);
  let file = srtType === 'translated' ? 'translated.srt' : 'subtitles.srt';

  if (!fs.existsSync(path.join(dir, file))) {
    dir = path.join(SAVED_DIR, jobId);
  }

  const srtPath = path.join(dir, file);
  if (!fs.existsSync(srtPath)) return res.status(404).json({ error: 'SRT no encontrado' });

  const filename = srtType === 'translated' ? 'subtitulos_traducidos.srt' : 'subtitulos_originales.srt';
  res.download(srtPath, filename);
});

app.get('/api/subtitle/export-vtt/:jobId/:srtType', (req, res) => {
  const { jobId, srtType } = req.params;

  let dir = path.join(TEMP_DIR, jobId);
  let file = srtType === 'translated' ? 'translated.srt' : 'subtitles.srt';

  if (!fs.existsSync(path.join(dir, file))) {
    dir = path.join(SAVED_DIR, jobId);
  }

  const srtPath = path.join(dir, file);
  if (!fs.existsSync(srtPath)) return res.status(404).json({ error: 'SRT no encontrado' });

  const srtContent = fs.readFileSync(srtPath, 'utf8');
  const vttContent = srtToVtt(srtContent);

  const filename = srtType === 'translated' ? 'subtitulos_traducidos.vtt' : 'subtitulos_originales.vtt';
  res.setHeader('Content-Type', 'text/vtt');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(vttContent);
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log('\nServidor: http://localhost:' + PORT + '\n');
});
