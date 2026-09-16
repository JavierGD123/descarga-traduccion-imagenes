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
result = model.transcribe(r'${audioPath}', task='transcribe', word_timestamps=True)
with open(r'${srtPath}', 'w', encoding='utf-8') as f:
    idx = 1
    for seg in result['segments']:
        words = seg.get('words', [])
        if not words:
            text = seg['text'].strip()
            if not text:
                continue
            start = seg['start']
            end = seg['end']
            sh = int(start // 3600)
            sm = int((start % 3600) // 60)
            ss = start % 60
            eh = int(end // 3600)
            em = int((end % 3600) // 60)
            es = end % 60
            f.write(f'{idx}\\n')
            f.write(f'{sh:02d}:{sm:02d}:{ss:06.3f} --> {eh:02d}:{em:02d}:{es:06.3f}\\n'.replace('.',','))
            f.write(f'{text}\\n\\n')
            idx += 1
            continue
        i = 0
        while i < len(words):
            chunk = words[i:i+3]
            start = chunk[0]['start']
            end = chunk[-1]['end']
            text = ' '.join(w['word'].strip() for w in chunk)
            if not text:
                i += len(chunk)
                continue
            sh = int(start // 3600)
            sm = int((start % 3600) // 60)
            ss = start % 60
            eh = int(end // 3600)
            em = int((end % 3600) // 60)
            es = end % 60
            f.write(f'{idx}\\n')
            f.write(f'{sh:02d}:{sm:02d}:{ss:06.3f} --> {eh:02d}:{em:02d}:{es:06.3f}\\n'.replace('.',','))
            f.write(f'{text}\\n\\n')
            idx += 1
            i += len(chunk)
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
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalized.trim().split(/\n\n+/);
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

function parseTime(timeStr) {
  const parts = timeStr.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!parts) return 0;
  return parseInt(parts[1]) * 3600 + parseInt(parts[2]) * 60 + parseInt(parts[3]) + parseInt(parts[4]) / 1000;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function refineSrt(srtContent) {
  const entries = parseSrt(srtContent);
  if (entries.length === 0) return srtContent;

  const MAX_DURATION = 4.0;
  const MAX_WORDS = 6;
  const GAP = 0.1;
  const result = [];

  for (const entry of entries) {
    const timeParts = entry.time.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (!timeParts) {
      result.push(entry);
      continue;
    }

    const start = parseTime(timeParts[1]);
    const end = parseTime(timeParts[2]);
    const duration = end - start;
    const words = entry.text.split(/\s+/);

    if (duration <= MAX_DURATION && words.length <= MAX_WORDS) {
      result.push(entry);
      continue;
    }

    const chunks = [];
    if (duration > MAX_DURATION && words.length > MAX_WORDS) {
      const wordCount = words.length;
      const chunksNeeded = Math.max(Math.ceil(duration / MAX_DURATION), Math.ceil(wordCount / MAX_WORDS));
      const wordsPerChunk = Math.ceil(wordCount / chunksNeeded);
      const timePerChunk = duration / chunksNeeded;

      for (let i = 0; i < words.length; i += wordsPerChunk) {
        const chunkWords = words.slice(i, i + wordsPerChunk);
        chunks.push({
          words: chunkWords,
          start: start + (i / wordCount) * duration,
          end: start + ((i + chunkWords.length) / wordCount) * duration
        });
      }
    } else if (duration > MAX_DURATION) {
      const chunksNeeded = Math.ceil(duration / MAX_DURATION);
      const timePerChunk = duration / chunksNeeded;
      const wordsPerChunk = Math.ceil(words.length / chunksNeeded);

      for (let i = 0; i < words.length; i += wordsPerChunk) {
        const chunkWords = words.slice(i, i + wordsPerChunk);
        const chunkStart = start + (i / words.length) * duration;
        const chunkEnd = start + ((i + chunkWords.length) / words.length) * duration;
        chunks.push({ words: chunkWords, start: chunkStart, end: chunkEnd });
      }
    } else {
      const chunksNeeded = Math.ceil(words.length / MAX_WORDS);
      const wordsPerChunk = Math.ceil(words.length / chunksNeeded);

      for (let i = 0; i < words.length; i += wordsPerChunk) {
        const chunkWords = words.slice(i, i + wordsPerChunk);
        const chunkStart = start + (i / words.length) * duration;
        const chunkEnd = start + ((i + chunkWords.length) / words.length) * duration;
        chunks.push({ words: chunkWords, start: chunkStart, end: chunkEnd });
      }
    }

    for (const chunk of chunks) {
      result.push({
        index: 0,
        time: `${formatTime(chunk.start)} --> ${formatTime(chunk.end)}`,
        text: chunk.words.join(' ')
      });
    }
  }

  let lastEnd = 0;
  for (const entry of result) {
    const timeParts = entry.time.match(/(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/);
    if (timeParts) {
      let start = parseTime(timeParts[1]);
      const end = parseTime(timeParts[2]);

      if (start < lastEnd) {
        start = lastEnd + GAP;
      }

      entry.time = `${formatTime(start)} --> ${formatTime(end)}`;
      lastEnd = end;
    }
  }

  return result.map((e, i) =>
    (i + 1) + '\n' + e.time + '\n' + e.text
  ).join('\n\n');
}

function srtToVtt(srtContent) {
  let vtt = 'WEBVTT\n\n';
  vtt += srtContent.replace(/(\d{2}):(\d{2}):(\d{2}),(\d{3})/g, '$1:$2:$3.$4');
  return vtt;
}

async function translateSrt(srtContent, targetLang, onProgress) {
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
      console.log('Error traduciendo entrada ' + (i+1) + ':', e.message);
      translated.push(entry);
    }
    if (onProgress) {
      onProgress(i + 1, entries.length, entry.text.substring(0, 30));
    }
    if (i < entries.length - 1) {
      await new Promise(r => setTimeout(r, 600));
    }
  }
  console.log('Traduccion completada: ' + translated.length + ' entradas');

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
  detectLanguage,
  refineSrt
};
