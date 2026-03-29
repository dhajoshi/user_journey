Great questions — these are the two most important practical details. Let me address both precisely.

## Part 1: Entra groups — the mental model correction

First, a critical clarification. You do NOT need 500 groups. The groups represent **access patterns**, not applications. Think of it like job roles in a company — you don't create a new "job title" for every employee, you create titles and assign people to them.Good questions — both touch the core of how this scales. Let me address them with diagrams first, then concrete code.

**On groups:** Your assumption is correct — you do have 500 app registrations, one per app. But groups are NOT per-app. They're per "what GCP access pattern do you need." There might only be 15 groups covering all 500 apps.The visualizer is timing out right now, so let me give you everything clearly in text with all the code you need.

---

## Part 1: How groups are created and where they live

Yes — 500 app registrations (one per app), but only ~15 security groups (one per GCP access pattern). The relationship is:

```
500 app registrations ──(member of)──> 15 security groups ──> ~15 GCP service accounts
```

An app registration in Entra has two things: the **application object** (the definition) and the **service principal** (the identity that actually authenticates). The service principal is added as a member of the group.

Here is the complete Terraform for creating groups and wiring memberships, driven by a YAML file your teams edit:

**`groups.yaml`** — the single source of truth for group definitions:

```yaml
groups:
  gcp-bigquery-readers:
    description: "Read BigQuery datasets"
  gcp-gcs-writers:
    description: "Write to GCS buckets"
  gcp-pubsub-publishers:
    description: "Publish to Pub/Sub"
  gcp-secret-readers:
    description: "Read Secret Manager secrets"
```

**`apps.yaml`** — teams declare which groups their app needs:

```yaml
apps:
  order-service:
    entra_client_id: "aaa-bbb-ccc-111"      # from Entra app registration
    groups:
      - gcp-bigquery-readers
      - gcp-pubsub-publishers

  inventory-api:
    entra_client_id: "aaa-bbb-ccc-222"
    groups:
      - gcp-bigquery-readers
      - gcp-gcs-writers

  auth-gateway:
    entra_client_id: "aaa-bbb-ccc-333"
    groups:
      - gcp-secret-readers
```

**`entra_groups.tf`** — Terraform using the `azuread` provider:

```hcl
# Read the YAML files as data sources
locals {
  groups_config = yamldecode(file("${path.module}/groups.yaml"))
  apps_config   = yamldecode(file("${path.module}/apps.yaml"))
}

# ----- CREATE GROUPS (once, ~15 resources total) -----
resource "azuread_group" "gcp_groups" {
  for_each = local.groups_config.groups

  display_name     = each.key
  security_enabled = true
  mail_enabled     = false
  description      = each.value.description

  # Prevent accidental deletion of groups that have 500+ members
  lifecycle {
    prevent_destroy = true
  }
}

# ----- CREATE APP REGISTRATIONS (one per app, ~500 resources) -----
resource "azuread_application" "apps" {
  for_each     = local.apps_config.apps
  display_name = each.key

  # Audience for GCP WIF token exchange
  identifier_uris = ["api://gcp-wif-prod-${each.key}"]
}

resource "azuread_service_principal" "apps" {
  for_each   = local.apps_config.apps
  client_id  = azuread_application.apps[each.key].client_id
}

# ----- ADD MEMBERS TO GROUPS (flat map of all app→group pairs) -----
locals {
  # Flatten: [{app: "order-service", group: "gcp-bigquery-readers"}, ...]
  app_group_memberships = flatten([
    for app_name, app in local.apps_config.apps : [
      for group_name in app.groups : {
        key        = "${app_name}::${group_name}"
        app_name   = app_name
        group_name = group_name
      }
    ]
  ])
}

resource "azuread_group_member" "memberships" {
  for_each = { for m in local.app_group_memberships : m.key => m }

  group_object_id  = azuread_group.gcp_groups[each.value.group_name].object_id
  member_object_id = azuread_service_principal.apps[each.value.app_name].object_id
}
```

**What happens when a new app onboards:** A developer adds 3–5 lines to `apps.yaml`, opens a PR, GitHub Actions runs `terraform plan` in TFE, you see the exact new `azuread_group_member` resources, you approve, done. No Entra portal clicking, no GCP console touching.

**The groups claim in the token:** Entra automatically includes the group Object IDs in every token issued for a service principal that belongs to those groups. The `attribute_mapping` in GCP WIF maps that claim:

```hcl
attribute_mapping = {
  "google.subject"   = "assertion.sub"
  "attribute.app_id" = "assertion.appid"     # the app's client_id
  "attribute.groups" = "assertion.groups"    # array of group Object IDs
}
```

---

## Part 2: Bootstrap isolation — how App1 cannot access App2's secret

This is the most important security question. The isolation has **two independent enforcement layers** — breaking either one alone is not enough to achieve a breach.

**Layer 1 — WIF attribute condition (who can impersonate which bootstrap SA)**

The WIF IAM binding for each bootstrap SA is tied to ONE specific Entra `client_id` via `attribute.app_id`:

```hcl
# sa-bootstrap-order-service can ONLY be impersonated by the order-service app
resource "google_service_account_iam_binding" "bootstrap_wif" {
  for_each           = local.apps_config.apps
  service_account_id = google_service_account.bootstrap[each.key].name
  role               = "roles/iam.workloadIdentityUser"

  members = [
    # Uses the specific app's Entra client_id — not a group OID, not a wildcard
    "principalSet://iam.googleapis.com/${var.wif_pool_name}/attribute.app_id/${each.value.entra_client_id}"
  ]
}
```

App1 has `client_id = AAA-111`. App2 has `client_id = BBB-222`. If App1 tries to impersonate `sa-bootstrap-app2`, the WIF pool checks: does this token have `appid == BBB-222`? App1's token has `appid == AAA-111`. **Rejected at the STS exchange step.**

**Layer 2 — Secret Manager resource-level IAM (which secret each bootstrap SA can read)**

This is the key distinction: the IAM binding is on the **secret resource**, NOT on the **project**. These are completely different GCP resources:

```hcl
# SECRET-LEVEL binding (correct — locks down to one secret)
resource "google_secret_manager_secret_iam_binding" "bootstrap_access" {
  for_each  = local.apps_config.apps
  project   = var.project_id
  secret_id = google_secret_manager_secret.entra_secret[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"

  members = [
    "serviceAccount:${google_service_account.bootstrap[each.key].email}"
  ]
}

# This creates bindings like:
# entra-secret-order-service  → sa-bootstrap-order-service can read
# entra-secret-inventory-api  → sa-bootstrap-inventory-api can read
# (no cross-access possible at GCP IAM level)
```

Compare this to what you must NEVER do:

```hcl
# PROJECT-LEVEL binding (WRONG — gives access to ALL secrets in the project)
resource "google_project_iam_binding" "bootstrap_access_WRONG" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  members = ["serviceAccount:sa-bootstrap-order-service@..."]
  # sa-bootstrap-order-service can now read EVERY secret in the project!
}
```

---

## Complete Python bootstrap example

Here is the full, production-ready bootstrap with both layers of isolation clearly visible:

```python
"""
bootstrap.py  —  secure startup sequence for any on-prem app

Two-phase bootstrap:
  Phase 1: Use CERTIFICATE-BASED bootstrap WIF credential (no secret needed)
            to read THIS APP'S secret from Secret Manager
  Phase 2: Use the retrieved Entra secret to get OIDC tokens for
            all subsequent GCP API calls via the main WIF credential

Isolation guarantees (enforced by GCP IAM, not by this code):
  - sa-bootstrap-order-service  →  can only read  entra-secret-order-service
  - sa-bootstrap-inventory-api  →  can only read  entra-secret-inventory-api
  Even if you change APP_NAME env var, the WIF appid binding stops you
  impersonating another app's bootstrap SA.
"""

import os
import stat
import requests
from pathlib import Path


APP_NAME   = os.environ["APP_NAME"]         # e.g. "order-service" set by deployment
PROJECT_ID = os.environ["GCP_PROJECT_ID"]
TENANT_ID  = os.environ["AZURE_TENANT_ID"]
CLIENT_ID  = os.environ["AZURE_CLIENT_ID"]  # This app's Entra client_id (not secret)
AUDIENCE   = os.environ.get("WIF_AUDIENCE", "api://gcp-wif-prod")


# ── PHASE 1: Read this app's Entra secret from Secret Manager ─────────────────

def fetch_entra_secret_from_secret_manager() -> str:
    """
    Uses the BOOTSTRAP WIF credential (certificate-based, points to
    sa-bootstrap-{APP_NAME}). That SA has resource-level IAM on ONE secret only:
      entra-client-secret-{APP_NAME}

    If APP_NAME is "order-service", this SA literally cannot call
    GetSecretVersion on "entra-client-secret-inventory-api" — GCP returns
    PERMISSION_DENIED before the request is even processed.
    """
    # Switch to the bootstrap credential (cert-based, no Entra secret needed)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/etc/gcp/wif-bootstrap.json"

    from google.cloud import secretmanager
    client = secretmanager.SecretManagerServiceClient()

    # Secret name is parameterised by APP_NAME — each app reads its own secret
    secret_resource = (
        f"projects/{PROJECT_ID}/secrets/"
        f"entra-client-secret-{APP_NAME}/versions/latest"
    )

    try:
        response = client.access_secret_version(request={"name": secret_resource})
    except Exception as e:
        # If this fails, it means either:
        #   a) the secret doesn't exist (provisioning error)
        #   b) the bootstrap SA doesn't have IAM on this secret (config error)
        #   c) the WIF token exchange failed (cert expired or appid mismatch)
        raise RuntimeError(
            f"Bootstrap failed for app '{APP_NAME}'. "
            f"Ensure sa-bootstrap-{APP_NAME} has IAM on "
            f"entra-client-secret-{APP_NAME}."
        ) from e

    return response.payload.data.decode("utf-8")


# ── PHASE 2: Store the secret securely in tmpfs ───────────────────────────────

def store_secret_in_tmpfs(secret_value: str) -> Path:
    """
    Stores the Entra client secret in /run/secrets/ (tmpfs on most Linux systems —
    not persisted to disk). Permissions set to 0o600 (owner read/write only).

    NOT stored in environment variables — those are visible via /proc/{pid}/environ
    to any process running as the same user.
    """
    secret_dir = Path("/run/secrets")
    secret_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    secret_file = secret_dir / f"entra-{APP_NAME}"
    secret_file.write_text(secret_value)
    secret_file.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0o600 — owner only

    return secret_file


# ── PHASE 3: Get Entra OIDC token using the retrieved secret ──────────────────

def get_entra_oidc_token(secret_file: Path) -> str:
    """
    Called by the get-entra-token executable at runtime (also used here to
    smoke-test the secret during bootstrap).

    Each app gets a token with:
      - appid: this app's CLIENT_ID (unique per app)
      - groups: the Entra group OIDs this app belongs to
      - iss: Entra issuer URL for your tenant
    """
    client_secret = secret_file.read_text().strip()

    resp = requests.post(
        f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token",
        data={
            "grant_type":    "client_credentials",
            "client_id":     CLIENT_ID,
            "client_secret": client_secret,
            "scope":         f"{AUDIENCE}/.default",
        },
        timeout=5,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


# ── PHASE 4: Activate main credential for GCP API calls ──────────────────────

def activate_main_wif_credential(secret_file: Path) -> None:
    """
    The main WIF credential JSON (wif-main.json) calls the token fetcher
    executable whenever google-auth needs a fresh OIDC token. The executable
    reads the secret from the tmpfs file.

    The main WIF credential points to the group-based service accounts
    (not the bootstrap SA), so all GCP API calls use the right identity.
    """
    # Tell the token fetcher where to find the secret
    os.environ["ENTRA_SECRET_FILE"] = str(secret_file)

    # Switch to the MAIN WIF credential for all subsequent GCP calls
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/etc/gcp/wif-main.json"


# ── Full bootstrap sequence ───────────────────────────────────────────────────

def bootstrap() -> None:
    print(f"[bootstrap] app={APP_NAME} starting...")

    secret_value = fetch_entra_secret_from_secret_manager()
    print("[bootstrap] Phase 1 ✓ — Entra secret retrieved from Secret Manager")

    secret_file = store_secret_in_tmpfs(secret_value)
    del secret_value  # Wipe from memory immediately — only on disk now
    print(f"[bootstrap] Phase 2 ✓ — Secret stored in {secret_file} (mode 0600)")

    # Smoke-test: verify the secret works before the app starts handling traffic
    token = get_entra_oidc_token(secret_file)
    print(f"[bootstrap] Phase 3 ✓ — OIDC token obtained ({len(token)} chars)")
    del token  # Not needed; google-auth will fetch on demand

    activate_main_wif_credential(secret_file)
    print("[bootstrap] Phase 4 ✓ — Main WIF credential active")

    print("[bootstrap] Ready. GCP clients will use wif-main.json for all API calls.")
```

And the companion token fetcher script that the main WIF credential JSON calls at runtime:

```python
#!/usr/bin/env python3
"""
/usr/local/bin/get-entra-token
Called by google-auth every ~55 minutes to refresh the OIDC token.
Reads the Entra secret from tmpfs (written during bootstrap, never in env vars).
Output must be JSON to stdout per the google-auth executable spec.
"""
import json, os, sys, requests

TENANT_ID  = os.environ["AZURE_TENANT_ID"]
CLIENT_ID  = os.environ["AZURE_CLIENT_ID"]
AUDIENCE   = os.environ.get("WIF_AUDIENCE", "api://gcp-wif-prod")

# Secret is in tmpfs, not in an env var
secret_file = os.environ["ENTRA_SECRET_FILE"]

try:
    client_secret = open(secret_file).read().strip()

    resp = requests.post(
        f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token",
        data={
            "grant_type":    "client_credentials",
            "client_id":     CLIENT_ID,
            "client_secret": client_secret,
            "scope":         f"{AUDIENCE}/.default",
        },
        timeout=5,
    )
    resp.raise_for_status()

    print(json.dumps({
        "version":    1,
        "success":    True,
        "token_type": "urn:ietf:params:oauth:token-type:id_token",
        "id_token":   resp.json()["access_token"],
    }))

except Exception as e:
    print(json.dumps({"version": 1, "success": False, "code": 1, "message": str(e)}))
    sys.exit(1)
```

And normal GCP client usage after bootstrap — the app developer writes none of the above, they just use clients normally:

```python
# main.py — the actual application, after bootstrap() is called at startup

from bootstrap import bootstrap
from google.cloud import bigquery, storage, pubsub_v1

if __name__ == "__main__":
    bootstrap()  # One call, does everything

    # From this point on, all GCP clients work transparently.
    # No credentials in the application code.

    bq = bigquery.Client()
    rows = bq.query("SELECT * FROM `dataset.table` LIMIT 10").result()
    for row in rows:
        print(dict(row))

    # Works for any GCP service the app's Entra groups grant access to
    storage_client = storage.Client()
    blob = storage_client.bucket("my-bucket").blob("output.json")
    blob.upload_from_string('{"result": "ok"}')
```

---

## What prevents App1 from reading App2's secret — in plain English

When App1 runs and tries to impersonate `sa-bootstrap-inventory-api` to read `entra-secret-inventory-api`, two walls stop it:

**Wall 1 — at the WIF token exchange.** App1's OIDC token contains `appid = APP1_CLIENT_ID`. The WIF IAM binding for `sa-bootstrap-inventory-api` says `attribute.app_id == APP2_CLIENT_ID`. These don't match. GCP STS returns a 403 before ever issuing a GCP access token. App1 cannot impersonate that SA.

**Wall 2 — at Secret Manager (even if Wall 1 somehow failed).** `sa-bootstrap-order-service` is only listed in the IAM policy of `entra-secret-order-service`, not `entra-secret-inventory-api`. A `GetSecretVersion` call on the wrong secret returns `PERMISSION_DENIED` from Secret Manager directly. The IAM check at the resource level is completely independent of WIF.

Both walls are enforced by GCP IAM infrastructure, not by your application code. Your application code cannot bypass them regardless of what it does.
