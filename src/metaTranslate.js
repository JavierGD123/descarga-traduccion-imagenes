const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BT_DIR = process.env.BT_DIR || 'C:\\Proyectos\\BallonsTranslator-Pro';
const TRANSLATE_TIMEOUT_MS = 300000;

let child = null;
let buffer = '';
let nextId = 1;
const pending = new Map();

function rejectAll(err) {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(err);
  }
  pending.clear();
}

function ensureChild() {
  if (child) return child;
  const python = path.join(BT_DIR, '.venv', 'Scripts', 'python.exe');
  const script = path.join(__dirname, '..', 'scripts', 'nllb-server.py');
  if (!fs.existsSync(python)) {
    throw new Error('Modelo Meta no disponible: falta el .venv de BallonsTranslator');
  }
  if (!fs.existsSync(script)) {
    throw new Error('Modelo Meta no disponible: falta scripts/nllb-server.py');
  }
  child = spawn(python, ['-u', script], { cwd: BT_DIR, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buffer += d;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.translations || []);
    }
  });
  child.stderr.on('data', d => {
    const s = String(d).trim();
    if (s) console.log('[nllb] ' + s.slice(-200));
  });
  child.on('exit', code => {
    child = null;
    rejectAll(new Error('proceso NLLB terminado (codigo ' + code + ')'));
  });
  child.on('error', err => {
    child = null;
    rejectAll(err);
  });
  child.unref();
  return child;
}

process.on('exit', () => {
  if (child) {
    try {
      child.kill();
    } catch (e) {}
  }
});

function translateBatch(texts, targetLang, sourceLang) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(texts) || texts.length === 0) {
      resolve([]);
      return;
    }
    let c;
    try {
      c = ensureChild();
    } catch (e) {
      reject(e);
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('timeout del modelo Meta'));
      }
    }, TRANSLATE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      c.stdin.write(JSON.stringify({ id, texts, target: targetLang, source: sourceLang || 'en' }) + '\n');
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

module.exports = { translateBatch };
