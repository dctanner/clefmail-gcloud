# Human sender verification

Sender verification is ready for production. Live-mail testing is complete.

Held messages carry `Clefmail/Held`. Successful verification removes that label
and restores messages that originally arrived in the inbox.

## Behavior

`humanVerification` defaults to `true` on each mailbox to hold mail from unknown senders after classification. Clefmail applies category labels and the AI archive policy first. Archived mail skips verification. Mail already outside the inbox also skips a new challenge. For messages that remain in the inbox, a DMARC pass reported by Gmail plus a published BIMI HTTPS certificate URL exempts the individual message from human verification. This DNS-only check follows `BIMI-Selector` and falls back to the authenticated parent domain when needed. It does not fetch the certificate or create permanent sender trust. Other messages follow these checks:

1. Check Google Contacts. Contacts are never archived by either Clefmail archive path, even when verification is disabled.
2. Check durable sender state **before** searching history. A pending sender's own held messages and Clefmail's outgoing challenge do not make them trusted.
3. For a sender without state, search retained Gmail incoming/sent metadata for exact correspondence. Earlier incoming mail or an email the mailbox has sent to the address exempts the sender from verification. Existing correspondence does **not** exempt non-contacts from the ordinary AI archive policy.
4. For an unknown sender, persist a pending record, archive the incoming message, and send a verification link. The message keeps its category label. Further messages from that sender are also classified first; those kept in the inbox join the hold, without repeated challenges while the link is valid.
5. The sender opens the link and completes Cloudflare Turnstile. Server-side validation checks success, hostname, action, and binding to this particular verification capability. GET requests and email link scanners cannot verify someone.
6. Under the same mailbox lease used by processing, create the sender's Google Contact, restore held messages that were originally in the inbox, and send a success email **to the verified sender**. Messages that were already archived by a Gmail filter, deleted, moved to Spam/Trash, or made drafts are not restored.
7. Later mail bypasses quarantine. Contacts and durable verified-sender state protect it from the AI archiver.

`archiveEnabled` controls **AI archiving only**. Human-verification quarantine is independently enabled and follows the AI archive decision. It can hold remaining inbox mail even when starred/important or body-unavailable. It never processes Spam, Trash, drafts, or sent-only messages. Gmail filters and other applications remain outside Clefmail's control.

The first challenge is an automatic reply with an `In-Reply-To` header when the original Message-ID is usable. The success email is a separate confirmation. Subjects and bodies use fixed templates; incoming message bodies are never copied into notices.

### Deliberate safety exceptions

- Automated replies, mailing-list/bulk mail, null return paths, common no-reply addresses, auto-response suppression headers, and reported DMARC failures are archived **without** a challenge to avoid reply loops/backscatter. A later ordinary message from that pending sender can trigger the first challenge. The mailbox owner can also add the sender to Contacts; on subsequent processing, held messages are released.
- Missing, duplicate, or malformed From headers cannot produce a safe destination: these messages are neither challenged nor automatically archived.
- Contacts/API/storage failures retry instead of treating an unknown result as permission to archive. A failing message can delay later history processing.
- Addresses use case-insensitive exact matching. A plus-tagged reply can also match its base address when its `In-Reply-To` or `References` header identifies a retained sent message addressed to that base address. For example, a reply from `dpo+noreply@example.com` can reference your message to `dpo@example.com`. Automated replies sent by Clefmail do not establish this relationship. Google Contacts means People API contact connections.

## Required permissions and migration

This upgrade requires the **People API** and the OAuth scope `https://www.googleapis.com/auth/contacts`, including for mailboxes with human verification off. Gmail's existing `gmail.modify` scope also permits sending the notices.

1. Enable `people.googleapis.com` in the same Google Cloud project.
2. Add the contacts scope to the OAuth consent configuration.
3. Privately move the existing `.secrets/<id>.token` aside and rerun `bun run authorize <id>` for each mailbox. The helper requires both scopes and refuses to overwrite token files.
4. Publish each replacement token as a new Secret Manager version. Update pinned numeric versions in **both** services' secret bindings. Do not print or commit tokens.
5. Deploy the upgrade only after reauthorization. Old Gmail-only tokens will make contact checks fail safely and processing retry; they cannot silently preserve old archive behavior.

A Google Workspace administrator or an OAuth publishing/verification change may be necessary. Reauthorization is a user/browser action, not something the runtime can do unattended.

## Configure Turnstile

Create a Cloudflare Turnstile widget for the public verification service's hostname. Keep hostname validation enabled. Use its public site key in configuration and store its **secret key** in Google Secret Manager, for example as `clefmail-turnstile-secret`.

Add the following top-level object to your private `config.json`:

```json
"verification": {
  "publicUrl": "https://YOUR-VERIFICATION-SERVICE.run.app",
  "siteKey": "YOUR_PUBLIC_TURNSTILE_SITE_KEY"
}
```

`publicUrl` must be an HTTPS origin with no credentials, path, query, or fragment. It can also be an explicitly mapped HTTPS domain. Register the exact hostname in Turnstile. Do not use Cloudflare's test keys in production.

Initially keep every account's `humanVerification` set to `false`. Deploy the public service before activating quarantine.

## Two services, not a public processor

The same image has two mutually exclusive startup modes:

| Mode | Reachability | Routes | Extra secret |
| --- | --- | --- | --- |
| `SERVICE_MODE=processor` (default) | Private Cloud Run IAM/internal ingress | `/pubsub`, `/renew`, `/healthz` | Classifier key |
| `SERVICE_MODE=verification` | Public HTTPS | `/verify`, `/healthz` only | Turnstile secret |

Never grant public access to the processor or proxy it through the verification service. The public mode never constructs the processor/classifier and requires neither a classifier key nor Pub/Sub configuration. Both services need mailbox OAuth credentials and the **same** state bucket, because successful verification modifies Gmail and the mailbox lease serializes those changes.

The deployment script creates a separate service and runtime identity named `<SERVICE>-verify`; it does not change the processor's ingress/IAM or start watches. Public hosting and additional cloud costs are explicit operator actions.

### Deployment sequence

1. Complete the normal private-service provisioning in the README, with all `humanVerification` flags **false**. This creates the private state bucket. For an existing deployment, reauthorize first as described above.
2. Upload a config version containing a `verification` object. If the public URL is not yet known, use a temporary valid HTTPS origin while verification remains disabled; no challenge links will be sent. The initial public service only establishes its Cloud Run URL.
3. Create the Turnstile-secret Secret Manager version privately and set these **references**, using your actual numeric versions:

   ```bash
   export PROJECT=your-google-project-id
   export REGION=us-central1
   export STATE_BUCKET=your-project-clefmail-state
   export VERIFICATION_SECRET_BINDINGS='/secrets/config.json=clefmail-config:2,GOOGLE_CLIENT_ID=clefmail-google-client-id:1,GOOGLE_CLIENT_SECRET=clefmail-google-client-secret:1,TURNSTILE_SECRET_KEY=clefmail-turnstile-secret:1,GMAIL_PERSONAL_REFRESH_TOKEN=clefmail-personal-token:2'
   bash scripts/deploy-verification.sh
   ```

   Include a token binding for every enabled account. Run in a private terminal; do not put literal secrets in these bindings. The script runs the full synthetic checks before making cloud changes.

4. Set `verification.publicUrl` to the printed service origin (or a separately configured custom domain) and configure that exact hostname in Turnstile. Upload a new config version; update the public service binding and redeploy it. Both services must ultimately use the same verification configuration and account IDs.
5. Confirm `/verify` serves the page publicly, `/pubsub` and `/renew` return **404** on the public service, and direct internet access to the private processor is still denied. Opening `/verify` without an emailed fragment should ask for the complete email link; it cannot create contacts or release mail.
6. Enable `humanVerification: true` for the desired mailbox, publish a new config version, and deploy that version to the **public service first**, then the private processor using the usual `SECRET_BINDINGS` and `scripts/deploy.sh`. The private binding does not need `TURNSTILE_SECRET_KEY`.

## Production monitoring

Monitor `verification_failed`, `request_failed`, dead-letter backlog, and cloud/provider quotas. Successful `watch_renewed` events record continued mailbox watch renewal. Logs omit email addresses and verification capabilities.

## State, retries, privacy, and limits

- Sender state is stored at `senders/<account-id>/<sha256(normalized-email)>.json` in the private bucket. It contains the sender address, a random 256-bit secret capability, expiration/completion state, and pending message IDs with their original inbox status. A hash path is not anonymization. Restrict access, do not publish the bucket, and never paste its contents into diagnostics.
- Links put the capability in a **URL fragment**, not a request path/query, so standard HTTP access logs do not receive it. The page removes the fragment before loading Turnstile, then posts it over HTTPS. Do not enable request-body logging. The page uses no-referrer/no-store headers and a restrictive CSP.
- Links expire after 30 days while pending. If another message arrives after expiration, a new token is issued and one new challenge may be sent. Old tokens then fail. There is no periodic reminder or automatic state cleanup.
- Completion is resumable: contact creation precedes restoration, every restored message is checkpointed, and confirmation delivery is journaled. The browser can retry after failures. New incoming mail also resumes an interrupted completion. There is no standalone background reconciliation job.
- Gmail sends and People contact creation are **not transactional** with GCS. Stable Message-IDs and exact Sent searches reduce duplicate notices; the People lookup avoids ordinary duplicate contacts. An ambiguous API success followed by a crash, API indexing lag, or manual deletion can still cause duplicates. This is not an exactly-once guarantee.
- Restoring only recorded inbox messages avoids changing mail already archived by the owner's Gmail filters. A manual archive while a message is held cannot be distinguished from the original quarantine, so verification can restore that message; Trash/Spam remain respected.
- A sender record holds at most 5,000 pending messages. Hitting the cap stops cursor progress with `sender_pending_limit` rather than forgetting message IDs; complete verification or add the sender to Contacts, then retry processing. Contacts/history pagination is bounded to 100 pages; quota/page-limit errors retry rather than assuming a sender is new.
- “Never emailed before” can only be evaluated against **retained, searchable Gmail data**. Permanently deleted correspondence cannot be discovered. Message history is queried only when there is no pending/verified state; historical bodies never go to the model. Incoming timestamps are checked to avoid counting newer messages as earlier correspondence.
- Turnstile establishes that a browser passed a human check and possesses the emailed capability. It does not certify a sender's legal identity, prevent all automation, or make future mail safe. Forwarding a verification link delegates its capability. Sender headers are not cryptographic identity; anti-loop rules reduce but do not eliminate backscatter risk.
- Gmail has no conditional contact-plus-label transaction. Small races with external contact/manual-label edits remain unavoidable.

## Pausing or disabling

To stop all new Clefmail archiving, set both `archiveEnabled: false` and `humanVerification: false` on the processor's account configuration. Existing pending mail stays archived; disabling is not an automatic bulk restore.

Prefer to drain existing challenges first. During a drain, keep the public service on its previous config with the account enabled and `humanVerification: true`, while disabling new quarantine in the processor config. Existing links can still complete against the shared bucket. Once drained, disable the public config/account too. Alternatively, restore mail manually in Gmail and add trusted senders to Google Contacts. Do not delete sender state as a routine fix: pending repeats could then be mistaken for prior trusted correspondence.

## Optional diagnostic mode

The optional `humanVerificationTest: true` account setting exercises the flow with the exact
subject `Human verification test`. This requires the public verification service
and Turnstile settings. You can leave `humanVerification: false` to keep ordinary
mail on the usual labeling path.

Classification and the archive policy also run before this diagnostic mode. Only mail that remains in the inbox reaches the sender check.

The match is case-sensitive and includes whitespace. Each eligible matching incoming
message gets a separate test record and verification link, including mail from
your own address, existing contacts, and previous correspondents. Verification
restores that test message and sends a confirmation. Test records leave Google
Contacts and ordinary sender trust unchanged, so you can repeat the test by
sending another message with the same subject.

Held messages carry `Clefmail/Held`. Successful verification removes that label
and restores messages that originally arrived in the inbox. Both test and normal
verification send the same success email.

Spam, Trash, drafts, malformed sender headers, and the automatic-reply safeguards
still apply. Replies with `Re:` in the subject follow the ordinary mail policy.
Set `humanVerificationTest: false` to stop starting tests; complete outstanding
links before disabling it.
