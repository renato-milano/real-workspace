# Stato del progetto — 2026-10-10

Fase 0 (spike dei rischi tecnici: streaming delle finestre del Mac, input remoto, voce) conclusa; esito del
confronto WebXR vs Unity: **WebXR (Meta IWSDK)**. Fase 1 in corso: workspace con più finestre da disporre
nella stanza (vedi "Finestre multiple" e "Stanza").

## Come riavviare

```bash
scripts/setup-whisper.sh  # una volta sola: whisper.cpp con encoder CoreML + modello (~2,8 GB in ~/.cache)

# visore collegato via USB (la prima volta dopo ogni riavvio del visore), modalità sviluppatore attiva
scripts/adb-wifi.sh     # ADB via Wi-Fi: poi il cavo si può staccare e ci si muove per la stanza
npm run bridge          # Electron: cattura finestre + signaling (porta 8443)
npm run xr              # Vite + IWSDK, client WebXR (https, porta 8081)
npm run quest:reverse   # adb reverse 8443/8081 → il Quest raggiunge il Mac su localhost
npm run quest:open      # apre il client WebXR nel browser del Quest (poi "Entra" nel visore)
npm run quest:open-2d   # in alternativa: viewer 2D di diagnostica
```

Il bridge riapre le finestre che erano aperte nel visore e avvia da sé whisper-server (pronto in ~3 s). Log diagnostici (ICE, errori XR, statistiche per stadio)
arrivano tutti sullo stdout del bridge.

Tutti gli script usano un solo ADB (`scripts/adb.sh`: quello di MQDH, e la connessione Wi-Fi se c'è):
mescolare l'ADB integrato di metavr con un server adb classico faceva perdere il visore. Col cavo, il
collegamento cade quando ci si muove (e `adb reverse` con lui): da qui il Wi-Fi. Se il visore smette di ricevere,
`scripts/adb.sh kill-server`, poi `scripts/adb-wifi.sh` (col cavo) e `npm run quest:reverse`; la pagina si
ricollega da sola. Se ADB vede il visore solo a intermittenza ("read failed" nel log di adb), riavviare il visore.

Debug della pagina nel visore: `scripts/adb.sh forward tcp:9222 localabstract:chrome_devtools_remote`, poi
`http://localhost:9222/json` (Chrome DevTools Protocol); lo stato del client è in `window.__qw`.

Attenzione: per provare l'input remoto non condividere il terminale in cui gira Claude Code: click e testo
arriverebbero alla sessione come messaggi. Usare un browser, Note o simili.

## Fatto
- Bridge Electron: cattura per finestra (desktopCapturer), WebRTC con VP9 di default (max 1920 px, banda minima
  via SDP), signaling WS, un solo viewer per tipo, canale di controllo per i test, statistiche per stadio.
- Viewer 2D di diagnostica (`apps/bridge/public`) e client condiviso `qw-client.js`.
- Client WebXR IWSDK (`apps/xr`) in MR passthrough: ogni finestra è un `XRQuadLayer` (compositor layer) con
  barra di presa, HUD con le misure sotto la finestra attiva. Il pannello mesh WebGL del confronto iniziale è
  stato rimosso.
- Finestre multiple, launcher nel visore, spostamento nella stanza (dettagli sotto).
- Input remoto: click, doppio click, trascinamento e scroll sulla finestra condivisa (dettagli sotto).
- Voce push-to-talk: A tenuto sul controller destro, trascrizione locale con whisper.cpp, testo scritto nella
  finestra attiva e inviato (dettagli sotto).
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

## Voce (2026-10-09)
- Visore: microfono sempre aperto (getUserMedia → AudioWorklet, PCM 16 kHz Int16) con pre-roll di 300 ms;
  mentre A è premuto i pacchetti da 100 ms vanno al bridge come frame binari sul WebSocket (`apps/xr/src/voice.ts`).
- Bridge: `apps/bridge/src/voice.js` avvia whisper-server (modello in memoria) e al rilascio gli passa il WAV;
  il testo passa per `corrections.js` e torna al visore, che lo mostra nell'HUD con i tempi.
- Modello large-v3-turbo, italiano fisso, decodifica greedy, nessun prompt.
- Il testo viene scritto nella finestra attiva (focus + eventi tastiera Unicode da `qw-input`) e **inviato**:
  dettando a Claude Code, finire di parlare vuol dire mandare il comando (scelta dell'utente). Tra testo e
  invio 150 ms di pausa: le TUI trattano una raffica di caratteri come incolla, e un invio dentro la raffica
  diventerebbe un a capo. Controller sinistro: X = invio, Y = esc (interrompe Claude Code).
  Verificato: dettature consecutive identiche al testo atteso in TextEdit; messaggi dettati dal visore a
  Claude Code arrivati corretti e partiti da soli (6,3 s di audio → 0,8 s).
- Filtro silenzio: sotto 200 ms di voce (finestre da 30 ms con RMS > 500) non si trascrive nulla, e le
  allucinazioni tipiche ("Grazie.", "Sottotitoli…") con poca voce vengono scartate. Senza, una pressione
  accidentale di A mandava "Grazie." a Claude Code.
- Registrazioni e trascrizioni salvate in `~/.cache/qw-voice/recordings` (ultime 200; `QW_VOICE_SAVE=0` le
  disattiva) per confrontare impostazioni con `node apps/bridge/scripts/voice-ab.mjs [n]`.

| Misura (voce reale, dal visore) | Esito |
|---|---|
| Frase breve (3–6 s di audio), rilascio → testo nel visore | **750–800 ms** |
| Testo lungo (28 s di audio) | **1,4 s** |
| Rete (WebSocket via adb reverse) | 3–7 ms |
| Accuratezza testo lungo (~85 parole) | 3 errori, tutti su termini tecnici o simili |

Cosa ha fatto la differenza:
1. **Encoder CoreML sul Neural Engine**: l'encoder di large-v3-turbo è quello pieno di large-v3; su GPU Metal
   (M3) costa ~3,2 s a frase indipendentemente dalla durata (Whisper elabora sempre finestre da 30 s). Con
   l'encoder CoreML precompilato (`ggml-large-v3-turbo-encoder.mlmodelc`) scende a ~0,5 s. Il primo avvio in
   assoluto compila il modello per il Neural Engine (~80 s), poi resta in cache.
2. **Greedy invece di best_of 2**: stesso testo sulle frasi di prova, ~400 ms in meno.
3. Ridurre `audio_ctx` aiuterebbe sulla GPU, ma va adattato alla durata della frase (se è troppo corto la
   trascrizione si tronca e si ripete) e con CoreML non serve.

Lezioni:
- Homebrew su macOS 14 compila da sorgente la formula whisper-cpp con llvm, rust e node: `scripts/setup-whisper.sh`
  compila solo whisper.cpp (cmake da pip in un venv privato).
- **Il prompt iniziale è pericoloso per noi**: migliora punteggiatura e termini (README, typecheck) ma il modello
  copia le parole del prompt: con "Codex, esegui…" nel prompt, "Claude, esegui…" è diventato "Codex, esegui…".
  Scambiare i destinatari è l'errore peggiore possibile; si usa invece un dizionario di correzioni dopo la
  trascrizione (`corrections.js`), con regole prudenti nate da errori osservati.
- whisper-server conserva i parametri di una richiesta per le successive: il bridge li manda sempre tutti.
- whisper-server è lanciato tramite un wrapper sh che lo termina quando si chiude la pipe col bridge: con kill o
  Ctrl+C il processo Electron non esegue `will-quit` e il server restava orfano.
- Eventi tastiera troppo ravvicinati perdono caratteri (TextEdit con 2 ms tra i pezzi da 20 caratteri): 8 ms.
- Errori ricorrenti ancora aperti: "README" → "ritmo" (non correggibile a dizionario: è una parola comune),
  "esegui" → "eseguvi", "apri" → "apre".

## Stanza (2026-10-09)
- Probe sul visore: ancora persistente WebXR (`requestPersistentHandle` / `restorePersistentAnchor`) ripristinata
  in ~10 ms tra sessioni, dopo il riavvio del visore e anche dopo una nuova scansione della stanza; tracciata
  per minuti senza perdite. Le coordinate della stanza invece cambiano a ogni sessione (stesso punto fisico:
  (0; 1,65; −0,97) e poi (−1,11; 1,21; 0,30)): le posizioni vanno salvate rispetto alle ancore, mai in assoluto.
- Piani da Space Setup (plane-detection): 19 nella stanza dell'utente (8 segmenti di muro, porte, pavimento,
  soffitto, letto, tavoli). Senza Space Setup con i muri (solo i confini) i piani sono 0. La scansione si
  avvia anche dalla pagina (`initiateRoomCapture`, pulsante "Scansiona stanza" nel launcher); i muri nuovi
  arrivano dalla sessione successiva.
- `apps/xr/src/room.ts` disegna i piani (muri azzurri, porte viola, mobili gialli) mentre si sposta una finestra.

## Finestre multiple (2026-10-10)
- Bridge: insieme di finestre aperte, ciascuna catturata una volta e inviata con una RTCPeerConnection per
  (viewer, finestra), così aprirne o chiuderne una non tocca le altre. La finestra attiva (ultima cliccata) e
  quella indicata dal raggio vanno a 30 fps, le altre a 5. Il bridge ricorda le finestre aperte tra riavvii.
- Visore (`panel.ts`, `launcher.ts`): launcher con le miniature delle finestre del Mac (click dello stick
  sinistro); ogni finestra ha una barra larga quanto lei (grilletto = sposta, con un margine invisibile verso
  l'alto) e un × staccato. Grip su un punto qualsiasi della finestra = spostala. Mentre la sposti segue il
  raggio sempre rivolta verso di te; stick su/giù = allontana/avvicina (fino a 8 m), sinistra/destra = più
  piccola/grande. B = porta la finestra attiva davanti a te.
- Misure: 4 finestre aperte, XR a 90 fps, decodifica hardware 5–7 ms per finestra.
- **Bug del Quest Browser (Chrome 152)**: i quad layer vengono mostrati al **doppio** della larghezza e altezza
  dichiarate, mentre la mesh su cui il raggio calcola le UV ha la dimensione dichiarata. Effetti: il video
  copriva barra, HUD e puntatore locale; il cursore del Mac si muoveva al doppio della velocità del raggio;
  la metà esterna della finestra non era cliccabile. Scoperto con cornici di prova via CDP (quelle a ±larghezza
  dal centro combaciavano coi bordi visibili). Correzione in `index.ts` (`halveNativeQuadSize`): sul layer
  nativo width/height vengono dimezzate intercettandone le assegnazioni.
- Lezioni:
  - I compositor layer stanno sempre sopra la scena: qualunque oggetto 3D davanti a una finestra (controller,
    puntatore) viene coperto. Il puntatore locale è quindi disegnato dentro il layer, sopra il video, a ogni
    frame del visore (`panel.ts`, `setCursor`).
  - La cattura di finestra di macOS produce un frame solo quando la finestra si ridisegna: col cursore che si
    muove sopra, TextEdit fermo dà ~4 fps, un terminale che lampeggia (Warp) 23–30. Per questo il cursore del
    Mac nello stream va a scatti sulle finestre statiche. `getDisplayMedia` con `cursor: 'never'` non lo
    esclude dalle catture di finestra (provato): resta come doppione in ritardo del puntatore locale.
  - Densità costante: una finestra si apre larga 1 m ogni 1920 px di stream, così testo e cursore hanno la
    stessa misura in tutte le finestre (prima una finestra piccola sul Mac veniva ingrandita).
  - Con più stream attivi la trascrizione rallenta (18 s di audio: 0,8 → 1,7 s; oltre 30 s Whisper fa due
    passate): la codifica VP9 software compete con whisper per CPU/GPU.
  - Il filtro One Euro del puntatore era stato tarato con il guadagno 2× del bug: da ritarare se serve.
  - Le chiusure "inspiegabili" erano click sul ×, allora attaccato alla barra: ora è staccato.

## Prossimi passi
1. Aggancio ai muri e persistenza del layout: una finestra lasciata vicino a un muro vi si appoggia;
   posizioni salvate rispetto a un'ancora persistente per finestra e riconoscimento della finestra per app e
   titolo (gli id del Mac cambiano).
2. Cursore del Mac fuori dallo stream (es. nasconderlo sul Mac mentre si usa il visore), ritaratura del filtro,
   e codifica meno pesante durante la trascrizione.
3. Anteprima prima dell'invio della dettatura, copia/incolla dal visore.
