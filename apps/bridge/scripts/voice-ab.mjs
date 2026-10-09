// Confronto A/B di impostazioni whisper sulle stesse registrazioni salvate dal bridge.
// Richiede il bridge avviato (usa il suo whisper-server). Uso: node scripts/voice-ab.mjs [numero ultime=5]
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { correct } from '../src/corrections.js';

const DIR = process.env.QW_VOICE_DIR ?? join(homedir(), '.cache', 'qw-voice', 'recordings');
const PORT = Number(process.env.QW_WHISPER_PORT ?? 8178);
const COUNT = Number(process.argv[2] ?? 5);

const CONFIGS = {
  base: { prompt: '', best_of: '1' },
  prompt: {
    prompt: 'Claude Code, Codex, commit, push, branch, npm run, TypeScript, typecheck, bridge, WebXR, Quest.',
    best_of: '1',
  },
  // Frasi in italiano nello stile dei comandi: orienta anche punteggiatura e nomi propri.
  frasi: {
    prompt: 'Claude, apri il README e il file index.ts. Codex, esegui npm run typecheck, poi fai commit e push sul branch main.',
    best_of: '1',
  },
};

async function transcribe(wav, params) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form });
  const body = await res.json();
  return { ms: Math.round(performance.now() - t0), text: (body.text ?? '').trim() };
}

const files = (await readdir(DIR)).filter((f) => f.endsWith('.wav')).sort().slice(-COUNT);
const totals = Object.fromEntries(Object.keys(CONFIGS).map((k) => [k, 0]));
for (const f of files) {
  const wav = await readFile(join(DIR, f));
  console.log(`\n== ${f} (${((wav.length - 44) / 32000).toFixed(1)} s)`);
  for (const [name, params] of Object.entries(CONFIGS)) {
    const r = await transcribe(wav, params);
    totals[name] += r.ms;
    const fixed = correct(r.text);
    console.log(`  ${name.padEnd(6)} ${String(r.ms).padStart(5)} ms  ${r.text}`);
    if (fixed !== r.text) console.log(`  ${''.padEnd(6)} corretto  ${fixed}`);
  }
}
console.log('\nmedia:', Object.entries(totals).map(([k, v]) => `${k} ${Math.round(v / files.length)} ms`).join(' · '));
// Nessun ripristino necessario: il bridge manda sempre tutti i parametri a ogni richiesta.
