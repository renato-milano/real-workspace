# Fase 0 — stato al 2026-10-07

Spike per validare i rischi tecnici del workspace MR su Quest 3: streaming delle finestre del Mac, input remoto,
voce. Esito del confronto WebXR vs Unity: **WebXR (Meta IWSDK)**.

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

Attenzione: per provare l'input remoto non condividere il terminale in cui gira Claude Code: click e testo
arriverebbero alla sessione come messaggi. Usare un browser, Note o simili.

## Fatto
- Bridge Electron: cattura per finestra (desktopCapturer), WebRTC con VP9 di default (max 1920 px, banda minima
  via SDP), signaling WS, un solo viewer per tipo, canale di controllo per i test, statistiche per stadio.
- Viewer 2D di diagnostica (`apps/bridge/public`) e client condiviso `qw-client.js`.
- Client WebXR IWSDK (`apps/xr`) in MR passthrough: un pannello finestra come `XRQuadLayer` (compositor layer),
  barra di presa per spostarlo, puntatore locale, ridimensionamento, HUD con le misure.
  Il pannello mesh WebGL usato nel confronto iniziale è stato rimosso.
- Input remoto: click, doppio click, trascinamento e scroll sulla finestra condivisa (dettagli sotto).
- Workaround per bug IWSDK 1.0.1 su Quest (render target del layer con samples=4 → crash in drawBuffers):
  `resolveDepthBuffer = false` sul render target, vedi `apps/xr/src/index.ts`.

## Risultati finora
| Misura | Esito |
|---|---|
| Frame rate XR con passthrough + 2 pannelli (confronto) | **90 fps stabili** |
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
30 fps contro i 90 del visore. Mitigato dal puntatore disegnato localmente nel visore a 90 fps (vedi Input
remoto); il cursore del Mac resta visibile nello stream, leggermente in ritardo.

Strumenti di test: `node apps/bridge/scripts/ctl.mjs '{"testPattern":true}'` apre una finestra con movimento
continuo e la seleziona; lo stesso script cambia `codec`, `maxres`, `fps`, `contentHint`, `degradation`.

## Input remoto (2026-10-07)
- Helper nativo `apps/bridge/native/qw-input.m` (Objective-C: i Command Line Tools attuali non compilano Swift
  per un modulemap duplicato). Il bridge lo compila al primo avvio; serve il permesso Accessibilità.
- Il visore manda coordinate UV del pannello; il bridge le converte in punti schermo con i bounds della finestra
  (CGWindowList, aggiornati ogni 500 ms), porta in primo piano la finestra al click e genera gli eventi CGEvent.
- Nel visore: barra sopra la finestra per spostarla; sulla finestra grilletto = click (doppio click incluso),
  tenuto + movimento = trascina, stick = scroll; puntatore locale a 90 fps. Fuori dalla finestra lo stick
  ridimensiona il pannello, B lo riporta davanti. Giudizio utente dopo la taratura del filtro: "ora va bene".
- Lezioni:
  - IWSDK genera anche un puntatore `screen-*` che in XR segue lo sguardo → va ignorato.
  - Il puntatore locale non deve intercettare il raggio (`raycast` disattivato), altrimenti le UV lette sono le sue.
  - Tremolio della mano amplificato dal raggio → filtro One Euro (0,7 Hz, beta 22, in metri sul pannello)
    e blocco del punto al click finché non ci si sposta di oltre 1,2 cm.

## Prossimi passi
1. Testo da tastiera senza guardare il Mac e scorciatoie (copia/incolla) dal visore.
2. Whisper locale (whisper.cpp large-v3-turbo) e misura latenza push-to-talk → testo.
3. Verso l'MVP: più finestre contemporanee, scelta della finestra dal visore, persistenza del layout.
