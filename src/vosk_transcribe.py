import sys, os, json, wave, subprocess

MODEL_DIR = r'C:\Proyectos\descarga-traduccion-imagenes\models\vosk'
AUDIO_FILE = sys.argv[1] if len(sys.argv) > 1 else ''
OUTPUT_SRT = sys.argv[2] if len(sys.argv) > 2 else ''
WORDS_PER_LINE = 3
FFMPEG_PATH = r'C:\Proyectos\descarga-traduccion-imagenes\tools\ffmpeg-9.0.1-essentials_build\bin\ffmpeg.exe'

if not AUDIO_FILE or not OUTPUT_SRT:
    print('Usage: vosk_transcribe.py <audio.wav> <output.srt>')
    sys.exit(1)

if not os.path.exists(AUDIO_FILE):
    print(f'Audio file not found: {AUDIO_FILE}')
    sys.exit(1)

if not os.path.exists(MODEL_DIR):
    print(f'Model not found at {MODEL_DIR}')
    sys.exit(1)

from vosk import Model, KaldiRecognizer

model = Model(MODEL_DIR)

wf = wave.open(AUDIO_FILE, 'rb')
if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getframerate() != 16000:
    converted = AUDIO_FILE.replace('.wav', '_16k.wav')
    subprocess.run([
        FFMPEG_PATH,
        '-i', AUDIO_FILE, '-ar', '16000', '-ac', '1', '-y', converted
    ], capture_output=True)
    wf.close()
    wf = wave.open(converted, 'rb')

rec = KaldiRecognizer(model, wf.getframerate())
rec.SetWords(True)

results = []
while True:
    data = wf.readframes(4000)
    if len(data) == 0:
        break
    if rec.AcceptWaveform(data):
        r = json.loads(rec.Result())
        if r.get('result'):
            results.append(r)

final = json.loads(rec.FinalResult())
if final.get('result'):
    results.append(final)

wf.close()

subs = []
idx = 1
for element in results:
    words = element.get('result', [])
    if not words:
        continue
    for i in range(0, len(words), WORDS_PER_LINE):
        chunk = words[i:i + WORDS_PER_LINE]
        start = chunk[0]['start']
        end = chunk[-1]['end']
        text = ' '.join(w['word'] for w in chunk)
        subs.append({
            'index': idx,
            'start': start,
            'end': end,
            'text': text
        })
        idx += 1

def format_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    ms = int((s - int(s)) * 1000)
    return f'{h:02d}:{m:02d}:{int(s):02d},{ms:03d}'

with open(OUTPUT_SRT, 'w', encoding='utf-8') as f:
    for sub in subs:
        f.write(f"{sub['index']}\n")
        f.write(f"{format_time(sub['start'])} --> {format_time(sub['end'])}\n")
        f.write(f"{sub['text']}\n\n")

print(f'DONE:{len(subs)}')
