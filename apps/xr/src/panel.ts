// Una finestra del Mac nel visore:
//   radice
//   ├─ barra del titolo larga quanto la finestra (afferrabile col grilletto, con un margine invisibile)
//   ├─ pulsante × (staccato dalla barra: non si chiude una finestra per sbaglio cercando di spostarla)
//   └─ finestra (XRQuadLayer, composto dal compositor di Horizon OS) → click / trascina / scroll sul Mac
// Il puntatore locale è disegnato DENTRO il layer, sopra il video, a ogni frame del visore: i compositor layer
// coprono qualunque oggetto 3D, e il cursore del Mac nello stream si aggiorna solo quando la finestra si
// ridisegna (TextEdit fermo: ~4 fps; un terminale che lampeggia: 30).

import {
  CircleGeometry,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NoColorSpace,
  OrthographicCamera,
  PlaneGeometry,
  RayInteractable,
  RingGeometry,
  Scene,
  ShaderMaterial,
  VideoTexture,
  XRQuadLayer,
  type Entity,
  type Vector3,
  type World,
} from '@iwsdk/core';
import { COLORS, canvasPlane, fitText } from './ui.js';

export const BAR_HEIGHT_M = 0.065;
const BAR_GAP_M = 0.015;
// Margine invisibile attorno alla barra che intercetta comunque il raggio (a 1 m, 6 cm sono un bersaglio piccolo).
// Verso il basso si ferma prima della finestra: se la coprisse, al bordo il raggio alternerebbe margine e
// finestra, e il puntatore salterebbe.
const GRAB_MARGIN_M = 0.03;
const GRAB_MARGIN_DOWN_M = 0.005;
const CLOSE_SIZE_M = 0.045;
const CLOSE_GAP_M = 0.05;
const HOVER_SCALE_Y = 1.15;
// Densità costante: 1920 px dello stream = 1 m. Una finestra piccola sul Mac non viene ingrandita (testo e
// cursore della stessa misura in tutte le finestre) finché non la ridimensioni tu.
const PX_PER_M = 1920;

export type PanelPointerEvent = {
  uv?: { x: number; y: number };
  point: Vector3;
  pointerId: number;
  pointerType?: string;
};
type PointerListener = (e: PanelPointerEvent) => void;

export type ContentOp = 'enter' | 'move' | 'down' | 'up' | 'leave';

export interface PanelHandlers {
  onContent(panel: WindowPanel, op: ContentOp, e: PanelPointerEvent): void;
  onBarDown(panel: WindowPanel, e: PanelPointerEvent): void;
  onClose(panel: WindowPanel): void;
  onResize(panel: WindowPanel): void;
}

// IWSDK genera anche un puntatore "screen-*" per la pagina 2D che in XR segue lo sguardo: va ignorato,
// altrimenti il cursore del Mac salta tra il punto mirato e quello guardato.
const isXrPointer = (e: PanelPointerEvent) => !e.pointerType?.startsWith('screen');

const grabZoneGeometry = (widthM: number) =>
  new PlaneGeometry(widthM + 2 * GRAB_MARGIN_M, BAR_HEIGHT_M + GRAB_MARGIN_M + GRAB_MARGIN_DOWN_M);

const blitCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
const blitGeometry = new PlaneGeometry(2, 2);

export class WindowPanel {
  readonly root: Entity;
  readonly layerEntity: Entity;
  readonly video = document.createElement('video');
  widthM: number;
  aspect = 9 / 16;
  active = false;
  private autoWidth = true; // larghezza ancora decisa dalla risoluzione dello stream
  private barHover = false;
  private barWidth = 0; // larghezza per cui è disegnata la barra
  private readonly bar;
  private readonly closeButton;
  private readonly grabZone: Mesh;
  private readonly texture: VideoTexture;
  private readonly blitScene = new Scene();
  private readonly blitMaterial: ShaderMaterial;
  // Puntatore nella scena del layer: unità = metri sul pannello (la scala li converte in coordinate NDC).
  private readonly cursor = new Group();

  constructor(
    private readonly world: World,
    readonly wid: string,
    public name: string,
    stream: MediaStream,
    private readonly handlers: PanelHandlers,
    widthM = 1.0,
  ) {
    this.widthM = widthM;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.srcObject = stream;
    this.video.play().catch(() => {});

    // Texture del layer: copiamo i pixel 1:1 nella superficie del compositor, senza conversioni.
    this.texture = new VideoTexture(this.video);
    this.texture.colorSpace = NoColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.blitMaterial = new ShaderMaterial({
      uniforms: { map: { value: this.texture } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D map; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv); }',
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.blitScene.add(new Mesh(blitGeometry, this.blitMaterial));
    // Anello bianco con bordo scuro (visibile su sfondi chiari e scuri) e punto blu al centro.
    const parts: [Mesh['geometry'], number][] = [
      [new RingGeometry(0.0055, 0.0085, 40), 0x000000],
      [new RingGeometry(0.006, 0.008, 40), 0xffffff],
      [new CircleGeometry(0.0025, 20), 0x4f8cff],
    ];
    parts.forEach(([geometry, color], i) => {
      const m = new Mesh(geometry, new MeshBasicMaterial({ color, transparent: true, opacity: i === 0 ? 0.5 : 1, depthTest: false }));
      m.renderOrder = 1 + i;
      this.cursor.add(m);
    });
    this.cursor.visible = false;
    this.blitScene.add(this.cursor);

    this.root = world.createTransformEntity();
    this.root.addComponent(RayInteractable);
    const rootObj = this.root.object3D!;
    this.bar = canvasPlane(this.widthM, BAR_HEIGHT_M, Math.round(this.widthM * 1400), (ctx, w, h) => this.drawBar(ctx, w, h));
    this.grabZone = new Mesh(
      grabZoneGeometry(this.widthM),
      // Trasparente ma visibile: three e pointer-events scartano gli oggetti invisibili dal raycast.
      new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.grabZone.position.set(0, (GRAB_MARGIN_M - GRAB_MARGIN_DOWN_M) / 2, -0.002);
    this.closeButton = canvasPlane(CLOSE_SIZE_M, CLOSE_SIZE_M, 128, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = COLORS.close;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, w / 2 - 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = w * 0.09;
      const r = w * 0.2;
      ctx.beginPath();
      ctx.moveTo(w / 2 - r, h / 2 - r);
      ctx.lineTo(w / 2 + r, h / 2 + r);
      ctx.moveTo(w / 2 + r, h / 2 - r);
      ctx.lineTo(w / 2 - r, h / 2 + r);
      ctx.stroke();
    });
    for (const m of [this.bar.mesh, this.grabZone, this.closeButton.mesh]) {
      (m as unknown as { pointerEvents: string }).pointerEvents = 'auto';
      rootObj.add(m);
    }

    this.layerEntity = world.createTransformEntity(undefined, { parent: this.root });
    this.layerEntity.addComponent(XRQuadLayer, {
      width: this.widthM,
      height: this.heightM,
      pixelWidth: 1920,
      pixelHeight: 1080,
      renderCallback: () => world.renderer.render(this.blitScene, blitCamera),
    });
    this.layerEntity.addComponent(RayInteractable);

    this.wireEvents();
    this.video.addEventListener('resize', () => {
      if (!this.video.videoWidth) return;
      this.aspect = this.video.videoHeight / this.video.videoWidth;
      if (this.autoWidth) this.widthM = Math.min(Math.max(this.video.videoWidth / PX_PER_M, 0.3), 3);
      this.layerEntity.setValue(XRQuadLayer, 'pixelWidth', this.video.videoWidth);
      this.layerEntity.setValue(XRQuadLayer, 'pixelHeight', this.video.videoHeight);
      this.applySize();
      handlers.onResize(this);
    });
    this.applySize();
  }

  get heightM() {
    return this.widthM * this.aspect;
  }

  setStream(stream: MediaStream) {
    this.video.srcObject = stream;
    this.video.play().catch(() => {});
  }

  // Puntatore in metri dal centro della finestra (x verso destra, y verso l'alto).
  setCursor(x: number, y: number) {
    this.cursor.position.set((2 * x) / this.widthM, (2 * y) / this.heightM, 0);
    this.cursor.visible = true;
  }

  hideCursor() {
    this.cursor.visible = false;
  }

  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.bar.redraw();
  }

  setWidth(widthM: number) {
    this.autoWidth = false;
    this.widthM = Math.min(Math.max(widthM, 0.3), 3);
    this.applySize();
  }

  applySize() {
    const h = this.heightM;
    // Barra, margine di presa e × seguono la larghezza della finestra. Durante il ridimensionamento con lo
    // stick la barra viene stirata; si ridisegna (canvas e texture nuovi) solo oltre il 15% di differenza.
    if (!this.barWidth || Math.abs(this.widthM / this.barWidth - 1) > 0.15) {
      this.barWidth = this.widthM;
      this.bar.setSize(this.widthM, BAR_HEIGHT_M);
      this.grabZone.geometry.dispose();
      this.grabZone.geometry = grabZoneGeometry(this.widthM);
    }
    this.bar.mesh.scale.x = this.widthM / this.barWidth;
    this.grabZone.scale.x = (this.widthM + 2 * GRAB_MARGIN_M) / (this.barWidth + 2 * GRAB_MARGIN_M);
    this.closeButton.mesh.position.x = this.widthM / 2 + CLOSE_GAP_M + CLOSE_SIZE_M / 2;
    this.layerEntity.setValue(XRQuadLayer, 'width', this.widthM);
    this.layerEntity.setValue(XRQuadLayer, 'height', h);
    this.layerEntity.object3D!.position.set(0, -(BAR_HEIGHT_M / 2 + BAR_GAP_M + h / 2), 0);
    this.cursor.scale.set(2 / this.widthM, 2 / h, 1);
  }

  // Centro della finestra rispetto alla radice (la barra), in coordinate locali.
  get contentOffsetY() {
    return -(BAR_HEIGHT_M / 2 + BAR_GAP_M + this.heightM / 2);
  }

  dispose() {
    this.layerEntity.dispose();
    this.root.dispose();
    this.video.srcObject = null;
    this.texture.dispose();
    this.blitMaterial.dispose();
    this.bar.dispose();
    this.closeButton.dispose();
    this.cursor.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose();
        (o.material as MeshBasicMaterial).dispose();
      }
    });
    this.grabZone.geometry.dispose();
    (this.grabZone.material as MeshBasicMaterial).dispose();
  }

  private drawBar(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.active ? COLORS.accent : this.barHover ? COLORS.barHover : COLORS.bar;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, h / 2);
    ctx.fill();
    if (this.barHover) {
      // Presa agganciata: bordo chiaro, ben visibile anche sulla barra blu della finestra attiva.
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = h * 0.1;
      ctx.beginPath();
      ctx.roundRect(h * 0.05, h * 0.05, w - h * 0.1, h * 0.9, h * 0.45);
      ctx.stroke();
    }
    // Maniglia al centro: righe orizzontali, il segno universale di "trascinami".
    ctx.strokeStyle = 'rgba(230,232,235,0.8)';
    ctx.lineWidth = Math.max(2, h * 0.07);
    ctx.lineCap = 'round';
    const handleW = Math.min(w * 0.18, h * 3);
    for (const dy of [-0.16, 0, 0.16]) {
      ctx.beginPath();
      ctx.moveTo(w / 2 - handleW / 2, h / 2 + dy * h);
      ctx.lineTo(w / 2 + handleW / 2, h / 2 + dy * h);
      ctx.stroke();
    }
    // Titolo a sinistra, fino alla maniglia.
    ctx.fillStyle = COLORS.text;
    ctx.font = `${Math.round(h * 0.46)}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, this.name, w / 2 - handleW / 2 - h * 0.9), h * 0.5, h / 2 + 1);
  }

  private wireEvents() {
    // Gli eventi puntatore (pmndrs/pointer-events, attivati da RayInteractable) risalgono dalla mesh che il
    // sistema dei layer crea come figlia dell'entità. I tipi three non li conoscono, da qui il cast.
    const on = (entity: Entity, type: string, fn: PointerListener) =>
      (entity.object3D!.addEventListener as (t: string, f: PointerListener) => void)(type, (e) => {
        if (isXrPointer(e)) fn(e);
      });

    const content = this.layerEntity;
    on(content, 'pointerenter', (e) => this.handlers.onContent(this, 'enter', e));
    on(content, 'pointermove', (e) => this.handlers.onContent(this, 'move', e));
    on(content, 'pointerdown', (e) => this.handlers.onContent(this, 'down', e));
    on(content, 'pointerup', (e) => this.handlers.onContent(this, 'up', e));
    on(content, 'pointerleave', (e) => this.handlers.onContent(this, 'leave', e));

    // Gli eventi della radice arrivano anche dalla finestra (figlia): si guarda l'oggetto colpito.
    const fromBar = (e: PanelPointerEvent & { object?: unknown }) => e.object === this.bar.mesh || e.object === this.grabZone;
    const fromClose = (e: PanelPointerEvent & { object?: unknown }) => e.object === this.closeButton.mesh;
    // pointerenter non si ripete passando dalla finestra alla barra (stesso sottoalbero): hover dal movimento.
    const setHover = (hover: boolean) => {
      if (hover === this.barHover) return;
      this.barHover = hover;
      this.bar.mesh.scale.y = hover ? HOVER_SCALE_Y : 1;
      this.bar.redraw();
    };
    on(this.root, 'pointermove', (e) => setHover(fromBar(e)));
    on(this.root, 'pointerleave', () => setHover(false));
    on(this.root, 'pointerdown', (e) => {
      if (fromClose(e)) this.handlers.onClose(this);
      else if (fromBar(e)) this.handlers.onBarDown(this, e);
    });
  }
}
