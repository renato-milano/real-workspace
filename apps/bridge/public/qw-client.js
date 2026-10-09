// Client viewer condiviso (viewer 2D e client WebXR): signaling con il bridge e ricezione WebRTC.
// Una RTCPeerConnection per finestra aperta (sid = id della finestra sul Mac).

export function connectViewer({ name, onStream, onClosed = () => {}, onState = () => {}, onMessage = () => {} }) {
  let ws = null;
  let replaced = false;
  const pcs = new Map(); // sid → { pc, last }
  const outbox = []; // messaggi inviati prima che il WebSocket sia aperto

  function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else outbox.push(msg);
  }

  function debug(line) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'log', line }));
  }

  function signal(data) {
    ws?.send(JSON.stringify({ type: 'signal', to: 'host', data }));
  }

  function closePc(sid) {
    pcs.get(sid)?.pc.close();
    pcs.delete(sid);
  }

  async function onOffer(sid, sdp, windowName) {
    // Il bridge può rinegoziare (es. cambio codec): ogni offer riparte da una connessione nuova.
    closePc(sid);
    const pc = new RTCPeerConnection({ iceServers: [] });
    pcs.set(sid, { pc, last: null });
    pc.ontrack = (e) => {
      // Latenza minima: chiediamo al jitter buffer di non trattenere frame oltre lo stretto necessario.
      if ('jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0;
      if ('playoutDelayHint' in e.receiver) e.receiver.playoutDelayHint = 0;
      onStream(e.streams[0] ?? new MediaStream([e.track]), { sid, name: windowName });
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) signal({ sid, candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      debug(`${windowName ?? sid}: ${pc.connectionState}`);
      onState(pc.connectionState, sid);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal({ sid, type: 'answer', sdp: answer.sdp });
  }

  function open() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'viewer', name }));
      while (outbox.length) ws.send(JSON.stringify(outbox.shift()));
      onState('in attesa del bridge…');
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'replaced') {
        replaced = true;
        for (const sid of [...pcs.keys()]) closePc(sid);
        onState("sostituito da un'altra scheda — questa è inattiva");
        return;
      }
      if (msg.type === 'closed') {
        closePc(msg.wid);
        onClosed(msg.wid, msg.reason);
        return;
      }
      if (msg.type !== 'signal') {
        onMessage(msg);
        return;
      }
      const { sid } = msg.data;
      if (msg.data.type === 'offer') onOffer(sid, msg.data.sdp, msg.data.name);
      else if (msg.data.candidate) {
        pcs.get(sid)?.pc.addIceCandidate(msg.data.candidate).catch((err) => debug(`addIceCandidate: ${err.message}`));
      }
    };
    ws.onclose = () => {
      if (replaced) return;
      // Al ricollegamento il bridge rimanda tutte le finestre aperte: quelle vecchie non servono più.
      for (const sid of [...pcs.keys()]) closePc(sid);
      onState('bridge non raggiungibile, riprovo…');
      setTimeout(open, 1000);
    };
  }
  open();

  return {
    send,

    // Dati binari (audio): senza connessione vanno persi, non ha senso accodarli.
    sendBinary(data) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(data);
      return true;
    },

    // Statistiche di ricezione di una finestra.
    async stats(sid) {
      const entry = pcs.get(sid);
      if (!entry) return null;
      const report = await entry.pc.getStats();
      let inb, pair;
      report.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s;
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
      });
      if (!inb) return null;
      const codec = inb.codecId ? report.get(inb.codecId) : null;
      const last = entry.last;
      let mbps = 0;
      // Medie sull'intervallo dall'ultima lettura: ms per frame di decodifica e di attesa nel jitter buffer.
      let decodeMs = 0;
      let jitterBufferMs = 0;
      if (last) {
        mbps = ((inb.bytesReceived - last.bytes) * 8) / ((inb.timestamp - last.ts) * 1000);
        const dFrames = (inb.framesDecoded ?? 0) - last.framesDecoded;
        if (dFrames > 0) decodeMs = (((inb.totalDecodeTime ?? 0) - last.decodeTime) * 1000) / dFrames;
        const dEmitted = (inb.jitterBufferEmittedCount ?? 0) - last.emitted;
        if (dEmitted > 0) jitterBufferMs = (((inb.jitterBufferDelay ?? 0) - last.jbDelay) * 1000) / dEmitted;
      }
      entry.last = {
        bytes: inb.bytesReceived,
        ts: inb.timestamp,
        framesDecoded: inb.framesDecoded ?? 0,
        decodeTime: inb.totalDecodeTime ?? 0,
        emitted: inb.jitterBufferEmittedCount ?? 0,
        jbDelay: inb.jitterBufferDelay ?? 0,
      };
      return {
        width: inb.frameWidth ?? 0,
        height: inb.frameHeight ?? 0,
        fps: inb.framesPerSecond ?? 0,
        mbps,
        codec: codec?.mimeType ?? '?',
        decoder: inb.decoderImplementation ?? '?',
        powerEfficient: inb.powerEfficientDecoder ?? false,
        framesDropped: inb.framesDropped ?? 0,
        jitterMs: Math.round((inb.jitter ?? 0) * 1000),
        decodeMs: Math.round(decodeMs),
        jitterBufferMs: Math.round(jitterBufferMs),
        rttMs: pair?.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : '?',
      };
    },
  };
}
