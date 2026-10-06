// Spike Fase 0 — confronto di leggibilità nel visore.
// Due pannelli mostrano lo stesso stream di una finestra Mac:
//   sinistra → mesh WebGL con VideoTexture (rendering classico, ricampionato due volte)
//   destra   → XRQuadLayer (composto direttamente dal compositor di Horizon OS)
//
// Controller destro:  stick su/giù = pannelli più grandi/piccoli
//                     A = mipmap on/off sul pannello mesh
//                     B = riporta i pannelli davanti a te
// Grab (raggio + grilletto) su un pannello per spostarlo.

import {
  CanvasTexture,
  DistanceGrabbable,
  InputComponent,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MovementMode,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RayInteractable,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  VideoTexture,
  World,
  XRLayerState,
  XRQuadLayer,
  type WebGLRenderTarget,
  createSystem,
  type Entity,
} from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { connectViewer, type StreamStats } from '@qw/client';

const PANEL_WIDTH_M = 1.0;
const PANEL_DISTANCE_M = 1.0;
const PANEL_GAP_M = 0.08;

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

// Texture per il pannello mesh: sRGB, con mipmap per ridurre lo sfarfallio quando è rimpicciolita.
const meshTexture = new VideoTexture(video);
meshTexture.colorSpace = SRGBColorSpace;
meshTexture.generateMipmaps = true;
meshTexture.minFilter = LinearMipmapLinearFilter;
meshTexture.magFilter = LinearFilter;

// Texture per il layer: copiamo i pixel 1:1 nella superficie del compositor, senza conversioni.
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

// --- HUD di misura ---------------------------------------------------------------

const hudCanvas = document.createElement('canvas');
hudCanvas.width = 1024;
hudCanvas.height = 200;
const hudTexture = new CanvasTexture(hudCanvas);
hudTexture.colorSpace = SRGBColorSpace;

function drawHud(lines: string[]) {
  const ctx = hudCanvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(16,18,22,0.92)';
  ctx.fillRect(0, 0, hudCanvas.width, hudCanvas.height);
  ctx.fillStyle = '#e6e8eb';
  ctx.font = '30px ui-monospace, monospace';
  lines.forEach((l, i) => ctx.fillText(l, 24, 46 + i * 44));
  hudTexture.needsUpdate = true;
}

function makeLabel(text: string) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(16,18,22,0.85)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#9ec1ff';
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillText(text, 18, 44);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return new Mesh(new PlaneGeometry(0.4, 0.05), new MeshBasicMaterial({ map: t, transparent: true }));
}

// --- Scena --------------------------------------------------------------------------

const world = await World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions);
remoteLog(`world creato; immersive-ar supportato: ${await navigator.xr?.isSessionSupported('immersive-ar')}`);

meshTexture.anisotropy = world.renderer.capabilities.getMaxAnisotropy();

let aspect = 1740 / 2940;
let widthM = PANEL_WIDTH_M;

const meshPanel = new Mesh(
  new PlaneGeometry(1, 1),
  new MeshBasicMaterial({ map: meshTexture, toneMapped: false }),
);
const meshEntity = world.createTransformEntity(meshPanel);
meshEntity.addComponent(RayInteractable);
meshEntity.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveAtSource, scale: false });

const layerEntity = world.createTransformEntity();
layerEntity.addComponent(XRQuadLayer, {
  width: widthM,
  height: widthM * aspect,
  pixelWidth: 2940,
  pixelHeight: 1740,
  renderCallback: () => world.renderer.render(blitScene, blitCamera),
});
layerEntity.addComponent(RayInteractable);
layerEntity.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveAtSource, scale: false });

const meshLabel = makeLabel('A · Mesh WebGL');
const layerLabel = makeLabel('B · Compositor layer');
meshEntity.object3D!.add(meshLabel);
layerEntity.object3D!.add(layerLabel);

const hud = new Mesh(new PlaneGeometry(0.8, 0.156), new MeshBasicMaterial({ map: hudTexture, transparent: true }));
const hudEntity = world.createTransformEntity(hud);

function applySize() {
  const h = widthM * aspect;
  meshPanel.scale.set(widthM, h, 1);
  layerEntity.setValue(XRQuadLayer, 'width', widthM);
  layerEntity.setValue(XRQuadLayer, 'height', h);
  // Le etichette sono figlie: le teniamo sopra il bordo, a dimensione costante.
  meshLabel.scale.set(1 / widthM, 1 / h, 1);
  meshLabel.position.set(0, 0.5 + 0.04 / h, 0);
  layerLabel.position.set(0, h / 2 + 0.04, 0);
}

const tmpDir = new Vector3();
function placeInFront() {
  const head = world.camera;
  head.getWorldDirection(tmpDir);
  tmpDir.y = 0;
  tmpDir.normalize();
  const yaw = Math.atan2(-tmpDir.x, -tmpDir.z);
  const base = new Vector3().setFromMatrixPosition(head.matrixWorld);
  const center = base.clone().addScaledVector(tmpDir, PANEL_DISTANCE_M);
  const right = new Vector3(-tmpDir.z, 0, tmpDir.x);
  const offset = widthM / 2 + PANEL_GAP_M / 2;

  const place = (e: Entity, side: number) => {
    const o = e.object3D!;
    o.position.copy(center).addScaledVector(right, side * offset);
    o.position.y = base.y - 0.05;
    o.rotation.set(0, yaw, 0);
  };
  place(meshEntity, -1);
  place(layerEntity, 1);
  const h = hudEntity.object3D!;
  h.position.copy(center);
  h.position.y = base.y - 0.05 - (widthM * aspect) / 2 - 0.15;
  h.rotation.set(-0.35, yaw, 0);
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

// --- Sistema: input, frame rate, HUD ---------------------------------------------------

class SpikeSystem extends createSystem({}) {
  private frames = 0;
  private elapsed = 0;
  private xrFps = 0;
  private stats: StreamStats | null = null;
  private targetRate: number | string = '-';
  private mipmaps = true;
  private logTick = 0;

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
      const st = this.stats;
      if (st && st.mbps > 0.2 && (this.logTick = (this.logTick + 1) % 4) === 0) {
        remoteLog(
          `[stats] dec ${st.width}×${st.height} ${st.fps}fps ${st.mbps.toFixed(1)}Mbps ${st.decoder}${st.powerEfficient ? '(hw)' : ''} ` +
            `decode ${st.decodeMs}ms jitterbuf ${st.jitterBufferMs}ms rtt ${st.rttMs}ms persi ${st.framesDropped} xr ${this.xrFps.toFixed(0)}fps`,
        );
      }
      this.targetRate = this.renderer.xr.getSession()?.frameRate ?? '-';
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

    const pad = this.input.gamepads.right;
    if (!pad) return;
    if (pad.getAxesEnteringUp(InputComponent.Thumbstick)) {
      widthM = Math.min(widthM * 1.1, 3);
      applySize();
    } else if (pad.getAxesEnteringDown(InputComponent.Thumbstick)) {
      widthM = Math.max(widthM / 1.1, 0.3);
      applySize();
    }
    if (pad.getButtonDown(InputComponent.A_Button)) {
      this.mipmaps = !this.mipmaps;
      meshTexture.generateMipmaps = this.mipmaps;
      meshTexture.minFilter = this.mipmaps ? LinearMipmapLinearFilter : LinearFilter;
      meshTexture.needsUpdate = true;
    }
    if (pad.getButtonDown(InputComponent.B_Button)) placeInFront();
  }

  private redrawHud() {
    const s = this.stats;
    const head = new Vector3().setFromMatrixPosition(world.camera.matrixWorld);
    const dist = head.distanceTo(layerEntity.object3D!.position);
    const fovDeg = (2 * Math.atan(widthM / 2 / dist) * 180) / Math.PI;
    drawHud([
      `XR ${this.xrFps.toFixed(0)} fps (target ${this.targetRate})   mipmap A: ${this.mipmaps ? 'on' : 'off'}`,
      s ? `stream ${s.width}×${s.height} ${s.fps}fps ${s.mbps.toFixed(1)}Mbps ${s.codec.replace('video/', '')}` : streamState,
      `pannello ${widthM.toFixed(2)} m a ${dist.toFixed(2)} m → ${fovDeg.toFixed(0)}° di campo visivo`,
      `${s ? ((s.width / fovDeg) | 0) + ' px/grado nello stream (Quest 3 ≈ 25)' : ''}`,
    ]);
  }
}

world.registerSystem(SpikeSystem);
