const translate = require('google-translate-api-x');

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

async function translateText(text) {
  if (!text || text.trim().length === 0) return '';
  try {
    const res = await translate(text, { from: 'en', to: 'es' });
    return res.text;
  } catch (error) {
    console.log('Error traduciendo:', error.message);
    return text;
  }
}

async function translateTexts(ocrResults, onProgress) {
  const results = [];
  const toTranslate = ocrResults.filter(r => r.text && isEnglish(r.text));

  console.log('\nTraduciendo ' + toTranslate.length + ' imagenes con texto en ingles...');

  let count = 0;
  for (let i = 0; i < ocrResults.length; i++) {
    const item = ocrResults[i];

    if (item.text && isEnglish(item.text)) {
      count++;

      const fullTranslated = await translateText(item.text);

      const blockTranslations = [];
      if (item.textBlocks && item.textBlocks.length > 0) {
        for (const block of item.textBlocks) {
          if (isEnglish(block.text)) {
            const t = await translateText(block.text);
            blockTranslations.push({
              bbox: block.bbox,
              original: block.text,
              translated: t
            });
            await new Promise(r => setTimeout(r, 600));
          }
        }
      }

      results.push({
        image: item.image,
        filename: item.filename,
        originalText: item.text,
        translatedText: fullTranslated,
        blockTranslations
      });

      if (count < toTranslate.length) {
        await new Promise(r => setTimeout(r, 1200));
      }
    } else {
      results.push({
        image: item.image,
        filename: item.filename,
        originalText: item.text,
        translatedText: item.text,
        blockTranslations: []
      });
    }

    if (onProgress) {
      onProgress(i + 1, ocrResults.length, item.filename);
    }
  }

  console.log('\n');
  return results;
}

module.exports = { translateTexts, translateText, isEnglish };
