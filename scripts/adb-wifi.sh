#!/bin/sh
# ADB via Wi-Fi: serve una volta il cavo per passare in modalità TCP, poi si può staccare.
# Dopo un riavvio del visore va ripetuto. Uso: scripts/adb-wifi.sh [ip del visore]
set -e
DIR="$(dirname "$0")"
IP="${1:-$("$DIR/adb.sh" -d shell ip -f inet addr show wlan0 | awk '/inet /{sub(/\/.*/,"",$2); print $2}')}"
"$DIR/adb.sh" -d tcpip 5555 >/dev/null 2>&1 || true
sleep 2
"$DIR/adb.sh" connect "$IP:5555"
