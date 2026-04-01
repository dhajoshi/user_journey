This is a multi-layer problem. Let me give you the steps first, then all the code organized by concern, with security and blast radius baked in throughout.

---

## Setup steps — one-time manual bootstrap

These are Azure CLI commands you run **once** to create the identity that GitHub Actions will use. Everything after this is managed by Terraform.

**Step 1 — Create the CI/CD app registration in Entra**

```bash
# Create one app registration per environment (dev and prod get separate identities)
# This limits blast radius: a compromised dev credential can't touch prod Entra resources

az ad app create \
  --display-name "github-actions-entra-tf-dev" \
  --sign-in-audience "AzureADMyOrg"

az ad app create \
  --display-name "github-actions-entra-tf-prod" \
  --sign-in-audience "AzureADMyOrg"

# Note the appId (client_id) from each output — you'll need these
```

**Step 2 — Create service principals for both**

```bash
DEV_APP_ID="<dev-appId-from-step-1>"
PROD_APP_ID="<prod-appId-from-step-1>"

az ad sp create --id $DEV_APP_ID
az ad sp create --id $PROD_APP_ID
```

**Step 3 — Assign Entra API permissions (minimum required)**

```bash
# Application.ReadWrite.OwnedBy — can only modify apps THIS SP created (key blast radius control)
# Group.Create             — can create new groups but NOT modify groups it doesn't own
# GroupMember.ReadWrite.All — can add/remove members to any group
# Application.ReadWrite.OwnedBy does NOT allow touching other teams' apps

GRAPH_API="00000003-0000-0000-c000-000000000000"

APP_RW_OWNEDBY="18a4783c-866b-4cc7-a460-3d5e5662c884"  # Application.ReadWrite.OwnedBy
GROUP_CREATE="bf7b1a76-6e77-406b-b258-bf5c7720e98f"     # Group.Create
GROUPMEMBER_RW="dbaae8cf-10b5-4b86-a4a1-f871c94c6695"   # GroupMember.ReadWrite.All

for APP_ID in $DEV_APP_ID $PROD_APP_ID; do
  az ad app permission add --id $APP_ID \
    --api $GRAPH_API \
    --api-permissions \
      "${APP_RW_OWNEDBY}=Role" \
      "${GROUP_CREATE}=Role" \
      "${GROUPMEMBER_RW}=Role"
done
```

**Step 4 — Grant admin consent**

```bash
TENANT_ID=$(az account show --query tenantId -o tsv)

for APP_ID in $DEV_APP_ID $PROD_APP_ID; do
  az ad app permission admin-consent --id $APP_ID
done
```

**Step 5 — Add federated credentials (GitHub OIDC subjects)**

```bash
# Dev: trusts pushes to main branch and PRs (plan only for PRs via workflow logic)
az ad app federated-credential create \
  --id $DEV_APP_ID \
  --parameters '{
    "name": "github-dev-main",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:YOUR_ORG/YOUR_REPO:environment:dev",
    "description": "GitHub Actions dev environment",
    "audiences": ["api://AzureADTokenExchange"]
  }'

az ad app federated-credential create \
  --id $DEV_APP_ID \
  --parameters '{
    "name": "github-dev-pr",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:YOUR_ORG/YOUR_REPO:pull_request",
    "description": "GitHub Actions PR plan",
    "audiences": ["api://AzureADTokenExchange"]
  }'

# Prod: trusts ONLY the prod environment (requires GitHub environment protection rules)
az ad app federated-credential create \
  --id $PROD_APP_ID \
  --parameters '{
    "name": "github-prod-main",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:YOUR_ORG/YOUR_REPO:environment:prod",
    "description": "GitHub Actions prod environment — requires manual approval",
    "audiences": ["api://AzureADTokenExchange"]
  }'
```

**Step 6 — Create TFE workspaces**

In TFE UI or via API: create two workspaces — `entra-apps-dev` and `entra-apps-prod`. Set **execution mode to Local** on both (so Terraform runs inside GitHub Actions where the OIDC token lives, TFE is used for state only).

**Step 7 — Add GitHub repository secrets and variables**

```bash
# Repository variables (not secrets — these are not sensitive)
# Settings → Secrets and variables → Actions → Variables

AZURE_TENANT_ID        = "<your-tenant-id>"
TFE_ORGANIZATION       = "<your-tfe-org-name>"
TFE_HOSTNAME           = "app.terraform.io"   # or your private TFE hostname

# Environment-specific variables (Settings → Environments → dev/prod → Variables)
# dev environment:
AZURE_CLIENT_ID        = "<dev-appId>"
TFE_WORKSPACE          = "entra-apps-dev"

# prod environment:
AZURE_CLIENT_ID        = "<prod-appId>"
TFE_WORKSPACE          = "entra-apps-prod"

# Repository secret (the only actual secret in this whole setup):
# Settings → Secrets and variables → Actions → Secrets
TFE_TOKEN              = "<tfe-user-or-team-token>"
```

**Step 8 — GitHub environment protection rules**

In GitHub repository Settings → Environments → `prod`:
- Enable "Required reviewers" (add your security team)
- Enable "Restrict deployment to protected branches" → `main` only
- Set a wait timer of 5 minutes (gives time to cancel accidental triggers)

---

## Repository structure

```
.
├── .github/
│   └── workflows/
│       ├── tf-plan.yml          ← runs on every PR
│       └── tf-apply.yml         ← runs on merge to main
│
├── terraform/
│   ├── modules/
│   │   ├── app_registration/    ← creates one Entra app + SP + optional secret
│   │   │   ├── main.tf
│   │   │   ├── variables.tf
│   │   │   └── outputs.tf
│   │   └── security_group/      ← creates one Entra security group
│   │       ├── main.tf
│   │       ├── variables.tf
│   │       └── outputs.tf
│   ├── config/
│   │   ├── apps.yaml            ← teams edit this to onboard apps
│   │   └── groups.yaml          ← platform team owns this
│   ├── backend.tf
│   ├── locals.tf
│   ├── main.tf
│   ├── outputs.tf
│   ├── providers.tf
│   └── variables.tf
│
└── scripts/
    └── bootstrap-entra-wif.sh   ← the Step 1-4 commands above, automated
```

---

## Terraform code

### `terraform/modules/app_registration/variables.tf`

```hcl
variable "app_name" {
  type        = string
  description = "Short app name, e.g. order-service. Becomes the display_name suffix."
  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.app_name))
    error_message = "app_name must be lowercase alphanumeric and hyphens only."
  }
}

variable "environment" {
  type        = string
  description = "Environment: dev, staging, or prod."
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "wif_audience" {
  type        = string
  description = "GCP WIF audience URI, e.g. api://gcp-wif-prod"
}

variable "create_client_secret" {
  type        = bool
  default     = true
  description = "Create a client secret for bootstrap. False if using cert-based auth."
}

variable "secret_rotation_days" {
  type        = number
  default     = 180
  description = "Client secret lifetime in days. Secret is auto-rotated 14 days before expiry."
  validation {
    condition     = var.secret_rotation_days <= 365
    error_message = "secret_rotation_days must be 365 or less (Entra maximum)."
  }
}

variable "additional_owners" {
  type        = list(string)
  default     = []
  description = "Object IDs of additional owners (e.g. team service account). The running SP is always added."
}
```

### `terraform/modules/app_registration/main.tf`

```hcl
data "azuread_client_config" "current" {}

resource "azuread_application" "this" {
  display_name    = "${var.app_name}-${var.environment}"
  sign_in_audience = "AzureADMyOrg"

  # App-specific audience URI for the GCP WIF OIDC token
  identifier_uris = ["${var.wif_audience}/${var.app_name}"]

  # The SP executing this Terraform (github-actions-entra-tf-*) is always an owner.
  # This is what makes Application.ReadWrite.OwnedBy work — it can only touch
  # apps it owns, and it owns every app it creates here.
  owners = distinct(concat(
    [data.azuread_client_config.current.object_id],
    var.additional_owners
  ))

  # Embed metadata in the notes field — no custom attribute API needed
  notes = jsonencode({
    managed_by  = "terraform"
    environment = var.environment
    app_name    = var.app_name
    repo        = "YOUR_ORG/YOUR_REPO"
  })

  lifecycle {
    prevent_destroy = true
    # Owners can be changed manually for emergency access; don't fight that
    ignore_changes  = [owners]
  }
}

resource "azuread_service_principal" "this" {
  client_id                    = azuread_application.this.client_id
  app_role_assignment_required = false
  owners                       = [data.azuread_client_config.current.object_id]

  lifecycle {
    prevent_destroy = true
  }
}

# Rotation anchor — changing this rotates the secret 14 days before expiry
resource "time_rotating" "secret" {
  count         = var.create_client_secret ? 1 : 0
  rotation_days = var.secret_rotation_days - 14
}

resource "azuread_application_password" "this" {
  count          = var.create_client_secret ? 1 : 0
  application_id = azuread_application.this.id
  display_name   = "gcp-wif-bootstrap-${var.environment}"

  # end_date in RFC3339 format, calculated from rotation days
  end_date = timeadd(
    time_rotating.secret[0].id,
    "${var.secret_rotation_days * 24}h"
  )

  # Triggers recreation when the rotation anchor changes
  rotate_when_changed = {
    rotation = time_rotating.secret[0].id
  }

  lifecycle {
    # New secret is created before old one is destroyed (zero downtime rotation)
    create_before_destroy = true
  }
}
```

### `terraform/modules/app_registration/outputs.tf`

```hcl
output "client_id" {
  description = "Entra Application (client) ID — safe to expose, not a secret"
  value       = azuread_application.this.client_id
}

output "object_id" {
  description = "Application object ID"
  value       = azuread_application.this.object_id
}

output "service_principal_object_id" {
  description = "Service principal object ID — used for group membership"
  value       = azuread_service_principal.this.object_id
}

output "display_name" {
  value = azuread_application.this.display_name
}

output "client_secret" {
  description = "Client secret — store this in GCP Secret Manager immediately, never in Terraform state for prod"
  value       = var.create_client_secret ? azuread_application_password.this[0].value : null
  sensitive   = true
}
```

### `terraform/modules/security_group/variables.tf`

```hcl
variable "group_name" {
  type        = string
  description = "Display name, e.g. gcp-bigquery-readers"
  validation {
    condition     = startswith(var.group_name, "gcp-")
    error_message = "All GCP access groups must be prefixed with 'gcp-' for clear ownership."
  }
}

variable "description" {
  type        = string
  description = "Human-readable description of what GCP access this group grants"
}

variable "additional_owners" {
  type        = list(string)
  default     = []
}
```

### `terraform/modules/security_group/main.tf`

```hcl
data "azuread_client_config" "current" {}

resource "azuread_group" "this" {
  display_name            = var.group_name
  security_enabled        = true
  mail_enabled            = false
  description             = var.description
  assignable_to_role      = false  # not used for Azure RBAC, only for Entra group claims

  owners = distinct(concat(
    [data.azuread_client_config.current.object_id],
    var.additional_owners
  ))

  lifecycle {
    prevent_destroy = true
    # Memberships managed by azuread_group_member resources below, not here
    ignore_changes  = [members]
  }
}
```

### `terraform/modules/security_group/outputs.tf`

```hcl
output "object_id" {
  value = azuread_group.this.object_id
}

output "display_name" {
  value = azuread_group.this.display_name
}
```

---

### `terraform/config/groups.yaml`

```yaml
# Platform team owns this file. One group per GCP access pattern.
# Do NOT create a group per application — groups represent roles, not apps.
groups:
  gcp-bigquery-readers:
    description: "Read access to BigQuery datasets and run jobs"
  gcp-gcs-writers:
    description: "Write objects to designated GCS buckets"
  gcp-pubsub-publishers:
    description: "Publish messages to Pub/Sub topics"
  gcp-secret-readers:
    description: "Read secrets from Secret Manager (bootstrap only)"
  gcp-spanner-readers:
    description: "Read from Spanner databases"
```

### `terraform/config/apps.yaml`

```yaml
# Application teams edit this file. Open a PR to onboard a new app.
# groups: list which GCP access patterns this app needs.
# create_client_secret: set false if using certificate-based auth (preferred).
apps:
  order-service:
    team: payments
    create_client_secret: true
    groups:
      - gcp-bigquery-readers
      - gcp-pubsub-publishers

  inventory-api:
    team: logistics
    create_client_secret: true
    groups:
      - gcp-bigquery-readers
      - gcp-gcs-writers

  auth-gateway:
    team: platform
    create_client_secret: false   # uses certificate-based auth
    groups:
      - gcp-secret-readers

  report-generator:
    team: finance
    create_client_secret: true
    groups:
      - gcp-bigquery-readers
      - gcp-gcs-writers
      - gcp-spanner-readers
```

---

### `terraform/providers.tf`

```hcl
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 2.47"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.10"
    }
  }
}

# Authentication uses OIDC when running in GitHub Actions (ARM_USE_OIDC=true is set by the workflow).
# Falls back to az login / env vars for local development.
# No client_secret is ever used — pure OIDC federation.
provider "azuread" {
  tenant_id = var.tenant_id
  client_id = var.client_id
  use_oidc  = true
}

provider "time" {}
```

### `terraform/backend.tf`

```hcl
terraform {
  cloud {
    # organization and workspace are overridden by env vars in CI:
    #   TF_CLOUD_ORGANIZATION  (set in workflow)
    #   TF_WORKSPACE           (set per GitHub environment)
    # Hardcoded values here are fallbacks for local dev only.
    organization = "my-tfe-org"
    hostname     = "app.terraform.io"  # change for private TFE

    workspaces {
      name = "entra-apps-dev"
    }
  }
}
```

### `terraform/variables.tf`

```hcl
variable "tenant_id" {
  type        = string
  description = "Azure AD tenant ID"
}

variable "client_id" {
  type        = string
  description = "Client ID of the GitHub Actions service principal for this environment"
}

variable "environment" {
  type        = string
  description = "Deployment environment: dev, staging, prod"
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging, or prod."
  }
}

variable "wif_audience_base" {
  type        = string
  description = "Base URI for GCP WIF audience, e.g. api://gcp-wif"
  default     = "api://gcp-wif"
}
```

### `terraform/locals.tf`

```hcl
locals {
  groups_config = yamldecode(file("${path.module}/config/groups.yaml"))
  apps_config   = yamldecode(file("${path.module}/config/apps.yaml"))

  wif_audience = "${var.wif_audience_base}-${var.environment}"

  # Flatten app → group memberships into a map keyed by "appname::groupname"
  # This is the join table that drives azuread_group_member resources
  app_group_pairs = {
    for pair in flatten([
      for app_name, app in local.apps_config.apps : [
        for group_name in app.groups : {
          key        = "${app_name}::${group_name}"
          app_name   = app_name
          group_name = group_name
        }
      ]
    ]) : pair.key => pair
  }
}
```

### `terraform/main.tf`

```hcl
# ── Security groups (one per GCP access pattern, ~5-20 total) ─────────────────

module "groups" {
  source = "./modules/security_group"

  for_each    = local.groups_config.groups
  group_name  = each.key
  description = each.value.description
}

# ── App registrations (one per application, ~500 total) ───────────────────────

module "apps" {
  source = "./modules/app_registration"

  for_each = local.apps_config.apps

  app_name             = each.key
  environment          = var.environment
  wif_audience         = local.wif_audience
  create_client_secret = try(each.value.create_client_secret, true)
}

# ── Group memberships — the bridge between apps and GCP access ────────────────
#
# Each membership says: "the service principal for app X is a member of group Y"
# GCP WIF then checks the groups claim in the OIDC token at runtime.
# Adding an app to a GCP service = adding one line to apps.yaml, opening a PR.

resource "azuread_group_member" "memberships" {
  for_each = local.app_group_pairs

  group_object_id  = module.groups[each.value.group_name].object_id
  member_object_id = module.apps[each.value.app_name].service_principal_object_id

  # No lifecycle prevent_destroy here — memberships are intentionally easy to remove
}
```

### `terraform/outputs.tf`

```hcl
# App registration outputs — client_ids are safe to expose (not secrets)
output "app_client_ids" {
  description = "Map of app name to Entra client_id. Use these in your WIF provider config."
  value = {
    for app_name, app_mod in module.apps :
    app_name => app_mod.client_id
  }
}

output "group_object_ids" {
  description = "Map of group name to Entra object_id. Use these in Terraform IAM bindings."
  value = {
    for group_name, group_mod in module.groups :
    group_name => group_mod.object_id
  }
}

# Client secrets are written to TFE state (encrypted at rest).
# Your post-apply step should push these to GCP Secret Manager.
# They are marked sensitive so they never appear in plan output.
output "app_client_secrets" {
  description = "Client secrets for apps that requested one. Push to GCP Secret Manager post-apply."
  sensitive   = true
  value = {
    for app_name, app_mod in module.apps :
    app_name => app_mod.client_secret
    if app_mod.client_secret != null
  }
}
```

---

## GitHub Actions workflows

### `.github/workflows/tf-plan.yml`

```yaml
name: Terraform plan

on:
  pull_request:
    branches: [main]
    paths:
      - "terraform/**"
      - ".github/workflows/tf-*.yml"

permissions:
  contents: read          # checkout
  id-token: write         # GitHub OIDC token for Azure federation
  pull-requests: write    # post plan summary as PR comment

jobs:
  # ── Format and validate (fast, no credentials needed) ────────────────────────
  validate:
    name: Validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "~1.6"
          cli_config_credentials_token: ${{ secrets.TFE_TOKEN }}

      - name: terraform fmt check
        run: terraform fmt -check -recursive
        working-directory: terraform

      - name: terraform validate
        run: |
          terraform init -backend=false
          terraform validate
        working-directory: terraform
        env:
          # Dummy values so validate doesn't fail on variable checks
          TF_VAR_tenant_id: "00000000-0000-0000-0000-000000000000"
          TF_VAR_client_id: "00000000-0000-0000-0000-000000000000"
          TF_VAR_environment: "dev"

  # ── Plan against dev (no approval gate, safe read-only preview) ───────────────
  plan-dev:
    name: Plan — dev
    runs-on: ubuntu-latest
    needs: validate
    environment: dev      # uses AZURE_CLIENT_ID and TFE_WORKSPACE from dev environment

    steps:
      - uses: actions/checkout@v4

      - name: Azure login via OIDC (no secret — federated credential)
        uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          allow-no-subscriptions: true   # Entra-only, no subscription needed

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "~1.6"
          cli_config_credentials_token: ${{ secrets.TFE_TOKEN }}

      - name: terraform init
        run: terraform init
        working-directory: terraform
        env:
          TF_CLOUD_ORGANIZATION: ${{ vars.TFE_ORGANIZATION }}
          TF_WORKSPACE: ${{ vars.TFE_WORKSPACE }}

      - name: terraform plan
        id: plan
        run: terraform plan -no-color -out=tfplan 2>&1 | tee plan_output.txt
        working-directory: terraform
        env:
          TF_CLOUD_ORGANIZATION: ${{ vars.TFE_ORGANIZATION }}
          TF_WORKSPACE: ${{ vars.TFE_WORKSPACE }}
          TF_VAR_tenant_id: ${{ vars.AZURE_TENANT_ID }}
          TF_VAR_client_id: ${{ vars.AZURE_CLIENT_ID }}
          TF_VAR_environment: "dev"
          # These are set by azure/login automatically — azuread provider reads them
          ARM_USE_OIDC: "true"
          ARM_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}
          ARM_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}

      - name: Post plan to PR
        uses: actions/github-script@v7
        if: always()
        with:
          script: |
            const fs = require('fs');
            const plan = fs.readFileSync('terraform/plan_output.txt', 'utf8');
            const truncated = plan.length > 60000
              ? plan.substring(0, 60000) + '\n\n... (truncated, see Actions log for full output)'
              : plan;

            const body = `## Terraform plan — dev

            <details><summary>Show plan</summary>

            \`\`\`hcl
            ${truncated}
            \`\`\`
            </details>

            Workflow: [${context.runId}](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})`;

            // Delete previous plan comments to keep the PR clean
            const comments = await github.rest.issues.listComments({
              owner: context.repo.owner, repo: context.repo.repo, issue_number: context.issue.number
            });
            for (const c of comments.data) {
              if (c.body.startsWith('## Terraform plan — dev')) {
                await github.rest.issues.deleteComment({
                  owner: context.repo.owner, repo: context.repo.repo, comment_id: c.id
                });
              }
            }
            await github.rest.issues.createComment({
              owner: context.repo.owner, repo: context.repo.repo,
              issue_number: context.issue.number, body
            });
```

### `.github/workflows/tf-apply.yml`

```yaml
name: Terraform apply

on:
  push:
    branches: [main]
    paths:
      - "terraform/**"

permissions:
  contents: read
  id-token: write

jobs:
  # ── Apply dev first, automatically ───────────────────────────────────────────
  apply-dev:
    name: Apply — dev
    runs-on: ubuntu-latest
    environment: dev       # GitHub environment — has AZURE_CLIENT_ID, TFE_WORKSPACE

    steps:
      - uses: actions/checkout@v4

      - name: Azure login via OIDC
        uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          allow-no-subscriptions: true

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "~1.6"
          cli_config_credentials_token: ${{ secrets.TFE_TOKEN }}

      - name: terraform init
        run: terraform init
        working-directory: terraform
        env:
          TF_CLOUD_ORGANIZATION: ${{ vars.TFE_ORGANIZATION }}
          TF_WORKSPACE: ${{ vars.TFE_WORKSPACE }}

      - name: terraform apply
        run: terraform apply -auto-approve
        working-directory: terraform
        env:
          TF_CLOUD_ORGANIZATION: ${{ vars.TFE_ORGANIZATION }}
          TF_WORKSPACE: ${{ vars.TFE_WORKSPACE }}
          TF_VAR_tenant_id: ${{ vars.AZURE_TENANT_ID }}
          TF_VAR_client_id: ${{ vars.AZURE_CLIENT_ID }}
          TF_VAR_environment: "dev"
          ARM_USE_OIDC: "true"
          ARM_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}
          ARM_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}

      # Push newly created client secrets to GCP Secret Manager immediately after apply.
      # They are in TF state (encrypted) but we want them off-state as fast as possible.
      - name: Push secrets to GCP Secret Manager
        run: |
          terraform output -json app_client_secrets | \
            python3 ../scripts/push_secrets_to_gcp.py \
              --project=${{ vars.GCP_PROJECT_ID }} \
              --environment=dev
        working-directory: terraform
        env:
          TF_CLOUD_ORGANIZATION: ${{ vars.TFE_ORGANIZATION }}
          TF_WORKSPACE: ${{ vars.TFE_WORKSPACE }}
          GOOGLE_APPLICATION_CREDENTIALS: /tmp/gcp-sa.json

  # ── Apply prod only after manual approval (enforced by GitHub environment) ───
  apply-prod:
    name: Apply — prod
    runs-on: ubuntu-latest
    needs: apply-dev
    environment: prod      # Requires reviewer approval configured in GitHub settings

    steps:
      - uses: actions/checkout@v4

      - name: Azure login via OIDC
        uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}    # prod client ID from prod environment
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          allow-no-subscriptions: true

      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "~1.6"
          cli_config_credentials_token: ${{ secrets.TFE_TOKEN }}

      - name: terraform init
        run: terraform init
        working-directory: terraform
        env:
          TF_CLOUD_ORGANIZATION: ${{ vars.TFE_ORGANIZATION }}
          TF_WORKSPACE: ${{ vars.TFE_WORKSPACE }}    # entra-apps-prod

      - name: terraform plan (safety check before prod apply)
        run: terraform plan -detailed-exitcode
        working-directory: terraform
        env:
          TF_CLOUD_ORGANIZATION: ${{ vars.TFE_ORGANIZATION }}
          TF_WORKSPACE: ${{ vars.TFE_WORKSPACE }}
          TF_VAR_tenant_id: ${{ vars.AZURE_TENANT_ID }}
          TF_VAR_client_id: ${{ vars.AZURE_CLIENT_ID }}
          TF_VAR_environment: "prod"
          ARM_USE_OIDC: "true"
          ARM_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}
          ARM_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}

      - name: terraform apply
        run: terraform apply -auto-approve
        working-directory: terraform
        env:
          TF_CLOUD_ORGANIZATION: ${{ vars.TFE_ORGANIZATION }}
          TF_WORKSPACE: ${{ vars.TFE_WORKSPACE }}
          TF_VAR_tenant_id: ${{ vars.AZURE_TENANT_ID }}
          TF_VAR_client_id: ${{ vars.AZURE_CLIENT_ID }}
          TF_VAR_environment: "prod"
          ARM_USE_OIDC: "true"
          ARM_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}
          ARM_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}

      - name: Push secrets to GCP Secret Manager
        run: |
          terraform output -json app_client_secrets | \
            python3 ../scripts/push_secrets_to_gcp.py \
              --project=${{ vars.GCP_PROJECT_ID }} \
              --environment=prod
        working-directory: terraform
        env:
          TF_CLOUD_ORGANIZATION: ${{ vars.TFE_ORGANIZATION }}
          TF_WORKSPACE: ${{ vars.TFE_WORKSPACE }}
```

### `scripts/push_secrets_to_gcp.py`

```python
#!/usr/bin/env python3
"""
Called after terraform apply to push freshly created Entra client secrets
into GCP Secret Manager. Secrets leave TFE state as fast as possible.

Usage:
  terraform output -json app_client_secrets | \
    python3 push_secrets_to_gcp.py --project=my-project --environment=prod
"""
import argparse
import json
import sys
from google.cloud import secretmanager


def push_secrets(secrets: dict, project: str, environment: str) -> None:
    client = secretmanager.SecretManagerServiceClient()

    for app_name, secret_value in secrets.items():
        if not secret_value:
            continue

        secret_id = f"entra-client-secret-{app_name}-{environment}"
        parent    = f"projects/{project}"
        name      = f"{parent}/secrets/{secret_id}"

        # Create the secret resource if it doesn't exist
        try:
            client.get_secret(request={"name": name})
        except Exception:
            client.create_secret(request={
                "parent": parent,
                "secret_id": secret_id,
                "secret": {
                    "replication": {"automatic": {}},
                    "labels": {
                        "app":         app_name,
                        "environment": environment,
                        "managed-by":  "terraform-pipeline",
                    },
                },
            })

        # Add the new secret version
        client.add_secret_version(request={
            "parent": name,
            "payload": {"data": secret_value.encode()},
        })

        print(f"[ok] {secret_id} updated in Secret Manager")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project",     required=True)
    parser.add_argument("--environment", required=True)
    args = parser.parse_args()

    payload = json.load(sys.stdin)
    push_secrets(payload, args.project, args.environment)
```

---

## Security and blast radius summary

| Concern | How it's addressed |
|---|---|
| Dev breach can't touch prod | Separate Entra SPs per environment; prod federated credential only trusts `environment:prod` GitHub subject |
| Runaway Terraform can't destroy everything | `prevent_destroy = true` on app registrations and groups; requires code change + PR to remove |
| Compromised CI SP can't touch other teams' apps | `Application.ReadWrite.OwnedBy` — SP can only modify apps it created |
| Client secrets visible in state | TFE state is encrypted at rest; secrets pushed to Secret Manager immediately post-apply and marked `sensitive` in Terraform |
| Accidental prod apply on force-push | `apply-prod` job requires human approval via GitHub environment protection rules |
| New app adds more access than intended | Groups claim is evaluated by GCP WIF at token exchange time — wrong group = 403, independent of what's in `apps.yaml` |
| 500 app secrets cross-contamination | Each app has its own Secret Manager secret resource with its own IAM binding; no project-level `secretmanager.secretAccessor` granted |
