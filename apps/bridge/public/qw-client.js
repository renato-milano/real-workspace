// Client viewer condiviso (viewer 2D e client WebXR): signaling con il bridge e ricezione WebRTC.

export function connectViewer({ name, onStream, onState = () => {} }) {
  let ws = null;
  let pc = null;
  let last = null;
  let replaced = false;
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

  async function onOffer(sdp) {
    // Il bridge può rinegoziare (es. cambio codec): ogni offer riparte da una connessione nuova.
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: [] });
    last = null;
    pc.ontrack = (e) => {
      // Latenza minima: chiediamo al jitter buffer di non trattenere frame oltre lo stretto necessario.
      const hasTarget = 'jitterBufferTarget' in e.receiver;
      const hasHint = 'playoutDelayHint' in e.receiver;
      if (hasTarget) e.receiver.jitterBufferTarget = 0;
      if (hasHint) e.receiver.playoutDelayHint = 0;
      debug(
        `ricevitore: jitterBufferTarget=${hasTarget ? e.receiver.jitterBufferTarget : 'n/d'} ` +
          `playoutDelayHint=${hasHint ? e.receiver.playoutDelayHint : 'n/d'} ua=${navigator.userAgent}`,
      );
      onStream(e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        debug(`ice locale: ${e.candidate.candidate}`);
        signal({ candidate: e.candidate.toJSON() });
      }
    };
    pc.onicegatheringstatechange = () => debug(`gathering ${pc.iceGatheringState}`);
    pc.oniceconnectionstatechange = () => debug(`ice ${pc.iceConnectionState}`);
    pc.onconnectionstatechange = () => {
      debug(`connection ${pc.connectionState}`);
      onState(pc.connectionState);
    };
    await pc.setRemoteDescription({ type: 'offer', sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal({ type: 'answer', sdp: answer.sdp });
  }

  function open() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'viewer', name }));
      while (outbox.length) ws.send(JSON.stringify(outbox.shift()));
      onState('in attesa del bridge…');
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'replaced') {
        replaced = true;
        pc?.close();
        onState('sostituito da un\'altra scheda — questa è inattiva');
        return;
      }
      if (msg.type !== 'signal') return;
      if (msg.data.type === 'offer') onOffer(msg.data.sdp);
      else if (msg.data.candidate) {
        debug(`ice remoto: ${msg.data.candidate.candidate}`);
        pc?.addIceCandidate(msg.data.candidate).catch((err) => debug(`addIceCandidate: ${err.message}`));
      }
    };
    ws.onclose = () => {
      if (replaced) return;
      onState('bridge non raggiungibile, riprovo…');
      setTimeout(open, 1000);
    };
  }
  open();

  return {
    send,

    async stats() {
      if (!pc) return null;
      const report = await pc.getStats();
      let inb, pair;
      report.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') inb = s;
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
      });
      if (!inb) return null;
      const codec = inb.codecId ? report.get(inb.codecId) : null;
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
      last = {
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
