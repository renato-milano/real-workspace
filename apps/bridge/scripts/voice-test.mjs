// Prova la trascrizione senza visore: manda un WAV 16 kHz mono come se arrivasse dal microfono.
// Uso: node scripts/voice-test.mjs file.wav
import { readFileSync } from 'node:fs';
import WebSocket from 'ws';

const wav = readFileSync(process.argv[2]);
const pcm = wav.subarray(44); // header WAV canonico
const ws = new WebSocket(`ws://localhost:${process.env.QW_PORT ?? 8443}/ws`);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', role: 'viewer', name: 'voice-test' }));
  ws.send(JSON.stringify({ type: 'voice', op: 'start' }));
  for (let i = 0; i < pcm.length; i += 3200) ws.send(pcm.subarray(i, i + 3200), { binary: true });
  ws.send(JSON.stringify({ type: 'voice', op: 'end' }));
  console.time('totale');
});
ws.on('message', (raw) => {
  const msg = JSON.parse(raw);
  if (msg.type !== 'transcript') return;
  console.timeEnd('totale');
  console.log(msg);
  ws.close();
});
