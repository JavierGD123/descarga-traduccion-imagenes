const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { scrapeImages } = require('./src/scraper');
const { extractTextFromImages } = require('./src/ocr');
const { translateTexts } = require('./src/translator');
const { editMultipleImages } = require('./src/imageEditor');
const { translateFolder } = require('./src/ballons');
const { generatePptx } = require('./src/pptx');
const { generatePdf } = require('./src/pdf');
const {
  downloadVideo, extractVideoUrls, extractAudio, transcribeAudio,
  translateSrt, embedSubtitles, parseSrt, srtToVtt, detectLanguage,
  initDownloadState, updateDownloadState, getDownloadState, cancelDownload
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

function sendProgress(jobId, step, total, message, detail, extra) {
  const client = sseClients.get(jobId);
  const payload = JSON.stringify({ step, total, message, detail: detail || '', extra: extra || null });
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
app.use('/temp', express.static(TEMP_DIR));

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

// ========== TRADUCCION POR LOTES ==========
const BATCH_SIZE = 5;
const batchSessions = new Map();

function pruneBatchSessions() {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [id, s] of batchSessions) {
    if (s.startedAt < cutoff) {
      batchSessions.delete(id);
      try { fs.rmSync(s.workDir, { recursive: true, force: true }); } catch(e) {}
    }
  }
}

function batchPayload(s) {
  const processed = s.cursor;
  return {
    success: true,
    batchPending: true,
    jobId: s.jobId,
    imageCount: processed,
    totalImages: s.images.length,
    processed,
    remaining: s.images.length - processed,
    batchNumber: s.batchNumber,
    batchSize: BATCH_SIZE,
    editCount: s.totalEdits,
    pendingTranslations: s.pendingTranslations || 0,
    translations: s.translatedResults.slice(),
    originalImages: s.images.slice(0, processed).map(f => '/temp/' + s.jobId + '/' + path.basename(f)),
    editedImages: s.editedImages.map(f => '/temp/' + s.jobId + '/edited/' + path.basename(f))
  };
}

async function processBatch(s, start, end) {
  const batchImages = s.images.slice(start, end);
  const n = s.batchNumber + 1;
  const TOTAL = s.useBallons ? 5 : 6;
  sendProgress(s.jobId, 1, TOTAL, 'Lote ' + n + ': traduciendo ' + batchImages.length + ' imagenes (' + (start + 1) + '-' + end + ' de ' + s.images.length + ')...');

  if (s.useBallons) {
    const batchDir = path.join(s.workDir, '_batch_' + n);
    fs.rmSync(batchDir, { recursive: true, force: true });
    fs.mkdirSync(batchDir, { recursive: true });
    for (const img of batchImages) {
      fs.copyFileSync(img, path.join(batchDir, path.basename(img)));
    }

    const bt = await translateFolder(batchDir, s.langName, (info) => {
      if (info && info.log) {
        sendProgress(s.jobId, 2, TOTAL, 'BallonsTranslator (lote ' + n + ')', String(info.log).slice(-120));
        return;
      }
      if (info && info.progress != null) {
        const pct = Math.round(info.progress * 100);
        sendProgress(s.jobId, 2, TOTAL, 'BallonsTranslator: ' + pct + '%', (info.stage || '') + ' · lote ' + n);
      }
    }, s.translator);
    if (!bt.rendered || bt.rendered.length === 0) {
      throw new Error('BallonsTranslator no exporto imagenes en el lote ' + n);
    }
    s.pendingTranslations += (bt.pendingTranslations || 0);
    const byName = new Map(batchImages.map(b => [path.parse(path.basename(b)).name, b]));
    let order = 0;
    for (const r of bt.rendered) {
      const idx = s.editedImages.length + 1;
      const ext = path.extname(r.file) || '.png';
      const dest = path.join(s.editedDir, 'edited_' + String(idx).padStart(3, '0') + ext);
      fs.copyFileSync(r.file, dest);
      s.editedImages.push(dest);
      const orig = byName.get(path.parse(r.page).name) || batchImages[Math.min(order, batchImages.length - 1)];
      order++;
      s.translatedResults.push({
        image: orig,
        filename: path.basename(orig),
        originalText: r.originalText || '',
        translatedText: r.translatedText || ''
      });
      s.totalEdits += (r.translatedBlocks || 0);
    }
    try { fs.rmSync(batchDir, { recursive: true, force: true }); } catch(e) {}
  } else {
    const ocrResults = await extractTextFromImages(batchImages, (i, total, filename) => {
      sendProgress(s.jobId, 2, TOTAL, 'OCR (lote ' + n + '): imagen ' + (start + i + 1) + ' de ' + s.images.length, filename);
    });
    const translatedResults = await translateTexts(ocrResults, (i, total, filename) => {
      sendProgress(s.jobId, 3, TOTAL, 'Traduccion (lote ' + n + '): imagen ' + (start + i + 1) + ' de ' + s.images.length, filename);
    }, { provider: s.translator, targetLang: s.langName });
    const editedResults = await editMultipleImages(ocrResults, translatedResults, s.editedDir, (i, total, filename) => {
      sendProgress(s.jobId, 4, TOTAL, 'Edicion (lote ' + n + '): imagen ' + (start + i + 1) + ' de ' + s.images.length, filename, {
        original: '/temp/' + s.jobId + '/' + filename,
        edited: '/temp/' + s.jobId + '/edited/edited_' + filename,
        filename: filename,
        index: start + i + 1,
        total: s.images.length
      });
    });
    for (const t of translatedResults) s.translatedResults.push(t);
    for (const r of editedResults) s.editedImages.push(r.editedPath);
    s.totalEdits += editedResults.reduce((sum, r) => sum + (r.count || 0), 0);
  }

  s.cursor = end;
  s.batchNumber = n;
}

async function finalizeSession(s) {
  const TOTAL = s.useBallons ? 5 : 6;
  const pptxStep = s.useBallons ? 3 : 5;
  const pdfStep = s.useBallons ? 4 : 6;
  const processed = s.cursor;

  if (processed === 0) throw new Error('No hay imagenes traducidas para finalizar');

  sendProgress(s.jobId, pptxStep, TOTAL, 'Generando PowerPoint con ' + processed + ' paginas...');
  await generatePptx(s.editedImages, s.translatedResults, s.workDir);
  sendProgress(s.jobId, pdfStep, TOTAL, 'Generando PDF...');
  await generatePdf(s.editedImages, s.translatedResults, s.workDir);

  const finalDir = path.join(SAVED_DIR, s.jobId);
  fs.mkdirSync(finalDir, { recursive: true });

  if (s.saveFiles) {
    fs.cpSync(s.workDir, finalDir, { recursive: true });
  } else {
    fs.copyFileSync(path.join(s.workDir, 'presentacion.pptx'), path.join(finalDir, 'presentacion.pptx'));
    fs.copyFileSync(path.join(s.workDir, 'presentacion.pdf'), path.join(finalDir, 'presentacion.pdf'));
    fs.mkdirSync(path.join(finalDir, 'edited'), { recursive: true });
    for (const f of fs.readdirSync(s.editedDir)) {
      fs.copyFileSync(path.join(s.editedDir, f), path.join(finalDir, 'edited', f));
    }
  }
  fs.mkdirSync(path.join(finalDir, 'originals'), { recursive: true });
  for (const img of s.images.slice(0, processed)) {
    const fname = path.basename(img);
    const src = path.join(s.workDir, fname);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(finalDir, 'originals', fname));
  }

  fs.rmSync(s.workDir, { recursive: true, force: true });
  if (!s.saveFiles) {
    setTimeout(() => { try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch(e) {} }, 10 * 60 * 1000);
  }
  batchSessions.delete(s.jobId);

  const stoppedEarly = processed < s.images.length;
  sendProgress(s.jobId, TOTAL, TOTAL, 'Listo! ' + processed + ' imagenes, ' + s.totalEdits + ' textos traducidos' + (stoppedEarly ? ' (proceso detenido antes del final)' : ''));

  return {
    success: true,
    jobId: s.jobId,
    imageCount: processed,
    totalImages: s.images.length,
    stoppedEarly,
    pendingTranslations: s.pendingTranslations || 0,
    pptxUrl: '/files/' + s.jobId + '/presentacion.pptx',
    pdfUrl: '/files/' + s.jobId + '/presentacion.pdf',
    translations: s.translatedResults,
    originalImages: s.images.slice(0, processed).map(f => '/files/' + s.jobId + '/originals/' + path.basename(f)),
    editedImages: s.editedImages.map(f => '/files/' + s.jobId + '/edited/' + path.basename(f)),
    editCount: s.totalEdits
  };
}

// ========== IMAGENES ==========
app.post('/api/process', async (req, res) => {
  const { url, saveFiles, clientId, engine, targetLang, translator } = req.body;
  if (!url) return res.status(400).json({ error: 'URL es requerida' });

  const jobId = clientId || ('job_' + Date.now());
  const workDir = path.join(TEMP_DIR, jobId);
  const editedDir = path.join(workDir, 'edited');
  fs.mkdirSync(editedDir, { recursive: true });
  const useBallons = engine !== 'legacy';
  const TOTAL = useBallons ? 5 : 6;
  pruneBatchSessions();

  const session = {
    jobId, workDir, editedDir, images: [], cursor: 0, batchNumber: 0,
    langName: targetLang || 'es', saveFiles: !!saveFiles, useBallons,
    translator: translator === 'meta' ? 'meta' : 'google',
    editedImages: [], translatedResults: [], totalEdits: 0, pendingTranslations: 0, startedAt: Date.now()
  };
  batchSessions.set(jobId, session);

  try {
    await waitMs(500);
    sendProgress(jobId, 1, TOTAL, 'Conectando con la pagina web...');
    const images = await scrapeImages(url, workDir);
    if (images.length === 0) {
      fs.rmSync(workDir, { recursive: true, force: true });
      batchSessions.delete(jobId);
      return res.status(404).json({ error: 'No se encontraron imagenes' });
    }
    session.images = images;

    const firstBatch = Math.min(BATCH_SIZE, images.length);
    await processBatch(session, 0, firstBatch);

    if (session.cursor >= images.length) {
      return res.json(await finalizeSession(session));
    }
    return res.json(batchPayload(session));
  } catch (error) {
    console.error('Error:', error);
    sendProgress(jobId, 0, TOTAL, 'Error: ' + error.message);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e) {}
    batchSessions.delete(jobId);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/batch/:jobId/action', async (req, res) => {
  const { jobId } = req.params;
  const action = (req.body && req.body.action) || '';
  pruneBatchSessions();
  const s = batchSessions.get(jobId);
  if (!s) {
    return res.status(404).json({ error: 'La sesion de traduccion expiro o no existe. Vuelve a iniciar el proceso.' });
  }
  const TOTAL = s.useBallons ? 5 : 6;

  try {
    if (action !== 'continue' && action !== 'rest' && action !== 'stop') {
      return res.status(400).json({ error: 'Accion no valida: ' + action });
    }

    const remaining = s.images.length - s.cursor;
    if (action === 'stop' || remaining <= 0) {
      return res.json(await finalizeSession(s));
    }

    const count = action === 'rest' ? remaining : Math.min(BATCH_SIZE, remaining);
    await processBatch(s, s.cursor, s.cursor + count);

    if (s.cursor >= s.images.length) {
      return res.json(await finalizeSession(s));
    }
    return res.json(batchPayload(s));
  } catch (error) {
    console.error('Error en lote:', error);
    sendProgress(jobId, 0, TOTAL, 'Error: ' + error.message);
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

function startDownloadJob(jobId, url, quality, mode) {
  const workDir = path.join(TEMP_DIR, jobId);
  initDownloadState(jobId, { url, mode: mode || 'download', videoUrl: '/api/video/' + jobId });

  setImmediate(async () => {
    try {
      sendProgress(jobId, 1, 2, 'Conectando con la pagina...', '', { kind: 'download', pct: 0 });
      const result = await downloadVideo(url, workDir, quality || 'best', (pct, mb, totalMb, msg) => {
        const text = msg || ('Descargando: ' + pct + '% (' + mb + 'MB / ' + totalMb + 'MB)');
        sendProgress(jobId, 1, 2, text, '', { kind: 'download', pct: pct || 0 });
        updateDownloadState(jobId, { status: 'downloading', pct: pct || 0, message: text });
      }, {
        jobId,
        onStatus: (msg) => {
          sendProgress(jobId, 1, 2, msg, '', { kind: 'download', pct: 0 });
          updateDownloadState(jobId, { status: 'downloading', message: msg });
        }
      });

      const state = getDownloadState(jobId) || {};
      const title = result.title || state.title || 'video';
      const filename = path.basename(result.path);
      updateDownloadState(jobId, { status: 'done', pct: 100, title, filename, message: 'Video listo', error: null });

      sendProgress(jobId, 2, 2, 'Video listo: ' + title, '', {
        kind: 'download', pct: 100, done: true,
        videoUrl: '/api/video/' + jobId, title, filename
      });
      console.log('[' + jobId + '] Descarga completa: ' + title);
    } catch (error) {
      const cancelled = /cancelada/i.test(error.message);
      const message = cancelled ? 'Descarga cancelada' : ('Error: ' + error.message);
      console.error('[' + jobId + '] ' + message);
      updateDownloadState(jobId, {
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? null : error.message,
        message
      });
      sendProgress(jobId, cancelled ? 2 : 0, 2, message, '', {
        kind: 'download', pct: 0, error: !cancelled, cancelled
      });
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
    }
  });
}

app.post('/api/subtitle/download', (req, res) => {
  const { url, clientId, quality, mode } = req.body;
  if (!url) return res.status(400).json({ error: 'URL es requerida' });

  const jobId = clientId || ('sub_' + Date.now());
  const workDir = path.join(TEMP_DIR, jobId);

  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  fs.mkdirSync(workDir, { recursive: true });

  startDownloadJob(jobId, url, quality || 'best', mode || 'download');

  res.json({ success: true, jobId, queued: true, videoUrl: '/api/video/' + jobId });
});

app.get('/api/subtitle/status/:jobId', (req, res) => {
  const st = getDownloadState(req.params.jobId);
  if (!st) return res.status(404).json({ error: 'Descarga no encontrada' });
  res.json(Object.assign({ success: true }, st));
});

app.post('/api/subtitle/cancel/:jobId', (req, res) => {
  cancelDownload(req.params.jobId);
  res.json({ success: true });
});

app.post('/api/subtitle/detect-quality', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL es requerida' });

  try {
    const videoUrls = await extractVideoUrls(url);
    if (videoUrls && (videoUrls.videoUrl || videoUrls.altUrl)) {
      const qualities = [];
      if (videoUrls.videoUrl) {
        qualities.push({ url: videoUrls.videoUrl, label: videoUrls.videoUrlText || 'LQ', isHd: false });
      }
      if (videoUrls.altUrl) {
        qualities.push({ url: videoUrls.altUrl, label: videoUrls.altUrlText || 'HQ', isHd: videoUrls.altUrlHd });
      }
      res.json({ success: true, title: videoUrls.title, qualities });
    } else {
      res.json({ success: true, title: null, qualities: [] });
    }
  } catch (error) {
    console.log('No se pudo detectar calidad: ' + error.message);
    res.json({ success: true, title: null, qualities: [] });
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
  const wantsFile = req.query.download === '1';

  if (wantsFile) {
    const st = getDownloadState(jobId);
    const rawTitle = (st && st.title) ? st.title : 'video';
    const asciiName = rawTitle.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 _.-]+/g, '').trim().slice(0, 80) || 'video';
    const utfName = rawTitle.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'video';
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="' + asciiName + '.mp4"; filename*=UTF-8\'\'' + encodeURIComponent(utfName + '.mp4')
    });
    return fs.createReadStream(videoPath).pipe(res);
  }

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
