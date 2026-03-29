Perfect! Let me walk through the **complete end-to-end manual setup** with your exact scenario:

- **App1** (on-prem) → writes to **GCS bucket in Project1**
- **App2** (on-prem) → writes to **GCS bucket in Project2**

Let me break it into **digestible steps** with actual commands and code.

---

## **STEP 1: Entra Setup (Microsoft Entra Admin)**

### **Step 1a: Create App1 Registration in Entra**

1. Go to **Entra Admin Center** → **Applications** → **App registrations** → **New registration**

```
Name: app1-gcs-writer
Supported account types: Accounts in this organizational directory only
Redirect URI: (leave blank for service principal)
```

2. After creation, note the **Application (client) ID**. Let's say: `aaa-111-bbb`

3. Go to **Certificates & secrets** → **Client secrets** → **New client secret**
   - Description: `app1-gcs-secret`
   - Expires: 12 months
   - **Copy the VALUE** (not the ID) → save it safely, we'll use later

**Result for App1:**
```
Client ID: aaa-111-bbb
Client Secret: [SAVED_SECURELY]
Tenant ID: your-tenant-id (e.g., aaaa-bbbb-cccc-dddd)
```

### **Step 1b: Create App2 Registration in Entra (Same Process)**

1. New registration → **app2-gcs-writer**
2. Note the **Client ID**: `bbb-222-ccc`
3. Create client secret → **Copy the VALUE**

**Result for App2:**
```
Client ID: bbb-222-ccc
Client Secret: [SAVED_SECURELY]
Tenant ID: aaaa-bbbb-cccc-dddd (same as App1)
```

### **Step 1c: Create Entra Security Groups**

1. Go to **Groups** → **New group**

**For App1:**
```
Group name: gcp-app1-gcs-writers
Group type: Security
Owners: [your-user]
Members: [Search for "app1-gcs-writer" and add it]
```

After creation, note the **Object ID**: `group-111-xxx`

**For App2:**
```
Group name: gcp-app2-gcs-writers
Group type: Security
Owners: [your-user]
Members: [Search for "app2-gcs-writer" and add it]
```

After creation, note the **Object ID**: `group-222-yyy`

---

## **STEP 2: GCP Project1 Setup (App1's Project)**

### **Step 2a: Create GCS Bucket in Project1**

```bash
# Login to GCP
gcloud auth login
gcloud config set project project1-id

# Create bucket for App1
gsutil mb gs://app1-gcs-logs-bucket
```

### **Step 2b: Create Service Accounts in Project1**

We need TWO service accounts per app in this project:

1. **Bootstrap SA** — reads the Entra secret from Secret Manager (certificate-based)
2. **Main SA** — impersonated by App1 to write to GCS

```bash
# Bootstrap Service Account (certificate-based, no secret needed at bootstrap time)
gcloud iam service-accounts create sa-bootstrap-app1 \
  --display-name="Bootstrap SA for App1"

# Main Service Account (used by App1 to write to GCS)
gcloud iam service-accounts create sa-app1-gcs-writer \
  --display-name="App1 GCS Writer SA"

# Get the email addresses
BOOTSTRAP_SA="sa-bootstrap-app1@project1-id.iam.gserviceaccount.com"
MAIN_SA="sa-app1-gcs-writer@project1-id.iam.gserviceaccount.com"
```

### **Step 2c: Create WIF Pool in Project1**

```bash
# Create Workload Identity Pool (once per project)
gcloud iam workload-identity-pools create entra-pool \
  --project=project1-id \
  --location=global \
  --display-name="Entra OIDC Pool"

# Get the pool name
POOL_NAME=$(gcloud iam workload-identity-pools describe entra-pool \
  --project=project1-id \
  --location=global \
  --format='value(name)')

echo "Pool Name: $POOL_NAME"
# Output: projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/entra-pool
```

### **Step 2d: Create WIF Provider (Entra OIDC)**

```bash
gcloud iam workload-identity-pools providers create-oidc entra-oidc \
  --project=project1-id \
  --location=global \
  --workload-identity-pool=entra-pool \
  --display-name="Microsoft Entra OIDC" \
  --attribute-mapping="google.subject=assertion.sub,attribute.app_id=assertion.appid,attribute.groups=assertion.groups" \
  --issuer-uri="https://login.microsoftonline.com/aaaa-bbbb-cccc-dddd/v2.0" \
  --attribute-condition="assertion.iss == 'https://login.microsoftonline.com/aaaa-bbbb-cccc-dddd/v2.0'"
```

### **Step 2e: Create WIF Credentials for App1 (Bootstrap)**

```bash
# Generate bootstrap credential (certificate-based)
gcloud iam workload-identity-pools create-cred-config \
  "$POOL_NAME/providers/entra-oidc" \
  --service-account="$BOOTSTRAP_SA" \
  --output-file=wif-bootstrap-app1.json

cat wif-bootstrap-app1.json
# Save this file → will deploy to /etc/gcp/wif-bootstrap.json on App1's machine
```

### **Step 2f: Create WIF Credentials for App1 (Main)**

```bash
# Generate main credential (used for GCP API calls)
gcloud iam workload-identity-pools create-cred-config \
  "$POOL_NAME/providers/entra-oidc" \
  --service-account="$MAIN_SA" \
  --output-file=wif-main-app1.json

cat wif-main-app1.json
# Save this file → will deploy to /etc/gcp/wif-main.json on App1's machine
```

### **Step 2g: Create WIF IAM Bindings**

**Bind Bootstrap SA** — can ONLY be impersonated by App1 (via its client_id):

```bash
gcloud iam service-accounts add-iam-policy-binding "$BOOTSTRAP_SA" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/$POOL_NAME/attribute.app_id/aaa-111-bbb"
```

**Bind Main SA** — can ONLY be impersonated by App1's group:

```bash
gcloud iam service-accounts add-iam-policy-binding "$MAIN_SA" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/$POOL_NAME/attribute.groups/group-111-xxx"
```

### **Step 2h: Create Secret Manager Secret**

```bash
# Create secret for App1's Entra client secret
echo "YOUR_APP1_CLIENT_SECRET_VALUE_HERE" | gcloud secrets create entra-client-secret-app1 \
  --project=project1-id \
  --data-file=-

# Get the secret name
SECRET_NAME="projects/PROJECT_NUMBER/secrets/entra-client-secret-app1/versions/latest"
```

### **Step 2i: Grant Secret Access (Resource-Level IAM)**

**CRITICAL**: Bootstrap SA can ONLY read THIS app's secret (not all secrets):

```bash
gcloud secrets add-iam-policy-binding entra-client-secret-app1 \
  --project=project1-id \
  --member="serviceAccount:$BOOTSTRAP_SA" \
  --role="roles/secretmanager.secretAccessor"
```

### **Step 2j: Grant GCS Write Access**

Main SA can write to App1's bucket:

```bash
gsutil iam ch serviceAccount:$MAIN_SA:objectCreator gs://app1-gcs-logs-bucket
gsutil iam ch serviceAccount:$MAIN_SA:objectViewer gs://app1-gcs-logs-bucket
```

---

## **STEP 3: GCP Project2 Setup (App2's Project)**

**Repeat Steps 2a-2j but for App2 and Project2:**

```bash
# Login and set project2
gcloud config set project project2-id

# Create App2's GCS bucket
gsutil mb gs://app2-gcs-logs-bucket

# Create SAs
gcloud iam service-accounts create sa-bootstrap-app2 \
  --display-name="Bootstrap SA for App2"

gcloud iam service-accounts create sa-app2-gcs-writer \
  --display-name="App2 GCS Writer SA"

BOOTSTRAP_SA_P2="sa-bootstrap-app2@project2-id.iam.gserviceaccount.com"
MAIN_SA_P2="sa-app2-gcs-writer@project2-id.iam.gserviceaccount.com"

# Create WIF Pool
gcloud iam workload-identity-pools create entra-pool \
  --project=project2-id \
  --location=global \
  --display-name="Entra OIDC Pool"

POOL_NAME_P2=$(gcloud iam workload-identity-pools describe entra-pool \
  --project=project2-id \
  --location=global \
  --format='value(name)')

# Create WIF Provider
gcloud iam workload-identity-pools providers create-oidc entra-oidc \
  --project=project2-id \
  --location=global \
  --workload-identity-pool=entra-pool \
  --display-name="Microsoft Entra OIDC" \
  --attribute-mapping="google.subject=assertion.sub,attribute.app_id=assertion.appid,attribute.groups=assertion.groups" \
  --issuer-uri="https://login.microsoftonline.com/aaaa-bbbb-cccc-dddd/v2.0" \
  --attribute-condition="assertion.iss == 'https://login.microsoftonline.com/aaaa-bbbb-cccc-dddd/v2.0'"

# Create credentials
gcloud iam workload-identity-pools create-cred-config \
  "$POOL_NAME_P2/providers/entra-oidc" \
  --service-account="$BOOTSTRAP_SA_P2" \
  --output-file=wif-bootstrap-app2.json

gcloud iam workload-identity-pools create-cred-config \
  "$POOL_NAME_P2/providers/entra-oidc" \
  --service-account="$MAIN_SA_P2" \
  --output-file=wif-main-app2.json

# WIF bindings
gcloud iam service-accounts add-iam-policy-binding "$BOOTSTRAP_SA_P2" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/$POOL_NAME_P2/attribute.app_id/bbb-222-ccc"

gcloud iam service-accounts add-iam-policy-binding "$MAIN_SA_P2" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/$POOL_NAME_P2/attribute.groups/group-222-yyy"

# Secret Manager
echo "YOUR_APP2_CLIENT_SECRET_VALUE_HERE" | gcloud secrets create entra-client-secret-app2 \
  --project=project2-id \
  --data-file=-

gcloud secrets add-iam-policy-binding entra-client-secret-app2 \
  --project=project2-id \
  --member="serviceAccount:$BOOTSTRAP_SA_P2" \
  --role="roles/secretmanager.secretAccessor"

# GCS access
gsutil iam ch serviceAccount:$MAIN_SA_P2:objectCreator gs://app2-gcs-logs-bucket
gsutil iam ch serviceAccount:$MAIN_SA_P2:objectViewer gs://app2-gcs-logs-bucket
```

---

## **STEP 4: Deploy Files to On-Prem Machines**

### **On App1 Machine:**

```bash
# Create directories
sudo mkdir -p /etc/gcp
sudo mkdir -p /usr/local/bin

# Copy credential files
sudo cp wif-bootstrap-app1.json /etc/gcp/wif-bootstrap.json
sudo cp wif-main-app1.json /etc/gcp/wif-main.json
sudo chown root:root /etc/gcp/*.json
sudo chmod 600 /etc/gcp/*.json
```

### **On App2 Machine:**

```bash
# Same process
sudo mkdir -p /etc/gcp
sudo mkdir -p /usr/local/bin

sudo cp wif-bootstrap-app2.json /etc/gcp/wif-bootstrap.json
sudo cp wif-main-app2.json /etc/gcp/wif-main.json
sudo chown root:root /etc/gcp/*.json
sudo chmod 600 /etc/gcp/*.json
```

---

## **STEP 5: Token Fetcher Script (Both Machines)**

Create on **both App1 and App2** at `/usr/local/bin/get-entra-token`:

```bash
sudo tee /usr/local/bin/get-entra-token > /dev/null << 'EOF'
#!/usr/bin/env python3
"""
/usr/local/bin/get-entra-token
Called by google-auth to fetch fresh Entra OIDC tokens.
Reads the Entra secret from tmpfs, NOT from env vars.
"""
import json
import os
import sys
import requests

TENANT_ID = os.environ["AZURE_TENANT_ID"]
CLIENT_ID = os.environ["AZURE_CLIENT_ID"]
AUDIENCE = os.environ.get("WIF_AUDIENCE", "api://gcp-wif-prod")

# Secret is in tmpfs (written by bootstrap.py during startup)
secret_file = os.environ.get("ENTRA_SECRET_FILE", "/run/secrets/entra-secret")

try:
    # Read secret from tmpfs
    client_secret = open(secret_file).read().strip()

    # Request token from Entra
    resp = requests.post(
        f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token",
        data={
            "grant_type": "client_credentials",
            "client_id": CLIENT_ID,
            "client_secret": client_secret,
            "scope": f"{AUDIENCE}/.default",
        },
        timeout=5,
    )
    resp.raise_for_status()

    # Output in the format google-auth expects
    print(
        json.dumps(
            {
                "version": 1,
                "success": True,
                "token_type": "urn:ietf:params:oauth:token-type:id_token",
                "id_token": resp.json()["access_token"],
            }
        )
    )

except Exception as e:
    print(json.dumps({"version": 1, "success": False, "code": 1, "message": str(e)}))
    sys.exit(1)
EOF

sudo chmod +x /usr/local/bin/get-entra-token
```

---

## **STEP 6: Bootstrap Module (Both Machines)**

Create `bootstrap.py` on both App1 and App2:

```python
"""
bootstrap.py — Secure startup for on-prem apps
Executed once at app startup.

Phase 1: Use certificate-based bootstrap credential to read the Entra secret from Secret Manager
Phase 2: Store secret in tmpfs (not env vars)
Phase 3: Smoke-test token generation
Phase 4: Activate main WIF credential for all GCP calls
"""

import os
import stat
import requests
from pathlib import Path
from google.cloud import secretmanager


def bootstrap():
    """Run the complete bootstrap sequence."""
    app_name = os.environ["APP_NAME"]
    project_id = os.environ["GCP_PROJECT_ID"]
    tenant_id = os.environ["AZURE_TENANT_ID"]
    client_id = os.environ["AZURE_CLIENT_ID"]

    print(f"[bootstrap] app={app_name} starting...")

    # PHASE 1: Fetch Entra secret from Secret Manager
    print("[bootstrap] Phase 1: Fetching Entra secret from Secret Manager...")
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/etc/gcp/wif-bootstrap.json"

    try:
        client = secretmanager.SecretManagerServiceClient()
        secret_resource = (
            f"projects/{project_id}/secrets/"
            f"entra-client-secret-{app_name}/versions/latest"
        )
        response = client.access_secret_version(request={"name": secret_resource})
        secret_value = response.payload.data.decode("utf-8")
        print("✓ Secret retrieved from Secret Manager")
    except Exception as e:
        raise RuntimeError(
            f"Bootstrap Phase 1 failed: Could not read secret. "
            f"Ensure sa-bootstrap-{app_name} has access to entra-client-secret-{app_name}. "
            f"Error: {e}"
        )

    # PHASE 2: Store secret in tmpfs (not in env vars)
    print("[bootstrap] Phase 2: Storing secret in tmpfs...")
    secret_dir = Path("/run/secrets")
    secret_dir.mkdir(mode=0o700, parents=True, exist_ok=True)

    secret_file = secret_dir / f"entra-{app_name}"
    secret_file.write_text(secret_value)
    secret_file.chmod(stat.S_IRUSR | stat.S_IWUSR)  # 0o600 — owner only
    print(f"✓ Secret stored at {secret_file} with mode 0600")

    # PHASE 3: Smoke-test token generation
    print("[bootstrap] Phase 3: Testing token generation...")
    try:
        token = get_entra_oidc_token(client_id, tenant_id, secret_file)
        print(f"✓ Token generated successfully ({len(token)} chars)")
    except Exception as e:
        raise RuntimeError(f"Bootstrap Phase 3 failed: Token generation failed. Error: {e}")

    # PHASE 4: Activate main credential
    print("[bootstrap] Phase 4: Activating main WIF credential...")
    os.environ["ENTRA_SECRET_FILE"] = str(secret_file)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/etc/gcp/wif-main.json"
    print("✓ Main WIF credential activated")

    print("[bootstrap] ✓✓✓ Bootstrap complete! Ready to call GCP APIs.")


def get_entra_oidc_token(client_id: str, tenant_id: str, secret_file: Path) -> str:
    """Get an Entra OIDC token using the client secret."""
    client_secret = secret_file.read_text().strip()

    resp = requests.post(
        f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token",
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
            "scope": "api://gcp-wif-prod/.default",
        },
        timeout=5,
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


if __name__ == "__main__":
    bootstrap()
```

---

## **STEP 7: Python Application (App1 & App2)**

### **On App1 Machine: `app1_logger.py`**

```python
"""
app1_logger.py
On-prem App1 that writes logs to GCS bucket in Project1.

Environment variables (set by deployment/systemd):
  APP_NAME=app1
  GCP_PROJECT_ID=project1-id
  AZURE_TENANT_ID=aaaa-bbbb-cccc-dddd
  AZURE_CLIENT_ID=aaa-111-bbb
  WIF_AUDIENCE=api://gcp-wif-prod
"""

import os
import json
import logging
from datetime import datetime
from bootstrap import bootstrap
from google.cloud import storage


# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(message)s")
logger = logging.getLogger(__name__)


def upload_logs_to_gcs(bucket_name: str, app_name: str, log_data: dict):
    """
    Upload logs to GCS bucket.
    The client uses wif-main.json automatically (set by bootstrap).
    """
    try:
        storage_client = storage.Client(project=os.environ["GCP_PROJECT_ID"])
        bucket = storage_client.bucket(bucket_name)

        # Create timestamped blob name
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        blob_name = f"logs/{app_name}/log_{timestamp}.json"

        blob = bucket.blob(blob_name)
        blob.upload_from_string(
            json.dumps(log_data, indent=2),
            content_type="application/json"
        )

        logger.info(f"✓ Logs uploaded to gs://{bucket_name}/{blob_name}")
        return blob_name

    except Exception as e:
        logger.error(f"✗ Failed to upload logs: {e}")
        raise


def main():
    """Main application logic."""
    app_name = os.environ.get("APP_NAME", "app1")
    project_id = os.environ.get("GCP_PROJECT_ID")
    bucket_name = "app1-gcs-logs-bucket"

    logger.info(f"Starting {app_name}...")

    # Bootstrap must run FIRST
    bootstrap()

    # Simulate application work and logging
    log_data = {
        "timestamp": datetime.now().isoformat(),
        "app": app_name,
        "project": project_id,
        "status": "running",
        "message": "Application successfully authenticated and writing to GCS",
        "event_count": 42,
        "events": [
            {"id": 1, "type": "order_created", "amount": 100.50},
            {"id": 2, "type": "order_shipped", "amount": 100.50},
            {"id": 3, "type": "order_delivered", "amount": 100.50},
        ],
    }

    logger.info(f"Log data to upload: {json.dumps(log_data, indent=2)}")

    # Upload to GCS
    blob_name = upload_logs_to_gcs(bucket_name, app_name, log_data)

    logger.info(f"✓ Application completed successfully!")
    logger.info(f"  Logs stored at: gs://{bucket_name}/{blob_name}")


if __name__ == "__main__":
    main()
```

### **On App2 Machine: `app2_logger.py`**

```python
"""
app2_logger.py
On-prem App2 that writes logs to GCS bucket in Project2.

Environment variables (set by deployment/systemd):
  APP_NAME=app2
  GCP_PROJECT_ID=project2-id
  AZURE_TENANT_ID=aaaa-bbbb-cccc-dddd
  AZURE_CLIENT_ID=bbb-222-ccc
  WIF_AUDIENCE=api://gcp-wif-prod
"""

import os
import json
import logging
from datetime import datetime
from bootstrap import bootstrap
from google.cloud import storage


logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(message)s")
logger = logging.getLogger(__name__)


def upload_logs_to_gcs(bucket_name: str, app_name: str, log_data: dict):
    """Upload logs to GCS bucket."""
    try:
        storage_client = storage.Client(project=os.environ["GCP_PROJECT_ID"])
        bucket = storage_client.bucket(bucket_name)

        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        blob_name = f"logs/{app_name}/log_{timestamp}.json"

        blob = bucket.blob(blob_name)
        blob.upload_from_string(
            json.dumps(log_data, indent=2),
            content_type="application/json"
        )

        logger.info(f"✓ Logs uploaded to gs://{bucket_name}/{blob_name}")
        return blob_name

    except Exception as e:
        logger.error(f"✗ Failed to upload logs: {e}")
        raise


def main():
    """Main application logic."""
    app_name = os.environ.get("APP_NAME", "app2")
    project_id = os.environ.get("GCP_PROJECT_ID")
    bucket_name = "app2-gcs-logs-bucket"

    logger.info(f"Starting {app_name}...")

    # Bootstrap must run FIRST
    bootstrap()

    # Simulate application work and logging
    log_data = {
        "timestamp": datetime.now().isoformat(),
        "app": app_name,
        "project": project_id,
        "status": "running",
        "message": "Application successfully authenticated and writing to GCS",
        "inventory_count": 1250,
        "items": [
            {"sku": "SKU-001", "quantity": 100, "price": 19.99},
            {"sku": "SKU-002", "quantity": 250, "price": 29.99},
            {"sku": "SKU-003", "quantity": 500, "price": 9.99},
        ],
    }

    logger.info(f"Log data to upload: {json.dumps(log_data, indent=2)}")

    # Upload to GCS
    blob_name = upload_logs_to_gcs(bucket_name, app_name, log_data)

    logger.info(f"✓ Application completed successfully!")
    logger.info(f"  Logs stored at: gs://{bucket_name}/{blob_name}")


if __name__ == "__main__":
    main()
```

---

## **STEP 8: Systemd Service Files (Deployment)**

### **On App1 Machine: `/etc/systemd/system/app1.service`**

```ini
[Unit]
Description=App1 GCS Logger
After=network.target

[Service]
Type=simple
User=app1
WorkingDirectory=/opt/app1

# Environment variables
Environment="APP_NAME=app1"
Environment="GCP_PROJECT_ID=project1-id"
Environment="AZURE_TENANT_ID=aaaa-bbbb-cccc-dddd"
Environment="AZURE_CLIENT_ID=aaa-111-bbb"
Environment="WIF_AUDIENCE=api://gcp-wif-prod"

# Python application
ExecStart=/usr/bin/python3 /opt/app1/app1_logger.py

# Restart policy
Restart=on-failure
RestartSec=10

# Logging
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### **On App2 Machine: `/etc/systemd/system/app2.service`**

```ini
[Unit]
Description=App2 GCS Logger
After=network.target

[Service]
Type=simple
User=app2
WorkingDirectory=/opt/app2

# Environment variables
Environment="APP_NAME=app2"
Environment="GCP_PROJECT_ID=project2-id"
Environment="AZURE_TENANT_ID=aaaa-bbbb-cccc-dddd"
Environment="AZURE_CLIENT_ID=bbb-222-ccc"
Environment="WIF_AUDIENCE=api://gcp-wif-prod"

# Python application
ExecStart=/usr/bin/python3 /opt/app2/app2_logger.py

# Restart policy
Restart=on-failure
RestartSec=10

# Logging
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

---

## **STEP 9: Deploy and Run**

### **On App1 Machine:**

```bash
# Install dependencies
sudo pip install google-cloud-storage google-cloud-secretmanager requests

# Create app directory
sudo mkdir -p /opt/app1
sudo chown app1:app1 /opt/app1

# Copy files
sudo cp bootstrap.py /opt/app1/
sudo cp app1_logger.py /opt/app1/
sudo cp wif-bootstrap-app1.json /etc/gcp/wif-bootstrap.json
sudo cp wif-main-app1.json /etc/gcp/wif-main.json

# Deploy systemd service
sudo cp app1.service /etc/systemd/system/

# Start service
sudo systemctl daemon-reload
sudo systemctl start app1
sudo systemctl enable app1

# View logs
sudo journalctl -u app1 -f
```

### **On App2 Machine:**

```bash
# Same process for app2
sudo pip install google-cloud-storage google-cloud-secretmanager requests

sudo mkdir -p /opt/app2
sudo chown app2:app2 /opt/app2

sudo cp bootstrap.py /opt/app2/
sudo cp app2_logger.py /opt/app2/
sudo cp wif-bootstrap-app2.json /etc/gcp/wif-bootstrap.json
sudo cp wif-main-app2.json /etc/gcp/wif-main.json

sudo cp app2.service /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl start app2
sudo systemctl enable app2

sudo journalctl -u app2 -f
```

---

## **STEP 10: Verify**

### **Check App1 Logs:**

```bash
# On app1 machine
sudo journalctl -u app1 -n 50

# Expected output:
# [bootstrap] app=app1 starting...
# [bootstrap] Phase 1: Fetching Entra secret from Secret Manager...
# ✓ Secret retrieved from Secret Manager
# [bootstrap] Phase 2: Storing secret in tmpfs...
# ✓ Secret stored at /run/secrets/entra-app1 with mode 0600
# [bootstrap] Phase 3: Testing token generation...
# ✓ Token generated successfully (1234 chars)
# [bootstrap] Phase 4: Activating main WIF credential...
# ✓ Main WIF credential activated
# [bootstrap] ✓✓✓ Bootstrap complete! Ready to call GCP APIs.
# ✓ Logs uploaded to gs://app1-gcs-logs-bucket/logs/app1/log_2026-03-29_14-30-45.json
# ✓ Application completed successfully!
```

### **Verify Logs in GCS (Project1):**

```bash
# On your local machine with GCP access
gcloud config set project project1-id

gsutil ls gs://app1-gcs-logs-bucket/logs/app1/

# Download and view
gsutil cp gs://app1-gcs-logs-bucket/logs/app1/log_2026-03-29_14-30-45.json -
```

### **Verify Logs in GCS (Project2):**

```bash
gcloud config set project project2-id

gsutil ls gs://app2-gcs-logs-bucket/logs/app2/

gsutil cp gs://app2-gcs-logs-bucket/logs/app2/log_2026-03-29_14-31-00.json -
```

---

## **SECURITY VERIFICATION**

### **Test 1: Can App1 Access App2's Bucket?**

```bash
# On App1 machine, try to access App2's bucket
python3 << 'EOF'
from google.cloud import storage
import os

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/etc/gcp/wif-main.json"
os.environ["ENTRA_SECRET_FILE"] = "/run/secrets/entra-app1"

try:
    client = storage.Client(project="project2-id")
    bucket = client.bucket("app2-gcs-logs-bucket")
    blobs = list(bucket.list_blobs())
    print(f"✗ SECURITY BREACH: App1 accessed App2's bucket! Found {len(blobs)} objects.")
except Exception as e:
    print(f"✓ SECURE: App1 cannot access App2's bucket. Error: {type(e).__name__}")
EOF
```

**Expected Result:** `PERMISSION_DENIED` error (secure ✓)

### **Test 2: Can App1 Read App2's Secret?**

```bash
# On App1 machine
python3 << 'EOF'
from google.cloud import secretmanager
import os

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "/etc/gcp/wif-bootstrap.json"

try:
    client = secretmanager.SecretManagerServiceClient()
    secret = client.access_secret_version(
        request={"name": "projects/project2-id/secrets/entra-client-secret-app2/versions/latest"}
    )
    print(f"✗ SECURITY BREACH: App1 read App2's secret!")
except Exception as e:
    print(f"✓ SECURE: App1 cannot read App2's secret. Error: {type(e).__name__}")
EOF
```

**Expected Result:** `PERMISSION_DENIED` error (secure ✓)

---

## **Summary Table**

| Component | App1 (Project1) | App2 (Project2) |
|-----------|---|---|
| **Entra Client ID** | `aaa-111-bbb` | `bbb-222-ccc` |
| **Entra Group OID** | `group-111-xxx` | `group-222-yyy` |
| **Bootstrap SA** | `sa-bootstrap-app1@project1-id.iam.gserviceaccount.com` | `sa-bootstrap-app2@project2-id.iam.gserviceaccount.com` |
| **Main SA** | `sa-app1-gcs-writer@project1-id.iam.gserviceaccount.com` | `sa-app2-gcs-writer@project2-id.iam.gserviceaccount.com` |
| **GCS Bucket** | `gs://app1-gcs-logs-bucket` | `gs://app2-gcs-logs-bucket` |
| **Secret** | `entra-client-secret-app1` (in Project1) | `entra-client-secret-app2` (in Project2) |
| **WIF Pool** | `entra-pool` (in Project1) | `entra-pool` (in Project2) |

---

## **Key Security Points**

✅ **App1 cannot:**
- Impersonate App2's SA (WIF `client_id` check fails)
- Read App2's secret (Secret Manager resource-level IAM)
- Access App2's bucket (GCS IAM binding on bootstrap SA is project-specific)

✅ **Isolation is enforced at:**
- **Entra level** — Each app has unique `client_id`
- **GCP WIF level** — Bootstrap SA bound to specific `client_id`, Main SA bound to specific group
- **Secret Manager level** — Bootstrap SA has resource-level access to ONE secret only
- **GCS level** — Write access bound to specific bucket

Does this step-by-step walkthrough clarify everything? Would you like me to create the complete Terraform code instead to automate all these manual steps?
