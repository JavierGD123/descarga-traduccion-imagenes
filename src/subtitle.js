const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const translate = require('google-translate-api-x');
const { transcribeWithVosk } = require('./vosk');

const FFMPEG_PATH = path.join(__dirname, '..', 'tools', 'ffmpeg-9.0.1-essentials_build', 'bin', 'ffmpeg.exe');
const FFMPEG_DIR = path.join(__dirname, '..', 'tools', 'ffmpeg-9.0.1-essentials_build', 'bin');
const YTDLP_PATH = 'C:\\Users\\javie\\AppData\\Roaming\\Python\\Python314\\Scripts\\yt-dlp.exe';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const downloadStates = new Map();
const activeDownloads = new Map();

function initDownloadState(jobId, info) {
  const st = {
    jobId,
    url: (info && info.url) || '',
    mode: (info && info.mode) || 'download',
    status: 'starting',
    pct: 0,
    mb: '',
    totalMb: '',
    speed: '',
    eta: '',
    title: (info && info.title) || '',
    filename: '',
    videoUrl: (info && info.videoUrl) || ('/api/video/' + jobId),
    message: 'Preparando descarga...',
    error: null,
    createdAt: Date.now()
  };
  downloadStates.set(jobId, st);
  return st;
}

function updateDownloadState(jobId, patch) {
  const st = downloadStates.get(jobId);
  if (!st) return null;
  Object.assign(st, patch);
  return st;
}

function getDownloadState(jobId) {
  return downloadStates.get(jobId) || null;
}

function getRecord(jobId) {
  if (!jobId) return null;
  let rec = activeDownloads.get(jobId);
  if (!rec) { rec = { cancelled: false }; activeDownloads.set(jobId, rec); }
  return rec;
}

function assertActive(jobId) {
  const rec = jobId && activeDownloads.get(jobId);
  if (rec && rec.cancelled) throw new Error('Descarga cancelada');
}

function cancelDownload(jobId) {
  const rec = activeDownloads.get(jobId);
  let stopped = false;
  if (rec) {
    rec.cancelled = true;
    stopped = true;
    try { if (rec.proc) rec.proc.kill(); } catch (e) {}
    try { if (rec.browser) rec.browser.close(); } catch (e) {}
  }
  updateDownloadState(jobId, { status: 'cancelled', message: 'Descarga cancelada' });
  return stopped;
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { onLine, jobId, ...spawnOpts } = opts;
    const env = Object.assign({}, process.env, {
      PATH: process.env.PATH + ';' + FFMPEG_DIR
    });
    const proc = spawn(cmd, args, { stdio: 'pipe', windowsHide: true, env, ...spawnOpts });
    const rec = jobId ? getRecord(jobId) : null;
    if (rec) {
      if (rec.cancelled) { try { proc.kill(); } catch (e) {} return reject(new Error('Descarga cancelada')); }
      rec.proc = proc;
    }
    let stdout = '';
    let stderr = '';
    const handle = (chunk, isError) => {
      const text = chunk.toString();
      if (isError) stderr += text; else stdout += text;
      if (onLine) {
        text.split(/[\r\n]+/).forEach(line => { if (line && line.trim()) onLine(line); });
      }
    };
    proc.stdout.on('data', d => handle(d, false));
    proc.stderr.on('data', d => handle(d, true));
    proc.on('close', code => {
      if (rec && rec.proc === proc) rec.proc = null;
      if (rec && rec.cancelled) return reject(new Error('Descarga cancelada'));
      if (code === 0) resolve(stdout);
      else reject(new Error(((stderr || stdout) + '').slice(-4000) || 'Exit code ' + code));
    });
    proc.on('error', reject);
  });
}

function isDirectMediaUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return /\.(mp4|mkv|webm|avi|mov|flv|wmv)$/i.test(pathname);
  } catch { return false; }
}

const PUPPETEER_SITES = ['fpo.xxx'];
const PAGE_EXTRACT_SITES = ['hackstore.mx', 'peliculas-gratis.com.mx'];
const YTDLP_SITES = ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', 'facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com', 'pornhub.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'xnxx.com', 'xvideos.com', 'bilibili.com', 'twitch.tv', 'streamable.com', 'reddit.com', 'tumblr.com', 'v.qq.com', 'nicovideo.jp', 'soundcloud.com'];

function matchesHost(hostname, list) {
  return list.some(s => hostname === s || hostname.endsWith('.' + s));
}

function getVideoStrategy(url) {
  try {
    if (isDirectMediaUrl(url)) return 'direct-http';
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (matchesHost(hostname, PUPPETEER_SITES)) return 'puppeteer';
    if (matchesHost(hostname, PAGE_EXTRACT_SITES)) return 'page-extract';
    return 'yt-dlp';
  } catch {
    return 'yt-dlp';
  }
}

async function extractVideoUrls(pageUrl) {
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    console.log('Extrayendo URLs de video desde pagina...');
    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const title = await page.title();
      if (!title.includes('momento') && !title.includes('moment') && !title.includes('Checking')) break;
    }

    const result = await page.evaluate(() => {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent || '';
        const match = text.match(/var\s+flashvars\s*=\s*\{[\s\S]*?\};/);
        if (match) {
          try {
            const objStr = match[0].replace('var flashvars = ', '').replace(/;$/, '');
            const flashvars = new Function('return ' + objStr)();
            return {
              videoUrl: flashvars.video_url || null,
              videoUrlText: flashvars.video_url_text || 'LQ',
              altUrl: flashvars.video_alt_url || null,
              altUrlText: flashvars.video_alt_url_text || 'HQ',
              altUrlHd: flashvars.video_alt_url_hd === '1',
              title: flashvars.video_title || document.title
            };
          } catch (e) {}
        }
      }
      return null;
    });

    return result;
  } finally {
    await browser.close();
  }
}

async function downloadVideoDirect(url, outputPath, onProgress, opts = {}) {
  const response = await axios({
    method: 'GET',
    url: url,
    responseType: 'stream',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': opts.referer || new URL(url).origin
    },
    timeout: 600000
  });

  const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
  let downloadedBytes = 0;

  const writer = fs.createWriteStream(outputPath);
  return new Promise((resolve, reject) => {
    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (onProgress && totalBytes > 0) {
        const pct = Math.round((downloadedBytes / totalBytes) * 100);
        const mb = (downloadedBytes / 1048576).toFixed(1);
        const totalMb = (totalBytes / 1048576).toFixed(1);
        onProgress(pct, mb, totalMb);
      }
    });
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MEDIA_URL_RE = /\.(m3u8|mpd|mp4|webm|mkv|mov|m4v)(\?|#|$)/i;
const AD_URL_RE = /(doubleclick|googlesyndication|adsanalytics|agl003|5gvci|adnxs|cvt-s2|\/ads?\b|\/vast\b|beacon|pubads|adsystem|recaptcha)/i;
const EMBED_PATH_RE = /\/(e|embed|embeds|player|stream|video|play|v)\//i;

function classifyMedia(u, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('mpegurl') || ct.includes('dash+xml')) return 'hls';
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(u)) return 'hls';
  return 'file';
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch (e) { return String(u).substring(0, 60); }
}

function normalizeUrl(u) {
  try { return new URL(u).href.replace(/\/+$/, ''); } catch (e) { return String(u || '').replace(/\/+$/, ''); }
}

function cleanTitle(t) {
  if (!t) return '';
  let s = String(t).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(Descargar|Ver)\s+(Pel[ií]cula|Serie|Anime|Video)\s+/i, '');
  s = s.replace(/\s*[-|]\s*(Hackstore(\.MX)?(\s*Oficial.*)?|Pel[ií]culas\s*Gratis(\.com\.mx)?|YouTube)\s*$/i, '');
  s = s.replace(/^[\s\-–—|]+|[\s\-–—|]+$/g, '');
  return s.slice(0, 120);
}

function friendlyYtdlpError(msg) {
  if (!msg) return '';
  const lines = String(msg).split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
  const errs = lines.filter(s => /^ERROR/i.test(s));
  if (errs.length) return errs[errs.length - 1].replace(/^ERROR:\s*/i, '');
  const last = lines[lines.length - 1] || '';
  return last.slice(0, 300);
}

function isEmbedUrl(u) {
  try {
    const url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return false;
    if (AD_URL_RE.test(u) || MEDIA_URL_RE.test(u)) return false;
    return EMBED_PATH_RE.test(url.pathname) || /\.html?$/i.test(url.pathname);
  } catch (e) { return false; }
}

function collectStrings(value, out, depth) {
  if (depth > 8 || out.length > 300) return;
  if (typeof value === 'string') { out.push(value); return; }
  if (Array.isArray(value)) { value.forEach(v => collectStrings(v, out, depth + 1)); return; }
  if (value && typeof value === 'object') {
    Object.keys(value).forEach(k => collectStrings(value[k], out, depth + 1));
  }
}

async function extractMediaFromPage(pageUrl, opts = {}) {
  const { jobId, onStatus, probeUrls } = opts;
  const puppeteer = require('puppeteer-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  puppeteer.use(StealthPlugin());

  const candidates = new Map();
  const frames = [];
  const probed = [];
  let pageTitle = '';

  const note = (u, resourceType, fromVideo, contentType) => {
    if (!u || !/^https?:/i.test(u)) return;
    if (AD_URL_RE.test(u)) return;
    const isMedia = MEDIA_URL_RE.test(u)
      || resourceType === 'media'
      || resourceType === 'manifest'
      || /mpegurl|dash\+xml|video\/mp4|video\/webm|video\/quicktime/i.test(String(contentType || ''));
    if (!isMedia) return;
    const existing = candidates.get(u);
    if (existing) { if (fromVideo) existing.fromVideo = true; return; }
    candidates.set(u, { url: u, kind: classifyMedia(u, contentType), fromVideo: !!fromVideo });
  };

  const addFrame = (u) => {
    if (!u || !/^https?:/i.test(u) || AD_URL_RE.test(u)) return;
    const norm = normalizeUrl(u);
    if (probed.indexOf(norm) !== -1) return;
    if (norm === normalizeUrl(pageUrl)) return;
    if (frames.some(f => normalizeUrl(f) === norm)) return;
    frames.push(u);
  };

  const rec = jobId ? getRecord(jobId) : null;
  if (rec && rec.cancelled) throw new Error('Descarga cancelada');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required']
  });
  if (rec) {
    rec.browser = browser;
    if (rec.cancelled) { await browser.close().catch(() => {}); throw new Error('Descarga cancelada'); }
  }

  try {
    const collectJson = async (r) => {
      let text;
      try { text = await r.text(); } catch (e) { return; }
      if (!text || text.length > 1000000) return;
      const trimmed = text.replace(/^\s+/, '');
      if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
      let obj;
      try { obj = JSON.parse(trimmed); } catch (e) { return; }
      const strings = [];
      collectStrings(obj, strings, 0);
      strings.forEach(s => {
        if (typeof s !== 'string' || !/^https?:/i.test(s)) return;
        if (MEDIA_URL_RE.test(s)) {
          note(s, 'media', false, /m3u8/i.test(s) ? 'application/vnd.apple.mpegurl' : '');
        } else if (isEmbedUrl(s)) {
          addFrame(s);
        }
      });
    };

    const hook = (pg) => {
      pg.on('request', r => {
        try {
          const rt = r.resourceType();
          note(r.url(), rt, rt === 'media', '');
        } catch (e) {}
      });
      pg.on('response', r => {
        try {
          const headers = r.headers();
          const ct = headers['content-type'] || '';
          const rt = r.request().resourceType();
          note(r.url(), rt, false, ct);
          if ((rt === 'fetch' || rt === 'xhr') && /json/i.test(ct)) collectJson(r);
        } catch (e) {}
      });
    };

    const collectVideoSrcs = async (pg) => {
      try {
        const srcs = await pg.evaluate(() => {
          const out = [];
          document.querySelectorAll('video, video source').forEach(el => {
            ['src', 'currentSrc'].forEach(k => {
              if (el[k] && typeof el[k] === 'string') out.push(el[k]);
            });
          });
          return out;
        });
        srcs.forEach(s => note(s, 'media', true, ''));
      } catch (e) {}
    };

    const collectFramesOf = (pg) => {
      let self = '';
      try { self = normalizeUrl(pg.url()); } catch (e) {}
      for (const f of pg.frames()) {
        try {
          const u = f.url();
          if (!u || !/^https?:/i.test(u)) continue;
          if (normalizeUrl(u) === self) continue;
          addFrame(u);
        } catch (e) {}
      }
    };

    const clickPlayerControls = async (pg) => {
      const selector = 'button, [role="tab"], [class*="server"], [class*="srv"], [class*="pill"], [class*="tab"], [class*="play"], [class*="option"]';
      let targets = [];
      try {
        targets = await pg.evaluate((sel) => {
          const out = [];
          const rx = /server|reproduc|play|ver ahora|ver en|calidad|fuente|source|tab|pill|opci[oó]n|continuar|comenzar|iniciar/i;
          document.querySelectorAll(sel).forEach(el => {
            if (out.length >= 8) return;
            const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
            const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
            if (!rx.test(txt) && !rx.test(cls)) return;
            if (el.tagName === 'A' && /^https?:/i.test(el.getAttribute('href') || '')) return;
            const r = el.getBoundingClientRect();
            if (r.width > 2 && r.height > 2 && txt.length <= 40) out.push(txt || cls.slice(0, 40));
          });
          return out;
        }, selector);
      } catch (e) {}

      for (const txt of targets) {
        if (candidates.size) break;
        assertActive(jobId);
        try {
          await pg.evaluate((sel, wanted) => {
            const els = Array.from(document.querySelectorAll(sel));
            const el = els.find(e => (e.innerText || '').replace(/\s+/g, ' ').trim() === wanted && e.getBoundingClientRect().width > 2);
            if (el) el.click();
          }, selector, txt);
        } catch (e) {}
        await sleep(1600);
        await collectVideoSrcs(pg);
        collectFramesOf(pg);
      }
    };

    const probePage = async (target, isMain) => {
      const pg = await browser.newPage();
      try {
        await pg.setUserAgent(USER_AGENT);
        await pg.setViewport({ width: 1366, height: 768 });
        hook(pg);

        if (onStatus) onStatus(isMain ? 'Abriendo pagina...' : 'Analizando reproductor: ' + hostOf(target));
        await pg.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

        const rounds = isMain ? 5 : 3;
        for (let i = 0; i < rounds; i++) {
          await sleep(3000);
          const t = await pg.title().catch(() => '');
          if (t) {
            if (!pageTitle) pageTitle = t;
            if (!/momento|moment|checking|just a|verifying/i.test(t)) break;
          }
        }
        if (!pageTitle && isMain) pageTitle = await pg.title().catch(() => '');

        await pg.evaluate(async () => {
          const h = document.body.scrollHeight;
          for (let p = 0; p < h; p += 600) {
            window.scrollTo(0, p);
            await new Promise(r => setTimeout(r, 150));
          }
          window.scrollTo(0, 0);
        }).catch(() => {});

        await sleep(2500);
        await collectVideoSrcs(pg);
        collectFramesOf(pg);

        if (candidates.size === 0) {
          await clickPlayerControls(pg);
          await sleep(1500);
          await collectVideoSrcs(pg);
          collectFramesOf(pg);
        }
      } catch (e) {
        console.log('Fallo al analizar ' + target + ': ' + e.message);
      } finally {
        await pg.close().catch(() => {});
      }
    };

    const targets = (probeUrls && probeUrls.length) ? probeUrls : [pageUrl];
    probed.push(normalizeUrl(pageUrl));
    targets.forEach(t => probed.push(normalizeUrl(t)));

    for (const target of targets) {
      assertActive(jobId);
      await probePage(target, normalizeUrl(target) === normalizeUrl(pageUrl));
    }

    if (onStatus) {
      onStatus(candidates.size
        ? 'Fuentes encontradas: ' + candidates.size
        : 'No se detecto video automaticamente');
    }

    return { media: [...candidates.values()], frames: frames.slice(), title: pageTitle };
  } finally {
    if (rec && rec.browser === browser) rec.browser = null;
    await browser.close().catch(() => {});
  }
}

function orderCandidates(list, quality) {
  const wantHls = !quality || quality === 'best';
  const score = c => (c.fromVideo ? 8 : 0) + (c.kind === 'hls' ? (wantHls ? 4 : 0) : 2);
  return [...list].sort((a, b) => score(b) - score(a));
}

function ytdlpFormatArgs(quality) {
  if (quality && quality !== 'best') {
    return ['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'];
  }
  return ['-f', 'bestvideo+bestaudio/best'];
}

function parseYtdlpLine(line, onProgress) {
  if (!onProgress) return;
  const m = line.match(/\[download\]\s+([\d.]+)%/);
  if (m) {
    const pct = Math.min(100, Math.floor(parseFloat(m[1])));
    const got = line.match(/\[download\]\s+([\d.]+[KMGT]?i?B)\s+of/);
    const total = line.match(/of\s+~?\s*([\d.]+[KMGT]?i?B)/);
    const speed = line.match(/at\s+([\d.]+[KMGT]?i?B\/s)/);
    const eta = line.match(/ETA\s+(\S+)/);
    const parts = ['Descargando: ' + pct + '%'];
    if (got && total) parts.push(got[1] + ' / ' + total[1]);
    if (speed) parts.push(speed[1]);
    if (eta && !/Unknown/i.test(eta[1])) parts.push('ETA ' + eta[1]);
    onProgress(pct, got ? got[1] : '', total ? total[1] : '', parts.join(' · '));
    return;
  }
  if (/^\[(Merger|ffmpeg|ExtractAudio|VideoConvertor|Fixup)/.test(line)) {
    onProgress(99, '', '', 'Procesando y uniendo pistas...');
  }
}

async function ytdlpDownload(target, outputDir, quality, opts = {}) {
  const { jobId, onProgress, referer, onStatus } = opts;
  assertActive(jobId);
  if (onStatus) onStatus('Descargando con yt-dlp...');
  const args = [
    ...ytdlpFormatArgs(quality),
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', FFMPEG_DIR,
    '--newline',
    '--progress',
    '--no-playlist',
    '--retries', '3',
    '--socket-timeout', '20',
    ...(referer ? ['--referer', referer] : []),
    '-o', path.join(outputDir, 'video.%(ext)s'),
    target
  ];
  await runCommand(YTDLP_PATH, args, { jobId, onLine: line => parseYtdlpLine(line, onProgress) });
  return finalizeVideo(outputDir);
}

async function probeTitle(url, referer) {
  const out = await runCommand(YTDLP_PATH, [
    '--skip-download',
    '--print', '%(title)s',
    '--no-playlist',
    '--no-warnings',
    '--socket-timeout', '20',
    ...(referer ? ['--referer', referer] : []),
    url
  ]);
  const line = (out || '').split(/[\r\n]+/).map(s => s.trim()).filter(s => s && s[0] !== '[')[0];
  return cleanTitle(line || '');
}

function finalizeVideo(outputDir) {
  const videoPath = path.join(outputDir, 'video.mp4');
  const files = fs.readdirSync(outputDir).filter(f => /^video\./.test(f) && !/\.part(\d+)?$/.test(f));
  if (files.length === 0) throw new Error('No se pudo descargar el video');
  const downloaded = path.join(outputDir, files[0]);
  if (downloaded !== videoPath) {
    if (fs.existsSync(videoPath)) fs.rmSync(videoPath, { force: true });
    fs.renameSync(downloaded, videoPath);
  }
  return videoPath;
}

async function downloadViaPageExtract(url, outputDir, quality, onProgress, opts = {}) {
  const { jobId, onStatus } = opts;
  const videoPath = path.join(outputDir, 'video.mp4');

  const cleanOutputs = () => {
    try {
      fs.readdirSync(outputDir).forEach(f => {
        if (/^video\./.test(f) || /\.part(\d+)?$/.test(f)) {
          try { fs.rmSync(path.join(outputDir, f), { force: true }); } catch (e) {}
        }
      });
    } catch (e) {}
  };

  const first = await extractMediaFromPage(url, { jobId, onStatus });
  const title = cleanTitle(first.title);
  if (title) updateDownloadState(jobId, { title });

  const attemptMedia = async (list) => {
    const ordered = orderCandidates(list, quality);
    for (const cand of ordered.slice(0, 6)) {
      assertActive(jobId);
      cleanOutputs();
      const candOrigin = (() => { try { return new URL(cand.url).origin; } catch (e) { return null; } })();
      const referers = cand.kind === 'file'
        ? [url, candOrigin].filter(Boolean)
        : [candOrigin ? candOrigin + '/' : null, url].filter(Boolean);
      if (onStatus) onStatus('Fuente detectada: ' + hostOf(cand.url) + ' (' + (cand.kind === 'hls' ? 'streaming' : 'archivo') + ')');

      let lastErr = null;
      for (const referer of referers) {
        assertActive(jobId);
        cleanOutputs();
        try {
          if (cand.kind === 'file') {
            if (onProgress) onProgress(0, '0', '0', 'Descargando archivo de video...');
            await downloadVideoDirect(cand.url, videoPath, onProgress, { referer });
          } else {
            await ytdlpDownload(cand.url, outputDir, quality, { jobId, onProgress, referer, onStatus });
          }
          console.log('Video descargado desde ' + hostOf(cand.url));
          return { path: videoPath, title };
        } catch (e) {
          if (/cancelada/i.test(e.message)) throw e;
          lastErr = e;
        }
      }
      console.log('Fallo fuente ' + hostOf(cand.url) + ': ' + (friendlyYtdlpError(lastErr && lastErr.message) || (lastErr && lastErr.message) || ''));
    }
    return null;
  };

  if (first.media.length) {
    const res = await attemptMedia(first.media);
    if (res) return res;
  }

  const tryFrames = async (frameList) => {
    for (const frameUrl of frameList.slice(0, 6)) {
      assertActive(jobId);
      const frameOrigin = (() => { try { return new URL(frameUrl).origin; } catch (e) { return null; } })();
      const referers = [frameOrigin ? frameOrigin + '/' : null, url].filter(Boolean);
      if (onStatus) onStatus('Probando reproductor: ' + hostOf(frameUrl));

      let lastErr = null;
      for (const referer of referers) {
        assertActive(jobId);
        cleanOutputs();
        try {
          await ytdlpDownload(frameUrl, outputDir, quality, { jobId, onProgress, referer, onStatus });
          console.log('Video descargado desde ' + hostOf(frameUrl));
          return { path: videoPath, title };
        } catch (e) {
          if (/cancelada/i.test(e.message)) throw e;
          lastErr = e;
        }
      }
      console.log('yt-dlp fallo en ' + hostOf(frameUrl) + ': ' + (friendlyYtdlpError(lastErr && lastErr.message) || (lastErr && lastErr.message) || ''));
    }
    return null;
  };

  if (first.frames.length) {
    const res = await tryFrames(first.frames);
    if (res) return res;

    const deepTargets = first.frames.filter(f => f !== url).slice(0, 4);
    if (deepTargets.length) {
      if (onStatus) onStatus('Abriendo reproductores...');
      const deep = await extractMediaFromPage(url, { jobId, onStatus, probeUrls: deepTargets });
      if (deep.media.length) {
        const res2 = await attemptMedia(deep.media);
        if (res2) return res2;
      }
      const extra = deep.frames.filter(f => deepTargets.indexOf(f) === -1);
      if (extra.length) {
        const res3 = await tryFrames(extra);
        if (res3) return res3;
      }
    }
  }

  throw new Error('No se encontro ningun video descargable en la pagina');
}

async function downloadVideo(url, outputDir, quality, onProgress, opts = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const jobId = opts.jobId;
  const videoPath = path.join(outputDir, 'video.mp4');
  const status = msg => {
    if (opts.onStatus) opts.onStatus(msg);
    if (onProgress) onProgress(0, '0', '0', msg);
  };

  const strategy = getVideoStrategy(url);
  console.log('Estrategia de descarga: ' + strategy + ' para ' + url.substring(0, 80));

  try {
    if (strategy === 'direct-http') {
      status('Descargando archivo directo...');
      await downloadVideoDirect(url, videoPath, onProgress, { referer: new URL(url).origin });
      console.log('Video descargado');
      let title = opts.titleHint || '';
      if (!title) {
        try {
          const base = decodeURIComponent(path.basename(new URL(url).pathname));
          title = cleanTitle(base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_\-.]+/g, ' '));
        } catch (e) {}
      }
      return { path: videoPath, title };
    }

    if (strategy === 'puppeteer') {
      let videoUrls;
      try {
        videoUrls = await extractVideoUrls(url);
      } catch (e) {
        console.log('Puppeteer fallo, intentando yt-dlp: ' + e.message);
        videoUrls = null;
      }

      if (videoUrls && (videoUrls.videoUrl || videoUrls.altUrl)) {
        const wantHq = !quality || quality === 'best' || quality === 'hq';
        let downloadUrl = null;
        let qualityLabel = '';

        if (wantHq && videoUrls.altUrl) {
          downloadUrl = videoUrls.altUrl;
          qualityLabel = videoUrls.altUrlText || 'HQ';
        } else if (videoUrls.videoUrl) {
          downloadUrl = videoUrls.videoUrl;
          qualityLabel = videoUrls.videoUrlText || 'LQ';
        } else {
          downloadUrl = videoUrls.altUrl;
          qualityLabel = videoUrls.altUrlText || 'HQ';
        }

        status('Calidad detectada: ' + qualityLabel);
        await downloadVideoDirect(downloadUrl, videoPath, onProgress, { referer: url });
        console.log('Video descargado (' + qualityLabel + ')');
        return { path: videoPath, title: cleanTitle(videoUrls.title) };
      }
    }

    if (strategy === 'page-extract') {
      status('Analizando la pagina y su reproductor...');
      try {
        const res = await downloadViaPageExtract(url, outputDir, quality, onProgress, opts);
        console.log('Video descargado');
        return res;
      } catch (e) {
        if (/cancelada/i.test(e.message)) throw e;
        console.log('Extraccion de pagina fallo, probando yt-dlp: ' + e.message);
        status('Probando con yt-dlp...');
        try {
          const title = await probeTitle(url);
          await ytdlpDownload(url, outputDir, quality, { jobId, onProgress, onStatus: status, referer: url });
          console.log('Video descargado');
          return { path: videoPath, title };
        } catch (e2) {
          if (/cancelada/i.test(e2.message)) throw e2;
          throw new Error(e.message);
        }
      }
    }

    status('Obteniendo informacion del video...');
    let title = '';
    try {
      title = await probeTitle(url);
    } catch (e) {
      if (/cancelada/i.test(e.message)) throw e;
      console.log('yt-dlp no soporta la URL, analizando la pagina: ' + e.message);
      try {
        const res = await downloadViaPageExtract(url, outputDir, quality, onProgress, opts);
        console.log('Video descargado');
        return res;
      } catch (e2) {
        if (/cancelada/i.test(e2.message)) throw e2;
        throw new Error(friendlyYtdlpError(e2.message) || friendlyYtdlpError(e.message) || 'No se pudo obtener el video');
      }
    }

    status('Descargando con yt-dlp...');
    try {
      await ytdlpDownload(url, outputDir, quality, { jobId, onProgress, onStatus: status, referer: url });
    } catch (e) {
      if (/cancelada/i.test(e.message)) throw e;
      console.log('yt-dlp fallo, analizando la pagina: ' + e.message);
      status('La descarga fallo, analizando la pagina...');
      const res = await downloadViaPageExtract(url, outputDir, quality, onProgress, opts);
      console.log('Video descargado');
      return res;
    }

    console.log('Video descargado');
    return { path: videoPath, title };
  } catch (e) {
    const rec = jobId && activeDownloads.get(jobId);
    if (rec && rec.cancelled) throw new Error('Descarga cancelada');
    throw e;
  }
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
  extractVideoUrls,
  extractMediaFromPage,
  getVideoStrategy,
  initDownloadState,
  updateDownloadState,
  getDownloadState,
  cancelDownload,
  extractAudio,
  transcribeAudio,
  translateSrt,
  embedSubtitles,
  parseSrt,
  srtToVtt,
  detectLanguage
};
