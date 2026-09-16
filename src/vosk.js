const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const FFMPEG_PATH = path.join(__dirname, '..', 'tools', 'ffmpeg-9.0.1-essentials_build', 'bin', 'ffmpeg.exe');
const FFMPEG_DIR = path.join(__dirname, '..', 'tools', 'ffmpeg-9.0.1-essentials_build', 'bin');
const PYTHON_PATH = 'python';
const VOSK_SCRIPT = path.join(__dirname, 'vosk_transcribe.py');
const MODEL_DIR = path.join(__dirname, '..', 'models', 'vosk');
const MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip';

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      PATH: process.env.PATH + ';' + FFMPEG_DIR
    });
    const proc = spawn(cmd, args, { stdio: 'pipe', windowsHide: true, env, ...opts });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || 'Exit code ' + code));
    });
    proc.on('error', reject);
  });
}

async function ensureModel() {
  if (fs.existsSync(MODEL_DIR)) {
    const files = fs.readdirSync(MODEL_DIR);
    if (files.length > 3) return;
  }

  console.log('Descargando modelo Vosk (espanol, ~50MB)...');
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  const modelsParentDir = path.dirname(MODEL_DIR);
  const zipPath = path.join(modelsParentDir, 'model.zip');
  const extractDir = path.join(modelsParentDir, 'model_extract');

  const psDownload = `$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -Uri '${MODEL_URL}' -OutFile '${zipPath}'`;
  await runCommand('powershell', ['-Command', psDownload]);

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 1000000) {
    throw new Error('Error descargando modelo Vosk');
  }

  console.log('Extrayendo modelo...');
  fs.mkdirSync(extractDir, { recursive: true });
  await runCommand('powershell', ['-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`]);

  const extractedDirs = fs.readdirSync(extractDir).filter(f =>
    fs.statSync(path.join(extractDir, f)).isDirectory()
  );

  if (extractedDirs.length > 0) {
    const extractedPath = path.join(extractDir, extractedDirs[0]);
    if (fs.existsSync(MODEL_DIR)) fs.rmSync(MODEL_DIR, { recursive: true, force: true });
    fs.renameSync(extractedPath, MODEL_DIR);
  }

  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });

  console.log('Modelo Vosk descargado');
}

async function transcribeWithVosk(audioPath) {
  await ensureModel();

  const outputDir = path.dirname(audioPath);
  const srtPath = path.join(outputDir, 'audio_vosk.srt');

  console.log('Transcribiendo con Vosk...');
  const result = await runCommand(PYTHON_PATH, [VOSK_SCRIPT, audioPath, srtPath]);

  if (result && result.trim().startsWith('DONE:')) {
    const count = parseInt(result.trim().split(':')[1]);
    console.log('Vosk: ' + count + ' bloques de texto');
  }

  if (fs.existsSync(srtPath)) {
    return fs.readFileSync(srtPath, 'utf8');
  }

  throw new Error('No se genero el archivo SRT con Vosk');
}

module.exports = { transcribeWithVosk, ensureModel };
