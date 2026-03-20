#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_DIR="${ROOT_DIR}/public"
HOST="${HOST:-0.0.0.0}"
PORT="${1:-8080}"

die() {
  echo "Errore: $1" >&2
  exit 1
}

if ! [[ "${PORT}" =~ ^[0-9]+$ ]]; then
  die "Porta non valida: ${PORT}"
fi

if ((PORT < 1 || PORT > 65535)); then
  die "Porta fuori range: ${PORT}"
fi

command -v python3 >/dev/null 2>&1 || die "python3 non trovato"

[[ -f "${PUBLIC_DIR}/esp32_flash.html" ]] || die "File mancante: ${PUBLIC_DIR}/esp32_flash.html"

if [[ ! -f "${PUBLIC_DIR}/esp32/manifest.json" ]]; then
  echo "Attenzione: manifest non trovato."
  echo "Esegui prima: ${ROOT_DIR}/build_esp32_firmware.sh"
fi

cd "${PUBLIC_DIR}"
echo "Flasher ESP32 online:"
echo "  URL: http://localhost:${PORT}/esp32_flash.html"
echo "  Stop: CTRL+C"
exec python3 -m http.server "${PORT}" --bind "${HOST}"
