#!/usr/bin/env bash
# Publica um novo APK no backend (rota /app/versao) pra liberar a
# atualização automática no app. Uso:
#   scripts/publicar-apk.sh <caminho-do-apk> <versionCode> <versionName> ["notas"] [obrigatoria=false]
set -euo pipefail

APK_PATH="$1"
VERSION_CODE="$2"
VERSION_NAME="$3"
NOTAS="${4:-}"
OBRIGATORIA="${5:-false}"

BASE_URL="${APP_API_BASE_URL:-https://brasmaquinas-com-br-estoq-git.ev53yh.easypanel.host}"

if [ -z "${APP_PUBLISH_TOKEN:-}" ]; then
  echo "Defina APP_PUBLISH_TOKEN no ambiente (mesmo valor configurado no EasyPanel)." >&2
  exit 1
fi

curl -sS -X POST "$BASE_URL/app/versao" \
  -H "x-publish-token: $APP_PUBLISH_TOKEN" \
  -F "apk=@${APK_PATH}" \
  -F "versionCode=${VERSION_CODE}" \
  -F "versionName=${VERSION_NAME}" \
  -F "notas=${NOTAS}" \
  -F "obrigatoria=${OBRIGATORIA}"
echo
