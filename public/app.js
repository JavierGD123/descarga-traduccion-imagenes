let currentJobId = null;
let currentSrt = null;
let selectedFile = null;
let currentEventSource = null;

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

function formatTime(ms) {
  var totalSec = Math.floor(ms / 1000);
  var min = Math.floor(totalSec / 60);
  var sec = totalSec % 60;
  return String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

function showProgress(step, total, message, detail, elapsed, stepName) {
  var el = document.getElementById('progressArea');
  el.style.display = 'block';

  var pct = total > 0 ? Math.round((step / total) * 100) : 0;
  document.getElementById('progressBar').style.width = pct + '%';
  document.getElementById('progressMsg').textContent = message || 'Procesando...';
  document.getElementById('progressDetail').textContent = detail || '';
  document.getElementById('progressStep').textContent = pct + '%';

  if (stepName) {
    document.getElementById('progressStepName').textContent = stepName;
    document.getElementById('progressStepName').style.display = 'inline';
  } else {
    document.getElementById('progressStepName').style.display = 'none';
  }

  if (elapsed) {
    document.getElementById('progressElapsed').textContent = formatTime(elapsed);
    if (step > 0 && step < total) {
      var eta = Math.round((elapsed / step) * (total - step));
      document.getElementById('progressEta').textContent = '~' + formatTime(eta) + ' restante';
    } else {
      document.getElementById('progressEta').textContent = '';
    }
  }
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
async function processUrl() {
  var url = document.getElementById('urlInput').value.trim();
  if (!url) { showError('Ingresa una URL valida'); return; }

  setLoading('processBtn', true);
  hideError();
  document.getElementById('results').style.display = 'none';

  try {
    showProgress(0, 6, 'Iniciando proceso...', '');
    var jobId = 'job_' + Date.now();
    startListening(jobId);

    var saveFiles = document.getElementById('saveImagesCheck').checked;
    var response = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, saveFiles, clientId: jobId })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al procesar');

    stopListening();
    showProgress(6, 6, 'Completado!', '');
    setTimeout(function() { hideProgress(); }, 800);
    showResults(data);
  } catch (error) {
    stopListening();
    hideProgress();
    showError(error.message);
  } finally {
    setLoading('processBtn', false);
  }
}

function showResults(data) {
  document.getElementById('results').style.display = 'block';
  document.getElementById('imageCount').textContent = data.imageCount;

  var tc = data.translations.filter(function(t) { return t.originalText !== t.translatedText; }).length;
  document.getElementById('translationCount').textContent = tc;
  document.getElementById('editCount').textContent = data.editCount || 0;

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
          '<img src="' + orig + '" loading="lazy">' +
        '</div>' +
        '<div class="preview-img-wrap edited">' +
          '<span class="preview-label">Editada</span>' +
          '<img src="' + edit + '" loading="lazy">' +
        '</div>' +
      '</div>' +
      '<div class="preview-name">' + name + '</div>';
    grid.appendChild(card);
  }

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

async function downloadVideoFromUrl() {
  var url = document.getElementById('videoUrlInput').value.trim();
  if (!url) { showError('Ingresa una URL de video'); return; }

  setLoading('downloadBtn', true);
  hideError();

  try {
    showProgress(0, 2, 'Descargando video...', '');
    var jobId = 'sub_' + Date.now();
    startListening(jobId);

    var response = await fetch('/api/subtitle/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, clientId: jobId })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Error al descargar');

    stopListening();
    showProgress(2, 2, 'Video listo!', '');
    setTimeout(function() { hideProgress(); }, 500);

    showVideoPlayer(data);
  } catch (error) {
    stopListening();
    hideProgress();
    showError(error.message);
  } finally {
    setLoading('downloadBtn', false);
  }
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

    showVideoPlayer(data);
  } catch (error) {
    stopListening();
    hideProgress();
    showError(error.message);
  } finally {
    setLoading('uploadBtn', false);
  }
}

function showVideoPlayer(data) {
  currentJobId = data.jobId;
  currentSrt = null;

  document.getElementById('step-load').style.display = 'none';
  document.getElementById('step-work').style.display = 'block';

  var video = document.getElementById('videoPlayer');

  while (video.firstChild) video.removeChild(video.firstChild);

  video.src = data.videoUrl;

  var track1 = document.createElement('track');
  track1.id = 'originalTrack';
  track1.kind = 'subtitles';
  track1.label = 'Original';
  track1.srclang = 'en';
  video.appendChild(track1);

  var track2 = document.createElement('track');
  track2.id = 'translatedTrack';
  track2.kind = 'subtitles';
  track2.label = 'Traducido';
  track2.srclang = 'es';
  video.appendChild(track2);

  video.load();

  document.getElementById('videoTitle').textContent = data.filename || 'Video Cargado';

  document.getElementById('translatePanel').style.display = 'none';
  document.getElementById('detectResult').style.display = 'none';
  document.getElementById('exportPanel').style.display = 'none';

  document.getElementById('optOriginal').style.display = 'none';
  document.getElementById('optTranslated').style.display = 'none';
  document.getElementById('subtitleTrack').value = 'off';
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

    var video = document.getElementById('videoPlayer');
    var origTrack = document.getElementById('originalTrack');
    if (origTrack) {
      origTrack.src = url;
    } else {
      var t = document.createElement('track');
      t.id = 'originalTrack';
      t.kind = 'subtitles';
      t.label = 'Original';
      t.srclang = 'en';
      t.src = url;
      video.appendChild(t);
    }

    document.getElementById('subtitleTrack').value = 'original';
    document.getElementById('optOriginal').style.display = 'block';
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

    console.log('[Frontend] Translating. jobId:', currentJobId, 'srtLength:', currentSrt.length, 'lang:', targetLang);
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

    var video = document.getElementById('videoPlayer');
    var transTrack = document.getElementById('translatedTrack');
    if (transTrack) {
      transTrack.src = url;
    } else {
      var t = document.createElement('track');
      t.id = 'translatedTrack';
      t.kind = 'subtitles';
      t.label = 'Traducido';
      t.srclang = 'es';
      t.src = url;
      video.appendChild(t);
    }

    document.getElementById('subtitleTrack').value = 'translated';
    document.getElementById('optTranslated').style.display = 'block';
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
  if (!video) return;
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
document.getElementById('videoUrlInput').addEventListener('keypress', function(e) { if (e.key === 'Enter') downloadVideoFromUrl(); });
document.getElementById('videoFileInput').addEventListener('change', handleFileSelect);
