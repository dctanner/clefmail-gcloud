#!/usr/bin/env bash
set -euo pipefail
: "${PROJECT:?Set PROJECT as for deployment}"
: "${STATE_BUCKET:?Set STATE_BUCKET as for deployment}"
: "${SECRET_BINDINGS:?Use the pinned SECRET_BINDINGS from processor deployment}"
region="${REGION:-us-central1}"
service="${SERVICE:-clefmail-gcloud}"
account="${1:?Pass the configured mailbox ID}"
run="${2:-inbox-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$account" =~ ^[a-z][a-z0-9_-]{0,49}$ && "$run" =~ ^[a-zA-Z0-9_-]{1,100}$ ]] || exit 2
g() { gcloud --project="$PROJECT" run "$@" --region="$region"; }
revision="$(g services describe "$service" --format='value(status.latestReadyRevisionName)')"
image="$(g revisions describe "$revision" --format='value(status.imageDigest)')"
runtime="$(g revisions describe "$revision" --format='value(spec.serviceAccountName)')"
job="${service}-inbox"
g jobs deploy "$job" --image="$image" --service-account="$runtime" --command=node \
  --set-env-vars="CONFIG_PATH=/secrets/config.json,STATE_BUCKET=${STATE_BUCKET}" \
  --set-secrets="$SECRET_BINDINGS" --tasks=1 --parallelism=1 --max-retries=3 --task-timeout=24h --quiet
echo "Processing mailbox $account under run name $run"
g jobs execute "$job" --args="dist/scripts/process-inbox.js,$account,$run" --wait
