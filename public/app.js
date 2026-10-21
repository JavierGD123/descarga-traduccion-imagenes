let currentJobId = null;
let currentSrt = null;
let selectedFile = null;
let currentEventSource = null;
let detectedQualities = [];
let livePreviewImages = {};
let downloadItems = {};
let currentMode = 'download';
let imgBatch = null;
let imgTotalSteps = 5;

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => { c.style.display = 'none'; c.classList.remove('active'); });

  if (tab === 'images') {
    document.querySelectorAll('.tab')[0].classList.add('active');
    document.getElementById('tab-images').style.display = 'block';
  } else {
    document.querySelectorAll('.tab')[1].classList.add('active');
    document.getElementById('tab-subtitles').style.display = 'block';
  }

  hideError();
  hideProgress();
  document.getElementById('results').style.display = 'none';
}

function startListening(jobId) {
  stopListening();
  currentJobId = jobId;

  currentEventSource = new EventSource('/api/progress/' + jobId);
  currentEventSource.onmessage = function(e) {
    var data = JSON.parse(e.data);
    showProgress(data.step, data.total, data.message, data.detail, data.elapsed, data.stepName);
    if (data.extra && data.extra.edited) {
      addLivePreview(data.extra);
    }
  };
  currentEventSource.onerror = function() {
    setTimeout(function() {
      if (currentJobId === jobId) startListening(jobId);
    }, 2000);
  };
}

function stopListening() {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
}

function showProgress(step, total, message, detail) {
  var el = document.getElementById('progressArea');
  el.style.display = 'block';

  var pct = total > 0 ? Math.round((step / total) * 100) : 0;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressMsg').textContent = message || 'Procesando...';
  document.getElementById('progressDetail').textContent = detail || '';
  document.getElementById('progressStep').textContent = pct + '%';
}

function hideProgress() {
  document.getElementById('progressArea').style.display = 'none';
  document.getElementById('progressBar').style.width = '0%';
  stopListening();
}

function showError(text) {
  hideProgress();
  var e = document.getElementById('error');
  e.style.display = 'block';
  e.querySelector('.error-text').textContent = text;
}

function hideError() {
  document.getElementById('error').style.display = 'none';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function srtToVtt(srt) {
  var vtt = 'WEBVTT\n\n';
  vtt += srt.replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, '$1:$2:$3.$4');
  return vtt;
}

function addLivePreview(imageData) {
  var container = document.getElementById('livePreview');
  var grid = document.getElementById('livePreviewGrid');
  container.style.display = 'block';

  var key = imageData.filename;
  if (livePreviewImages[key]) return;
  livePreviewImages[key] = true;

  var card = document.createElement('div');
  card.className = 'live-preview-card';
  card.innerHTML =
    '<div class="live-preview-images">' +
      '<div class="live-preview-img-wrap">' +
        '<span class="live-preview-label">Original</span>' +
        '<img src="' + imageData.original + '" loading="lazy" onclick="openLightbox(this.src)" style="cursor:pointer">' +
      '</div>' +
      '<div class="live-preview-img-wrap">' +
        '<span class="live-preview-label">Editada</span>' +
        '<img src="' + imageData.edited + '" loading="lazy" onclick="openLightbox(this.src)" style="cursor:pointer">' +
      '</div>' +
    '</div>' +
    '<div class="live-preview-name">' + imageData.filename + ' (' + imageData.index + '/' + imageData.total + ')</div>';
  grid.appendChild(card);
}

function clearLivePreview() {
  livePreviewImages = {};
  var grid = document.getElementById('livePreviewGrid');
  if (grid) grid.innerHTML = '';
  var container = document.getElementById('livePreview');
  if (container) container.style.display = 'none';
}

function openLightbox(src) {
  event.stopPropagation();
  var lightbox = document.getElementById('lightbox');
  var img = document.getElementById('lightboxImg');
  img.src = src;
  lightbox.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  document.getElementById('lightbox').style.display = 'none';
  document.body.style.overflow = '';
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeLightbox();
});

function setLoading(btnId, loading) {
  var btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  var textEl = btn.querySelector('.btn-text');
  var loaderEl = btn.querySelector('.btn-loader');
  if (textEl) textEl.style.display = loading ? 'none' : 'inline';
  if (loaderEl) loaderEl.style.display = loading ? 'inline-flex' : 'none';
}

// ========== IMAGENES ==========
function updateEngineUI() {
  var v = document.getElementById('imgEngine').value.split('|');
  document.getElementById('imgLangGroup').style.display = v[0] === 'ballons' ? 'flex' : 'none';
  document.getElementById('metaHint').style.display = v[1] === 'meta' ? 'block' : 'none';
}

async function processUrl() {
  var url = document.getElementById('urlInput').value.trim();
  if (!url) { showError('Ingresa una URL valida'); return; }

  var sel = document.getElementById('imgEngine').value.split('|');
  var engine = sel[0];
  var translator = sel[1] || 'google';
  var targetLang = document.getElementById('imgTargetLang').value;
  var totalSteps = engine === 'ballons' ? 5 : 6;

  setLoading('processBtn', true);
  hideError();
  document.getElementById('results').style.display = 'none';
  clearLivePreview();
  imgTotalSteps = totalSteps;

  try {
    showProgress(0, totalSteps, 'Iniciando proceso...', '');
    var jobId = 'job_' + Date.now();
    startListening(jobId);

    var saveFiles = document.getElementById('saveImagesCheck').checked;
    var response = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, saveFiles, clientId: jobId, engine: engine, targetLang: targetLang, translator: translator })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al procesar');

    handleImageResponse(data);
  } catch (error) {
    stopListening();
    hideProgress();
    showError(error.message);
  } finally {
    setLoading('processBtn', false);
  }
}

function handleImageResponse(data) {
  if (data.batchPending) {
    showBatchPreview(data);
    return;
  }
  stopListening();
  showProgress(imgTotalSteps, imgTotalSteps, 'Completado!', '');
  setTimeout(function() { hideProgress(); }, 800);
  imgBatch = null;
  showResults(data);
}

function buildPreviewGrid(data) {
  var grid = document.getElementById('imageGrid');
  grid.innerHTML = '';

  var originals = data.originalImages || [];
  var edited = data.editedImages || [];

  for (var i = 0; i < data.imageCount; i++) {
    var orig = originals[i] || '';
    var edit = edited[i] || orig;
    var name = orig.split('/').pop();

    var card = document.createElement('div');
    card.className = 'preview-card';
    card.innerHTML =
      '<div class="preview-images">' +
        '<div class="preview-img-wrap">' +
          '<span class="preview-label">Original</span>' +
          '<img src="' + orig + '" loading="lazy" onclick="openLightbox(this.src)" style="cursor:pointer">' +
        '</div>' +
        '<div class="preview-img-wrap edited">' +
          '<span class="preview-label">Editada</span>' +
          '<img src="' + edit + '" loading="lazy" onclick="openLightbox(this.src)" style="cursor:pointer">' +
        '</div>' +
      '</div>' +
      '<div class="preview-name">' + name + '</div>';
    grid.appendChild(card);
  }
}

function showBatchPreview(data) {
  imgBatch = { jobId: data.jobId, batchNumber: data.batchNumber, busy: false };

  document.getElementById('results').style.display = 'block';
  document.getElementById('resultsTitle').textContent = 'Vista previa: lote ' + data.batchNumber + ' traducido';

  var info = document.getElementById('batchInfo');
  info.style.display = 'block';
  info.textContent = 'Traducidas ' + data.processed + ' de ' + data.totalImages + ' imagenes · restan ' + data.remaining;
  if (data.pendingTranslations > 0) {
    info.textContent += ' · ⚠ ' + data.pendingTranslations + ' pagina(s) con traduccion incompleta';
  }

  document.getElementById('imageCount').textContent = data.imageCount;
  var tc = (data.translations || []).filter(function(t) { return t.originalText !== t.translatedText; }).length;
  document.getElementById('translationCount').textContent = tc;
  document.getElementById('editCount').textContent = data.editCount || 0;

  buildPreviewGrid(data);

  document.getElementById('downloadButtons').style.display = 'none';
  var actions = document.getElementById('batchActions');
  actions.style.display = 'flex';
  document.getElementById('batchContinueBtn').textContent =
    'Continuar (siguientes ' + Math.min(data.batchSize, data.remaining) + ')';
  document.getElementById('batchRestBtn').style.display = 'inline-flex';
  document.getElementById('batchStopBtn').style.display = 'inline-flex';
  setBatchDisabled(false);
}

async function runBatchAction(action) {
  if (!imgBatch || imgBatch.busy) return;
  imgBatch.busy = true;
  setBatchDisabled(true);
  hideError();

  try {
    if (!currentEventSource) startListening(imgBatch.jobId);
    showProgress(0, imgTotalSteps, action === 'stop' ? 'Deteniendo y generando archivos...' : 'Procesando siguiente lote...', '');

    var response = await fetch('/api/batch/' + imgBatch.jobId + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al procesar el lote');

    handleImageResponse(data);
  } catch (error) {
    showError(error.message);
  } finally {
    if (imgBatch) imgBatch.busy = false;
    setBatchDisabled(false);
  }
}

function setBatchDisabled(disabled) {
  ['batchContinueBtn', 'batchRestBtn', 'batchStopBtn'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

function showResults(data) {
  document.getElementById('results').style.display = 'block';
  document.getElementById('resultsTitle').textContent =
    data.stoppedEarly ? 'Resultados (proceso detenido antes del final)' : 'Resultados';
  var info = document.getElementById('batchInfo');
  if (data.pendingTranslations > 0) {
    info.style.display = 'block';
    info.textContent = '⚠ ' + data.pendingTranslations + ' pagina(s) con traduccion incompleta';
  } else {
    info.style.display = 'none';
  }
  document.getElementById('batchActions').style.display = 'none';
  document.getElementById('downloadButtons').style.display = 'flex';
  document.getElementById('imageCount').textContent = data.imageCount;

  var tc = data.translations.filter(function(t) { return t.originalText !== t.translatedText; }).length;
  document.getElementById('translationCount').textContent = tc;
  document.getElementById('editCount').textContent = data.editCount || 0;

  buildPreviewGrid(data);

  document.getElementById('downloadPptx').href = data.pptxUrl;
  document.getElementById('downloadPdf').href = data.pdfUrl;
}

// ========== SUBTITULOS ==========

function handleFileSelect(e) {
  var file = e.target.files[0];
  if (!file) return;
  selectedFile = file;
  document.querySelector('.file-upload-content').style.display = 'none';
  document.getElementById('fileSelected').style.display = 'flex';
  document.getElementById('fileName').textContent = file.name + ' (' + formatSize(file.size) + ')';
  document.getElementById('uploadBtn').style.display = 'block';
}

function removeFile() {
  selectedFile = null;
  document.getElementById('videoFileInput').value = '';
  document.querySelector('.file-upload-content').style.display = 'flex';
  document.getElementById('fileSelected').style.display = 'none';
  document.getElementById('uploadBtn').style.display = 'none';
}

// ========== DESCARGAS MULTIPLES ==========

function changeMode(mode) {
  currentMode = mode;
  document.getElementById('modeDownloadLabel').classList.toggle('active', mode === 'download');
  document.getElementById('modeSubtitlesLabel').classList.toggle('active', mode === 'subtitles');
}

function parseUrls(text) {
  var parts = String(text || '').split(/[\s,;]+/);
  var out = [];
  parts.forEach(function(p) {
    p = p.trim();
    if (/^https?:\/\/\S+$/i.test(p) && out.indexOf(p) === -1) out.push(p);
  });
  return out;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function q(root, cls) { return root ? root.querySelector('.' + cls) : null; }

function setBtn(root, cls, visible) {
  var el = q(root, cls);
  if (el) el.style.display = visible ? 'inline-flex' : 'none';
}

function refreshDownloads() {
  var keys = Object.keys(downloadItems);
  document.getElementById('downloadsPanel').style.display = keys.length ? 'block' : 'none';
  document.getElementById('downloadsCount').textContent = keys.length;
  var hasDone = keys.some(function(k) { return downloadItems[k].status === 'done'; });
  document.getElementById('saveAllBtn').style.display = hasDone ? 'inline-flex' : 'none';
}

function createDownloadItemEl(item) {
  var el = document.createElement('div');
  el.className = 'dl-item';
  el.id = 'dl_' + item.jobId;
  el.innerHTML =
    '<div class="dl-info">' +
      '<div class="dl-title">' + escapeHtml(item.title || 'Descargando...') + '</div>' +
      '<div class="dl-url">' + escapeHtml(item.url) + '</div>' +
      '<div class="dl-status">Preparando descarga...</div>' +
      '<div class="dl-track"><div class="dl-fill"></div></div>' +
    '</div>' +
    '<div class="dl-actions">' +
      '<button class="dl-btn dl-play" style="display:none;" onclick="playDownload(\'' + item.jobId + '\')">Reproducir</button>' +
      '<a class="dl-btn dl-save" style="display:none;" href="/api/video/' + item.jobId + '?download=1">Guardar</a>' +
      '<button class="dl-btn dl-retry" style="display:none;" onclick="retryDownload(\'' + item.jobId + '\')">Reintentar</button>' +
      '<button class="dl-btn dl-cancel" onclick="cancelDownloadItem(\'' + item.jobId + '\')">Cancelar</button>' +
      '<button class="dl-btn dl-remove" onclick="removeDownloadItem(\'' + item.jobId + '\')">X</button>' +
    '</div>';
  document.getElementById('downloadList').appendChild(el);
  return el;
}

async function detectVideoQuality() {
  if (currentMode !== 'subtitles') {
    document.getElementById('qualityPanel').style.display = 'none';
    return;
  }
  var urls = parseUrls(document.getElementById('videoUrlsInput').value);
  if (urls.length !== 1 || !/fpo\.xxx/i.test(urls[0])) {
    document.getElementById('qualityPanel').style.display = 'none';
    detectedQualities = [];
    return;
  }
  var url = urls[0];

  try {
    var response = await fetch('/api/subtitle/detect-quality', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    var data = await response.json();

    if (data.success && data.qualities && data.qualities.length > 0) {
      detectedQualities = data.qualities;
      var select = document.getElementById('qualitySelect');
      select.innerHTML = '';

      if (data.qualities.length === 1) {
        var opt = document.createElement('option');
        opt.value = data.qualities[0].label === 'HQ' ? 'hq' : 'lq';
        opt.textContent = data.qualities[0].label + (data.qualities[0].isHd ? ' (HD)' : '');
        select.appendChild(opt);
      } else {
        var bestOpt = document.createElement('option');
        bestOpt.value = 'best';
        bestOpt.textContent = 'Mejor calidad disponible';
        select.appendChild(bestOpt);

        data.qualities.forEach(function(q2) {
          var o = document.createElement('option');
          o.value = q2.label === 'HQ' ? 'hq' : 'lq';
          o.textContent = q2.label + (q2.isHd ? ' (HD)' : '');
          select.appendChild(o);
        });
      }

      document.getElementById('qualityPanel').style.display = 'flex';
      document.getElementById('qualityInfo').textContent = data.title || '';
    } else {
      document.getElementById('qualityPanel').style.display = 'none';
      detectedQualities = [];
    }
  } catch (e) {
    document.getElementById('qualityPanel').style.display = 'none';
    detectedQualities = [];
  }
}

async function downloadVideos() {
  var input = document.getElementById('videoUrlsInput');
  var urls = parseUrls(input.value);
  if (!urls.length) { showError('Ingresa al menos una URL valida (debe empezar con http)'); return; }

  hideError();
  input.value = '';

  urls.forEach(function(u) { startDownload(u); });
}

function startDownload(url, jobId) {
  jobId = jobId || ('dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));

  var item = downloadItems[jobId];
  if (!item) {
    item = { jobId: jobId, url: url, mode: currentMode, status: 'starting', pct: 0, title: '', es: null };
    downloadItems[jobId] = item;
    item.el = createDownloadItemEl(item);
  } else {
    item.status = 'starting';
    item.pct = 0;
    item.es = null;
    if (q(item.el, 'dl-title')) q(item.el, 'dl-title').textContent = 'Descargando...';
    item.el.classList.remove('error', 'done', 'cancelled');
    setBtn(item.el, 'dl-play', false);
    setBtn(item.el, 'dl-save', false);
    setBtn(item.el, 'dl-retry', false);
    setBtn(item.el, 'dl-cancel', true);
    if (q(item.el, 'dl-fill')) q(item.el, 'dl-fill').style.width = '3%';
    if (q(item.el, 'dl-status')) q(item.el, 'dl-status').textContent = 'Preparando descarga...';
  }
  refreshDownloads();

  var mode = item.mode;
  var quality = mode === 'download' ? 'best' : (document.getElementById('qualitySelect').value || 'best');

  fetch('/api/subtitle/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url, clientId: jobId, quality: quality, mode: mode })
  })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
    .then(function(res) {
      if (!res.ok || !res.data.success) throw new Error(res.data.error || 'Error al iniciar la descarga');
      listenDownload(jobId);
      setTimeout(function() { syncDownloadStatus(jobId); }, 800);
    })
    .catch(function(e) { setDownloadError(jobId, e.message); });
}

function listenDownload(jobId) {
  var item = downloadItems[jobId];
  if (!item || item.es) return;

  var es = new EventSource('/api/progress/' + jobId);
  item.es = es;

  es.onmessage = function(e) {
    var data;
    try { data = JSON.parse(e.data); } catch (err) { return; }
    handleDownloadMessage(jobId, data);
  };

  es.onerror = function() {
    var it = downloadItems[jobId];
    if (!it || it.status === 'done' || it.status === 'error' || it.status === 'cancelled') {
      try { es.close(); } catch (err) {}
      if (it) it.es = null;
      return;
    }
    setTimeout(function() {
      var it2 = downloadItems[jobId];
      if (!it2) return;
      try { es.close(); } catch (err) {}
      it2.es = null;
      if (it2.status !== 'done' && it2.status !== 'error' && it2.status !== 'cancelled') listenDownload(jobId);
    }, 2500);
  };
}

function syncDownloadStatus(jobId) {
  fetch('/api/subtitle/status/' + jobId)
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(st) {
      if (!st || !downloadItems[jobId]) return;
      if (st.status === 'done') setDownloadDone(jobId, st.title);
      else if (st.status === 'error') setDownloadError(jobId, st.error || st.message);
      else if (st.status === 'cancelled') setDownloadCancelled(jobId);
      else if (st.message) updateDownloadProgress(jobId, st.pct || 0, st.message);
    })
    .catch(function() {});
}

function handleDownloadMessage(jobId, data) {
  var item = downloadItems[jobId];
  if (!item) return;
  var extra = data.extra || {};

  if (extra.done) { setDownloadDone(jobId, extra.title); return; }
  if (extra.cancelled) { setDownloadCancelled(jobId); return; }
  if (extra.error) { setDownloadError(jobId, data.message || 'Error al descargar'); return; }

  updateDownloadProgress(jobId, extra.pct || 0, data.message || 'Descargando...');
}

function updateDownloadProgress(jobId, pct, message) {
  var item = downloadItems[jobId];
  if (!item || item.status === 'done') return;
  item.status = 'downloading';
  item.pct = pct;
  item.el.classList.remove('error', 'done', 'cancelled');
  if (q(item.el, 'dl-status')) q(item.el, 'dl-status').textContent = message;
  if (q(item.el, 'dl-fill')) q(item.el, 'dl-fill').style.width = Math.max(3, pct) + '%';
  setBtn(item.el, 'dl-cancel', true);
  setBtn(item.el, 'dl-play', false);
  setBtn(item.el, 'dl-save', false);
  setBtn(item.el, 'dl-retry', false);
  refreshDownloads();
}

function setDownloadDone(jobId, title) {
  var item = downloadItems[jobId];
  if (!item) return;
  item.status = 'done';
  item.pct = 100;
  if (title) item.title = title;

  item.el.classList.remove('error', 'cancelled');
  item.el.classList.add('done');
  if (q(item.el, 'dl-title')) q(item.el, 'dl-title').textContent = item.title || 'Video listo';
  if (q(item.el, 'dl-status')) q(item.el, 'dl-status').textContent = 'Completado (maxima calidad)';
  if (q(item.el, 'dl-fill')) q(item.el, 'dl-fill').style.width = '100%';
  setBtn(item.el, 'dl-cancel', false);
  setBtn(item.el, 'dl-retry', false);
  setBtn(item.el, 'dl-play', true);
  setBtn(item.el, 'dl-save', true);

  closeJobListener(jobId);
  refreshDownloads();

  if (item.mode === 'subtitles' && Object.keys(downloadItems).length === 1) playDownload(jobId);
}

function setDownloadError(jobId, message) {
  var item = downloadItems[jobId];
  if (!item || item.status === 'done') return;
  item.status = 'error';
  item.el.classList.remove('done', 'cancelled');
  item.el.classList.add('error');
  if (q(item.el, 'dl-status')) q(item.el, 'dl-status').textContent = 'Error: ' + (message || 'no se pudo descargar');
  if (q(item.el, 'dl-fill')) q(item.el, 'dl-fill').style.width = '100%';
  setBtn(item.el, 'dl-cancel', false);
  setBtn(item.el, 'dl-play', false);
  setBtn(item.el, 'dl-save', false);
  setBtn(item.el, 'dl-retry', true);
  closeJobListener(jobId);
  refreshDownloads();
}

function setDownloadCancelled(jobId) {
  var item = downloadItems[jobId];
  if (!item || item.status === 'done') return;
  item.status = 'cancelled';
  item.el.classList.remove('done', 'error');
  item.el.classList.add('cancelled');
  if (q(item.el, 'dl-status')) q(item.el, 'dl-status').textContent = 'Cancelado';
  setBtn(item.el, 'dl-cancel', false);
  setBtn(item.el, 'dl-play', false);
  setBtn(item.el, 'dl-save', false);
  setBtn(item.el, 'dl-retry', true);
  closeJobListener(jobId);
  refreshDownloads();
}

function closeJobListener(jobId) {
  var item = downloadItems[jobId];
  if (item && item.es) {
    try { item.es.close(); } catch (e) {}
    item.es = null;
  }
}

function cancelDownloadItem(jobId) {
  var item = downloadItems[jobId];
  if (!item) return;
  if (q(item.el, 'dl-status')) q(item.el, 'dl-status').textContent = 'Cancelando...';
  fetch('/api/subtitle/cancel/' + jobId, { method: 'POST' }).catch(function() {});
}

function retryDownload(jobId) {
  var item = downloadItems[jobId];
  if (!item) return;
  startDownload(item.url, jobId);
}

function removeDownloadItem(jobId) {
  var item = downloadItems[jobId];
  if (!item) return;
  if (item.status !== 'done' && item.status !== 'error' && item.status !== 'cancelled') {
    fetch('/api/subtitle/cancel/' + jobId, { method: 'POST' }).catch(function() {});
  }
  closeJobListener(jobId);
  if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
  delete downloadItems[jobId];
  refreshDownloads();
}

function clearDownloads() {
  Object.keys(downloadItems).forEach(removeDownloadItem);
  refreshDownloads();
}

function saveAllDownloads() {
  var done = Object.keys(downloadItems).filter(function(k) { return downloadItems[k].status === 'done'; });
  done.forEach(function(jobId, i) {
    setTimeout(function() {
      var a = document.createElement('a');
      a.href = '/api/video/' + jobId + '?download=1';
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, i * 600);
  });
}

function playDownload(jobId) {
  var item = downloadItems[jobId];
  if (!item) return;
  showVideoPlayer({ jobId: jobId, videoUrl: '/api/video/' + jobId, filename: item.title || 'Video descargado' }, item.mode);
}

function backToLoads() {
  var video = document.getElementById('videoPlayer');
  try { video.pause(); } catch (e) {}
  document.getElementById('step-work').style.display = 'none';
  document.getElementById('step-load').style.display = 'block';
}

async function uploadVideoFile() {
  if (!selectedFile) { showError('Selecciona un archivo de video'); return; }

  setLoading('uploadBtn', true);
  hideError();

  try {
    showProgress(0, 1, 'Subiendo video...', '');
    var jobId = 'sub_' + Date.now();
    startListening(jobId);

    var formData = new FormData();
    formData.append('video', selectedFile);
    formData.append('clientId', jobId);

    var response = await fetch('/api/subtitle/upload', {
      method: 'POST',
      body: formData
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al subir');

    stopListening();
    showProgress(1, 1, 'Video listo!', '');
    setTimeout(function() { hideProgress(); }, 500);

    showVideoPlayer(data, 'subtitles');
  } catch (error) {
    stopListening();
    hideProgress();
    showError(error.message);
  } finally {
    setLoading('uploadBtn', false);
  }
}

function showVideoPlayer(data, mode) {
  currentJobId = data.jobId;
  currentSrt = null;
  setWorkMode(mode || 'subtitles');

  document.getElementById('step-load').style.display = 'none';
  document.getElementById('step-work').style.display = 'block';

  var video = document.getElementById('videoPlayer');
  video.src = data.videoUrl;
  video.load();

  document.getElementById('videoTitle').textContent = data.filename || 'Video Cargado';

  document.getElementById('optOriginal').style.display = 'none';
  document.getElementById('optTranslated').style.display = 'none';
  document.getElementById('subtitleTrack').value = 'off';
}

function setWorkMode(mode) {
  var subs = mode === 'subtitles';
  document.getElementById('controlsPanel').style.display = subs ? 'block' : 'none';
  document.getElementById('subtitleControls').style.display = subs ? 'flex' : 'none';
  document.getElementById('backBtn').style.display = 'inline-flex';
  document.getElementById('translatePanel').style.display = 'none';
  document.getElementById('detectResult').style.display = 'none';
  document.getElementById('exportPanel').style.display = 'none';
}

async function generateSubtitles() {
  if (!currentJobId) { showError('Primero carga un video'); return; }

  var engine = document.getElementById('engineSelect').value;
  setLoading('generateBtn', true);
  hideError();

  try {
    showProgress(0, 3, 'Generando subtitulos...', '');
    startListening(currentJobId);

    var response = await fetch('/api/subtitle/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: currentJobId, engine })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al generar');

    stopListening();
    showProgress(3, 3, 'Subtitulos generados!', '');
    setTimeout(function() { hideProgress(); }, 500);

    currentSrt = data.srtContent;

    document.getElementById('detectedLang').textContent = data.detectedLang === 'en' ? 'Ingles' : 'Espanol';
    document.getElementById('subtitleCount').textContent = data.subtitleCount + ' bloques';
    document.getElementById('detectResult').style.display = 'block';

    var vtt = srtToVtt(data.srtContent);
    var blob = new Blob([vtt], { type: 'text/vtt' });
    var url = URL.createObjectURL(blob);
    document.getElementById('originalTrack').src = url;
    document.getElementById('optOriginal').style.display = 'block';

    document.getElementById('subtitleTrack').value = 'original';
    document.getElementById('optOriginal').selected = true;
    changeSubtitleTrack();

    document.getElementById('translatePanel').style.display = 'flex';

    document.getElementById('exportSrtOriginal').href = '/api/subtitle/export-srt/' + currentJobId + '/original';
    document.getElementById('exportVttOriginal').href = '/api/subtitle/export-vtt/' + currentJobId + '/original';
    document.getElementById('exportPanel').style.display = 'block';
    document.getElementById('exportVideoBtn').style.display = 'none';
    document.getElementById('exportSrtTranslated').style.display = 'none';
    document.getElementById('exportVttTranslated').style.display = 'none';

  } catch (error) {
    stopListening();
    hideProgress();
    showError(error.message);
  } finally {
    setLoading('generateBtn', false);
  }
}

async function translateSubtitles() {
  if (!currentJobId || !currentSrt) { showError('Primero genera los subtitulos'); return; }

  var targetLang = document.getElementById('targetLang').value;
  setLoading('translateBtn', true);
  hideError();

  try {
    showProgress(0, 2, 'Traduciendo subtitulos...', '');
    startListening(currentJobId);

    var response = await fetch('/api/subtitle/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: currentJobId, srtContent: currentSrt, targetLang })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al traducir');

    stopListening();
    showProgress(2, 2, 'Traduccion completada!', '');
    setTimeout(function() { hideProgress(); }, 500);

    var vtt = srtToVtt(data.srtContent);
    var blob = new Blob([vtt], { type: 'text/vtt' });
    var url = URL.createObjectURL(blob);
    document.getElementById('translatedTrack').src = url;
    document.getElementById('optTranslated').style.display = 'block';

    document.getElementById('subtitleTrack').value = 'translated';
    document.getElementById('optTranslated').selected = true;
    changeSubtitleTrack();

    document.getElementById('exportSrtTranslated').href = '/api/subtitle/export-srt/' + currentJobId + '/translated';
    document.getElementById('exportVttTranslated').href = '/api/subtitle/export-vtt/' + currentJobId + '/translated';
    document.getElementById('exportSrtTranslated').style.display = 'inline-flex';
    document.getElementById('exportVttTranslated').style.display = 'inline-flex';
    document.getElementById('exportVideoBtn').style.display = 'inline-flex';

  } catch (error) {
    stopListening();
    hideProgress();
    showError(error.message);
  } finally {
    setLoading('translateBtn', false);
  }
}

async function exportVideoWithSubs() {
  if (!currentJobId) { showError('No hay video para exportar'); return; }

  setLoading('exportVideoBtn', true);
  hideError();

  try {
    showProgress(0, 1, 'Exportando video con subtitulos...', '');
    startListening(currentJobId);

    var response = await fetch('/api/subtitle/export-video/' + currentJobId + '/translated');
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al exportar');

    stopListening();
    showProgress(1, 1, 'Video exportado!', '');
    setTimeout(function() { hideProgress(); }, 500);

    var link = document.createElement('a');
    link.href = data.videoUrl;
    link.download = 'video_subtitled.mp4';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

  } catch (error) {
    stopListening();
    hideProgress();
    showError(error.message);
  } finally {
    setLoading('exportVideoBtn', false);
  }
}

function changeSubtitleTrack() {
  var video = document.getElementById('videoPlayer');
  var tracks = video.textTracks;
  var val = document.getElementById('subtitleTrack').value;

  for (var i = 0; i < tracks.length; i++) {
    tracks[i].mode = 'hidden';
  }

  if (val === 'original' && tracks.length > 0) {
    tracks[0].mode = 'showing';
  } else if (val === 'translated' && tracks.length > 1) {
    tracks[1].mode = 'showing';
  }
}

document.getElementById('urlInput').addEventListener('keypress', function(e) { if (e.key === 'Enter') processUrl(); });
document.getElementById('videoUrlsInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    downloadVideos();
  }
});
document.getElementById('videoUrlsInput').addEventListener('blur', function() { detectVideoQuality(); });
document.getElementById('videoFileInput').addEventListener('change', handleFileSelect);
