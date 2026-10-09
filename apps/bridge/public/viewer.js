// Viewer 2D: mostra l'ultima finestra aperta ricevuta dal bridge e le sue statistiche di decodifica.
import { connectViewer } from './qw-client.js';

const video = document.getElementById('video');
const hud = document.getElementById('hud');

let currentSid = null;
const client = connectViewer({
  name: 'viewer-2d',
  onStream: (stream, { sid }) => {
    currentSid = sid;
    video.srcObject = stream;
  },
  onState: (state) => {
    hud.textContent = state === 'connected' ? 'connesso — seleziona una finestra nel bridge sul Mac' : state;
  },
});

setInterval(async () => {
  const s = currentSid && (await client.stats(currentSid));
  if (!s || !s.width) return;
  hud.innerHTML =
    `${s.width}×${s.height} @ ${s.fps}fps   ${s.mbps.toFixed(1)} Mbps\n` +
    `codec ${s.codec}   dec ${s.decoder}${s.powerEfficient ? ' (hw)' : ''}\n` +
    `persi ${s.framesDropped}   jitter ${s.jitterMs}ms   rtt ${s.rttMs}ms\n` +
    `video element ${video.videoWidth}×${video.videoHeight}, finestra ${innerWidth}×${innerHeight} (dpr ${devicePixelRatio})`;
}, 1000);

document.getElementById('native').onclick = () => document.body.classList.toggle('native');
document.getElementById('hide').onclick = () => (hud.hidden = !hud.hidden);
