// Client WebXR del workspace: una finestra del Mac come pannello in MR, con input remoto.
//
// Struttura del pannello:
//   barra (afferrabile col raggio + grilletto) → sposta tutto
//   └─ finestra (XRQuadLayer, composto dal compositor di Horizon OS) → click / trascina / scroll sul Mac
//   │  └─ puntatore locale, disegnato a 90 fps: non aspetta il video
//   └─ HUD di misura
//
// Controller destro:  stick su/giù sulla finestra = scroll; altrove = pannello più grande/piccolo
//                     A tenuto = parla: al rilascio il testo viene scritto nella finestra (senza invio)
//                     B = riporta il pannello davanti a te
// Controller sinistro: X = invio · Y = cancella l'ultima dettatura

import {
  CanvasTexture,
  CircleGeometry,
  DistanceGrabbable,
  InputComponent,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MovementMode,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RayInteractable,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  VideoTexture,
  World,
  XRLayerState,
  XRQuadLayer,
  createSystem,
  type WebGLRenderTarget,
} from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { connectViewer, type StreamStats } from '@qw/client';
import { OneEuroFilter } from './one-euro.js';
import { createMic, type MicState } from './voice.js';

const PANEL_WIDTH_M = 1.2;
const PANEL_DISTANCE_M = 1.0;
const BAR_HEIGHT_M = 0.035;
const BAR_GAP_M = 0.015;
const SCROLL_PX_PER_FRAME = 18;
const STICK_DEADZONE = 0.2;
// Filtro del puntatore, in metri sul pannello: fermo sotto ~1 Hz di tremolio, reattivo quando ci si muove.
const POINTER_MIN_CUTOFF_HZ = 0.7;
const POINTER_BETA = 22;
// Col tasto premuto il punto resta bloccato finché non ci si sposta di oltre 1,2 cm: il gesto di premere
// il grilletto non deve spostare il click, e un trascinamento parte solo quando è voluto.
const DRAG_START_M = 0.012;

// --- Stream dal bridge ---------------------------------------------------------

const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
video.autoplay = true;

let streamState = 'connessione al bridge…';
const client = connectViewer({
  name: 'xr-iwsdk',
  onStream: (stream) => {
    video.srcObject = stream;
    video.play().catch(() => {});
  },
  onState: (s) => (streamState = s),
  onMessage: (msg) => {
    if (msg.type === 'transcript') onTranscript(msg as unknown as Transcript);
  },
});

// Diagnostica: errori e eventi chiave finiscono nel log del bridge (il browser del Quest non è ispezionabile da qui).
const remoteLog = (line: string) => client.send({ type: 'log', line: `[xr] ${line}` });
window.addEventListener('error', (e) => remoteLog(`error: ${e.message}\n${e.error?.stack ?? `@ ${e.filename}:${e.lineno}`}`));
window.addEventListener('unhandledrejection', (e) => remoteLog(`rejection: ${String(e.reason?.stack ?? e.reason)}`));
const origError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  remoteLog(`console.error: ${args.map(String).join(' ')}`);
  origError(...args);
};
const origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  remoteLog(`console.warn: ${args.map(String).join(' ')}`);
  origWarn(...args);
};

// --- Voce (push-to-talk) -------------------------------------------------------------

type Transcript = { text?: string; error?: string; audioMs: number; whisperMs?: number; typed?: boolean };

let micState: MicState = 'off';
let micDetail = '';
let voiceStatus = '';
let voiceText = '';
let releasedAt = 0;

const mic = createMic({
  sendChunk: (pcm) => client.sendBinary(pcm),
  onState: (s, detail) => {
    micState = s;
    if (detail) micDetail = detail;
    remoteLog(`microfono: ${s}${detail ? ` (${detail})` : ''}`);
  },
});

function onTranscript(t: Transcript) {
  // Latenza percepita: dal rilascio del tasto al testo nel visore.
  const totalMs = Math.round(performance.now() - releasedAt);
  if (t.error) {
    voiceStatus = `voce: errore — ${t.error}`;
    voiceText = '';
  } else {
    const where = !t.text ? '' : t.typed ? ' · scritto (X invia, Y cancella)' : ' · nessuna finestra, non inserito';
    voiceStatus = `voce: ${(t.audioMs / 1000).toFixed(1)} s · ${totalMs} ms${where}`;
    voiceText = t.text || '(niente di riconosciuto)';
  }
  remoteLog(`[voce] audio ${t.audioMs}ms whisper ${t.whisperMs ?? '-'}ms totale ${totalMs}ms`);
}

// Texture del layer: copiamo i pixel 1:1 nella superficie del compositor, senza conversioni.
const layerTexture = new VideoTexture(video);
layerTexture.colorSpace = NoColorSpace;
layerTexture.generateMipmaps = false;
layerTexture.minFilter = LinearFilter;
layerTexture.magFilter = LinearFilter;

// Scena "blit": un quad a schermo intero che copia il video nel render target del layer.
const blitScene = new Scene();
const blitCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
blitScene.add(
  new Mesh(
    new PlaneGeometry(2, 2),
    new ShaderMaterial({
      uniforms: { map: { value: layerTexture } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }',
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  ),
);

// --- Elementi di interfaccia disegnati su canvas -------------------------------------

function canvasPlane(
  width: number,
  height: number,
  px: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  const c = document.createElement('canvas');
  c.width = px;
  c.height = Math.round((px * height) / width);
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  const redraw = () => {
    draw(c.getContext('2d')!, c.width, c.height);
    texture.needsUpdate = true;
  };
  redraw();
  const mesh = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: texture, transparent: true }));
  return { mesh, redraw };
}

let hudLines: string[] = [];
const HUD_TEXT_LINES = 2; // righe per l'ultima trascrizione
const hud = canvasPlane(0.8, 0.22, 1024, (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(16,18,22,0.88)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 18);
  ctx.fill();
  ctx.fillStyle = '#e6e8eb';
  ctx.font = '30px ui-monospace, monospace';
  hudLines.forEach((l, i) => ctx.fillText(l, 24, 46 + i * 42));
  // Trascrizione: a capo sulle parole, al massimo HUD_TEXT_LINES righe (le ultime parole restano visibili).
  if (voiceText) {
    ctx.fillStyle = '#9fc2ff';
    const lines: string[] = [];
    let line = '';
    for (const word of voiceText.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > w - 48 && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
    const shown = lines.slice(-HUD_TEXT_LINES);
    if (lines.length > HUD_TEXT_LINES) shown[0] = `…${shown[0]}`;
    shown.forEach((l, i) => ctx.fillText(l, 24, 46 + (hudLines.length + i) * 42));
  }
});

let barHover = false;
const bar = canvasPlane(PANEL_WIDTH_M * 0.35, BAR_HEIGHT_M, 512, (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = barHover ? 'rgba(79,140,255,0.95)' : 'rgba(40,44,52,0.9)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(230,232,235,0.9)';
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.arc(w / 2 + i * 16, h / 2, 4, 0, Math.PI * 2);
    ctx.fill();
  }
});

// --- Scena --------------------------------------------------------------------------

const world = await World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions);
remoteLog(`world creato; immersive-ar supportato: ${await navigator.xr?.isSessionSupported('immersive-ar')}`);

let aspect = 1128 / 1918;
let widthM = PANEL_WIDTH_M;

// Barra: l'unico punto di presa. Il contenuto della finestra resta libero per click e scroll.
const barEntity = world.createTransformEntity(bar.mesh);
barEntity.addComponent(RayInteractable);
barEntity.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveAtSource, scale: false });
bar.mesh.addEventListener('pointerenter', () => {
  barHover = true;
  bar.redraw();
});
bar.mesh.addEventListener('pointerleave', () => {
  barHover = false;
  bar.redraw();
});

const layerEntity = world.createTransformEntity(undefined, { parent: barEntity });
layerEntity.addComponent(XRQuadLayer, {
  width: widthM,
  height: widthM * aspect,
  pixelWidth: 1918,
  pixelHeight: 1128,
  renderCallback: () => world.renderer.render(blitScene, blitCamera),
});
layerEntity.addComponent(RayInteractable);

const hudEntity = world.createTransformEntity(hud.mesh, { parent: barEntity });

// Puntatore locale: anello sul punto colpito, appena davanti al pannello e sempre sopra il contenuto.
const cursor = new Mesh(
  new RingGeometry(0.004, 0.0065, 32),
  new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }),
);
const cursorDot = new Mesh(new CircleGeometry(0.0022, 16), new MeshBasicMaterial({ color: 0x4f8cff, depthTest: false }));
cursor.add(cursorDot);
cursor.renderOrder = 10;
cursorDot.renderOrder = 11;
cursor.visible = false;
// Il puntatore non deve intercettare il raggio: altrimenti le UV lette sarebbero quelle dell'anello
// (che sta davanti alla finestra) e il cursore del Mac salterebbe a ogni frame.
for (const m of [cursor, cursorDot]) {
  m.raycast = () => {};
  (m as unknown as { pointerEvents: string }).pointerEvents = 'none';
}
world.createTransformEntity(cursor, { parent: layerEntity });

// --- Input remoto -------------------------------------------------------------------

type PanelPointerEvent = {
  uv?: { x: number; y: number };
  point: Vector3;
  pointerId: number;
  pointerType?: string;
};
type PointerListener = (e: PanelPointerEvent) => void;

// Solo i puntatori XR (raggio di controller e mani, tocco diretto) comandano il Mac. IWSDK genera anche un
// puntatore "screen-*" per la pagina 2D che in XR segue lo sguardo: va ignorato, altrimenti il cursore
// del Mac salta tra il punto mirato e quello guardato.
const isXrPointer = (e: PanelPointerEvent) => !e.pointerType?.startsWith('screen');

// Un solo puntatore attivo alla volta: quello entrato per primo, o quello che ha premuto per ultimo.
let activePointer: number | null = null;
let pointerDown = false;
const lastUv = { u: 0, v: 0 };
const filterX = new OneEuroFilter(POINTER_MIN_CUTOFF_HZ, POINTER_BETA);
const filterY = new OneEuroFilter(POINTER_MIN_CUTOFF_HZ, POINTER_BETA);
let lastFilterTime = 0;
let clickLock: { x: number; y: number } | null = null;

function resetPointerFilter() {
  filterX.reset();
  filterY.reset();
  lastFilterTime = 0;
  clickLock = null;
}

function onPanelPointer(op: 'move' | 'down' | 'up', e: PanelPointerEvent) {
  if (!e.uv) return;
  const h = widthM * aspect;
  const now = performance.now();
  const dt = lastFilterTime ? (now - lastFilterTime) / 1000 : 0;
  lastFilterTime = now;

  // Coordinate in metri sul pannello, origine al centro: il filtro lavora in unità fisiche.
  let x = filterX.filter((e.uv.x - 0.5) * widthM, dt);
  let y = filterY.filter((e.uv.y - 0.5) * h, dt);

  if (op === 'down') clickLock = { x, y };
  if (clickLock) {
    if (Math.hypot(x - clickLock.x, y - clickLock.y) < DRAG_START_M) {
      x = clickLock.x;
      y = clickLock.y;
    } else {
      clickLock = null; // movimento deciso: da qui è un trascinamento
    }
  }
  if (op === 'up') clickLock = null;

  lastUv.u = x / widthM + 0.5;
  lastUv.v = y / h + 0.5;
  cursor.position.set(x, y, 0.003);
  cursor.visible = true;
  client.send({ type: 'input', op, u: lastUv.u, v: lastUv.v });
}

function release() {
  // Rilascio di sicurezza: se il puntatore esce col tasto premuto, il Mac non deve restare in trascinamento.
  if (pointerDown) client.send({ type: 'input', op: 'up', u: lastUv.u, v: lastUv.v });
  pointerDown = false;
  activePointer = null;
  cursor.visible = false;
  resetPointerFilter();
}

// Gli eventi puntatore (pmndrs/pointer-events, attivati da RayInteractable) risalgono dalla mesh che il
// sistema dei layer crea come figlia dell'entità. I tipi three non li conoscono, da qui il cast.
const on = (type: string, fn: PointerListener) =>
  (layerEntity.object3D!.addEventListener as (t: string, f: PointerListener) => void)(type, (e) => {
    if (isXrPointer(e)) fn(e);
  });

on('pointerenter', (e) => {
  if (activePointer != null) return;
  activePointer = e.pointerId;
  resetPointerFilter();
});
on('pointermove', (e) => {
  if (e.pointerId === activePointer) onPanelPointer('move', e);
});
on('pointerdown', (e) => {
  if (e.pointerId !== activePointer) {
    release();
    activePointer = e.pointerId;
    resetPointerFilter();
  }
  pointerDown = true;
  onPanelPointer('down', e);
});
on('pointerup', (e) => {
  if (e.pointerId !== activePointer) return;
  pointerDown = false;
  onPanelPointer('up', e);
});
on('pointerleave', (e) => {
  if (e.pointerId === activePointer) release();
});

// --- Layout -------------------------------------------------------------------------

function applySize() {
  const h = widthM * aspect;
  layerEntity.setValue(XRQuadLayer, 'width', widthM);
  layerEntity.setValue(XRQuadLayer, 'height', h);
  layerEntity.object3D!.position.set(0, -(BAR_HEIGHT_M / 2 + BAR_GAP_M + h / 2), 0);
  const hudObj = hudEntity.object3D!;
  hudObj.position.set(0, -(BAR_HEIGHT_M / 2 + BAR_GAP_M + h + 0.13), 0.02);
  hudObj.rotation.set(-0.3, 0, 0);
}

const tmpDir = new Vector3();
const tmpBase = new Vector3();
function placeInFront() {
  const head = world.camera;
  head.getWorldDirection(tmpDir);
  tmpDir.y = 0;
  tmpDir.normalize();
  const yaw = Math.atan2(-tmpDir.x, -tmpDir.z);
  tmpBase.setFromMatrixPosition(head.matrixWorld);
  const o = barEntity.object3D!;
  o.position.copy(tmpBase).addScaledVector(tmpDir, PANEL_DISTANCE_M);
  // Barra poco sopra gli occhi: il centro della finestra cade leggermente sotto lo sguardo.
  o.position.y = tmpBase.y + (widthM * aspect) / 2 - 0.08;
  o.rotation.set(0, yaw, 0);
}

applySize();
placeInFront();

video.addEventListener('resize', () => {
  remoteLog(`video ${video.videoWidth}×${video.videoHeight}`);
  if (!video.videoWidth) return;
  aspect = video.videoHeight / video.videoWidth;
  layerEntity.setValue(XRQuadLayer, 'pixelWidth', video.videoWidth);
  layerEntity.setValue(XRQuadLayer, 'pixelHeight', video.videoHeight);
  applySize();
});

// --- Sistema: input controller, frame rate, HUD ---------------------------------------------

class WorkspaceSystem extends createSystem({}) {
  private frames = 0;
  private elapsed = 0;
  private xrFps = 0;
  private stats: StreamStats | null = null;
  private targetRate: number | string = '-';
  private logTick = 0;
  private head = new Vector3();
  private panelPos = new Vector3();

  init() {
    this.renderer.xr.addEventListener('sessionstart', () => {
      const session = this.renderer.xr.getSession();
      const rates = session?.supportedFrameRates;
      remoteLog(
        `sessione avviata: blend=${session?.environmentBlendMode} features=${JSON.stringify(session?.enabledFeatures)} ` +
          `rates=${rates ? Array.from(rates).join(',') : '-'} video=${video.videoWidth}×${video.videoHeight}`,
      );
      session?.addEventListener('end', () => remoteLog('sessione terminata'));
      // Il browser del Quest parte a 72 Hz: chiediamo 90 se disponibile.
      if (session && rates?.includes(90)) session.updateTargetFrameRate(90).catch(() => {});
      setTimeout(placeInFront, 300);
    });
    setInterval(async () => {
      this.stats = await client.stats();
      this.targetRate = this.renderer.xr.getSession()?.frameRate ?? '-';
      const st = this.stats;
      if (st && st.mbps > 0.2 && (this.logTick = (this.logTick + 1) % 4) === 0) {
        remoteLog(
          `[stats] dec ${st.width}×${st.height} ${st.fps}fps ${st.mbps.toFixed(1)}Mbps ${st.decoder}${st.powerEfficient ? '(hw)' : ''} ` +
            `decode ${st.decodeMs}ms jitterbuf ${st.jitterBufferMs}ms rtt ${st.rttMs}ms persi ${st.framesDropped} xr ${this.xrFps.toFixed(0)}fps`,
        );
      }
    }, 500);
  }

  update(delta: number) {
    // Workaround bug IWSDK 1.0.1 su Quest: il render target del layer ha samples=4; quando diventa
    // nativo, setRenderTargetTextures() disattiva il multisample-render-to-texture e three cerca un
    // framebuffer multisample mai creato → "Invalid value used as weak map key" a ogni frame.
    // Con resolveDepthBuffer=false three alloca da sé il depth e mantiene il percorso MSRTT valido.
    if (layerEntity.hasComponent(XRLayerState)) {
      const rt = XRLayerState.data.renderTarget[layerEntity.index] as WebGLRenderTarget | null;
      if (rt && rt.resolveDepthBuffer) rt.resolveDepthBuffer = false;
    }

    this.frames++;
    this.elapsed += delta;
    if (this.elapsed >= 0.5) {
      this.xrFps = this.frames / this.elapsed;
      this.frames = 0;
      this.elapsed = 0;
      this.redrawHud();
    }

    const left = this.input.gamepads.left;
    if (left?.getButtonDown(InputComponent.X_Button)) {
      client.send({ type: 'input', op: 'key', key: 'return' });
      voiceStatus = 'voce: inviato (invio)';
      voiceText = '';
      this.redrawHud();
    } else if (left?.getButtonDown(InputComponent.Y_Button)) {
      client.send({ type: 'input', op: 'undo-dictation' });
      voiceStatus = 'voce: ultima dettatura cancellata';
      voiceText = '';
      this.redrawHud();
    }

    const pad = this.input.gamepads.right;
    if (!pad) return;
    if (activePointer != null) {
      // Sulla finestra lo stick scorre il contenuto, in modo continuo e proporzionale.
      const stick = pad.getAxesValues(InputComponent.Thumbstick);
      if (stick && Math.abs(stick.y) > STICK_DEADZONE) {
        client.send({ type: 'input', op: 'scroll', dy: Math.round(-stick.y * SCROLL_PX_PER_FRAME) });
      }
    } else if (pad.getAxesEnteringUp(InputComponent.Thumbstick)) {
      widthM = Math.min(widthM * 1.1, 3);
      applySize();
    } else if (pad.getAxesEnteringDown(InputComponent.Thumbstick)) {
      widthM = Math.max(widthM / 1.1, 0.3);
      applySize();
    }
    if (pad.getButtonDown(InputComponent.B_Button)) placeInFront();

    if (pad.getButtonDown(InputComponent.A_Button)) {
      if (mic.ready) {
        client.send({ type: 'voice', op: 'start' });
        mic.start();
        voiceStatus = 'voce: ● ascolto…';
      } else {
        voiceStatus = `voce: microfono ${micState}${micDetail ? ` (${micDetail})` : ''}`;
      }
      this.redrawHud();
    } else if (pad.getButtonUp(InputComponent.A_Button) && mic.ready && voiceStatus.startsWith('voce: ●')) {
      mic.stop();
      client.send({ type: 'voice', op: 'end' });
      releasedAt = performance.now();
      voiceStatus = 'voce: trascrivo…';
      this.redrawHud();
    }
  }

  private redrawHud() {
    const s = this.stats;
    this.head.setFromMatrixPosition(world.camera.matrixWorld);
    layerEntity.object3D!.getWorldPosition(this.panelPos);
    const dist = this.head.distanceTo(this.panelPos);
    const fovDeg = (2 * Math.atan(widthM / 2 / dist) * 180) / Math.PI;
    hudLines = [
      `XR ${this.xrFps.toFixed(0)} fps (target ${this.targetRate})   pannello ${widthM.toFixed(2)} m · ${fovDeg.toFixed(0)}°`,
      s ? `stream ${s.width}×${s.height} ${s.fps}fps ${s.codec.replace('video/', '')} · buffer ${s.jitterBufferMs}ms` : streamState,
      activePointer != null ? `puntatore ${lastUv.u.toFixed(3)}, ${lastUv.v.toFixed(3)}${pointerDown ? ' · premuto' : ''}` : '',
      voiceStatus || `voce: tieni premuto A per parlare (microfono ${micState})`,
    ];
    hud.redraw();
  }
}

world.registerSystem(WorkspaceSystem);
