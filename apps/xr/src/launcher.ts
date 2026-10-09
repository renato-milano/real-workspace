// Launcher: elenco delle finestre del Mac con miniatura. Clic su una finestra = aprila nel visore
// (o chiudila, se è già aperta). Si apre e si chiude col click dello stick sinistro. In alto a destra il
// pulsante per riscansionare la stanza (Space Setup), raro ma da avere a portata di mano.

import { RayInteractable, Vector3, type Entity, type World } from '@iwsdk/core';
import { COLORS, canvasPlane, fitText } from './ui.js';
import type { PanelPointerEvent } from './panel.js';

export type WindowInfo = { id: string; name: string; thumb: string };

const WIDTH_M = 1.0;
const HEIGHT_M = 0.66;
const COLS = 4;
const ROWS = 4;
const HEADER = 0.1; // frazione dell'altezza
const PAD = 0.015; // frazione della larghezza
const SCAN_BUTTON = { x0: 0.78, x1: 0.985 }; // frazioni della larghezza, nella fascia del titolo

export function createLauncher(
  world: World,
  {
    isOpen,
    onPick,
    onRoomScan,
  }: { isOpen: (id: string) => boolean; onPick: (w: WindowInfo) => void; onRoomScan: () => void },
) {
  let list: WindowInfo[] = [];
  let status = 'carico l’elenco delle finestre…';
  const thumbs = new Map<string, HTMLImageElement>();
  let hover = -1; // indice della finestra indicata, -2 = pulsante scansione

  const plane = canvasPlane(WIDTH_M, HEIGHT_M, 2048, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = COLORS.bg;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 28);
    ctx.fill();

    const headerH = h * HEADER;
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 ${Math.round(headerH * 0.4)}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('Finestre del Mac', w * PAD * 2, headerH / 2);
    ctx.fillStyle = COLORS.muted;
    ctx.font = `${Math.round(headerH * 0.28)}px -apple-system, system-ui, sans-serif`;
    const hint = list.length ? 'clic: apri / chiudi · stick sinistro: nascondi' : status;
    ctx.fillText(hint, w * 0.3, headerH / 2);
    const bx = w * SCAN_BUTTON.x0;
    const bw = w * (SCAN_BUTTON.x1 - SCAN_BUTTON.x0);
    ctx.fillStyle = hover === -2 ? 'rgba(79,140,255,0.95)' : 'rgba(40,44,52,0.95)';
    ctx.beginPath();
    ctx.roundRect(bx, headerH * 0.18, bw, headerH * 0.64, headerH * 0.32);
    ctx.fill();
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.fillText('Scansiona stanza', bx + bw / 2, headerH / 2);
    ctx.textAlign = 'left';

    const pad = w * PAD;
    const cellW = (w - pad * (COLS + 1)) / COLS;
    const cellH = (h - headerH - pad * (ROWS + 1)) / ROWS;
    list.slice(0, COLS * ROWS).forEach((win, i) => {
      const x = pad + (i % COLS) * (cellW + pad);
      const y = headerH + pad + Math.floor(i / COLS) * (cellH + pad);
      const open = isOpen(win.id);
      ctx.fillStyle = i === hover ? 'rgba(60,66,78,0.95)' : 'rgba(30,33,40,0.95)';
      ctx.beginPath();
      ctx.roundRect(x, y, cellW, cellH, 14);
      ctx.fill();
      if (open) {
        ctx.strokeStyle = COLORS.ok;
        ctx.lineWidth = 6;
        ctx.stroke();
      }
      const labelH = cellH * 0.2;
      const img = thumbs.get(win.id);
      if (img?.complete && img.naturalWidth) {
        const boxW = cellW - 16;
        const boxH = cellH - labelH - 16;
        const s = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
        const iw = img.naturalWidth * s;
        const ih = img.naturalHeight * s;
        ctx.drawImage(img, x + 8 + (boxW - iw) / 2, y + 8 + (boxH - ih) / 2, iw, ih);
      }
      ctx.fillStyle = open ? COLORS.ok : COLORS.text;
      ctx.font = `${Math.round(labelH * 0.5)}px -apple-system, system-ui, sans-serif`;
      ctx.fillText(fitText(ctx, `${open ? '● ' : ''}${win.name}`, cellW - 24), x + 12, y + cellH - labelH / 2);
    });
  });
  // Nascosto non deve intercettare il raggio (three non esclude gli oggetti invisibili dal raycast).
  const setInteractive = (on: boolean) => {
    plane.mesh.visible = on;
    (plane.mesh as unknown as { pointerEvents: string }).pointerEvents = on ? 'auto' : 'none';
  };
  setInteractive(false);
  const entity: Entity = world.createTransformEntity(plane.mesh);
  entity.addComponent(RayInteractable);

  function cellAt(uv: { x: number; y: number }) {
    // uv con origine in basso a sinistra; il canvas ha origine in alto a sinistra.
    const fx = uv.x;
    const fy = 1 - uv.y;
    if (fy < HEADER) return fx >= SCAN_BUTTON.x0 && fx <= SCAN_BUTTON.x1 ? -2 : -1;
    const col = Math.floor(fx * COLS);
    const row = Math.floor(((fy - HEADER) / (1 - HEADER)) * ROWS);
    const i = row * COLS + col;
    return col >= 0 && col < COLS && row >= 0 && row < ROWS && i < list.length ? i : -1;
  }

  const on = (type: string, fn: (e: PanelPointerEvent) => void) =>
    (plane.mesh.addEventListener as (t: string, f: (e: PanelPointerEvent) => void) => void)(type, (e) => {
      if (!e.pointerType?.startsWith('screen')) fn(e);
    });
  on('pointermove', (e) => {
    const i = e.uv ? cellAt(e.uv) : -1;
    if (i !== hover) {
      hover = i;
      plane.redraw();
    }
  });
  on('pointerleave', () => {
    hover = -1;
    plane.redraw();
  });
  on('pointerdown', (e) => {
    const i = e.uv ? cellAt(e.uv) : -1;
    if (i >= 0) onPick(list[i]);
    else if (i === -2) onRoomScan();
  });

  const dir = new Vector3();
  const pos = new Vector3();

  return {
    get visible() {
      return plane.mesh.visible;
    },

    // Davanti a te, un po' sotto lo sguardo e inclinato verso l'alto, come un vassoio.
    show() {
      const head = world.camera;
      head.getWorldDirection(dir);
      dir.y = 0;
      dir.normalize();
      pos.setFromMatrixPosition(head.matrixWorld);
      const o = entity.object3D!;
      o.position.copy(pos).addScaledVector(dir, 0.75);
      o.position.y = pos.y - 0.3;
      o.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0, 'YXZ');
      o.rotateX(-0.45);
      setInteractive(true);
      plane.redraw();
    },

    hide() {
      setInteractive(false);
    },

    setList(next: WindowInfo[]) {
      list = next;
      status = next.length ? '' : 'nessuna finestra trovata';
      thumbs.clear();
      for (const w of next) {
        if (!w.thumb) continue;
        const img = new Image();
        img.onload = () => plane.redraw();
        img.src = w.thumb;
        thumbs.set(w.id, img);
      }
      plane.redraw();
    },

    redraw() {
      plane.redraw();
    },
  };
}
