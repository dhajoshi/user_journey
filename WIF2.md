Great questions — let me break both of these down clearly with visuals.

## Part 1: How the Entra group → SA → Role segregation works

Think of it this way: instead of giving each of your 500 apps its own identity in GCP, you group apps by **what they need to do**. The group is the bridge.Let me show you this with a concrete, clickable example you can explore — pick apps from the left, see exactly what lands in their OIDC token and what GCP access they get.The key insight from that explorer: **GCP never knows about individual apps**. It only knows about groups. When the token arrives at GCP STS, it looks at the `groups` array claim and finds the matching IAM binding. The "Report Generator" gets 3 service accounts because it's in 3 groups — but you didn't configure anything in GCP for that specific app; it just inherited access by virtue of group membership.

Notice the "Legacy Batch Job" — no groups, no access. That's your default-deny posture working automatically.

---

## Part 2: How does an app actually get its OIDC token / secret?

This is the question that trips people up most. There are **three patterns** depending on where your on-prem app runs. Let me show each one clearly.Let me give you the credential pattern comparison in text since the widget timed out.

---

## How apps get their OIDC token — 3 patterns

### Pattern A — Certificate (recommended, no shared secrets)

The app server generates its own private key. Only the public certificate is uploaded to Entra. At runtime the app signs a JWT with its private key; Entra verifies it using the public cert it already has. Nothing secret ever travels over the network.

```
Server generates: private key (never leaves) + public cert
Entra stores:     public cert only
Runtime:          app signs assertion JWT with private key → Entra verifies → issues OIDC token
```

Automation: Terraform provisions the Entra app registration and uploads the cert via the Microsoft Graph API provider. Cert rotation is a cron job that generates a new cert, uploads it, then deletes the old one — zero downtime because Entra accepts all uploaded certs until they're removed.

### Pattern B — Azure Arc managed identity (zero credentials)

If you can install the Azure Arc agent on your on-prem servers (it's a lightweight agent, no Azure VMs needed), the machine itself gets an Entra identity. Your app calls a local HTTP endpoint on the machine (`localhost:40342`) with no credentials at all. The Arc agent handles the Entra auth internally using a hardware-bound credential. This is the cleanest model.

```
Azure Arc agent installed → machine has Entra managed identity
App calls: GET localhost:40342/metadata/identity/oauth2/token (no creds needed)
Agent returns: OIDC token for the machine's identity
```

### Pattern C — Client secret (common, requires care)

The classic approach. You create a client secret in Entra, then store it in GCP Secret Manager. The app fetches it at startup using a narrow bootstrap credential (a separate WIF-bound service account that can only read secrets, nothing else). This is a two-phase bootstrap:

```
Phase 1 (startup): WIF bootstrap credential → Secret Manager → read Entra client secret
Phase 2 (runtime): Entra client secret → Entra token endpoint → OIDC token → GCP STS → API calls
```

The important discipline here is: **one secret per app registration**, stored under a versioned Secret Manager secret, with automated rotation. Never a shared secret across apps.

---

## How it all ties together

The mental model to carry forward:

- **Entra group** = "what kind of access does this app need?" — managed by the app team in a YAML file
- **GCP service account** = "which GCP identity represents that kind of access?" — one per access pattern, not one per app
- **IAM binding** = the rule that says "anyone whose token contains this group OID can impersonate this SA" — set once in Terraform, never touched again
- **OIDC token** = the proof of identity that carries the group claims — fetched by the app at runtime using one of the three patterns above

For most organizations, Pattern A (certificate) for new apps and Pattern C (client secret in Secret Manager) for existing ones is the right migration path, with Arc as an aspirational target for greenfield infrastructure.
