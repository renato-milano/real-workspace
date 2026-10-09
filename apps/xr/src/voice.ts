// Microfono del visore per il push-to-talk: PCM 16 kHz mono (Int16) inviato al bridge a pacchetti da 100 ms.
// Il microfono resta aperto per tutta la sessione: avviarlo alla pressione del tasto costerebbe centinaia di
// ms e taglierebbe l'inizio della frase. Un pre-roll di 300 ms recupera anche la prima sillaba.

const SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = SAMPLE_RATE / 10;
const PREROLL_CHUNKS = 3;

// AudioWorklet in linea: copia ogni blocco di 128 campioni verso il thread principale.
const WORKLET = `
class QwPcm extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('qw-pcm', QwPcm);
`;

export type MicState = 'off' | 'permesso…' | 'pronto' | 'negato' | 'sospeso';

export function createMic({
  sendChunk,
  onState,
}: {
  sendChunk: (pcm: Int16Array) => void;
  onState: (s: MicState, detail?: string) => void;
}) {
  let ctx: AudioContext | null = null;
  let recording = false;
  let pending = new Int16Array(CHUNK_SAMPLES);
  let fill = 0;
  const preroll: Int16Array[] = [];

  function onSamples(f32: Float32Array) {
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      pending[fill++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (fill === CHUNK_SAMPLES) {
        if (recording) sendChunk(pending);
        else {
          preroll.push(pending);
          if (preroll.length > PREROLL_CHUNKS) preroll.shift();
        }
        pending = new Int16Array(CHUNK_SAMPLES);
        fill = 0;
      }
    }
  }

  async function init() {
    onState('permesso…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // Il browser ricampiona l'ingresso alla frequenza del contesto: niente ricampionamento a mano.
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'qw-pcm');
      node.port.onmessage = (e) => onSamples(e.data as Float32Array);
      ctx.createMediaStreamSource(stream).connect(node);
      onState(ctx.state === 'running' ? 'pronto' : 'sospeso', `${ctx.sampleRate} Hz`);
      ctx.onstatechange = () => onState(ctx!.state === 'running' ? 'pronto' : 'sospeso');
    } catch (err) {
      onState('negato', String((err as Error)?.message ?? err));
    }
  }

  // L'AudioContext parte solo dopo un gesto dell'utente: il click su "Entra" basta.
  const resume = () => ctx?.state === 'suspended' && ctx.resume().catch(() => {});
  document.addEventListener('pointerdown', resume, true);
  document.addEventListener('click', resume, true);

  init();

  return {
    get ready() {
      return ctx?.state === 'running';
    },
    start() {
      resume();
      recording = true;
      for (const c of preroll) sendChunk(c);
      preroll.length = 0;
    },
    stop() {
      // Il pezzo parziale in coda fa parte della frase.
      if (recording && fill > 0) sendChunk(pending.slice(0, fill));
      fill = 0;
      recording = false;
    },
  };
}
