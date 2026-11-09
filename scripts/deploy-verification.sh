#!/usr/bin/env bash
# Explicit opt-in public service; NEVER change the private processor's IAM/ingress.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT:?Set PROJECT}"
: "${STATE_BUCKET:?Use the same private bucket as the processor}"
: "${VERIFICATION_SECRET_BINDINGS:?Set pinned Secret Manager references; see README}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-clefmail-gcloud}"
[[ "$SERVICE" =~ ^[a-z][a-z0-9-]{0,18}$ ]] || { echo "Invalid SERVICE" >&2; exit 1; }
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo "Invalid PROJECT" >&2; exit 1; }
[[ "$STATE_BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]] || { echo "Invalid STATE_BUCKET" >&2; exit 1; }
PUBLIC_SERVICE="${SERVICE}-verify"
RUNTIME="${SERVICE}-verify@${PROJECT}.iam.gserviceaccount.com"
IFS=',' read -ra bindings <<< "$VERIFICATION_SECRET_BINDINGS"
for binding in "${bindings[@]}"; do
  [[ "$binding" =~ ^(/secrets/config\.json|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|TURNSTILE_SECRET_KEY|PLATFORMER_SECRET|GMAIL_[A-Z0-9_]+_REFRESH_TOKEN)=([a-zA-Z0-9_-]+):([1-9][0-9]*)$ ]] ||
    { echo "Use known NAME=secret:numeric-version bindings only." >&2; exit 1; }
  name="${binding%%=*}"
  [[ ",${seen:-}," != *",${name},"* ]] || { echo "Duplicate secret binding" >&2; exit 1; }
  seen="${seen:-}${seen:+,}${name}"
done
[[ ",${seen}," == *,TURNSTILE_SECRET_KEY,* || ",${seen}," == *,PLATFORMER_SECRET,* ]] ||
  { echo "Bind the secret for your chosen captcha." >&2; exit 1; }
for required in /secrets/config.json GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  [[ ",${VERIFICATION_SECRET_BINDINGS}," == *",${required}="* ]] ||
    { echo "Missing required secret binding: ${required}" >&2; exit 1; }
done
g() { gcloud --project="$PROJECT" "$@"; }
bun run check:full
g services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  storage.googleapis.com gmail.googleapis.com people.googleapis.com secretmanager.googleapis.com
g storage buckets describe "gs://${STATE_BUCKET}" >/dev/null
g iam service-accounts describe "$RUNTIME" >/dev/null 2>&1 ||
  g iam service-accounts create "${SERVICE}-verify"
g storage buckets add-iam-policy-binding "gs://${STATE_BUCKET}" \
  --member="serviceAccount:${RUNTIME}" --role=roles/storage.objectUser
for binding in "${bindings[@]}"; do
  secret="${binding#*=}"; secret="${secret%:*}"
  g secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUNTIME}" --role=roles/secretmanager.secretAccessor
done
g run deploy "$PUBLIC_SERVICE" --source=. --region="$REGION" --service-account="$RUNTIME" \
  --allow-unauthenticated --ingress=all --min-instances=0 --max-instances=1 \
  --concurrency=1 --timeout=300 --memory=512Mi --cpu=1 --port=8080 \
  --set-env-vars="SERVICE_MODE=verification,CONFIG_PATH=/secrets/config.json,STATE_BUCKET=${STATE_BUCKET}" \
  --set-secrets="$VERIFICATION_SECRET_BINDINGS" --quiet
URL="$(g run services describe "$PUBLIC_SERVICE" --region="$REGION" --format='value(status.url)')"
printf 'Public verification service submitted: %s/verify\n' "$URL"
printf 'Set verification.publicUrl to this HTTPS origin (or your mapped domain), configure your chosen captcha, and redeploy both configs before enabling humanVerification. Verify /pubsub and /renew return 404 here; keep the processor private.\n'
