// Stanza reale: piani da Space Setup (WebXR plane-detection), mostrati come contorni colorati per etichetta
// solo mentre si sposta una finestra (muri azzurri, porte viola, mobili gialli). capture() avvia dal browser
// la scansione della stanza (initiateRoomCapture, pulsante nel launcher); i muri nuovi arrivano dalla
// sessione successiva.
// Si usa direttamente WebXR, non il SceneUnderstandingSystem di IWSDK (che gestisce un'unica ancora globale).

import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineLoop,
  Matrix4,
  createSystem,
  type World,
} from '@iwsdk/core';

const LABEL_COLORS: Record<string, number> = {
  wall: 0x4fd1ff,
  floor: 0x4fff8a,
  ceiling: 0x9aa0a6,
  table: 0xffd84f,
  shelf: 0xffd84f,
  bed: 0xffd84f,
  'wall art': 0xff9f4f,
  window: 0xb388ff,
  door: 0xb388ff,
};

// Tipi WebXR non ancora (o non del tutto) nelle definizioni di TypeScript.
export type XRPlaneLike = {
  planeSpace: XRSpace;
  polygon: DOMPointReadOnly[];
  orientation?: string;
  semanticLabel?: string;
  lastChangedTime: number;
};
type FrameLike = XRFrame & { detectedPlanes?: Set<XRPlaneLike> };
type SessionLike = XRSession & { initiateRoomCapture?: () => Promise<void> };

export type RoomPlane = { plane: XRPlaneLike; line: LineLoop; changed: number };

export function registerRoom(world: World, log: (line: string) => void) {
  const group = new Group();
  group.visible = false;
  world.createTransformEntity(group);
  const planes = new Map<XRPlaneLike, RoomPlane>();
  const tmp = new Matrix4();
  let summary = '';

  class RoomSystem extends createSystem({}) {
    init() {
      this.renderer.xr.addEventListener('sessionend', () => {
        for (const { line } of planes.values()) {
          line.geometry.dispose();
          line.removeFromParent();
        }
        planes.clear();
        summary = '';
      });
    }

    update() {
      const frame = this.renderer.xr.getFrame() as FrameLike | null;
      const space = this.renderer.xr.getReferenceSpace();
      const session = this.renderer.xr.getSession() as SessionLike | null;
      if (!frame || !space || !session) return;

      const detected = frame.detectedPlanes;
      if (!detected) return;
      for (const [plane, entry] of planes) {
        if (detected.has(plane)) continue;
        entry.line.geometry.dispose();
        entry.line.removeFromParent();
        planes.delete(plane);
      }
      for (const plane of detected) {
        let entry = planes.get(plane);
        if (!entry || entry.changed !== plane.lastChangedTime) {
          // Il poligono è nel piano XZ dello spazio del piano.
          const geometry = new BufferGeometry();
          geometry.setAttribute('position', new Float32BufferAttribute(plane.polygon.flatMap((p) => [p.x, 0, p.z]), 3));
          if (entry) {
            entry.line.geometry.dispose();
            entry.line.geometry = geometry;
            entry.changed = plane.lastChangedTime;
          } else {
            const color = LABEL_COLORS[plane.semanticLabel ?? ''] ?? 0xff4fd8;
            const line = new LineLoop(geometry, new LineBasicMaterial({ color, transparent: true, opacity: 0.7 }));
            line.raycast = () => {};
            group.add(line);
            entry = { plane, line, changed: plane.lastChangedTime };
            planes.set(plane, entry);
          }
        }
        const pose = frame.getPose(plane.planeSpace, space);
        if (pose) {
          tmp.fromArray(pose.transform.matrix);
          tmp.decompose(entry.line.position, entry.line.quaternion, entry.line.scale);
        }
      }
      const next = `${planes.size} piani, ${[...planes.keys()].filter((p) => p.semanticLabel === 'wall').length} muri`;
      if (next !== summary) log(`[stanza] ${(summary = next)}`);
    }
  }

  async function roomCapture() {
    const session = world.renderer.xr.getSession() as SessionLike | null;
    if (!session?.initiateRoomCapture) {
      log('[stanza] initiateRoomCapture non disponibile in questo browser');
      return;
    }
    log('[stanza] avvio scansione della stanza dal browser…');
    try {
      await session.initiateRoomCapture();
      log('[stanza] scansione conclusa: i muri nuovi arrivano dalla prossima sessione');
    } catch (err) {
      log(`[stanza] scansione della stanza fallita: ${String((err as Error)?.message ?? err)}`);
    }
  }

  world.registerSystem(RoomSystem);

  return {
    planes,
    setVisible(visible: boolean) {
      group.visible = visible;
    },
    get summary() {
      return summary;
    },
    capture: roomCapture,
  };
}
