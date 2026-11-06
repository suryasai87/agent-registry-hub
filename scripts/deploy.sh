#!/usr/bin/env bash
# Build → bundle deploy → setup job (migrations + grants) → start the app → first sync → verify.
#   ./scripts/deploy.sh [target] [profile] [extra bundle args...]
#   ./scripts/deploy.sh demo DEFAULT
#   ./scripts/deploy.sh new_workspace MYPROFILE --var warehouse_id=abc123
# Flags (env): CODE_ONLY=1 skips the setup job and the first sync (app code changes only).
#              STAGE_ONLY=1 stages a new version (bundle deploy, no app restart). Platform Watch then detects the
#              newer VERSION, regression-tests it on a Lakebase branch, and an admin accepts or delays it in the app.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-demo}"; PROFILE="${2:-DEFAULT}"; shift $(( $# > 2 ? 2 : $# )) || true
EXTRA=("$@")
B=(databricks bundle --target "$TARGET" --profile "$PROFILE")
APP_NAME="$(python3 -c "import re,sys;t=open('databricks.yml').read();m=re.search(r'app_name:\n(?:.*\n)*?\s+default:\s*(\S+)',t);print(m.group(1))")"
for a in "${EXTRA[@]:-}"; do [[ "$a" == app_name=* ]] && APP_NAME="${a#app_name=}"; done

echo "▸ 1/6 build frontend (npm proxy registry from frontend/.npmrc)"
( cd frontend && npm ci --no-audit --no-fund && npm run build )
test -f app/static/index.html || { echo "frontend build missing"; exit 1; }

echo "▸ 2/6 validate + deploy bundle ($TARGET)"
"${B[@]}" validate ${EXTRA[@]+"${EXTRA[@]}"}
"${B[@]}" deploy ${EXTRA[@]+"${EXTRA[@]}"}

if [[ "${STAGE_ONLY:-0}" == "1" ]]; then
  echo "▸ staged $(cat VERSION). Starting Platform Watch so the update is regression-tested and offered in the app"
  "${B[@]}" run registry_updates --no-wait ${EXTRA[@]+"${EXTRA[@]}"} || true
  echo "✓ staged; review it under Platform updates in the app (accept or delay)"
  exit 0
fi

if [[ "${CODE_ONLY:-0}" != "1" ]]; then
  echo "▸ 3/6 setup job: migrations, app SP Lakebase role, least-privilege grants"
  "${B[@]}" run registry_setup ${EXTRA[@]+"${EXTRA[@]}"}
fi

echo "▸ 4/6 deploy + start the app"
"${B[@]}" run registry_app ${EXTRA[@]+"${EXTRA[@]}"} || echo "  (bundle run's status poll can time out while the deployment still succeeds; verifying below)"

if [[ "${CODE_ONLY:-0}" != "1" ]]; then
  echo "▸ 5/6 first sync (hydrates Lakebase; the job then runs hourly)"
  "${B[@]}" run registry_sync --no-wait ${EXTRA[@]+"${EXTRA[@]}"} || true
fi

echo "▸ 6/6 verify RUNNING + HTTP 200"
for i in $(seq 1 40); do
  STATE="$(databricks apps get "$APP_NAME" --profile "$PROFILE" -o json | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("compute_status",{}).get("state"),(d.get("active_deployment") or {}).get("status",{}).get("state"),d.get("url"))')"
  read -r COMPUTE DEPLOY URL <<<"$STATE"
  [[ "$COMPUTE" == "ACTIVE" && "$DEPLOY" == "SUCCEEDED" ]] && break
  sleep 15
done
TOKEN="$(databricks auth token --profile "$PROFILE" | python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])')"
for path in / /api/health /api/me /api/catalog?page_size=1; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$URL$path")"
  echo "  $CODE  $URL$path"
  [[ "$CODE" == "200" ]] || { echo "✗ $path returned $CODE (on 502: databricks apps logs $APP_NAME --profile $PROFILE)"; exit 1; }
done
echo "✓ $APP_NAME is RUNNING at $URL"
