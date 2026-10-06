// Input remoto: converte gli eventi del visore (coordinate normalizzate sul pannello) in eventi mouse macOS
// sulla finestra condivisa, tramite l'helper nativo qw-input.
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

  let windowId = null;
  let bounds = null; // {x, y, w, h} in punti globali

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
    } else if (msg.op === 'bounds' && msg.windowId === windowId) {
      bounds = msg.missing ? null : { x: msg.x, y: msg.y, w: msg.w, h: msg.h };
    }
  });
  helper.on('exit', (code) => log(`qw-input terminato (${code})`));
  send({ op: 'trusted' });

  // La finestra può essere spostata o ridimensionata sul Mac: aggiorniamo i bounds di continuo.
  const timer = setInterval(() => {
    if (windowId != null) send({ op: 'bounds', windowId });
  }, 500);

  function toScreen(u, v) {
    if (!bounds) return null;
    // u,v come le UV del pannello: origine in basso a sinistra.
    const cu = Math.min(Math.max(u, 0), 1);
    const cv = Math.min(Math.max(v, 0), 1);
    return { x: bounds.x + cu * bounds.w, y: bounds.y + (1 - cv) * bounds.h };
  }

  return {
    // sourceId di desktopCapturer: "window:<CGWindowID>:0" (gli schermi interi non sono supportati).
    setSource(sourceId) {
      const m = /^window:(\d+):/.exec(sourceId ?? '');
      windowId = m ? Number(m[1]) : null;
      bounds = null;
      if (windowId != null) send({ op: 'bounds', windowId });
    },

    handle(msg) {
      if (msg.op === 'scroll') {
        send({ op: 'scroll', dx: msg.dx ?? 0, dy: msg.dy ?? 0 });
        return;
      }
      const p = toScreen(msg.u, msg.v);
      if (!p) return;
      if (msg.op === 'down') send({ op: 'focus', windowId });
      if (msg.op === 'move' || msg.op === 'down' || msg.op === 'up') send({ op: msg.op, ...p });
    },

    dispose() {
      clearInterval(timer);
      helper.kill();
    },
  };
}
