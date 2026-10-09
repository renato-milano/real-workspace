// Renderer del bridge: cattura le finestre aperte nel visore e le invia a ogni viewer, con una
// RTCPeerConnection per (viewer, finestra): aprire o chiudere una finestra non tocca gli stream delle altre.
// La finestra attiva (quella su cui si lavora) va a fps pieni, le altre a fps ridotti per risparmiare
// codifica sul Mac e decodifica sul visore.

const $ = (sel) => document.querySelector(sel);
const grid = $('#grid');
const preview = $('#preview');
const codecSel = $('#codec');
const bitrateSel = $('#bitrate');
const fpsSel = $('#fps');
const maxresSel = $('#maxres');

const INACTIVE_FPS = 5;

const captures = new Map(); // wid → { stream, track, name }
const peers = new Map(); // `${viewerId}|${wid}` → { pc, sender, viewerId, wid, last, lastLog }
const viewers = new Map(); // viewerId → name
let activeWid = null;
let hoverWid = null; // finestra indicata dal raggio nel visore: anche lei a fps pieni
let ws = null;

const peerKey = (viewerId, wid) => `${viewerId}|${wid}`;
const shortName = (wid) => (captures.get(wid)?.name ?? wid).slice(0, 24);

// --- Log ---------------------------------------------------------------------

function log(line) {
  const el = $('#log');
  el.textContent = `${new Date().toLocaleTimeString()} ${line}\n` + el.textContent.slice(0, 5000);
  if (!line.startsWith('[main]') && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'log', line }));
}
window.bridge.onLog((line) => log(`[main] ${line}`));

function notify(to, data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'notify', to, data }));
}

// --- Elenco finestre (UI del Mac: click = apri/chiudi nel visore) ----------------

async function refreshSources() {
  const sources = await window.bridge.listSources();
  grid.replaceChildren(
    ...sources.map((s) => {
      const el = document.createElement('button');
      el.className = 'src' + (captures.has(s.id) ? ' open' : '') + (s.id === activeWid ? ' active' : '');
      el.innerHTML = `<img alt="" /><span></span>`;
      el.querySelector('img').src = s.thumbnail;
      el.querySelector('span').textContent = s.name;
      el.title = s.name;
      el.onclick = () => (captures.has(s.id) ? closeWindow(s.id) : openWindow(s.id, s.name, { activate: true }));
      return el;
    }),
  );
}

// --- Finestre aperte -------------------------------------------------------------

function saveOpenSet() {
  const list = [...captures].map(([id, c]) => ({ id, name: c.name }));
  try {
    localStorage.setItem('qw.openWindows', JSON.stringify(list));
  } catch {}
  window.bridge.setOpenWindows(list.map((w) => w.id));
  $('#capture-info').textContent = list.length
    ? `${list.length} finestre aperte · attiva: ${activeWid ? shortName(activeWid) : '—'}`
    : 'Nessuna finestra aperta';
}

async function capture(wid) {
  // Il cursore del Mac resta nello stream: getDisplayMedia con cursor: 'never' non lo esclude dalle catture
  // di finestra su macOS (provato), quindi si usa la via più semplice.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: wid,
        // Oltre ~1920 px il visore non mostra più dettaglio su un pannello di dimensioni normali,
        // mentre codifica e decodifica (e quindi la latenza) crescono con i pixel.
        maxWidth: Number(maxresSel.value),
        maxHeight: 2880,
        maxFrameRate: Number(fpsSel.value),
      },
    },
  });
  const track = stream.getVideoTracks()[0];
  // 'text' dice all'encoder di privilegiare la nitidezza dei dettagli rispetto alla fluidità.
  track.contentHint = contentHint;
  return { stream, track };
}

async function openWindow(wid, name, { activate = false } = {}) {
  if (!captures.has(wid)) {
    let c;
    try {
      c = await capture(wid);
    } catch (err) {
      log(`cattura di "${name}" fallita: ${err.message}`);
      notify('*', { type: 'closed', wid, reason: 'cattura fallita' });
      return;
    }
    captures.set(wid, { ...c, name });
    // La finestra chiusa sul Mac termina la traccia: la chiudiamo anche nel visore.
    c.track.onended = () => closeWindow(wid, 'chiusa sul Mac');
    const s = c.track.getSettings();
    log(`aperta: ${name} (${s.width}×${s.height})`);
    for (const viewerId of viewers.keys()) createPeer(viewerId, wid);
    saveOpenSet();
  }
  if (activate) setActive(wid);
  refreshSources();
}

function closeWindow(wid, reason = 'chiusa') {
  const c = captures.get(wid);
  if (!c) return;
  for (const [key, p] of peers) {
    if (p.wid !== wid) continue;
    p.pc.close();
    peers.delete(key);
  }
  c.stream.getTracks().forEach((t) => t.stop());
  captures.delete(wid);
  if (activeWid === wid) activeWid = null;
  notify('*', { type: 'closed', wid, reason });
  log(`${reason}: ${c.name}`);
  saveOpenSet();
  refreshSources();
}

function setActive(wid) {
  if (!captures.has(wid) || wid === activeWid) return;
  activeWid = wid;
  preview.srcObject = captures.get(wid).stream;
  for (const p of peers.values()) tuneSender(p);
  saveOpenSet();
  refreshSources();
}

// Frame effettivamente prodotti dalla cattura macOS (finestra attiva), misurati sull'anteprima locale.
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

async function tuneSender(peer) {
  const params = peer.sender.getParameters();
  // Con testo da leggere la risoluzione non va mai sacrificata: meglio perdere frame.
  params.degradationPreference = degradation;
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = Number(bitrateSel.value);
  const full = peer.wid === activeWid || peer.wid === hoverWid;
  params.encodings[0].maxFramerate = full ? Number(fpsSel.value) : INACTIVE_FPS;
  params.encodings[0].scaleResolutionDownBy = 1;
  await peer.sender.setParameters(params).catch((err) => log(`setParameters ${shortName(peer.wid)}: ${err.message}`));
}

async function createPeer(viewerId, wid) {
  const c = captures.get(wid);
  if (!c) return;
  const key = peerKey(viewerId, wid);
  peers.get(key)?.pc.close();

  const pc = new RTCPeerConnection({ iceServers: [] });
  const transceiver = pc.addTransceiver(c.track, { direction: 'sendonly', streams: [c.stream] });
  const codecs = orderedCodecs(codecSel.value);
  if (codecs) transceiver.setCodecPreferences(codecs);
  else log(`codec ${codecSel.value} non disponibile, uso default`);

  const peer = { pc, sender: transceiver.sender, viewerId, wid, last: null, lastLog: 0 };
  peers.set(key, peer);

  pc.onicecandidate = (e) => {
    if (e.candidate) signal(viewerId, { sid: wid, candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => log(`${viewerId} ${shortName(wid)}: ${pc.connectionState}`);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await tuneSender(peer);
  signal(viewerId, { sid: wid, name: c.name, type: 'offer', sdp: offer.sdp });
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
  const peer = peers.get(peerKey(from, data.sid));
  if (!peer) return;
  if (data.type === 'answer') await peer.pc.setRemoteDescription({ type: 'answer', sdp: mungeAnswer(data.sdp) });
  else if (data.candidate) {
    await peer.pc.addIceCandidate(data.candidate).catch((err) => log(`addIceCandidate: ${err.message}`));
  }
}

// Cambi di codifica: il codec richiede di rinegoziare da zero (il viewer accetta una nuova offer per la stessa
// finestra in qualsiasi momento), risoluzione e fps richiedono di ricatturare.
function renegotiateAll() {
  for (const p of [...peers.values()]) createPeer(p.viewerId, p.wid);
}
async function recaptureAll() {
  for (const [wid, c] of captures) {
    const next = await capture(wid).catch(() => null);
    if (!next) continue;
    c.track.onended = null;
    c.stream.getTracks().forEach((t) => t.stop());
    Object.assign(c, next);
    next.track.onended = () => closeWindow(wid, 'chiusa sul Mac');
    for (const p of peers.values()) if (p.wid === wid) await p.sender.replaceTrack(next.track);
    if (wid === activeWid) preview.srcObject = next.stream;
  }
}
codecSel.onchange = renegotiateAll;
bitrateSel.onchange = () => {
  for (const p of peers.values()) tuneSender(p);
};
maxresSel.onchange = recaptureAll;
fpsSel.onchange = async () => {
  await recaptureAll();
  for (const p of peers.values()) tuneSender(p);
};

// --- Controllo remoto (scripts/ctl.mjs) ---------------------------------------------

async function findSource(name) {
  for (let i = 0; i < 20; i++) {
    const match = (await window.bridge.listSources()).find((s) => s.name.includes(name));
    if (match) return match;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function onControl(msg) {
  log(`controllo: ${JSON.stringify(msg)}`);
  if (msg.maxres) {
    maxresSel.value = String(msg.maxres);
    await recaptureAll();
  }
  if (msg.fps) {
    fpsSel.value = String(msg.fps);
    await fpsSel.onchange();
  }
  // select = apri e rendi attiva una finestra per (parte del) titolo; close = chiudila; closeAll = tutte.
  if (msg.select || msg.testPattern) {
    const match = await findSource(msg.select ?? 'QW Test Pattern');
    if (match) await openWindow(match.id, match.name, { activate: true });
  }
  if (msg.close) {
    for (const [wid, c] of captures) if (c.name.includes(msg.close)) closeWindow(wid);
  }
  if (msg.closeAll) for (const wid of [...captures.keys()]) closeWindow(wid);
  if (msg.contentHint || msg.degradation) {
    contentHint = msg.contentHint ?? contentHint;
    degradation = msg.degradation ?? degradation;
    for (const c of captures.values()) c.track.contentHint = contentHint;
    for (const p of peers.values()) await tuneSender(p);
  }
  if (msg.codec) {
    codecSel.value = msg.codec;
    renegotiateAll();
  }
}

// --- Signaling -----------------------------------------------------------------

async function onViewerMessage(msg) {
  // Messaggi dal visore inoltrati dal main (con `from`).
  if (msg.type === 'open') {
    const source = (await window.bridge.listSources()).find((s) => s.id === msg.wid);
    if (source) await openWindow(source.id, source.name, { activate: true });
    else notify(msg.from, { type: 'closed', wid: msg.wid, reason: 'finestra non più presente' });
  } else if (msg.type === 'close') {
    closeWindow(msg.wid);
  } else if (msg.type === 'active') {
    setActive(msg.wid);
  } else if (msg.type === 'hover') {
    const prev = hoverWid;
    hoverWid = msg.wid && captures.has(msg.wid) ? msg.wid : null;
    for (const p of peers.values()) if (p.wid === prev || p.wid === hoverWid) tuneSender(p);
  }
}

async function connect() {
  const { port, lan } = await window.bridge.serverInfo();
  $('#server').textContent = `http://localhost:${port}  ·  LAN: ${lan.map((ip) => `${ip}:${port}`).join(', ')}`;

  ws = new WebSocket(`ws://localhost:${port}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'host' }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'viewer-joined') {
      log(`viewer ${msg.id} (${msg.name}) connesso`);
      viewers.set(msg.id, msg.name);
      // Un viewer che si (ri)collega riceve subito tutte le finestre aperte.
      for (const wid of captures.keys()) createPeer(msg.id, wid);
      if (activeWid) notify(msg.id, { type: 'active', wid: activeWid });
    } else if (msg.type === 'viewer-left') {
      viewers.delete(msg.id);
      for (const [key, p] of peers) {
        if (p.viewerId !== msg.id) continue;
        p.pc.close();
        peers.delete(key);
      }
      log(`viewer ${msg.id} uscito`);
    } else if (msg.type === 'signal') {
      onSignal(msg.from, msg.data);
    } else if (msg.type === 'control') {
      onControl(msg);
    } else if (msg.from) {
      onViewerMessage(msg);
    }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}

// --- Statistiche ---------------------------------------------------------------

async function updateStats() {
  const box = $('#peers');
  if (!peers.size) {
    box.textContent = viewers.size ? 'nessuna finestra aperta' : 'nessun viewer connesso';
    return;
  }
  const blocks = [];
  let totalEncodeMs = 0;
  for (const p of peers.values()) {
    const report = await p.pc.getStats();
    let out;
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') out = s;
    });
    let mbps = 0;
    let encodeMs = 0;
    let encodedFps = 0;
    if (out && p.last) {
      const dt = (out.timestamp - p.last.ts) / 1000;
      mbps = ((out.bytesSent - p.last.bytes) * 8) / (dt * 1e6);
      const dFrames = (out.framesEncoded ?? 0) - p.last.framesEncoded;
      encodedFps = dFrames / dt;
      if (dFrames > 0) encodeMs = (((out.totalEncodeTime ?? 0) - p.last.encodeTime) * 1000) / dFrames;
      totalEncodeMs += encodeMs * encodedFps; // ms di codifica al secondo, sommati su tutte le finestre
    }
    if (out) p.last = { bytes: out.bytesSent, ts: out.timestamp, framesEncoded: out.framesEncoded ?? 0, encodeTime: out.totalEncodeTime ?? 0 };
    const active = p.wid === activeWid;
    if (out && Date.now() - p.lastLog > 4000) {
      p.lastLog = Date.now();
      log(
        `[stats ${p.viewerId} ${shortName(p.wid)}${active ? ' *' : ''}] enc ${out.frameWidth}×${out.frameHeight} ` +
          `${encodedFps.toFixed(0)}fps ${mbps.toFixed(1)}Mbps ${encodeMs.toFixed(1)}ms/frame limit=${out.qualityLimitationReason}`,
      );
    }
    blocks.push(
      `<div class="peer"><b>${p.viewerId}</b> ${shortName(p.wid)}${active ? ' ★' : ''} — ${p.pc.connectionState}\n` +
        (out
          ? `${out.frameWidth ?? '?'}×${out.frameHeight ?? '?'} @ ${encodedFps.toFixed(0)}fps  ${mbps.toFixed(1)} Mbps  ${encodeMs.toFixed(1)} ms/frame`
          : 'in negoziazione…') +
        `</div>`,
    );
  }
  blocks.unshift(`<div class="peer">codifica totale: ${(totalEncodeMs / 10).toFixed(0)}% di un core · cattura attiva ${captureFps} fps</div>`);
  box.innerHTML = blocks.join('');
}

$('#refresh').onclick = refreshSources;

// Al riavvio riapre le finestre che erano aperte, se esistono ancora (stesso id, o stesso titolo).
async function restoreOpenWindows() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem('qw.openWindows') ?? '[]');
  } catch {}
  const sources = await window.bridge.listSources();
  for (const w of saved) {
    const match = sources.find((s) => s.id === w.id) ?? sources.find((s) => s.name === w.name);
    if (match) await openWindow(match.id, match.name);
  }
  if (!activeWid && captures.size) setActive(captures.keys().next().value);
  saveOpenSet();
  refreshSources();
}
restoreOpenWindows();
connect();
setInterval(updateStats, 1000);
