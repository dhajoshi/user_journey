This is a comprehensive design challenge. Let me lay out the full architecture first, then show the design visually, and finally give you the Python implementation.

The core design philosophy here is **scale without sprawl** — with 500+ apps, you cannot manage 500 individual workload identity pools or service accounts manually. The key insight is to use a **hierarchical, attribute-based model**: one WIF pool per environment, Entra groups as the access boundary, and Terraform to automate everything.

Here's how the layers stack up:

**Identity layer** — Microsoft Entra issues OIDC tokens per application (via app registrations or managed identities). Each app gets a token with claims like `appid`, `groups`, and custom attributes. These claims become the trust conditions in GCP.

**Federation layer** — A small number of Workload Identity Pools (one per environment: dev/staging/prod) each with one Entra OIDC provider. You use **attribute conditions** on pool providers to map Entra claims to GCP attributes — this is what lets you avoid 500 individual configurations.

**Authorization layer** — GCP service accounts are bound to pools via IAM, and the bindings use `attribute.group == "gcp-sa-bigquery-readers"` style conditions. You group apps by their GCP access needs, not one-to-one.

**Automation layer** — Terraform Enterprise manages all WIF pools, providers, service accounts, and IAM bindings as code, with GitHub Actions triggering plans on PRs. New apps onboard by adding a Terraform variable entry — no manual GCP console work.Now let me walk through each layer in detail.

---

## Layer 1 — Entra identity model (the foundation)

Every on-prem application gets an **Entra app registration** (or uses the machine's managed identity if it's on Azure Arc). The critical design decision here is that you don't create 500 individual trust configurations in GCP — you use **Entra security groups** to represent access roles, and those groups flow as claims inside every OIDC token.

The group-to-GCP-access mapping looks like this:

| Entra group | What it means | GCP binding |
|---|---|---|
| `gcp-bigquery-readers` | Apps that need BQ read access | `roles/bigquery.dataViewer` on SA |
| `gcp-gcs-writers` | Apps writing to GCS buckets | `roles/storage.objectCreator` on SA |
| `gcp-pubsub-publishers` | Apps publishing to Pub/Sub | `roles/pubsub.publisher` on SA |
| `gcp-secret-readers` | Apps reading secrets | `roles/secretmanager.secretAccessor` on SA |

An app can be in multiple groups. Adding an app to a GCP service just means adding it to the right Entra group — no GCP console touch needed.

---

## Layer 2 — GCP Workload Identity Federation design

You create **one WIF pool per environment**, not one per application. Inside each pool, one OIDC provider points at Entra's OIDC discovery endpoint.

The **attribute mapping** on the provider is where the magic lives:

```hcl
attribute_mapping = {
  "google.subject"        = "assertion.sub"           # unique app identity
  "attribute.app_id"      = "assertion.appid"         # Entra app registration ID
  "attribute.groups"      = "assertion.groups"        # array of group object IDs
  "attribute.environment" = "assertion.tid"           # can be extended
}
```

The **attribute condition** on the provider acts as a perimeter — only tokens from your tenant, with the right audience, are accepted:

```
assertion.iss == "https://login.microsoftonline.com/<TENANT_ID>/v2.0" &&
assertion.aud == "api://gcp-wif-<ENV>"
```

Service accounts are then bound using a CEL condition:

```
attribute.groups.exists(g, g == "<GROUP_OBJECT_ID>")
```

This means any app in that Entra group can impersonate that service account — automatically, without any individual app configuration in GCP.

---

## Layer 3 — Terraform automation design

This is where 500-app scale becomes manageable. The structure:Here's the concrete Terraform code for this structure:

**`modules/wif-pool/main.tf`** — the pool module, called once per environment:

```hcl
variable "env"          {}
variable "project_id"   {}
variable "tenant_id"    {}
variable "wif_audience" {}  # e.g. "api://gcp-wif-prod"

resource "google_iam_workload_identity_pool" "main" {
  project                   = var.project_id
  workload_identity_pool_id = "entra-${var.env}"
  display_name              = "Entra WIF ${var.env}"
}

resource "google_iam_workload_identity_pool_provider" "entra" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.main.workload_identity_pool_id
  workload_identity_pool_provider_id = "entra-oidc"
  display_name                       = "Microsoft Entra OIDC"

  oidc {
    issuer_uri        = "https://login.microsoftonline.com/${var.tenant_id}/v2.0"
    allowed_audiences = [var.wif_audience]
  }

  attribute_mapping = {
    "google.subject"   = "assertion.sub"
    "attribute.app_id" = "assertion.appid"
    "attribute.groups" = "assertion.groups"  # Entra group OIDs as array claim
    "attribute.tid"    = "assertion.tid"
  }

  attribute_condition = <<-EOT
    assertion.iss == "https://login.microsoftonline.com/${var.tenant_id}/v2.0" &&
    "${var.wif_audience}" in assertion.aud
  EOT
}

output "pool_name" {
  value = google_iam_workload_identity_pool.main.name
}
```

**`modules/iam-bindings/main.tf`** — the heart of the group-to-SA mapping:

```hcl
variable "project_id"    {}
variable "pool_name"     {}
variable "access_groups" {
  type = list(object({
    group_object_id = string   # Entra group OID
    sa_email        = string   # GCP service account
    gcp_roles       = list(string)
  }))
}

# Each group gets impersonation rights on its service account
resource "google_service_account_iam_binding" "wif" {
  for_each = { for g in var.access_groups : g.group_object_id => g }

  service_account_id = "projects/${var.project_id}/serviceAccounts/${each.value.sa_email}"
  role               = "roles/iam.workloadIdentityUser"

  members = [
    "principalSet://iam.googleapis.com/${var.pool_name}/attribute.groups/${each.key}"
  ]
}

# Each service account gets its GCP service roles
resource "google_project_iam_member" "sa_roles" {
  for_each = {
    for pair in flatten([
      for g in var.access_groups : [
        for role in g.gcp_roles : {
          key  = "${g.group_object_id}-${role}"
          sa   = g.sa_email
          role = role
        }
      ]
    ]) : pair.key => pair
  }

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${each.value.sa}"
}
```

**`groups.yaml`** in GitHub — the one file a team edits to onboard:

```yaml
access_groups:
  - name: bigquery-readers
    entra_group_object_id: "aaa-bbb-ccc-111"
    service_account: sa-bq-reader@my-project.iam.gserviceaccount.com
    gcp_roles:
      - roles/bigquery.dataViewer
      - roles/bigquery.jobUser

  - name: gcs-writers
    entra_group_object_id: "aaa-bbb-ccc-222"
    service_account: sa-gcs-writer@my-project.iam.gserviceaccount.com
    gcp_roles:
      - roles/storage.objectCreator

  - name: pubsub-publishers
    entra_group_object_id: "aaa-bbb-ccc-333"
    service_account: sa-pubsub-pub@my-project.iam.gserviceaccount.com
    gcp_roles:
      - roles/pubsub.publisher
      - roles/pubsub.viewer
```

**Onboarding a new app** = add it to the right Entra group in `groups.yaml`, open a PR, GitHub Actions runs `terraform plan` in TFE, you review the diff (it will just show the group membership change), merge = done. No GCP console, no new Terraform resources for the app itself.

---

## Layer 4 — Python application implementation

Now for the runtime side. The `google-auth` library handles everything natively — it understands WIF credential files and does the Entra token fetch + STS exchange automatically.

**Step 1 — generate the credential configuration file** (do this once per app, store it in your secrets manager or bake it into the container):

```bash
gcloud iam workload-identity-pools create-cred-config \
  projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/entra-prod/providers/entra-oidc \
  --service-account="sa-bq-reader@my-project.iam.gserviceaccount.com" \
  --credential-source-executable-command="/usr/local/bin/get-entra-token" \
  --credential-source-executable-timeout-millis=5000 \
  --output-file=/etc/gcp/wif-credentials.json
```

This produces a JSON file that tells the Google client library *how* to get an Entra token at runtime. The `--credential-source-executable-command` is a small script you write that calls Entra's token endpoint.

**Step 2 — the Entra token fetcher script** (`/usr/local/bin/get-entra-token`):

```python
#!/usr/bin/env python3
"""
Called by google-auth at runtime to fetch a fresh Entra OIDC token.
Output must be JSON to stdout: {"version": 1, "success": true, "token_type": "urn:ietf:params:oauth:token-type:id_token", "id_token": "..."}
Reads config from env vars set by your secrets manager or k8s secrets.
"""
import json, os, sys
import urllib.request, urllib.parse

TENANT_ID     = os.environ["AZURE_TENANT_ID"]
CLIENT_ID     = os.environ["AZURE_CLIENT_ID"]
CLIENT_SECRET = os.environ["AZURE_CLIENT_SECRET"]   # from Secret Manager / vault
AUDIENCE      = os.environ.get("GCP_WIF_AUDIENCE", "api://gcp-wif-prod")

def get_entra_token() -> str:
    url  = f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token"
    data = urllib.parse.urlencode({
        "grant_type":    "client_credentials",
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope":         f"{AUDIENCE}/.default",
    }).encode()

    req = urllib.request.Request(url, data=data,
                                  headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=4) as resp:
        return json.loads(resp.read())["access_token"]

if __name__ == "__main__":
    try:
        token = get_entra_token()
        print(json.dumps({
            "version":    1,
            "success":    True,
            "token_type": "urn:ietf:params:oauth:token-type:id_token",
            "id_token":   token,
        }))
    except Exception as e:
        print(json.dumps({"version": 1, "success": False, "code": 1, "message": str(e)}))
        sys.exit(1)
```

**Step 3 — the Python application code** (the part developers actually write):

```python
"""
Example: on-prem Python app connecting to BigQuery via WIF.
The GOOGLE_APPLICATION_CREDENTIALS env var points to the WIF credential JSON.
Everything else is identical to any GCP client library usage.
"""
import os
from google.cloud import bigquery
from google.auth import default as google_auth_default

# Point to the WIF credential file (set this in your systemd unit, container env, etc.)
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/etc/gcp/wif-credentials.json"

def query_bigquery(project_id: str, query: str) -> list[dict]:
    """
    google-auth transparently:
      1. Reads the WIF credential config
      2. Calls /usr/local/bin/get-entra-token to get an Entra JWT
      3. Exchanges it at GCP STS for a short-lived GCP access token
      4. Impersonates the service account
      5. Refreshes automatically before expiry
    """
    client = bigquery.Client(project=project_id)
    rows   = client.query(query).result()
    return [dict(row) for row in rows]


def upload_to_gcs(bucket_name: str, blob_name: str, data: bytes) -> None:
    from google.cloud import storage
    # Same credential file works for any GCP service
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob   = bucket.blob(blob_name)
    blob.upload_from_string(data)


def publish_to_pubsub(project_id: str, topic_id: str, message: dict) -> None:
    import json
    from google.cloud import pubsub_v1
    publisher = pubsub_v1.PublisherClient()
    topic_path = publisher.topic_path(project_id, topic_id)
    publisher.publish(topic_path, json.dumps(message).encode())


if __name__ == "__main__":
    results = query_bigquery(
        project_id="my-gcp-project",
        query="SELECT * FROM `dataset.table` LIMIT 10"
    )
    for row in results:
        print(row)
```

**Step 4 — Secret Manager integration** (recommended for the client secret):

```python
"""
Bootstrap: fetch the Entra client secret from GCP Secret Manager at startup.
This requires a bootstrapping credential — use a narrowly-scoped SA with only
roles/secretmanager.secretAccessor, provisioned via a separate WIF group.
"""
import os
from google.cloud import secretmanager

def load_entra_credentials_from_secret_manager(project_id: str, secret_id: str) -> None:
    client = secretmanager.SecretManagerServiceClient()
    name   = f"projects/{project_id}/secrets/{secret_id}/versions/latest"
    resp   = client.access_secret_version(request={"name": name})
    
    # Secret payload is JSON: {"client_id": "...", "client_secret": "..."}
    import json
    creds = json.loads(resp.payload.data.decode())
    
    os.environ["AZURE_CLIENT_ID"]     = creds["client_id"]
    os.environ["AZURE_CLIENT_SECRET"] = creds["client_secret"]
```

---

## Security posture summary

A few things worth calling out explicitly:

**No long-lived keys anywhere.** GCP service account keys are never created. The Entra client secret is the only credential, and it lives in Secret Manager — not on disk, not in environment variables at rest.

**Blast radius containment.** If an app is compromised, revoking it from its Entra group immediately removes GCP access — no GCP-side change needed. The compromised app cannot impersonate any other service account because WIF bindings are tied to specific group OIDs.

**Token lifetime.** GCP STS tokens are valid for 1 hour. The Google client libraries handle refresh automatically. Entra tokens are valid for the lifetime you configure on the app registration (recommend 1 hour to match).

**Audit trail.** Every GCP API call appears in Cloud Audit Logs with the `principalSubject` showing the Entra `sub` claim, so you know exactly which app made which call. Entra logs the token issuance. Two independent audit trails, correlated by timestamp.

**Least privilege at scale.** The group-based model means you have `N` service accounts where `N` = the number of distinct access patterns, not 500. Typically 10–20 groups covers most organizations. Each SA has exactly the roles it needs and no more.

For Java applications, the pattern is identical — `google-cloud-java` client libraries read `GOOGLE_APPLICATION_CREDENTIALS` the same way, and you'd write the equivalent Entra token fetcher as a small executable or shell script. The credential JSON file and the WIF infrastructure are completely language-agnostic.
