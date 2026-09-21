#!/bin/bash
# One-time GCP provisioning for openDAW's Cloud Run deployment. Reuses the same GCP project,
# region, and Workload Identity pool as Mix-O-Tron ("mix-o-tron", us-central1, pool
# "github-actions") — both repos live under the Cognitive-Proof GitHub org. Mirrors the exact
# resources/roles already set up for mixotron-deployer@mix-o-tron.iam.gserviceaccount.com, minus
# roles/secretmanager.secretAccessor (openDAW's static SPA build needs no runtime secrets).
set -euo pipefail

PROJECT_ID="mix-o-tron"
REGION="us-central1"
SERVICE_NAME="opendaw-studio"
AR_REPO="opendaw"
GITHUB_REPO="Cognitive-Proof/openDAW"
SA_NAME="opendaw-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
POOL_ID="github-actions"            # reusing Mix-O-Tron's existing pool
PROVIDER_ID="opendaw-repo"          # new provider, scoped only to Cognitive-Proof/openDAW

gcloud config set project "$PROJECT_ID"

# 1. Artifact Registry repo for openDAW's image (mixotron has its own "mixotron" repo the same way).
gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="openDAW studio container images"

# 2. Deployer service account + roles (matches mixotron-deployer's exact roles minus secret access).
gcloud iam service-accounts create "$SA_NAME" \
    --display-name="openDAW Cloud Run deployer"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/run.admin"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/artifactregistry.writer"

# 3. New WIF provider under the EXISTING github-actions pool, scoped only to this repo — same
#    shape as the pool's existing "mixotron-repo" provider, just for openDAW.
gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_ID" \
    --display-name="openDAW repo" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository=='${GITHUB_REPO}'" \
    --issuer-uri="https://token.actions.githubusercontent.com"

# 4. Let this specific repo impersonate the deployer service account.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPO}"

echo
echo "Set these as repo *variables* (not secrets) in Cognitive-Proof/openDAW -> Settings -> Secrets and variables -> Actions -> Variables:"
echo "GCP_PROJECT_ID      = ${PROJECT_ID}"
echo "REGION              = ${REGION}"
echo "NAME                = ${SERVICE_NAME}"
echo "DOCKER_LOCATION     = ${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
echo "WIF_SERVICE_ACCOUNT = ${SA_EMAIL}"
echo "WIF_PROVIDER        = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
