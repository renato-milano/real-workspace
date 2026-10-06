// Bridge (spike Fase 0): cattura finestre macOS e le invia via WebRTC ai client nel visore.
// Il main process fa da server HTTP + relay di signaling; la cattura e WebRTC vivono nel renderer.
import { app, BrowserWindow, desktopCapturer, ipcMain } from 'electron';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { createInputService } from './input.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.QW_PORT ?? 8443);
const PUBLIC_DIR = join(__dirname, '..', 'public');

// Chromium di default nasconde gli IP locali dietro nomi mDNS (.local); il browser del Quest
// non sempre li risolve, e su LAN privata non ci serve l'offuscamento.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

// --- HTTP statico -----------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(PUBLIC_DIR, path));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// --- Signaling relay --------------------------------------------------------
// Protocollo minimo:
//   client → server  {type:'hello', role:'host'|'viewer', name?}
//   server → host    {type:'viewer-joined', id, name} | {type:'viewer-left', id}
//   server → viewer  {type:'welcome', id}
//   chiunque         {type:'signal', to, data}  → inoltrato con `from`
//   viewer → host    {type:'input', ...}       → inoltrato al host (input remoto, step successivo)

const wss = new WebSocketServer({ server, path: '/ws' });
let host = null;
const viewers = new Map(); // id → { ws, name }
let nextId = 1;

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  let id = null;
  let role = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'hello') {
      role = msg.role;
      if (role === 'ctl') {
        id = 'ctl';
        log('controllo connesso');
        return;
      }
      if (role === 'host') {
        host = ws;
        id = 'host';
        for (const [vid, v] of viewers) send(host, { type: 'viewer-joined', id: vid, name: v.name });
      } else {
        // Un solo viewer per tipo: schede vecchie rimaste aperte (es. dopo uno standby) raddoppierebbero
        // codifica sul Mac e decodifica sul visore, falsando anche le misure.
        for (const [vid, v] of viewers) {
          if (v.name !== (msg.name ?? 'viewer')) continue;
          send(v.ws, { type: 'replaced' });
          v.ws.close();
          viewers.delete(vid);
          send(host, { type: 'viewer-left', id: vid });
          log(`viewer ${vid} sostituito`);
        }
        id = `v${nextId++}`;
        viewers.set(id, { ws, name: msg.name ?? 'viewer' });
        send(ws, { type: 'welcome', id });
        send(host, { type: 'viewer-joined', id, name: msg.name ?? 'viewer' });
      }
      log(`${role} connesso (${id})`);
      return;
    }

    if (msg.type === 'log') {
      log(`<${id}> ${msg.line}`);
      return;
    }

    if (msg.type === 'signal') {
      const target = msg.to === 'host' ? host : viewers.get(msg.to)?.ws;
      send(target, { type: 'signal', from: id, data: msg.data });
      return;
    }

    if (msg.type === 'input' && role === 'viewer') {
      input?.handle(msg);
      return;
    }

    if (role === 'ctl' && msg.type === 'control' && msg.testPattern) openTestPattern();
    if (role === 'viewer' || role === 'ctl') send(host, { ...msg, from: id });
  });

  ws.on('close', () => {
    if (role === 'host' && host === ws) host = null;
    if (role === 'viewer') {
      viewers.delete(id);
      send(host, { type: 'viewer-left', id });
    }
    if (role) log(`${role} disconnesso (${id})`);
  });
});

// --- Finestra di controllo --------------------------------------------------

let controlWin = null;
let input = null;

function log(line) {
  console.log(`[bridge] ${line}`);
  controlWin?.webContents.send('log', line);
}

let testWin = null;
function openTestPattern() {
  // 960×565 punti = 1920×1130 pixel su Retina: stessa risoluzione delle misure fatte sul terminale.
  if (testWin && !testWin.isDestroyed()) return;
  testWin = new BrowserWindow({ width: 960, height: 565, useContentSize: true, title: 'QW Test Pattern' });
  testWin.loadFile(join(__dirname, 'renderer', 'test-pattern.html'));
}

ipcMain.handle('list-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 320, height: 200 },
  });
  return sources
    .filter((s) => s.name && !s.name.startsWith('Quest Workspace Bridge'))
    .map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
});

ipcMain.on('active-source', (_e, sourceId) => input?.setSource(sourceId));

ipcMain.handle('server-info', () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  return { port: PORT, lan };
});

app.whenReady().then(() => {
  server.listen(PORT, '0.0.0.0', () => log(`server su http://localhost:${PORT}`));
  input = createInputService({ nativeDir: join(__dirname, '..', 'native'), log });

  controlWin = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'Quest Workspace Bridge',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // Il renderer resta in esecuzione anche se la finestra è in secondo piano: è lui che codifica.
      backgroundThrottling: false,
    },
  });
  controlWin.loadFile(join(__dirname, 'renderer', 'index.html'));
});

app.on('window-all-closed', () => app.quit());
