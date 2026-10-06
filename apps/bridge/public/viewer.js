// Viewer 2D: riceve lo stream di una finestra dal bridge e mostra le statistiche di decodifica.
import { connectViewer } from './qw-client.js';

const video = document.getElementById('video');
const hud = document.getElementById('hud');

const client = connectViewer({
  name: 'viewer-2d',
  onStream: (stream) => {
    video.srcObject = stream;
  },
  onState: (state) => {
    hud.textContent = state === 'connected' ? 'connesso — seleziona una finestra nel bridge sul Mac' : state;
  },
});

setInterval(async () => {
  const s = await client.stats();
  if (!s || !s.width) return;
  hud.innerHTML =
    `${s.width}×${s.height} @ ${s.fps}fps   ${s.mbps.toFixed(1)} Mbps\n` +
    `codec ${s.codec}   dec ${s.decoder}${s.powerEfficient ? ' (hw)' : ''}\n` +
    `persi ${s.framesDropped}   jitter ${s.jitterMs}ms   rtt ${s.rttMs}ms\n` +
    `video element ${video.videoWidth}×${video.videoHeight}, finestra ${innerWidth}×${innerHeight} (dpr ${devicePixelRatio})`;
}, 1000);

document.getElementById('native').onclick = () => document.body.classList.toggle('native');
document.getElementById('hide').onclick = () => (hud.hidden = !hud.hidden);
