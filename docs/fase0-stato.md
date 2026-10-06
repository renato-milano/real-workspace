# Fase 0 — stato al 2026-10-07

Spike di confronto WebXR vs Unity per il client del visore (Quest 3). Il bridge sul Mac è comune a entrambi.

## Come riavviare

```bash
# visore collegato via USB, modalità sviluppatore attiva
npm run bridge          # Electron: cattura finestre + signaling (porta 8443)
npm run xr              # Vite + IWSDK, client WebXR (https, porta 8081)
npm run quest:reverse   # adb reverse 8443/8081 → il Quest raggiunge il Mac su localhost
npm run quest:open      # apre il client WebXR nel browser del Quest (poi "Entra" nel visore)
npm run quest:open-2d   # in alternativa: viewer 2D di diagnostica
```

Il bridge ricorda l'ultima finestra condivisa. Log diagnostici (ICE, errori XR, statistiche per stadio)
arrivano tutti sullo stdout del bridge.

## Fatto
- Bridge Electron: cattura per finestra (desktopCapturer), WebRTC H.264 con VideoToolbox, signaling WS,
  scelta di risoluzione max / codec / bitrate / fps, statistiche encoder.
- Viewer 2D (`apps/bridge/public`) e client condiviso `qw-client.js`.
- Client WebXR IWSDK (`apps/xr`) in MR passthrough, due pannelli affiancati sullo stesso stream:
  A = mesh WebGL con VideoTexture, B = `XRQuadLayer` (compositor layer). Grab, ridimensionamento, HUD.
- Workaround per bug IWSDK 1.0.1 su Quest (render target del layer con samples=4 → crash in drawBuffers):
  `resolveDepthBuffer = false` sul render target, vedi `apps/xr/src/index.ts`.

## Risultati finora
| Misura | Esito |
|---|---|
| Frame rate XR con passthrough + 2 pannelli | **90 fps stabili** |
| Leggibilità A (mesh) vs B (compositor layer) | **B nettamente migliore**; a 1920 px "perfetta" (giudizio utente) |
| Latenza percepita su B | **accettabile** (giudizio utente, 2026-10-07) |

Latenza per stadio (stream 1918×1128, 30 fps, terminale reale con mouse in movimento):

| Stadio | Iniziale (2940 px, H.264 High) | Attuale (1920 px, VP9, banda minima) |
|---|---|---|
| Codifica Mac | 60–125 ms (VideoToolbox) | ~8–25 ms (libvpx) |
| Decodifica Quest | 50–450 ms (H.264 High = software) | **4–7 ms** (hardware) |
| Jitter buffer Quest | fino a 750 ms | **0–68 ms** (mediana < 50) |
| Rete | 10–20 ms | 8–15 ms |

Cosa ha fatto la differenza, in ordine di impatto:
1. **Codec**: il browser del Quest decodifica H.264 High in software (39 ms/frame anche sul pattern di test);
   H.264 Baseline, VP9 e AV1 vanno in hardware (5 ms). VP9 è il default.
2. **Risoluzione max 1920 px**: oltre, il visore non mostra più dettaglio su un pannello normale.
3. **Banda minima via SDP** (`x-google-min/start-bitrate` nell'answer): senza, la stima di banda resta bassa con
   contenuto statico e il pacer "dosa" i frame grandi → jitter buffer 120–170 ms.
4. **Un solo viewer per tipo** (le schede rimaste aperte raddoppiavano codifica e decodifica).

Limite noto: la cattura finestre di macOS consegna ~30 fps, quindi il cursore del Mac nello stream si muove a
30 fps contro i 90 del visore (leggermente a scatti). Soluzione prevista: puntatore disegnato localmente nel
visore a 90 fps, con la posizione inviata via WebSocket, indipendente dal video.

Strumenti di test: `node apps/bridge/scripts/ctl.mjs '{"testPattern":true}'` apre una finestra con movimento
continuo e la seleziona; lo stesso script cambia `codec`, `maxres`, `fps`, `contentHint`, `degradation`.

## Prossimi passi
1. Decidere WebXR vs Unity: con B leggibile, 90 fps e latenza accettabile, lo spike Unity potrebbe non servire.
2. Click remoto: dal raggio sul pannello alle coordinate della finestra → CGEvent sul Mac; puntatore locale a 90 fps.
3. Whisper locale (whisper.cpp large-v3-turbo) e misura latenza push-to-talk → testo.
4. Pulizia spike → MVP: rimuovere il pannello A, più finestre contemporanee, persistenza layout.
