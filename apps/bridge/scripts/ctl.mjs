// Invia un comando di controllo al bridge, es.:
//   node scripts/ctl.mjs '{"testPattern":true}'
//   node scripts/ctl.mjs '{"codec":"video/VP9","maxres":1920}'
import WebSocket from 'ws';

const msg = JSON.parse(process.argv[2] ?? '{}');
const ws = new WebSocket(`ws://localhost:${process.env.QW_PORT ?? 8443}/ws`);
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', role: 'ctl' }));
  ws.send(JSON.stringify({ type: 'control', ...msg }));
  setTimeout(() => ws.close(), 200);
});
ws.on('error', (err) => {
  console.error(`bridge non raggiungibile: ${err.message}`);
  process.exit(1);
});
