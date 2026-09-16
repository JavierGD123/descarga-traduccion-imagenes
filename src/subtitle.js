const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const translate = require('google-translate-api-x');
const { transcribeWithVosk } = require('./vosk');

const FFMPEG_PATH = path.join(__dirname, '..', 'tools', 'ffmpeg-9.0.1-essentials_build', 'bin', 'ffmpeg.exe');
const FFMPEG_DIR = path.join(__dirname, '..', 'tools', 'ffmpeg-9.0.1-essentials_build', 'bin');
const YTDLP_PATH = 'C:\\Users\\javie\\AppData\\Roaming\\Python\\Python314\\Scripts\\yt-dlp.exe';

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

async function downloadVideo(url, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'video.%(ext)s');
  const videoPath = path.join(outputDir, 'video.mp4');

  console.log('Descargando video...');
  await runCommand(YTDLP_PATH, [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', FFMPEG_DIR,
    '-o', outputPath,
    '--no-playlist',
    url
  ]);

  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('video.'));
  if (files.length === 0) throw new Error('No se pudo descargar el video');

  const downloaded = path.join(outputDir, files[0]);
  if (downloaded !== videoPath) {
    fs.renameSync(downloaded, videoPath);
  }

  console.log('Video descargado');
  return videoPath;
}

async function extractAudio(videoPath, outputDir) {
  const audioPath = path.join(outputDir, 'audio.wav');
  console.log('Extrayendo audio...');

  await runCommand(FFMPEG_PATH, [
    '-i', videoPath,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    '-y', audioPath
  ]);

  console.log('Audio extraido');
  return audioPath;
}

async function transcribeAudio(audioPath, engine) {
  if (engine === 'vosk') {
    return await transcribeWithVosk(audioPath);
  }
  return await transcribeWhisper(audioPath);
}

async function transcribeWhisper(audioPath) {
  console.log('Transcribiendo audio con Whisper (puede tardar varios minutos)...');

  const outputDir = path.dirname(audioPath);
  const srtPath = path.join(outputDir, 'audio.srt');

  const pyScript = `
import sys, os, whisper
os.add_dll_directory(r'${FFMPEG_DIR}')
os.environ['PATH'] += r';${FFMPEG_DIR}'
model = whisper.load_model('base')
result = model.transcribe(r'${audioPath}', task='transcribe')
with open(r'${srtPath}', 'w', encoding='utf-8') as f:
    for i, seg in enumerate(result['segments']):
        start = seg['start']
        end = seg['end']
        text = seg['text'].strip()
        sh = int(start // 3600)
        sm = int((start % 3600) // 60)
        ss = start % 60
        eh = int(end // 3600)
        em = int((end % 3600) // 60)
        es = end % 60
        f.write(f'{i+1}\\n')
        f.write(f'{sh:02d}:{sm:02d}:{ss:06.3f} --> {eh:02d}:{em:02d}:{es:06.3f}\\n'.replace('.',','))
        f.write(f'{text}\\n\\n')
print('DONE')
`;

  const pyPath = path.join(outputDir, 'whisper_run.py');
  fs.writeFileSync(pyPath, pyScript, 'utf8');

  await runCommand('python', [pyPath]);
  fs.unlinkSync(pyPath);

  if (fs.existsSync(srtPath)) {
    console.log('Transcripcion completada');
    return fs.readFileSync(srtPath, 'utf8');
  }

  throw new Error('No se genero el archivo SRT');
}

function parseSrt(srtContent) {
  const blocks = srtContent.trim().split(/\n\n+/);
  const entries = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length >= 3) {
      entries.push({
        index: parseInt(lines[0]),
        time: lines[1],
        text: lines.slice(2).join(' ')
      });
    }
  }
  return entries;
}

function srtToVtt(srtContent) {
  let vtt = 'WEBVTT\n\n';
  vtt += srtContent.replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, '$1:$2:$3.$4');
  return vtt;
}

async function translateSrt(srtContent, targetLang) {
  console.log('Traduciendo subtitulos...');
  const entries = parseSrt(srtContent);
  const toLang = targetLang || 'es';

  const translated = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    try {
      const res = await translate(entry.text, { from: 'auto', to: toLang });
      translated.push({ ...entry, text: res.text });
    } catch (e) {
      translated.push(entry);
    }
    process.stdout.write('\rTraduciendo subtitulos: ' + (i + 1) + '/' + entries.length);
    if (i < entries.length - 1) {
      await new Promise(r => setTimeout(r, 600));
    }
  }
  console.log('\n');

  return translated.map((e, i) =>
    (i + 1) + '\n' + e.time + '\n' + e.text
  ).join('\n\n');
}

async function embedSubtitles(videoPath, srtContent, outputDir) {
  const srtPath = path.join(outputDir, 'subtitles.srt');
  const outputPath = path.join(outputDir, 'video_subtitled.mp4');

  fs.writeFileSync(srtPath, srtContent, 'utf8');
  console.log('Insertando subtitulos en el video...');

  const safeSrt = path.join(outputDir, 'subs.srt');
  fs.copyFileSync(srtPath, safeSrt);

  await runCommand(FFMPEG_PATH, [
    '-i', videoPath,
    '-vf', 'subtitles=subs.srt',
    '-c:a', 'copy',
    '-y', outputPath
  ], { cwd: outputDir });

  console.log('Video con subtitulos generado');
  return outputPath;
}

function detectLanguage(srtContent) {
  const entries = parseSrt(srtContent);
  const allText = entries.map(e => e.text).join(' ').toLowerCase();
  const eng = /\b(the|is|are|was|were|have|has|had|will|would|could|should|can|may|might|do|does|did|be|been|being|a|an|and|or|but|in|on|at|to|for|of|with|by|i|you|he|she|it|we|they|my|your|his|her|this|that|what|how|when|where|why|not|no|yes|oh|hey|well|just|like|get|go|come|make|know|think|see|want|look|give|use|find|tell|ask|try|use|work|start|help|show|play|run|move|feel|keep|let|read|stop|write|open|close|walk|wait|believe|call|pay|bring|put|mean|set|turn|leave|get|let|say|tell|said|got|gotta|gonna|wanna|yeah|hey|hi|damn|shit|fuck|oh|wow|really|right|okay|well|sure|cool|nice|great|yes|no|maybe)\b/gi;
  const matches = allText.match(eng) || [];
  return matches.length > entries.length * 0.2 ? 'en' : 'es';
}

module.exports = {
  downloadVideo,
  extractAudio,
  transcribeAudio,
  translateSrt,
  embedSubtitles,
  parseSrt,
  srtToVtt,
  detectLanguage
};
