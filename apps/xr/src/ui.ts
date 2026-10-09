// Elementi di interfaccia disegnati su canvas: un piano con texture ridisegnabile.

import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';

export const COLORS = {
  bg: 'rgba(16,18,22,0.9)',
  bar: 'rgba(92,98,110,0.95)',
  barHover: 'rgba(120,128,142,0.98)',
  accent: 'rgba(79,140,255,0.95)',
  ok: '#3ecf8e',
  text: '#e6e8eb',
  muted: '#8b919c',
  close: '#ff5f57',
};

export function canvasPlane(
  width: number,
  height: number,
  px: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  let canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = Math.round((px * height) / width);
  let texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new MeshBasicMaterial({ map: texture, transparent: true });
  const mesh = new Mesh(new PlaneGeometry(width, height), material);
  const redraw = () => {
    draw(canvas.getContext('2d')!, canvas.width, canvas.height);
    texture.needsUpdate = true;
  };
  redraw();
  // Nuove dimensioni fisiche: geometria e canvas si adattano (stessa densità di pixel per metro).
  const pxPerM = px / width;
  // Canvas e texture nuovi: una texture già caricata in GPU non cambia dimensioni in modo affidabile.
  const setSize = (w: number, h: number) => {
    mesh.geometry.dispose();
    mesh.geometry = new PlaneGeometry(w, h);
    canvas = document.createElement('canvas');
    canvas.width = Math.min(4096, Math.round(w * pxPerM));
    canvas.height = Math.round((canvas.width * h) / w);
    const old = texture;
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    material.map = texture;
    material.needsUpdate = true;
    old.dispose();
    redraw();
  };
  const dispose = () => {
    mesh.geometry.dispose();
    material.dispose();
    texture.dispose();
  };
  return { mesh, redraw, setSize, dispose };
}

// Testo su una riga, accorciato con "…" se non entra in maxWidth.
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}
