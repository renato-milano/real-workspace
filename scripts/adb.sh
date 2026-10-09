#!/bin/sh
# Un solo ADB per tutto il progetto: quello di Meta Quest Developer Hub (o QW_ADB / adb nel PATH).
# Mescolare l'ADB integrato di metavr con un server adb classico fa perdere il visore a uno dei due
# (stream fermo, "no devices"), anche col cavo collegato.
# Se il visore è connesso via Wi-Fi (scripts/adb-wifi.sh) si usa quello: il cavo cade quando ci si muove
# per la stanza, e adb reverse funziona allo stesso modo anche senza cavo.
ADB="${QW_ADB:-/Applications/Meta Quest Developer Hub.app/Contents/Resources/bin/adb}"
[ -x "$ADB" ] || ADB=adb
SERIAL="${QW_QUEST:-$("$ADB" devices | awk '$2=="device" && $1 ~ /:5555$/ {print $1; exit}')}"
case "$1" in
  devices|connect|disconnect|kill-server|start-server|tcpip|-*) exec "$ADB" "$@" ;;
esac
[ -n "$SERIAL" ] && exec "$ADB" -s "$SERIAL" "$@"
exec "$ADB" "$@"
