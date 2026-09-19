#!/bin/bash
# One-time GCP provisioning for openDAW's Cloud Run deployment, run manually by a human with
# project-owner (or equivalent IAM-admin) access — not run by CI. Reuses the same GCP project and
# region as Mix-O-Tron ("mix-o-tron", us-central1); both repos live under the Cognitive-Proof
# GitHub org.
#
# If Mix-O-Tron already has a deployer service account and/or a Workload Identity pool that trusts
# the whole Cognitive-Proof org (not just its own repo), skip the matching step below and just add
# the binding in step 5 against that existing pool/service account instead of creating new ones.
set -euo pipefail

PROJECT_ID="mix-o-tron"
REGION="us-central1"
SERVICE_NAME="opendaw-studio"
AR_REPO="opendaw"
GITHUB_REPO="Cognitive-Proof/openDAW"
SA_NAME="opendaw-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
POOL_ID="github-pool"
PROVIDER_ID="github-provider"

gcloud config set project "$PROJECT_ID"

# 1. Enable required APIs (idempotent).
gcloud services enable run.googleapis.com artifactregistry.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

# 2. Artifact Registry repo for openDAW's image. Skip and adjust DOCKER_LOCATION below if Mix-O-Tron
#    already has a docker repo you'd rather reuse.
gcloud artifacts repositories create "$AR_REPO" \
    --repository-format=docker \
    --location="$REGION" \
    --description="openDAW studio container images"

# 3. Deployer service account + roles. Skip if reusing Mix-O-Tron's existing deploy service account
#    (then just extend that account's bindings in steps 4-5 with $GITHUB_REPO instead).
gcloud iam service-accounts create "$SA_NAME" \
    --display-name="openDAW Cloud Run deployer"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/run.admin"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/artifactregistry.writer"

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/iam.serviceAccountUser"

# 4. Workload Identity Federation pool + OIDC provider for GitHub Actions. SKIP THIS STEP if
#    Mix-O-Tron's release.yaml already references a WIF_PROVIDER whose attribute-condition trusts
#    the whole Cognitive-Proof org (`assertion.repository_owner == 'Cognitive-Proof'`) rather than
#    just `Cognitive-Proof/mixotron` — in that case reuse that pool/provider id in step 5 directly.
gcloud iam workload-identity-pools create "$POOL_ID" \
    --location="global" \
    --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_ID" \
    --display-name="GitHub OIDC" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository_owner == 'Cognitive-Proof'" \
    --issuer-uri="https://token.actions.githubusercontent.com"

# 5. Let this specific repo impersonate the deployer service account.
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_REPO}"

echo
echo "Set these as repo *variables* (not secrets) in Cognitive-Proof/openDAW → Settings → Secrets and variables → Actions → Variables:"
echo "GCP_PROJECT_ID     = ${PROJECT_ID}"
echo "REGION             = ${REGION}"
echo "NAME               = ${SERVICE_NAME}"
echo "DOCKER_LOCATION    = ${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
echo "WIF_SERVICE_ACCOUNT = ${SA_EMAIL}"
echo "WIF_PROVIDER       = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
