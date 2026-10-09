// Voce: trascrizione push-to-talk con whisper.cpp in locale.
// Il visore manda PCM 16 kHz mono (Int16) mentre il tasto è premuto; al rilascio il bridge lo passa a
// whisper-server, che tiene il modello caricato in memoria (Metal), e rimanda il testo al visore.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { correct } from './corrections.js';

const SAMPLE_RATE = 16000;
const PORT = Number(process.env.QW_WHISPER_PORT ?? 8178);
const MODEL = process.env.QW_WHISPER_MODEL ?? join(homedir(), '.cache', 'qw-models', 'ggml-large-v3-turbo.bin');
// Build con encoder CoreML (scripts/setup-whisper.sh): sul Neural Engine l'encoder è ~4 volte più veloce che
// su GPU Metal. Il file .mlmodelc va accanto al modello, whisper.cpp lo trova da solo.
const SERVER_BIN = process.env.QW_WHISPER_SERVER ??
  join(homedir(), '.cache', 'qw-tools', 'whisper.cpp', 'build-coreml', 'bin', 'whisper-server');
// Registrazioni salvate in locale (fuori dal repo) per confrontare impostazioni sugli stessi audio
// (scripts/voice-ab.mjs). QW_VOICE_SAVE=0 le disattiva; si tengono le ultime MAX_RECORDINGS.
const RECORDINGS = process.env.QW_VOICE_DIR ?? join(homedir(), '.cache', 'qw-voice', 'recordings');
const SAVE = process.env.QW_VOICE_SAVE !== '0';
const MAX_RECORDINGS = 200;

export function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createVoiceService({ log }) {
  let ready = false;
  let server = null;
  const sessions = new Map(); // viewer id → { chunks, bytes }

  if (!existsSync(MODEL) || !existsSync(SERVER_BIN)) {
    log('voce: whisper.cpp o modello assenti (scripts/setup-whisper.sh), trascrizione disattivata');
  } else {
    // Il modello resta caricato nel server: niente costo di caricamento a ogni frase.
    // Decodifica greedy (-bo 1): stesso testo di best_of 2 sulle frasi di prova, ~400 ms in meno.
    // Niente prompt iniziale: costa ~300 ms a frase; da rivalutare se i termini tecnici escono sbagliati.
    // Lanciato tramite sh: quando la pipe su stdin si chiude (bridge terminato in qualunque modo, anche kill -9)
    // il wrapper uccide whisper-server, che altrimenti resterebbe orfano a occupare porta e memoria.
    const args = ['-m', MODEL, '--host', '127.0.0.1', '--port', String(PORT), '-l', 'it', '-nt', '-bo', '1'];
    const wrapper = 'exec 3<&0; "$0" "$@" </dev/null & pid=$!; (read _ <&3; kill $pid 2>/dev/null) & wait $pid';
    server = spawn('/bin/sh', ['-c', wrapper, SERVER_BIN, ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    const tail = [];
    server.stderr.on('data', (d) => {
      tail.push(...d.toString().split('\n').filter(Boolean));
      tail.splice(0, Math.max(0, tail.length - 20));
    });
    server.on('error', (err) => log(`voce: whisper-server non avviabile (${err.message})`));
    server.on('exit', (code) => {
      ready = false;
      if (code) log(`voce: whisper-server terminato (${code})\n${tail.join('\n')}`);
    });
    waitReady();
  }

  async function waitReady() {
    const t0 = Date.now();
    while (server && server.exitCode == null) {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/`);
        if (res.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!server || server.exitCode != null) return;
    log(`voce: whisper-server pronto in ${Date.now() - t0} ms`);
    // La prima inferenza compila gli shader Metal: la facciamo subito su 1 s di silenzio.
    const t1 = Date.now();
    await transcribe(Buffer.alloc(SAMPLE_RATE * 2)).catch(() => {});
    ready = true;
    log(`voce: riscaldamento ${Date.now() - t1} ms, pronta (${MODEL.split('/').pop()})`);
  }

  async function transcribe(pcm) {
    const form = new FormData();
    form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'audio.wav');
    form.append('temperature', '0.0');
    form.append('response_format', 'json');
    // Il server conserva i parametri ricevuti per le richieste successive: li mandiamo sempre tutti,
    // così una prova A/B con altri valori non lascia strascichi.
    form.append('prompt', '');
    form.append('best_of', '1');
    const res = await fetch(`http://127.0.0.1:${PORT}/inference`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return (body.text ?? '').trim();
  }

  async function save(pcm, meta) {
    await mkdir(RECORDINGS, { recursive: true });
    const name = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(join(RECORDINGS, `${name}.wav`), wav(pcm));
    await writeFile(join(RECORDINGS, `${name}.json`), JSON.stringify(meta, null, 2));
    const wavs = (await readdir(RECORDINGS)).filter((f) => f.endsWith('.wav')).sort();
    for (const old of wavs.slice(0, -MAX_RECORDINGS)) {
      const base = old.slice(0, -4);
      await unlink(join(RECORDINGS, old)).catch(() => {});
      await unlink(join(RECORDINGS, `${base}.json`)).catch(() => {});
    }
  }

  return {
    // Messaggi JSON: {type:'voice', op:'start'|'end'|'cancel'}; reply() risponde al viewer che parla.
    async handle(viewerId, msg, reply) {
      if (msg.op === 'start') {
        sessions.set(viewerId, { chunks: [], bytes: 0 });
        return;
      }
      const s = sessions.get(viewerId);
      sessions.delete(viewerId);
      if (msg.op !== 'end' || !s) return;

      const audioMs = Math.round((s.bytes / 2 / SAMPLE_RATE) * 1000);
      if (!ready) {
        reply({ type: 'transcript', error: server ? 'whisper non ancora pronto' : 'trascrizione non disponibile', audioMs });
        return;
      }
      if (audioMs < 250) {
        reply({ type: 'transcript', text: '', audioMs, whisperMs: 0 });
        return;
      }
      const t0 = performance.now();
      try {
        const pcm = Buffer.concat(s.chunks);
        const raw = await transcribe(pcm);
        const whisperMs = Math.round(performance.now() - t0);
        const text = correct(raw);
        log(`voce: ${audioMs} ms di audio → ${whisperMs} ms whisper: "${text}"${text !== raw ? ` (grezzo: "${raw}")` : ''}`);
        reply({ type: 'transcript', text, audioMs, whisperMs });
        if (SAVE) save(pcm, { raw, text, audioMs, whisperMs }).catch((err) => log(`voce: salvataggio fallito (${err.message})`));
      } catch (err) {
        log(`voce: errore trascrizione (${err.message})`);
        reply({ type: 'transcript', error: err.message, audioMs });
      }
    },

    // Audio binario (PCM Int16 LE) della sessione aperta da quel viewer.
    chunk(viewerId, data) {
      const s = sessions.get(viewerId);
      if (!s) return;
      s.chunks.push(Buffer.from(data));
      s.bytes += data.length;
    },

    dispose() {
      server?.stdin.end();
      server = null;
    },
  };
}
