# Servidor de traduccion NLLB-200 (Meta, el modelo de WhatsApp) por lineas JSON.
# Protocolo (stdin -> stdout, una linea JSON por mensaje):
#   entrada: {"id": 1, "texts": ["Hello", ...], "target": "es", "source": "en"}
#   salida:  {"id": 1, "translations": ["Hola", ...]}
#   error:   {"id": 1, "error": "mensaje"}
import sys
import json

MODEL_ID = 'facebook/nllb-200-distilled-600M'
LANG_MAP = {
    'es': 'spa_Latn', 'en': 'eng_Latn', 'pt': 'por_Latn', 'fr': 'fra_Latn',
    'de': 'deu_Latn', 'it': 'ita_Latn', 'ja': 'jpn_Jpan', 'ko': 'kor_Hang',
    'zh': 'zho_Hans', 'ru': 'rus_Cyrl',
}

_tok = None
_model = None


def load_model():
    global _tok, _model
    if _tok is None or _model is None:
        from transformers import AutoTokenizer, AutoModelForSeq2SeqLM
        print('[nllb] cargando modelo ' + MODEL_ID + '...', file=sys.stderr, flush=True)
        _tok = AutoTokenizer.from_pretrained(MODEL_ID)
        _model = AutoModelForSeq2SeqLM.from_pretrained(MODEL_ID)
        _model.eval()
        print('[nllb] modelo listo', file=sys.stderr, flush=True)


def translate(texts, source, target):
    import torch
    load_model()
    src = LANG_MAP.get((source or 'en').lower(), 'eng_Latn')
    tgt = LANG_MAP.get((target or 'es').lower(), 'spa_Latn')
    _tok.src_lang = src
    forced = None
    if hasattr(_tok, 'lang_code_to_id'):
        forced = _tok.lang_code_to_id.get(tgt)
    if forced is None:
        raw = _tok.convert_tokens_to_ids(tgt)
        forced = raw[0] if isinstance(raw, (list, tuple)) else raw
    inputs = _tok(texts, return_tensors='pt', padding=True, truncation=True, max_length=512)
    with torch.no_grad():
        out = _model.generate(
            **inputs, forced_bos_token_id=forced, max_length=512, num_beams=5
        )
    return _tok.batch_decode(out, skip_special_tokens=True)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get('id')
            texts = [t if isinstance(t, str) else str(t) for t in (req.get('texts') or [])]
            if not texts:
                result = []
            else:
                result = translate(texts, req.get('source') or 'en', req.get('target') or 'es')
            print(json.dumps({'id': rid, 'translations': result}, ensure_ascii=False), flush=True)
        except Exception as e:  # noqa: BLE001 - el padre espera siempre una respuesta JSON
            print(json.dumps({'id': rid, 'error': str(e)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
