// Client WebXR del workspace: finestre del Mac come pannelli in MR, da disporre nella stanza, con input remoto
// e voce. Ogni finestra è un WindowPanel (panel.ts); il launcher (launcher.ts) apre e chiude le finestre.
//
// Controller destro:  grilletto sulla finestra = click / trascina sul Mac; sulla barra = sposta la finestra
//                     stick sulla finestra = scroll
//                     grip tenuto su un punto qualsiasi della finestra = sposta la finestra (come la barra)
//                     mentre sposti una finestra: stick su/giù = allontana/avvicina, sinistra/destra = più piccola/grande
//                     A tenuto = parla: al rilascio il testo va nella finestra attiva e viene inviato
//                     B = porta la finestra attiva davanti a te
// Controller sinistro: click dello stick = launcher (con il pulsante per la scansione della stanza)
//                     X = invio · Y = esc (interrompe Claude Code)
// Finestra attiva (barra blu): l'ultima cliccata. Riceve dettatura e tasti, e va a fps pieni.

import { InputComponent, Matrix4, Quaternion, Vector3, World, createSystem, type WebGLRenderTarget, XRLayerState } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { connectViewer, type StreamStats } from '@qw/client';
import { OneEuroFilter } from './one-euro.js';
import { createMic, type MicState } from './voice.js';
import { BAR_HEIGHT_M, WindowPanel, type ContentOp, type PanelPointerEvent } from './panel.js';
import { createLauncher, type WindowInfo } from './launcher.js';
import { registerRoom } from './room.js';
import { canvasPlane } from './ui.js';

const PANEL_WIDTH_M = 1.0;
const PANEL_DISTANCE_M = 1.1;
const SCROLL_PX_PER_FRAME = 18;
const STICK_DEADZONE = 0.2;
// Spostamento con il raggio: velocità di allontanamento/avvicinamento e di ridimensionamento con lo stick.
const PUSH_RATE = 1.6; // fattore esponenziale al secondo sulla distanza
const RESIZE_RATE = 0.8;
const MIN_DIST_M = 0.3;
const MAX_DIST_M = 8;
// Filtro del puntatore, in metri sul pannello: fermo sotto ~1 Hz di tremolio, reattivo quando ci si muove.
const POINTER_MIN_CUTOFF_HZ = 0.7;
const POINTER_BETA = 22;
// Col tasto premuto il punto resta bloccato finché non ci si sposta di oltre 1,2 cm: il gesto di premere
// il grilletto non deve spostare il click, e un trascinamento parte solo quando è voluto.
const DRAG_START_M = 0.012;

// Stato condiviso, dichiarato prima della scena: HUD e sistemi lo leggono già durante la creazione.
const panels = new Map<string, WindowPanel>();
let activeWid: string | null = null;
let bridgeState = 'connessione al bridge…';
let micState: MicState = 'off';
let micDetail = '';
let voiceStatus = '';
let voiceText = '';
let releasedAt = 0;

// Diagnostica: errori e eventi chiave finiscono nel log del bridge (il browser del Quest non è ispezionabile
// da qui). Le righe scritte prima della connessione partono appena il client esiste.
// Assegnato più sotto, dopo la creazione del mondo; prima di allora remoteLog accoda.
let client!: ReturnType<typeof connectViewer>;
const earlyLogs: string[] = [];
function remoteLog(line: string) {
  if (client) client.send({ type: 'log', line: `[xr] ${line}` });
  else earlyLogs.push(line);
}

// --- Scena --------------------------------------------------------------------------

// Il mondo va creato prima di collegarsi al bridge: gli stream delle finestre possono arrivare subito.
const world = await World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions);

const room = registerRoom(world, (line) => remoteLog(line));

const launcher = createLauncher(world, {
  isOpen: (id) => panels.has(id),
  onPick: (w) => {
    if (panels.has(w.id)) client.send({ type: 'close', wid: w.id });
    else client.send({ type: 'open', wid: w.id });
  },
  onRoomScan: () => {
    launcher.hide();
    room.capture();
  },
});

function toggleLauncher() {
  if (launcher.visible) launcher.hide();
  else {
    launcher.show();
    client.send({ type: 'windows' });
  }
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
hud.mesh.raycast = () => {};
const hudEntity = world.createTransformEntity(hud.mesh);
hud.mesh.visible = false;

// --- Connessione al bridge ----------------------------------------------------------

client = connectViewer({
  name: 'xr-iwsdk',
  onStream: (stream, { sid, name }) => openPanel(sid, name ?? sid, stream),
  onClosed: (sid, reason) => {
    remoteLog(`finestra chiusa: ${panels.get(sid)?.name ?? sid} (${reason ?? '-'})`);
    closePanel(sid);
  },
  onState: (s, sid) => {
    if (!sid) bridgeState = s;
  },
  onMessage: (msg) => {
    if (msg.type === 'transcript') onTranscript(msg as unknown as Transcript);
    else if (msg.type === 'windows') launcher.setList(msg.list as WindowInfo[]);
    else if (msg.type === 'active') setActive(msg.wid as string, false);
  },
});

for (const line of earlyLogs.splice(0)) remoteLog(line);
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
remoteLog(`world creato; immersive-ar supportato: ${await navigator.xr?.isSessionSupported('immersive-ar')}`);

// --- Voce (push-to-talk) -------------------------------------------------------------

type Transcript = { text?: string; error?: string; audioMs: number; whisperMs?: number; typed?: boolean };

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
    const where = !t.text ? '' : t.typed ? ' · inviato' : ' · nessuna finestra attiva, non inviato';
    voiceStatus = `voce: ${(t.audioMs / 1000).toFixed(1)} s · ${totalMs} ms${where}`;
    voiceText = t.text || '(nessuna voce)';
  }
  remoteLog(`[voce] audio ${t.audioMs}ms whisper ${t.whisperMs ?? '-'}ms totale ${totalMs}ms`);
}

// --- Finestre -------------------------------------------------------------------------

const tmpDir = new Vector3();
const tmpHead = new Vector3();
const tmpPos = new Vector3();

function headYaw() {
  world.camera.getWorldDirection(tmpDir);
  return Math.atan2(-tmpDir.x, -tmpDir.z);
}

// Posizione libera davanti a te: prova l'asse dello sguardo, poi a destra e a sinistra a passi di 35°,
// evitando le direzioni già occupate da altre finestre.
function placeNewPanel(panel: WindowPanel) {
  tmpHead.setFromMatrixPosition(world.camera.matrixWorld);
  const base = headYaw();
  const taken = [...panels.values()]
    .filter((p) => p !== panel)
    .map((p) => {
      const o = p.root.object3D!.position;
      return Math.atan2(-(o.x - tmpHead.x), -(o.z - tmpHead.z));
    });
  const step = (35 * Math.PI) / 180;
  let yaw = base;
  for (const k of [0, 1, -1, 2, -2, 3, -3]) {
    const candidate = base + k * step;
    if (taken.every((t) => Math.abs(Math.atan2(Math.sin(t - candidate), Math.cos(t - candidate))) > step * 0.7)) {
      yaw = candidate;
      break;
    }
  }
  placeAt(panel, yaw, PANEL_DISTANCE_M);
}

// Finestra a `dist` metri dalla testa nella direzione `yaw`, rivolta verso di te, centro poco sotto lo sguardo.
function placeAt(panel: WindowPanel, yaw: number, dist: number) {
  tmpHead.setFromMatrixPosition(world.camera.matrixWorld);
  const o = panel.root.object3D!;
  o.position.set(tmpHead.x - Math.sin(yaw) * dist, tmpHead.y - panel.contentOffsetY - 0.1, tmpHead.z - Math.cos(yaw) * dist);
  o.rotation.set(0, yaw, 0);
}

function openPanel(wid: string, name: string, stream: MediaStream) {
  const existing = panels.get(wid);
  if (existing) {
    // Rinegoziazione (es. cambio codec o bridge riavviato): stessa finestra, stream nuovo.
    existing.setStream(stream);
    return;
  }
  const panel = new WindowPanel(world, wid, name, stream, panelHandlers, PANEL_WIDTH_M);
  panels.set(wid, panel);
  placeNewPanel(panel);
  panel.setActive(wid === activeWid);
  remoteLog(`finestra aperta: ${name} (${panels.size} aperte)`);
  if (launcher.visible) launcher.redraw();
  updateHudPlacement();
}

function closePanel(wid: string) {
  const panel = panels.get(wid);
  if (!panel) return;
  if (pointer.panel === panel) releasePointer();
  if (drag?.panel === panel) endDrag();
  panels.delete(wid);
  panel.dispose();
  if (activeWid === wid) activeWid = null;
  if (launcher.visible) launcher.redraw();
  updateHudPlacement();
}

function setActive(wid: string, notify = true) {
  if (wid === activeWid) return;
  activeWid = wid;
  for (const p of panels.values()) p.setActive(p.wid === wid);
  if (notify) client.send({ type: 'active', wid });
  updateHudPlacement();
}

// L'HUD segue la finestra attiva: sotto di essa, leggermente inclinato verso di te.
function updateHudPlacement() {
  const panel = (activeWid && panels.get(activeWid)) || panels.values().next().value;
  const o = hudEntity.object3D!;
  if (!panel) {
    hud.mesh.visible = false;
    return;
  }
  hud.mesh.visible = true;
  o.removeFromParent();
  panel.root.object3D!.add(o);
  o.position.set(0, panel.contentOffsetY * 2 - BAR_HEIGHT_M - 0.14, 0.02);
  o.rotation.set(-0.3, 0, 0);
}

// --- Puntatore sulle finestre -------------------------------------------------------------

// Un solo puntatore attivo alla volta: quello entrato per primo, o quello che ha premuto per ultimo.
const pointer = {
  id: null as number | null,
  panel: null as WindowPanel | null,
  down: false,
  u: 0,
  v: 0,
  point: new Vector3(), // ultimo punto colpito sulla finestra, in coordinate mondo
};
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

function sendPointer(op: 'move' | 'down' | 'up', panel: WindowPanel, e: PanelPointerEvent) {
  if (!e.uv) return;
  pointer.point.copy(e.point);
  const w = panel.widthM;
  const h = panel.heightM;
  const now = performance.now();
  const dt = lastFilterTime ? (now - lastFilterTime) / 1000 : 0;
  lastFilterTime = now;

  // Coordinate in metri sul pannello, origine al centro: il filtro lavora in unità fisiche.
  let x = filterX.filter((e.uv.x - 0.5) * w, dt);
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

  pointer.u = x / w + 0.5;
  pointer.v = y / h + 0.5;
  panel.setCursor(x, y);
  client.send({ type: 'input', op, wid: panel.wid, u: pointer.u, v: pointer.v });
}

// Finestra indicata dal raggio: va a fps pieni come quella attiva, altrimenti il cursore del Mac nello stream
// si muove a scatti (le finestre inattive viaggiano a 5 fps). La dettatura resta alla finestra cliccata.
let hoverWid: string | null = null;
function setHover(wid: string | null) {
  if (wid === hoverWid) return;
  hoverWid = wid;
  client.send({ type: 'hover', wid });
}

function releasePointer() {
  // Rilascio di sicurezza: se il puntatore esce col tasto premuto, il Mac non deve restare in trascinamento.
  const panel = pointer.panel;
  if (panel && pointer.down) client.send({ type: 'input', op: 'up', wid: panel.wid, u: pointer.u, v: pointer.v });
  if (panel) panel.hideCursor();
  pointer.id = null;
  pointer.panel = null;
  pointer.down = false;
  resetPointerFilter();
  setHover(null);
}

type Hand = 'left' | 'right';
type DragButton = typeof InputComponent.Trigger | typeof InputComponent.Squeeze;
// Inizio di un trascinamento, completato nel sistema (che conosce lo stato dei controller).
// Senza mano: barra premuta col grilletto, la mano è quella col grilletto giù.
let pendingDrag: { panel: WindowPanel; point: Vector3; hand?: Hand; button: DragButton } | null = null;

const panelHandlers = {
  onContent(panel: WindowPanel, op: ContentOp, e: PanelPointerEvent) {
    if (drag) return;
    switch (op) {
      case 'enter':
        if (pointer.id != null) return;
        pointer.id = e.pointerId;
        pointer.panel = panel;
        resetPointerFilter();
        setHover(panel.wid);
        return;
      case 'move':
        if (e.pointerId === pointer.id && pointer.panel === panel) sendPointer('move', panel, e);
        return;
      case 'down':
        if (e.pointerId !== pointer.id || pointer.panel !== panel) {
          releasePointer();
          pointer.id = e.pointerId;
          pointer.panel = panel;
        }
        pointer.down = true;
        setActive(panel.wid);
        sendPointer('down', panel, e);
        return;
      case 'up':
        if (e.pointerId !== pointer.id || pointer.panel !== panel) return;
        pointer.down = false;
        sendPointer('up', panel, e);
        return;
      case 'leave':
        if (e.pointerId === pointer.id && pointer.panel === panel) releasePointer();
    }
  },
  onBarDown(panel: WindowPanel, e: PanelPointerEvent) {
    // La mano si conosce solo nel sistema (stato dei grilletti): l'inizio del trascinamento si completa lì.
    remoteLog(`[drag] barra premuta: ${panel.name} (puntatore ${e.pointerId} ${e.pointerType}, drag in corso: ${drag ? drag.panel.name : 'no'})`);
    pendingDrag = { panel, point: e.point.clone(), button: InputComponent.Trigger };
  },
  onClose(panel: WindowPanel) {
    client.send({ type: 'close', wid: panel.wid });
    closePanel(panel.wid);
  },
  onResize() {
    updateHudPlacement();
  },
};

// --- Spostamento delle finestre nella stanza ------------------------------------------------
// Grilletto sulla barra: la finestra segue il raggio alla stessa distanza, sempre rivolta verso di te.
// Con lo stick della stessa mano la allontani o avvicini (fino a 8 m: il muro di fronte) e la ridimensioni.

let drag: { panel: WindowPanel; hand: Hand; button: DragButton; dist: number; grabLocal: Vector3 } | null = null;

function endDrag(reason = '') {
  if (drag) remoteLog(`[drag] fine: ${drag.panel.name} a ${drag.dist.toFixed(2)} m${reason ? ` (${reason})` : ''}`);
  drag = null;
  room.setVisible(false);
}

// --- Dimensione dei layer nativi ----------------------------------------------------------
// Il browser del Quest (Chrome 152) mostra i quad layer al DOPPIO della larghezza e altezza dichiarate
// (misurato con cornici di prova: quelle a ±larghezza dal centro combaciano coi bordi visibili). La mesh su cui
// il raggio calcola le UV ha invece la dimensione dichiarata: il video copriva barra e HUD, e il cursore del Mac
// si muoveva al doppio della velocità del raggio. Sul singolo layer nativo dimezziamo width/height
// intercettandone le assegnazioni: IWSDK continua a lavorare con le misure vere.
const halvedLayers = new WeakSet<object>();
function halveNativeQuadSize(layer: object) {
  if (halvedLayers.has(layer)) return;
  halvedLayers.add(layer);
  const proto = Object.getPrototypeOf(layer);
  for (const key of ['width', 'height']) {
    const d = Object.getOwnPropertyDescriptor(proto, key);
    if (!d?.get || !d.set) continue;
    const { get, set } = d;
    const raw = get.call(layer) as number;
    Object.defineProperty(layer, key, {
      configurable: true,
      get() {
        return (get.call(this) as number) * 2;
      },
      set(v: number) {
        set.call(this, v / 2);
      },
    });
    set.call(layer, raw / 2);
  }
  remoteLog('layer nativo: dimensioni dimezzate (correzione Quest Browser)');
}

// --- Sistema: input controller, trascinamento, frame rate, HUD ---------------------------------

class WorkspaceSystem extends createSystem({}) {
  private frames = 0;
  private elapsed = 0;
  private xrFps = 0;
  private stats: StreamStats | null = null;
  private targetRate: number | string = '-';
  private logTick = 0;
  private rayMatrix = new Matrix4();
  private rayOrigin = new Vector3();
  private rayDir = new Vector3();
  private rayQuat = new Quaternion();
  private target = new Vector3();
  private offset = new Vector3();

  init() {
    this.renderer.xr.addEventListener('sessionstart', () => {
      const session = this.renderer.xr.getSession();
      const rates = session?.supportedFrameRates;
      remoteLog(
        `sessione avviata: blend=${session?.environmentBlendMode} features=${JSON.stringify(session?.enabledFeatures)} ` +
          `rates=${rates ? Array.from(rates).join(',') : '-'} finestre=${panels.size}`,
      );
      session?.addEventListener('end', () => remoteLog('sessione terminata'));
      // Il browser del Quest parte a 72 Hz: chiediamo 90 se disponibile.
      if (session && rates?.includes(90)) session.updateTargetFrameRate(90).catch(() => {});
      // La posa della testa è valida dopo qualche frame: allora disponiamo le finestre davanti a te.
      setTimeout(() => {
        for (const p of panels.values()) placeNewPanel(p);
        if (!panels.size) toggleLauncher();
      }, 300);
    });
    setInterval(() => this.collectStats(), 500);
  }

  private async collectStats() {
    this.targetRate = this.renderer.xr.getSession()?.frameRate ?? '-';
    this.stats = activeWid ? await client.stats(activeWid) : null;
    // Ogni 2 s una riga con tutte le finestre: serve a misurare quante ne reggono visore e Mac.
    if ((this.logTick = (this.logTick + 1) % 4) !== 0 || !panels.size) return;
    const parts: string[] = [];
    for (const p of panels.values()) {
      const s = p.wid === activeWid ? this.stats : await client.stats(p.wid);
      if (s) parts.push(`${p.name.slice(0, 16)}${p.wid === activeWid ? '*' : ''} ${s.fps}fps dec ${s.decodeMs}ms jb ${s.jitterBufferMs}ms${s.powerEfficient ? '' : ' SW'}`);
    }
    remoteLog(`[stats] xr ${this.xrFps.toFixed(0)}fps · ${panels.size} finestre: ${parts.join(' | ')}`);
  }

  update(delta: number) {
    // Workaround bug IWSDK 1.0.1 su Quest: il render target del layer ha samples=4; quando diventa
    // nativo, setRenderTargetTextures() disattiva il multisample-render-to-texture e three cerca un
    // framebuffer multisample mai creato → "Invalid value used as weak map key" a ogni frame.
    // Con resolveDepthBuffer=false three alloca da sé il depth e mantiene il percorso MSRTT valido.
    for (const p of panels.values()) {
      if (!p.layerEntity.hasComponent(XRLayerState)) continue;
      const rt = XRLayerState.data.renderTarget[p.layerEntity.index] as WebGLRenderTarget | null;
      if (rt && rt.resolveDepthBuffer) rt.resolveDepthBuffer = false;
      const native = XRLayerState.data.xrLayer[p.layerEntity.index] as object | null;
      if (native) halveNativeQuadSize(native);
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
    const right = this.input.gamepads.right;

    if (left?.getButtonDown(InputComponent.Thumbstick)) toggleLauncher();
    if (left?.getButtonDown(InputComponent.X_Button)) {
      client.send({ type: 'input', op: 'key', key: 'return' });
      voiceStatus = 'voce: invio';
      voiceText = '';
      this.redrawHud();
    } else if (left?.getButtonDown(InputComponent.Y_Button)) {
      client.send({ type: 'input', op: 'key', key: 'escape' });
      voiceStatus = 'voce: esc';
      this.redrawHud();
    }

    this.updateDrag(delta);
    if (!right) return;

    if (!drag && pointer.panel) {
      // Sulla finestra lo stick scorre il contenuto, in modo continuo e proporzionale.
      const stick = right.getAxesValues(InputComponent.Thumbstick);
      if (stick && Math.abs(stick.y) > STICK_DEADZONE) {
        client.send({ type: 'input', op: 'scroll', dy: Math.round(-stick.y * SCROLL_PX_PER_FRAME) });
      }
    }
    if (right.getButtonDown(InputComponent.B_Button) && activeWid) {
      const panel = panels.get(activeWid);
      if (panel) placeAt(panel, headYaw(), PANEL_DISTANCE_M);
    }

    if (right.getButtonDown(InputComponent.A_Button)) {
      if (mic.ready && activeWid) {
        client.send({ type: 'voice', op: 'start' });
        mic.start();
        voiceStatus = 'voce: ● ascolto…';
      } else if (!activeWid) {
        voiceStatus = 'voce: nessuna finestra attiva (cliccane una)';
      } else {
        voiceStatus = `voce: microfono ${micState}${micDetail ? ` (${micDetail})` : ''}`;
      }
      this.redrawHud();
    } else if (right.getButtonUp(InputComponent.A_Button) && mic.ready && voiceStatus.startsWith('voce: ●')) {
      mic.stop();
      client.send({ type: 'voice', op: 'end' });
      releasedAt = performance.now();
      voiceStatus = 'voce: trascrivo…';
      this.redrawHud();
    }
  }

  private rayOf(hand: Hand) {
    const space = this.player.raySpaces[hand];
    space.updateWorldMatrix(true, false);
    this.rayMatrix.copy(space.matrixWorld);
    this.rayOrigin.setFromMatrixPosition(this.rayMatrix);
    this.rayQuat.setFromRotationMatrix(this.rayMatrix);
    this.rayDir.set(0, 0, -1).applyQuaternion(this.rayQuat);
  }

  private updateDrag(delta: number) {
    // Grip su una finestra indicata: la si sposta da quel punto, senza dover mirare alla barra.
    if (!drag && !pendingDrag && pointer.panel) {
      for (const hand of ['right', 'left'] as const) {
        if (!this.input.gamepads[hand]?.getButtonDown(InputComponent.Squeeze)) continue;
        remoteLog(`[drag] grip sulla finestra: ${pointer.panel.name} (mano ${hand})`);
        pendingDrag = { panel: pointer.panel, point: pointer.point.clone(), hand, button: InputComponent.Squeeze };
        break;
      }
    }
    if (pendingDrag) {
      // Mano che ha premuto: quella col grilletto giù in questo frame (destra se entrambe).
      const hand: Hand =
        pendingDrag.hand ?? (this.input.gamepads.right?.getButtonPressed(InputComponent.Trigger) ? 'right' : 'left');
      const { panel, point, button } = pendingDrag;
      pendingDrag = null;
      this.rayOf(hand);
      releasePointer();
      drag = {
        panel,
        hand,
        button,
        dist: Math.max(MIN_DIST_M, point.distanceTo(this.rayOrigin)),
        grabLocal: panel.root.object3D!.worldToLocal(point.clone()),
      };
      setActive(panel.wid);
      room.setVisible(true);
      remoteLog(`[drag] inizio: ${panel.name} mano ${hand} a ${drag.dist.toFixed(2)} m`);
    }
    if (!drag) return;

    const pad = this.input.gamepads[drag.hand];
    if (!pad || !pad.getButtonPressed(drag.button)) {
      endDrag(pad ? 'rilasciato' : 'controller assente');
      return;
    }
    const stick = pad.getAxesValues(InputComponent.Thumbstick);
    if (stick) {
      // Stick in avanti (y negativo) = allontana.
      if (Math.abs(stick.y) > STICK_DEADZONE) {
        drag.dist = Math.min(MAX_DIST_M, Math.max(MIN_DIST_M, drag.dist * Math.exp(-stick.y * PUSH_RATE * delta)));
      }
      if (Math.abs(stick.x) > STICK_DEADZONE) {
        drag.panel.setWidth(drag.panel.widthM * Math.exp(stick.x * RESIZE_RATE * delta));
        updateHudPlacement();
      }
    }

    this.rayOf(drag.hand);
    this.target.copy(this.rayOrigin).addScaledVector(this.rayDir, drag.dist);
    // Rivolta verso la testa, solo rotazione attorno alla verticale: le finestre restano dritte.
    tmpHead.setFromMatrixPosition(world.camera.matrixWorld);
    const yaw = Math.atan2(tmpHead.x - this.target.x, tmpHead.z - this.target.z);
    const o = drag.panel.root.object3D!;
    o.rotation.set(0, yaw, 0);
    // Il punto afferrato resta sotto il raggio: la radice sta a target − R·(punto afferrato in locale).
    this.offset.copy(drag.grabLocal).applyEuler(o.rotation);
    tmpPos.copy(this.target).sub(this.offset);
    o.position.copy(tmpPos);
  }

  private redrawHud() {
    const s = this.stats;
    const active = activeWid ? panels.get(activeWid) : null;
    hudLines = [
      `XR ${this.xrFps.toFixed(0)} fps (target ${this.targetRate}) · ${panels.size} finestre`,
      active && s
        ? `${active.name.slice(0, 22)} ${s.width}×${s.height} ${s.fps}fps · buffer ${s.jitterBufferMs}ms`
        : bridgeState,
      drag ? `sposto: ${drag.dist.toFixed(2)} m · ${drag.panel.widthM.toFixed(2)} m · ${room.summary}` : room.summary,
      voiceStatus || `voce: tieni premuto A per parlare (microfono ${micState})`,
    ];
    hud.redraw();
  }
}

world.registerSystem(WorkspaceSystem);

// Stato ispezionabile dal debugger remoto (chrome://inspect o CDP via adb forward).
Object.assign(window, {
  __qw: {
    world,
    panels,
    get drag() {
      return drag && { panel: drag.panel.name, hand: drag.hand, dist: drag.dist };
    },
    get pointer() {
      return { id: pointer.id, panel: pointer.panel?.name, down: pointer.down };
    },
    get activeWid() {
      return activeWid;
    },
    // Layer nativi del compositor rispetto alla barra: dimensioni e posizione reali.
    layers() {
      return [...panels.values()].map((p) => {
        const xl = XRLayerState.data.xrLayer[p.layerEntity.index] as unknown as {
          width: number;
          height: number;
          transform: XRRigidTransform;
          space: XRSpace;
        } | null;
        const bar = new Vector3();
        p.root.object3D!.getWorldPosition(bar);
        const content = new Vector3();
        p.layerEntity.object3D!.getWorldPosition(content);
        const rs = world.renderer.xr.getSession()?.renderState as unknown as { layers?: unknown[] } | undefined;
        return {
          name: p.name.slice(0, 20),
          widthM: p.widthM,
          heightM: p.heightM,
          native: xl && { width: xl.width, height: xl.height, pos: xl.transform && [xl.transform.position.x, xl.transform.position.y, xl.transform.position.z] },
          bar: bar.toArray(),
          content: content.toArray(),
          sessionLayers: rs?.layers?.length,
        };
      });
    },
  },
});
