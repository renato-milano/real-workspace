// Input remoto: converte gli eventi del visore (coordinate normalizzate sul pannello di una finestra) in eventi
// mouse e tastiera macOS, tramite l'helper nativo qw-input.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

export function createInputService({ nativeDir, log }) {
  const source = join(nativeDir, 'qw-input.m');
  const binary = join(nativeDir, 'bin', 'qw-input');

  // Ricompila se il binario manca o è più vecchio del sorgente (è ignorato da git).
  if (!existsSync(binary) || statSync(binary).mtimeMs < statSync(source).mtimeMs) {
    log('compilo qw-input…');
    execFileSync('clang', [
      '-fobjc-arc', '-O2', source,
      '-framework', 'AppKit', '-framework', 'ApplicationServices',
      '-o', binary,
    ]);
  }

  const helper = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const send = (msg) => helper.stdin.write(JSON.stringify(msg) + '\n');

  // Finestre aperte nel visore (CGWindowID → bounds in punti globali) e finestra attiva: quella che riceve
  // testo dettato e tasti. Diventa attiva l'ultima finestra cliccata o indicata dal visore.
  const windows = new Map();
  let active = null;

  createInterface({ input: helper.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.op === 'trusted') {
      log(
        msg.trusted
          ? 'input remoto: permesso Accessibilità OK'
          : 'input remoto: manca il permesso Accessibilità (Impostazioni → Privacy e sicurezza → Accessibilità → Electron)',
      );
    } else if (msg.op === 'bounds' && windows.has(msg.windowId)) {
      windows.set(msg.windowId, msg.missing ? null : { x: msg.x, y: msg.y, w: msg.w, h: msg.h });
    }
  });
  helper.on('exit', (code) => log(`qw-input terminato (${code})`));
  send({ op: 'trusted' });

  // Le finestre possono essere spostate o ridimensionate sul Mac: aggiorniamo i bounds di continuo.
  const timer = setInterval(() => {
    for (const windowId of windows.keys()) send({ op: 'bounds', windowId });
  }, 500);

  // sourceId di desktopCapturer: "window:<CGWindowID>:0" (gli schermi interi non sono supportati).
  function windowIdOf(sourceId) {
    const m = /^window:(\d+):/.exec(sourceId ?? '');
    return m ? Number(m[1]) : null;
  }

  function toScreen(windowId, u, v) {
    const b = windows.get(windowId);
    if (!b) return null;
    // u,v come le UV del pannello: origine in basso a sinistra.
    const cu = Math.min(Math.max(u, 0), 1);
    const cv = Math.min(Math.max(v, 0), 1);
    return { x: b.x + cu * b.w, y: b.y + (1 - cv) * b.h };
  }

  return {
    // Elenco delle finestre aperte nel visore (sourceId), aggiornato dal renderer del bridge.
    setWindows(sourceIds) {
      const ids = new Set(sourceIds.map(windowIdOf).filter((id) => id != null));
      for (const id of windows.keys()) if (!ids.has(id)) windows.delete(id);
      for (const id of ids) {
        if (!windows.has(id)) {
          windows.set(id, null);
          send({ op: 'bounds', windowId: id });
        }
      }
      if (active != null && !ids.has(active)) active = null;
    },

    setActive(sourceId) {
      const id = windowIdOf(sourceId);
      if (id != null && windows.has(id)) active = id;
    },

    handle(msg) {
      if (msg.op === 'key') {
        // Solo i tasti che servono dal visore: invio per mandare, esc per interrompere.
        if (active == null || !['return', 'escape'].includes(msg.key)) return;
        send({ op: 'focus', windowId: active });
        send({ op: 'key', key: msg.key, count: 1 });
        return;
      }
      if (msg.op === 'scroll') {
        // Lo scroll va alla finestra sotto il cursore del Mac, già portato lì dai movimenti del puntatore.
        send({ op: 'scroll', dx: msg.dx ?? 0, dy: msg.dy ?? 0 });
        return;
      }
      const windowId = windowIdOf(msg.wid);
      const p = toScreen(windowId, msg.u, msg.v);
      if (!p) return;
      if (msg.op === 'down') {
        active = windowId;
        send({ op: 'focus', windowId });
      }
      if (msg.op === 'move' || msg.op === 'down' || msg.op === 'up') send({ op: msg.op, ...p });
    },

    // Scrive un testo dettato nella finestra attiva e preme invio: dettando a Claude Code o Codex, finire
    // di parlare vuol dire mandare il comando. Restituisce false se non c'è una finestra su cui scrivere.
    typeText(text) {
      if (active == null || !text) return false;
      send({ op: 'focus', windowId: active });
      send({ op: 'type', text });
      // Le TUI (Claude Code) trattano una raffica di caratteri come incolla: un invio dentro la raffica
      // diventerebbe un a capo. La pausa lo fa arrivare come tasto a sé.
      send({ op: 'sleep', ms: 150 });
      send({ op: 'key', key: 'return', count: 1 });
      return true;
    },

    dispose() {
      clearInterval(timer);
      helper.kill();
    },
  };
}
