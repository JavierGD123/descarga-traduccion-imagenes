const translate = require('google-translate-api-x');
const metaBridge = require('./metaTranslate');

const CONCURRENCY = 5;

const GOOGLE_TO = { es: 'es', en: 'en', pt: 'pt', fr: 'fr', de: 'de', it: 'it', ja: 'ja', ko: 'ko', zh: 'zh-CN', ru: 'ru' };

function isEnglish(text) {
  if (!text || text.trim().length < 3) return false;
  const englishWords = /\b(the|is|are|was|were|have|has|had|will|would|could|should|can|may|might|do|does|did|be|been|being|a|an|and|or|but|in|on|at|to|for|of|with|by|from|as|into|through|during|before|after|out|off|over|under|then|here|there|when|where|why|how|all|each|every|both|few|more|most|other|some|such|no|not|only|own|same|so|than|too|very|just|because|if|about|up|down|now|new|old|good|bad|big|small|long|short|first|last|next|this|that|these|those|what|which|who|it|its|my|your|his|her|our|their|me|him|us|them|hey|hello|thank|please|yes|ok|love|hate|like|want|need|go|come|see|look|find|give|take|make|know|think|say|ask|try|use|work|start|help|show|play|run|move|feel|keep|let|read|stop|write|open|close|walk|wait|believe|call|pay|bring|put|mean|set|turn|leave|get|let|say|tell|said|got|gotta|gonna|wanna|yeah|hey|hi|damn|shit|fuck|oh|wow|really|right|okay|well|sure|cool|nice|great|yes|no|maybe)\b/i;
  const words = text.split(/\s+/).filter(w => w.length > 1);
  if (words.length === 0) return false;
  let count = 0;
  for (const word of words) {
    if (englishWords.test(word)) count++;
  }
  return count / words.length > 0.1;
}

async function translateText(text, to) {
  if (!text || text.trim().length === 0) return '';
  try {
    const res = await translate(text, { from: 'en', to: (to && GOOGLE_TO[to]) || to || 'es' });
    return res.text;
  } catch (error) {
    console.log('Error traduciendo:', error.message);
    return text;
  }
}

function translatePool(tasks, onProgress) {
  let completed = 0;
  const total = tasks.length;
  const results = [];

  function runNext() {
    if (tasks.length === 0) return Promise.resolve();
    const task = tasks.shift();
    return task.fn().then(result => {
      completed++;
      results.push(result);
      if (onProgress) onProgress(completed, total, task.label || '');
      return runNext();
    });
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, total); i++) {
    workers.push(runNext());
  }
  return Promise.all(workers).then(() => results);
}

async function translateTexts(ocrResults, onProgress, options) {
  const opts = options || {};
  const targetLang = opts.targetLang || 'es';
  const useMeta = opts.provider === 'meta';

  const toTranslateCount = ocrResults.filter(r => r.text && isEnglish(r.text)).length;
  console.log('\nTraduciendo ' + toTranslateCount + ' imagenes con ' + (useMeta ? 'Meta NLLB (local)' : 'Google') + ' (max ' + CONCURRENCY + ')...');

  const work = [];

  for (let i = 0; i < ocrResults.length; i++) {
    const item = ocrResults[i];
    if (item.text && isEnglish(item.text)) {
      const imageIndex = i;
      const filename = item.filename;

      work.push({ imageIndex, type: 'full', filename, text: item.text });

      if (item.textBlocks && item.textBlocks.length > 0) {
        for (let b = 0; b < item.textBlocks.length; b++) {
          const block = item.textBlocks[b];
          if (isEnglish(block.text)) {
            work.push({ imageIndex, type: 'block', blockIndex: b, bbox: block.bbox, original: block.text, filename, text: block.text });
          }
        }
      }
    }
  }

  let allResults = null;
  if (useMeta && work.length > 0) {
    try {
      const outs = await metaBridge.translateBatch(work.map(w => w.text), targetLang);
      if (!Array.isArray(outs) || outs.length !== work.length) {
        throw new Error('respuesta invalida del modelo NLLB');
      }
      allResults = work.map((w, i) => ({ imageIndex: w.imageIndex, type: w.type, blockIndex: w.blockIndex, bbox: w.bbox, original: w.original, translated: outs[i] }));
      if (onProgress) {
        const seen = new Set();
        let c = 0;
        for (const w of work) {
          if (seen.has(w.imageIndex)) continue;
          seen.add(w.imageIndex);
          c++;
          onProgress(c, ocrResults.length, w.filename);
        }
      }
      console.log('Traducido con Meta NLLB local: ' + work.length + ' textos');
    } catch (error) {
      console.warn('Meta NLLB fallo (' + error.message + '); respaldo con Google.');
      allResults = null;
    }
  }

  if (!allResults) {
    const tasks = work.map(w => ({
      label: w.filename,
      fn: () => translateText(w.text, targetLang).then(translated => ({
        imageIndex: w.imageIndex, type: w.type, blockIndex: w.blockIndex, bbox: w.bbox, original: w.original, translated
      }))
    }));
    allResults = await translatePool(tasks, onProgress);
  }

  const imageMap = new Map();
  for (const r of allResults) {
    if (!imageMap.has(r.imageIndex)) {
      imageMap.set(r.imageIndex, { full: null, blocks: [] });
    }
    if (r.type === 'full') {
      imageMap.get(r.imageIndex).full = r.translated;
    } else {
      imageMap.get(r.imageIndex).blocks.push({
        bbox: r.bbox,
        original: r.original,
        translated: r.translated
      });
    }
  }

  const results = [];
  for (let i = 0; i < ocrResults.length; i++) {
    const item = ocrResults[i];
    const data = imageMap.get(i);
    if (data && data.full !== null) {
      data.blocks.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
      results.push({
        image: item.image,
        filename: item.filename,
        originalText: item.text,
        translatedText: data.full,
        blockTranslations: data.blocks
      });
    } else {
      results.push({
        image: item.image,
        filename: item.filename,
        originalText: item.text,
        translatedText: item.text,
        blockTranslations: []
      });
    }
  }

  console.log('\n');
  return results;
}

module.exports = { translateTexts, translateText, isEnglish };
