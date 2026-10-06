// Renderer del bridge: cattura la finestra scelta e la invia a ogni viewer con una RTCPeerConnection dedicata.

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const preview = $('#preview');
const codecSel = $('#codec');
const bitrateSel = $('#bitrate');
const fpsSel = $('#fps');
const maxresSel = $('#maxres');

let stream = null;
let track = null;
let activeSourceId = null;
let activeSourceName = '';
const peers = new Map(); // viewerId → { pc, sender, name, last }
let ws = null;

// --- Log ---------------------------------------------------------------------

function log(line) {
  const el = $('#log');
  el.textContent = `${new Date().toLocaleTimeString()} ${line}\n` + el.textContent.slice(0, 5000);
  if (!line.startsWith('[main]') && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'log', line }));
}
window.bridge.onLog((line) => log(`[main] ${line}`));

// --- Elenco finestre -----------------------------------------------------------

async function refreshSources() {
  const sources = await window.bridge.listSources();
  grid.replaceChildren(
    ...sources.map((s) => {
      const el = document.createElement('button');
      el.className = 'src' + (s.id === activeSourceId ? ' active' : '');
      el.innerHTML = `<img alt="" /><span></span>`;
      el.querySelector('img').src = s.thumbnail;
      el.querySelector('span').textContent = s.name;
      el.title = s.name;
      el.onclick = () => selectSource(s.id, s.name);
      return el;
    }),
  );
}

// --- Cattura -------------------------------------------------------------------

async function selectSource(id, name) {
  const fps = Number(fpsSel.value);
  const next = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: id,
        // Oltre ~1920 px il visore non mostra più dettaglio su un pannello di dimensioni normali,
        // mentre codifica e decodifica (e quindi la latenza) crescono con i pixel.
        maxWidth: Number(maxresSel.value),
        maxHeight: 2880,
        maxFrameRate: fps,
      },
    },
  });
  const nextTrack = next.getVideoTracks()[0];
  // 'text' dice all'encoder di privilegiare la nitidezza dei dettagli rispetto alla fluidità.
  nextTrack.contentHint = contentHint;

  stream?.getTracks().forEach((t) => t.stop());
  stream = next;
  track = nextTrack;
  activeSourceId = id;
  activeSourceName = name;
  window.bridge.setActiveSource(id);
  try {
    localStorage.setItem('qw.lastSource', JSON.stringify({ id, name }));
  } catch {}
  preview.srcObject = stream;

  for (const p of peers.values()) await p.sender.replaceTrack(track);

  const s = track.getSettings();
  $('#capture-info').textContent = `${name} — ${s.width}×${s.height} @ ${s.frameRate ?? fps}fps`;
  log(`cattura: ${name} (${s.width}×${s.height})`);
  refreshSources();
}

// Frame effettivamente prodotti dalla cattura macOS, misurati sull'anteprima locale.
let capturedFrames = 0;
function countCapturedFrames() {
  capturedFrames++;
  preview.requestVideoFrameCallback(countCapturedFrames);
}
preview.requestVideoFrameCallback(countCapturedFrames);
let captureFps = 0;
setInterval(() => {
  captureFps = capturedFrames / 2;
  capturedFrames = 0;
}, 2000);

let contentHint = 'text';
let degradation = 'maintain-resolution';

// --- WebRTC verso i viewer ----------------------------------------------------

function orderedCodecs(choice) {
  // 'video/H264' = High profile (64xxxx), 'video/H264-baseline' = Constrained Baseline (42e0xx):
  // i decoder hardware non sempre accettano High profile nel percorso WebRTC.
  const baseline = choice === 'video/H264-baseline';
  const mime = baseline ? 'video/H264' : choice;
  const profile = baseline ? /profile-level-id=42e0/ : /profile-level-id=64/;
  const codecs = RTCRtpReceiver.getCapabilities('video').codecs;
  const score = (c) => {
    if (c.mimeType !== mime) return 2;
    if (mime === 'video/H264') return profile.test(c.sdpFmtpLine ?? '') ? 0 : 1;
    return 0;
  };
  const preferred = codecs.filter((c) => c.mimeType === mime);
  if (!preferred.length) return null;
  return [...codecs].sort((a, b) => score(a) - score(b));
}

async function tuneSender(sender) {
  const params = sender.getParameters();
  // Con testo da leggere la risoluzione non va mai sacrificata: meglio perdere frame.
  params.degradationPreference = degradation;
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = Number(bitrateSel.value);
  params.encodings[0].maxFramerate = Number(fpsSel.value);
  params.encodings[0].scaleResolutionDownBy = 1;
  await sender.setParameters(params);
}

async function createPeer(viewerId, name) {
  peers.get(viewerId)?.pc.close();

  const pc = new RTCPeerConnection({ iceServers: [] });
  const transceiver = pc.addTransceiver(track ?? 'video', {
    direction: 'sendonly',
    streams: stream ? [stream] : [],
  });
  const codecs = orderedCodecs(codecSel.value);
  if (codecs) transceiver.setCodecPreferences(codecs);
  else log(`codec ${codecSel.value} non disponibile, uso default`);

  const peer = { pc, sender: transceiver.sender, name, last: null };
  peers.set(viewerId, peer);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      log(`ice locale → ${viewerId}: ${e.candidate.candidate}`);
      signal(viewerId, { candidate: e.candidate.toJSON() });
    }
  };
  pc.oniceconnectionstatechange = () => log(`${viewerId} ice ${pc.iceConnectionState}`);
  pc.onconnectionstatechange = () => log(`${viewerId} ${pc.connectionState}`);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await tuneSender(peer.sender);
  signal(viewerId, { type: 'offer', sdp: offer.sdp });
}

function signal(to, data) {
  ws?.send(JSON.stringify({ type: 'signal', to, data }));
}

// Su LAN la banda c'è, ma la stima di WebRTC parte bassa e resta bassa finché il traffico è scarso
// (terminale quasi fermo): un frame grande viene poi "dosato" dal pacer e arriva in ritardo.
// I parametri x-google-* nell'answer applicata al mittente fissano un minimo e un punto di partenza.
const MIN_KBPS = 15000;
const START_KBPS = 20000;
function mungeAnswer(sdp) {
  const lines = sdp.split('\r\n');
  const videoPts = new Set();
  let inVideo = false;
  for (const l of lines) {
    if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
    const m = inVideo && l.match(/^a=rtpmap:(\d+) (VP8|VP9|AV1|H264)\//);
    if (m) videoPts.add(m[1]);
  }
  const extra = `x-google-min-bitrate=${MIN_KBPS};x-google-start-bitrate=${START_KBPS};x-google-max-bitrate=${Number(bitrateSel.value) / 1000}`;
  const seen = new Set();
  const out = lines.map((l) => {
    const m = l.match(/^a=fmtp:(\d+) (.*)$/);
    if (m && videoPts.has(m[1])) {
      seen.add(m[1]);
      return `a=fmtp:${m[1]} ${m[2]};${extra}`;
    }
    return l;
  });
  // Codec senza riga fmtp (es. VP8): la aggiungiamo subito dopo la rtpmap.
  for (const pt of videoPts) {
    if (seen.has(pt)) continue;
    const i = out.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
    out.splice(i + 1, 0, `a=fmtp:${pt} ${extra}`);
  }
  return out.join('\r\n');
}

async function onSignal(from, data) {
  const peer = peers.get(from);
  if (!peer) return;
  if (data.type === 'answer') await peer.pc.setRemoteDescription({ type: 'answer', sdp: mungeAnswer(data.sdp) });
  else if (data.candidate) {
    log(`ice remoto ← ${from}: ${data.candidate.candidate}`);
    await peer.pc.addIceCandidate(data.candidate).catch((err) => log(`addIceCandidate: ${err.message}`));
  }
}

// Cambio codec: serve rinegoziare da zero, il viewer accetta una nuova offer in qualsiasi momento.
codecSel.onchange = () => {
  for (const [id, p] of peers) createPeer(id, p.name);
};
bitrateSel.onchange = fpsSel.onchange = () => {
  for (const p of peers.values()) tuneSender(p.sender);
};
maxresSel.addEventListener('change', () => {
  if (activeSourceId) selectSource(activeSourceId, activeSourceName);
});
fpsSel.addEventListener('change', () => {
  if (activeSourceId) selectSource(activeSourceId, activeSourceName);
});

// --- Controllo remoto (scripts/ctl.mjs) ---------------------------------------------

async function onControl(msg) {
  log(`controllo: ${JSON.stringify(msg)}`);
  if (msg.maxres) {
    maxresSel.value = String(msg.maxres);
    if (activeSourceId) await selectSource(activeSourceId, activeSourceName);
  }
  if (msg.fps) {
    fpsSel.value = String(msg.fps);
    if (activeSourceId) await selectSource(activeSourceId, activeSourceName);
  }
  if (msg.select || msg.testPattern) {
    const name = msg.select ?? 'QW Test Pattern';
    for (let i = 0; i < 20; i++) {
      const match = (await window.bridge.listSources()).find((s) => s.name.includes(name));
      if (match) {
        await selectSource(match.id, match.name);
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (msg.contentHint || msg.degradation) {
    contentHint = msg.contentHint ?? contentHint;
    degradation = msg.degradation ?? degradation;
    if (track) track.contentHint = contentHint;
    for (const p of peers.values()) await tuneSender(p.sender);
  }
  if (msg.codec) {
    codecSel.value = msg.codec;
    for (const [id, p] of peers) createPeer(id, p.name);
  }
}

// --- Signaling -----------------------------------------------------------------

async function connect() {
  const { port, lan } = await window.bridge.serverInfo();
  $('#server').textContent = `http://localhost:${port}  ·  LAN: ${lan.map((ip) => `${ip}:${port}`).join(', ')}`;

  ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'host' }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'viewer-joined') {
      log(`viewer ${msg.id} (${msg.name}) connesso`);
      createPeer(msg.id, msg.name);
    } else if (msg.type === 'viewer-left') {
      peers.get(msg.id)?.pc.close();
      peers.delete(msg.id);
      log(`viewer ${msg.id} uscito`);
    } else if (msg.type === 'signal') {
      onSignal(msg.from, msg.data);
    } else if (msg.type === 'control') {
      onControl(msg);
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}

// --- Statistiche ---------------------------------------------------------------

async function updateStats() {
  const box = $('#peers');
  if (!peers.size) {
    box.textContent = 'nessun viewer connesso';
    return;
  }
  const blocks = [];
  for (const [id, p] of peers) {
    const report = await p.pc.getStats();
    let out, pair, codec;
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
    if (out?.codecId) codec = report.get(out.codecId);
    const remote = pair && report.get(pair.remoteCandidateId);

    let mbps = 0;
    let encodeMs = 0;
    if (out && p.last) {
      mbps = ((out.bytesSent - p.last.bytes) * 8) / ((out.timestamp - p.last.ts) * 1000);
      const dFrames = (out.framesEncoded ?? 0) - p.last.framesEncoded;
      if (dFrames > 0) encodeMs = (((out.totalEncodeTime ?? 0) - p.last.encodeTime) * 1000) / dFrames;
    }
    if (out) p.last = { bytes: out.bytesSent, ts: out.timestamp, framesEncoded: out.framesEncoded ?? 0, encodeTime: out.totalEncodeTime ?? 0 };
    if (out && mbps > 0.2 && Date.now() - (p.lastLog ?? 0) > 2000) {
      p.lastLog = Date.now();
      log(
        `[stats ${id}] cap ${captureFps}fps enc ${out.frameWidth}×${out.frameHeight} ${out.framesPerSecond ?? 0}fps ${mbps.toFixed(1)}Mbps ` +
          `${out.encoderImplementation} ${encodeMs.toFixed(1)}ms/frame limit=${out.qualityLimitationReason} ` +
          `bwe ${pair?.availableOutgoingBitrate ? (pair.availableOutgoingBitrate / 1e6).toFixed(1) + 'Mbps' : '?'}`,
      );
    }

    const limit = out?.qualityLimitationReason;
    blocks.push(
      `<div class="peer"><b>${id}</b> ${p.name} — ${p.pc.connectionState}\n` +
        (out
          ? `${out.frameWidth ?? '?'}×${out.frameHeight ?? '?'} @ ${out.framesPerSecond ?? 0}fps  ${mbps.toFixed(1)} Mbps\n` +
            `codec ${codec?.mimeType ?? '?'}  enc ${out.encoderImplementation ?? '?'}\n` +
            `limit <span class="${limit && limit !== 'none' ? 'warn' : ''}">${limit ?? '?'}</span>` +
            `  rtt ${pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) + 'ms' : '?'}` +
            `  via ${remote?.address ?? '?'}`
          : 'in negoziazione…') +
        `</div>`,
    );
  }
  box.innerHTML = blocks.join('');
}

$('#refresh').onclick = refreshSources;

// Al riavvio riprende l'ultima finestra condivisa, se è ancora aperta (stesso id, o stesso titolo).
async function restoreLastSource() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem('qw.lastSource') ?? 'null');
  } catch {}
  if (!saved) return refreshSources();
  const sources = await window.bridge.listSources();
  const match = sources.find((s) => s.id === saved.id) ?? sources.find((s) => s.name === saved.name);
  if (match) await selectSource(match.id, match.name);
  else refreshSources();
}
restoreLastSource();
connect();
setInterval(updateStats, 1000);
