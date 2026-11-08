#!/usr/bin/env bash
# Explicit operator-run deployment. Never called by tests or package lifecycle scripts.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT:?Set PROJECT to the OAuth client / Gmail watch Google Cloud project}"
: "${STATE_BUCKET:?Set a globally unique private checkpoint bucket name}"
: "${SECRET_BINDINGS:?Set Cloud Run secret references, not literal secret values; see README}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-clefmail-gcloud}"
[[ "$SERVICE" =~ ^[a-z][a-z0-9-]{0,18}$ ]] || { echo "Invalid SERVICE" >&2; exit 1; }
[[ "$PROJECT" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { echo "Invalid PROJECT" >&2; exit 1; }
[[ "$STATE_BUCKET" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]] || { echo "Invalid STATE_BUCKET" >&2; exit 1; }
# Validate references before making any cloud changes. Never accept literal secrets.
IFS=',' read -ra bindings <<< "$SECRET_BINDINGS"
for binding in "${bindings[@]}"; do
  # Only the application's credential names: never NODE_OPTIONS, PATH, STATE_BUCKET, etc.
  [[ "$binding" =~ ^(/secrets/config\.json|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|CLASSIFIER_API_KEY|OPENAI_API_KEY|GMAIL_[A-Z0-9_]+_REFRESH_TOKEN)=([a-zA-Z0-9_-]+):([1-9][0-9]*)$ ]] ||
    { echo "Use NAME=secret:version or /secrets/config.json=secret:version (numeric versions, known names only)." >&2; exit 1; }
  name="${binding%%=*}"
  [[ ",${seen:-}," != *",${name},"* ]] || { echo "Duplicate secret binding: ${name}" >&2; exit 1; }
  seen="${seen:-}${seen:+,}${name}"
done
[[ ",${seen}," == *,CLASSIFIER_API_KEY,* || ",${seen}," == *,OPENAI_API_KEY,* ]] ||
  { echo "Bind the API key for your configured classifier." >&2; exit 1; }
for required in /secrets/config.json GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET; do
  [[ ",${SECRET_BINDINGS}," == *",${required}="* ]] ||
    { echo "Missing required secret binding: ${required}" >&2; exit 1; }
done
RUNTIME="${SERVICE}-runtime@${PROJECT}.iam.gserviceaccount.com"
INVOKER="${SERVICE}-invoke@${PROJECT}.iam.gserviceaccount.com"
TOPIC="projects/${PROJECT}/topics/${SERVICE}"
SUBSCRIPTION="projects/${PROJECT}/subscriptions/${SERVICE}"
g() { gcloud --project="$PROJECT" "$@"; }

bun run check:full
g services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  pubsub.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com \
  storage.googleapis.com gmail.googleapis.com people.googleapis.com iamcredentials.googleapis.com

for name in "${SERVICE}-runtime" "${SERVICE}-invoke"; do
  g iam service-accounts describe "${name}@${PROJECT}.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    g iam service-accounts create "$name"
done
g storage buckets describe "gs://${STATE_BUCKET}" >/dev/null 2>&1 ||
  g storage buckets create "gs://${STATE_BUCKET}" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
# These restrictions also apply if the dedicated bucket already exists.
g storage buckets update "gs://${STATE_BUCKET}" --uniform-bucket-level-access --public-access-prevention
g storage buckets add-iam-policy-binding "gs://${STATE_BUCKET}" \
  --member="serviceAccount:${RUNTIME}" --role=roles/storage.objectUser

# Grant access only to the explicitly referenced secrets. Pin numeric versions.
for binding in "${bindings[@]}"; do
  secret="${binding#*=}"
  secret="${secret%:*}"
  g secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:${RUNTIME}" --role=roles/secretmanager.secretAccessor
done

for topic in "$SERVICE" "${SERVICE}-dead"; do
  g pubsub topics describe "$topic" >/dev/null 2>&1 || g pubsub topics create "$topic"
done
g pubsub topics add-iam-policy-binding "$SERVICE" \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher

# Internal ingress still admits same-project Pub/Sub push and Cloud Scheduler on the
# run.app URL, while blocking direct internet requests before IAM is even consulted.
g run deploy "$SERVICE" --source=. --region="$REGION" --service-account="$RUNTIME" \
  --no-allow-unauthenticated --ingress=internal --min-instances=0 --max-instances=1 \
  --concurrency=1 --timeout=300 --memory=512Mi --cpu=1 --port=8080 \
  --set-env-vars="SERVICE_MODE=processor,CONFIG_PATH=/secrets/config.json,STATE_BUCKET=${STATE_BUCKET},GMAIL_TOPIC=${TOPIC},PUBSUB_SUBSCRIPTION=${SUBSCRIPTION}" \
  --set-secrets="$SECRET_BINDINGS" --quiet
URL="$(g run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
g run services add-iam-policy-binding "$SERVICE" --region="$REGION" \
  --member="serviceAccount:${INVOKER}" --role=roles/run.invoker

NUMBER="$(g projects describe "$PROJECT" --format='value(projectNumber)')"
PUBSUB_AGENT="service-${NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"
g beta services identity create --service=pubsub.googleapis.com >/dev/null
g iam service-accounts add-iam-policy-binding "$INVOKER" \
  --member="serviceAccount:${PUBSUB_AGENT}" --role=roles/iam.serviceAccountTokenCreator
g pubsub topics add-iam-policy-binding "${SERVICE}-dead" \
  --member="serviceAccount:${PUBSUB_AGENT}" --role=roles/pubsub.publisher

action=create
g pubsub subscriptions describe "$SERVICE" >/dev/null 2>&1 && action=update
topic_args=()
[[ "$action" != create ]] || topic_args+=("--topic=${TOPIC}")
g pubsub subscriptions "$action" "$SERVICE" \
  ${topic_args[@]+"${topic_args[@]}"} \
  --push-endpoint="${URL}/pubsub" --push-auth-service-account="$INVOKER" --push-auth-token-audience="$URL" \
  --ack-deadline=300 --min-retry-delay=10s --max-retry-delay=600s \
  --message-retention-duration=1d --expiration-period=never \
  --dead-letter-topic="projects/${PROJECT}/topics/${SERVICE}-dead" --max-delivery-attempts=5
g pubsub subscriptions add-iam-policy-binding "$SERVICE" \
  --member="serviceAccount:${PUBSUB_AGENT}" --role=roles/pubsub.subscriber
g pubsub subscriptions describe "${SERVICE}-dead" >/dev/null 2>&1 ||
  g pubsub subscriptions create "${SERVICE}-dead" --topic="${SERVICE}-dead" \
    --message-retention-duration=1d --expiration-period=never

action=create
g scheduler jobs describe "${SERVICE}-renew" --location="$REGION" >/dev/null 2>&1 && action=update
g scheduler jobs "$action" http "${SERVICE}-renew" --location="$REGION" \
  --schedule="0 4 * * *" --time-zone=Etc/UTC --uri="${URL}/renew" --http-method=POST \
  --oidc-service-account-email="$INVOKER" --oidc-token-audience="$URL" \
  --attempt-deadline=300s --max-retry-attempts=3

# Initializes first-watch baselines. Existing watches are renewed without moving cursors.
# From this point, new eligible mail is labeled AND may be archived.
g scheduler jobs run "${SERVICE}-renew" --location="$REGION"
printf 'Deployment submitted: %s\nVerify watch_renewed logs and real delivery before claiming success.\n' "$URL"
