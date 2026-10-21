const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BT_DIR = process.env.BT_DIR || 'C:\\Proyectos\\BallonsTranslator-Pro';
const API_HOST = '127.0.0.1';
const API_PORT = parseInt(process.env.BT_API_PORT || '39542', 10);
const TEMP_DIR = path.join(__dirname, '..', 'temp');
const LOG_FILE = path.join(TEMP_DIR, 'ballons.log');
const CFG_DIR = path.join(TEMP_DIR, 'ballons-configs');

// Codigos de la UI -> nombres de idioma que usa el traductor Google de BT
const LANG_NAMES = {
  es: 'Español',
  en: 'English',
  pt: 'Português',
  fr: 'Français',
  de: 'Deutsch',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  zh: '简体中文',
  ru: 'русский язык'
};

let proc = null;
let procLang = null;
let logTail = [];
let jobChain = Promise.resolve();
const FAILED_TRANSLATION_RE = /^\[translation failed\]$/i;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pushLog(chunk) {
  const lines = String(chunk).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    logTail.push(line);
    if (logTail.length > 200) logTail.shift();
  }
}

function getLogTail() { return logTail.slice(-30).join('\n'); }

function normalizeLang(lang) {
  const key = String(lang || 'es').toLowerCase().trim();
  if (LANG_NAMES[key]) return key;
  for (const [code, name] of Object.entries(LANG_NAMES)) {
    if (name.toLowerCase() === key) return code;
  }
  return 'es';
}

function ensureConfig(langCode, translator) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  const cfgPath = path.join(CFG_DIR, 'config_' + langCode + '.json');
  const examplePath = path.join(BT_DIR, 'config', 'config.example.json');
  if (!fs.existsSync(examplePath)) {
    throw new Error('No se encontro config.example.json en BallonsTranslator-Pro');
  }
  const cfg = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  const useMeta = translator === 'meta';
  cfg.module = cfg.module || {};
  // nllb200 no admite 'Auto' como source: BaseTranslator (raise_unsupported_lang=False)
  // resetea source Y target al primer idioma soportado (English->English) y NLLB copia
  // el texto sin traducir. Con Meta el source se fija en English (igual que el legacy).
  cfg.module.translate_source = useMeta ? 'English' : 'Auto';
  cfg.module.translate_target = LANG_NAMES[langCode];
  // mit48px (default) requiere ocr_ar_48px.ckpt no descargado; mit48px_ctc esta disponible localmente.
  cfg.module.ocr = 'mit48px_ctc';
  // 'builtin' descarga CLIP de HuggingFace en el MAIN THREAD (auto-layout post-inpaint)
  // y bloquea la API hasta agotar el timeout del export. El check es opcional.
  cfg.module.layout_box_size_check_model_id = '';
  // example.json usa 'model_contour' + prithivMLmods (ViT en HF) para balloon shape;
  // se restauran los defaults locales de config.py (contour_ratio, sin modelo).
  cfg.module.layout_balloon_shape_auto_method = 'contour_ratio';
  cfg.module.layout_balloon_shape_model_id = '';
  // Traductor: google (default) o nllb200 (Meta, el de WhatsApp). Con Meta se carga
  // perezosamente para no bloquear el arranque con la descarga del modelo (~2.4GB).
  cfg.module.translator = useMeta ? 'nllb200' : 'google';
  if (useMeta) cfg.module.load_model_on_demand = true;
  cfg.confirm_before_run = false;
  cfg.open_recent_on_startup = false;
  cfg.show_welcome_screen = false;
  cfg.auto_update_from_github = false;
  cfg.recent_proj_list = [];
  // automation_api_* son campos de ModuleConfig (utils/config.py); la copia top-level
  // la ignora ProgramConfig.load, pero se deja por si upstream corrige la lectura.
  cfg.module.automation_api_enabled = true;
  cfg.module.automation_api_port = API_PORT;
  cfg.module.automation_api_key = '';
  cfg.automation_api_enabled = true;
  cfg.automation_api_port = API_PORT;
  cfg.automation_api_key = '';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  return cfgPath;
}

function apiGet(timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: API_HOST, port: API_PORT, path: '/health', timeout: timeoutMs }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('Respuesta invalida de BallonsTranslator')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function apiPost(route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request({
      host: API_HOST, port: API_PORT, path: '/' + route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs || 60000
    }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch (e) {
          return reject(new Error('Respuesta invalida de la API de BallonsTranslator: ' + buf.slice(0, 200)));
        }
        if (json.ok === false) return reject(new Error(json.error || 'Error de la API de BallonsTranslator'));
        resolve(json.result !== undefined ? json.result : json);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout de la API de BallonsTranslator')));
    req.write(data);
    req.end();
  });
}

async function isHealthy() {
  try { await apiGet(2000); return true; } catch (e) { return false; }
}

function startProcess(langCode, translator, onLog) {
  const python = path.join(BT_DIR, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(python)) {
    throw new Error('BallonsTranslator no esta instalado (.venv no encontrado). Ejecuta scripts\\setup-ballons.bat primero.');
  }
  const cfgPath = ensureConfig(langCode, translator);
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  logStream.write('\n===== ' + new Date().toISOString() + ' start lang=' + langCode + ' =====\n');

  proc = spawn(python, ['launch.py', '--headless', '--frozen', '--gpu-profile', 'cpu', '--config_path', cfgPath], {
    cwd: BT_DIR,
    env: Object.assign({}, process.env, { BT_KEEP_ALIVE: '1', PYTHONUNBUFFERED: '1' }),
    windowsHide: true
  });
  procLang = langCode + '|' + (translator === 'meta' ? 'meta' : 'google');

  const onData = d => {
    const s = d.toString();
    logStream.write(s);
    pushLog(s);
    if (onLog) onLog(s);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('error', err => {
    pushLog('error de proceso: ' + err.message);
    proc = null;
    procLang = null;
  });
  proc.on('exit', code => {
    pushLog('BallonsTranslator terminado (code=' + code + ')');
    proc = null;
    procLang = null;
    try { logStream.end(); } catch (e) {}
  });
}

function stopProcess() {
  return new Promise(resolve => {
    if (!proc) return resolve();
    const p = proc;
    let timer = null;
    const done = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      resolve();
    };
    p.once('exit', done);
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      } else {
        p.kill('SIGTERM');
      }
    } catch (e) { done(); return; }
    timer = setTimeout(() => {
      timer = null;
      try { p.kill('SIGKILL'); } catch (e) {}
      done();
    }, 8000);
  });
}

async function waitForHealth(maxMs, onLog) {
  const start = Date.now();
  let announced = 0;
  while (Date.now() - start < maxMs) {
    if (await isHealthy()) return;
    if (!proc) {
      throw new Error('BallonsTranslator se cerro antes de estar listo. Revisa temp/ballons.log\n' + getLogTail());
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed - announced >= 30) {
      announced = elapsed;
      if (onLog) onLog('Esperando a BallonsTranslator... (' + elapsed + 's)');
    }
    await sleep(2000);
  }
  throw new Error('BallonsTranslator no respondio en ' + Math.round(maxMs / 1000) + 's. Revisa temp/ballons.log\n' + getLogTail());
}

async function ensureRunning(langCode, translator, onLog) {
  const wantLang = langCode + '|' + (translator === 'meta' ? 'meta' : 'google');
  if (proc && procLang === wantLang && await isHealthy()) return;
  if (proc) {
    if (procLang !== wantLang && onLog) onLog('Cambiando idioma o traductor: reiniciando BallonsTranslator...');
    await stopProcess();
  } else if (await isHealthy()) {
    throw new Error('Hay otra instancia de BallonsTranslator usando el puerto ' + API_PORT + '. Cierrala e intentalo de nuevo.');
  }
  if (onLog) onLog('Iniciando BallonsTranslator (idioma: ' + LANG_NAMES[langCode] + (translator === 'meta' ? ', traductor Meta NLLB' : '') + ')...');
  startProcess(langCode, translator, onLog);
  // Primer arranque puede tardar mucho (descarga de modelos); margen extra por si HF
  // responde lento o hay reintentos de descarga.
  await waitForHealth(45 * 60 * 1000, onLog);
  if (onLog) onLog('BallonsTranslator listo.');
}

async function translateFolder(imagesDir, targetLang, onProgress, translator) {
  const lang = normalizeLang(targetLang);
  const tr = translator === 'meta' ? 'meta' : 'google';
  const run = async () => {
    await ensureRunning(lang, tr, onProgress && (s => onProgress({ log: s })));

    await apiPost('open_project', { path: imagesDir }, 120000);

    const start = await apiPost('job_start', { task: 'run_pipeline', payload: {} }, 30000);
    const jobId = start.job_id;
    if (!jobId) throw new Error('BallonsTranslator no devolvio job_id');

    const deadline = Date.now() + 2 * 60 * 60 * 1000;
    let status = null;
    while (true) {
      await sleep(2000);
      status = await apiPost('job_status', { job_id: jobId }, 30000);
      if (onProgress && status) {
        onProgress({ progress: status.progress, stage: status.stage, status: status.status });
      }
      if (status && (status.status === 'succeeded' || status.status === 'failed' || status.status === 'cancelled')) break;
      if (Date.now() > deadline) {
        await apiPost('job_cancel', { job_id: jobId }, 15000).catch(() => {});
        throw new Error('BallonsTranslator tardo mas de 2 horas; proceso cancelado');
      }
    }
    if (status.status !== 'succeeded') {
      let detail = '';
      try {
        const logs = await apiPost('job_logs', { job_id: jobId }, 15000);
        if (logs && logs.logs && logs.logs.length) detail = '\n' + logs.logs.slice(-15).join('\n');
      } catch (e) {}
      throw new Error('Pipeline de BallonsTranslator ' + status.status + (status.stage ? ' (' + status.stage + ')' : '') + detail);
    }

    // El main thread de BT ejecuta auto-layout + guardado tras el pipeline; pedir
    // export_translation_json primero drena esa cola y confirma que las traducciones
    // estan en memoria antes de exportar (reintenta si llegaron incompletas).
    const transPath = path.join(imagesDir, 'bt_translations.json');
    let pageTexts = {};
    let pendingPages = -1;
    let failedPages = 0;
    for (let attempt = 0; attempt < 30; attempt++) {
      await apiPost('export_translation_json', { path: transPath }, 10 * 60 * 1000);
      try {
        const transJson = JSON.parse(fs.readFileSync(transPath, 'utf8'));
        const pages = transJson.pages || [];
        pageTexts = {};
        let empty = 0;
        let failed = 0;
        for (const p of pages) {
          const blocks = p.blocks || [];
          let hasEmpty = false;
          let hasFailed = false;
          for (const b of blocks) {
            const t = String((b && b.translation) || '').trim();
            if (!t) hasEmpty = true;
            else if (FAILED_TRANSLATION_RE.test(t)) hasFailed = true;
          }
          if (blocks.length > 0) {
            if (hasEmpty) empty++;
            if (hasFailed) failed++;
          }
          pageTexts[p.page] = {
            originalText: blocks.map(b => b.source).filter(Boolean).join('\n'),
            translatedText: blocks.map(b => b.translation).filter(Boolean).join('\n'),
            translatedBlocks: blocks.filter(b => {
              const t = String((b && b.translation) || '').trim();
              return t && !FAILED_TRANSLATION_RE.test(t);
            }).length
          };
        }
        failedPages = failed;
        pendingPages = empty + failed;
        if (pages.length > 0 && empty === 0) break;
        if (attempt === 29 && onProgress) {
          onProgress({ log: 'Aviso: traducciones incompletas tras reintentos (' + empty + ' pagina(s) pendientes)' });
        }
      } catch (e) {}
      if (attempt < 29) await sleep(3000);
    }
    if (failedPages > 0 && onProgress) {
      onProgress({ log: 'Aviso: ' + failedPages + ' pagina(s) con [Translation failed] (traduccion fallida)' });
    }

    const outDir = path.join(imagesDir, 'bt_export');
    fs.rmSync(outDir, { recursive: true, force: true });
    const exportRst = await apiPost('export', {
      kind: 'rendered_batch',
      out_dir: outDir,
      include_unrendered: true
    }, 10 * 60 * 1000);

    const rendered = [];
    for (const entry of (exportRst.paths || [])) {
      const page = Array.isArray(entry) ? entry[0] : entry.pagename;
      const file = Array.isArray(entry) ? entry[1] : entry.path;
      if (file && fs.existsSync(file)) {
        rendered.push(Object.assign({ page: page, file: file }, pageTexts[page] || { originalText: '', translatedText: '', translatedBlocks: 0 }));
      }
    }
    if (rendered.length === 0) {
      throw new Error('BallonsTranslator no exporto ninguna imagen. Revisa temp/ballons.log\n' + getLogTail());
    }
    return { rendered: rendered, exportDir: outDir, exportMissing: exportRst.missing || [], pendingTranslations: Math.max(pendingPages, 0) };
  };

  // Un solo job a la vez (BT tiene estado unico por instancia)
  const queued = jobChain.then(run, run);
  jobChain = queued.catch(() => {});
  return queued;
}

async function stop() {
  await stopProcess();
}

module.exports = { translateFolder, stop, LANG_NAMES, normalizeLang, BT_DIR, API_PORT };
