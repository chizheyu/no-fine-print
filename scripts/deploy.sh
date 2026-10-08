#!/usr/bin/env bash
# Deploy No Fine Print to Google Cloud: Cloud Run service + nightly scan job + Firestore + Vertex AI.
# Usage: PROJECT_ID=my-project ./scripts/deploy.sh   (after `gcloud auth login`; billing must be enabled)
set -euo pipefail
: "${PROJECT_ID:?set PROJECT_ID}"
REGION="${REGION:-asia-southeast1}"
SA_NAME=nfp-run
SA="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID" >/dev/null
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com firestore.googleapis.com cloudscheduler.googleapis.com

gcloud firestore databases describe --database='(default)' >/dev/null 2>&1 || \
  gcloud firestore databases create --location="$REGION" --type=firestore-native

gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create "$SA_NAME" --display-name "No Fine Print (Cloud Run)"
# A new service account takes a few seconds to become visible to IAM; retry instead of failing.
for role in roles/aiplatform.user roles/datastore.user; do
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$SA" --role "$role" --condition=None >/dev/null 2>&1 && break
    [ "$attempt" = 12 ] && { echo "Could not grant $role to $SA" >&2; exit 1; }
    sleep 10
  done
done

ENV_VARS="GOOGLE_GENAI_USE_VERTEXAI=true,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,GOOGLE_CLOUD_LOCATION=global,STORE=firestore${GEMINI_MODEL:+,GEMINI_MODEL=$GEMINI_MODEL}"

gcloud run deploy no-fine-print --source . --region "$REGION" --service-account "$SA" \
  --allow-unauthenticated --memory 512Mi --max-instances 3 --set-env-vars "$ENV_VARS"

gcloud run jobs deploy nfp-scan --source . --region "$REGION" --service-account "$SA" \
  --command node --args jobs/scan.js --task-timeout 900 --set-env-vars "$ENV_VARS"

gcloud run jobs add-iam-policy-binding nfp-scan --region "$REGION" --member "serviceAccount:$SA" --role roles/run.invoker >/dev/null
gcloud scheduler jobs describe nfp-scan-nightly --location "$REGION" >/dev/null 2>&1 || \
  gcloud scheduler jobs create http nfp-scan-nightly --location "$REGION" \
    --schedule "30 2 * * *" --time-zone "Asia/Singapore" --http-method POST \
    --uri "https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/nfp-scan:run" \
    --oauth-service-account-email "$SA"

echo "Service URL: $(gcloud run services describe no-fine-print --region "$REGION" --format='value(status.url)')"
