# Mailroom

Local-first email triage using Cloudflare's Clef decision model, with optional Codex review of exceptions.

**Prototype · Observe mode by default · Windows credential storage**

Mailroom proposes where emails belong, records why a decision needs review, and keeps an audit trail. It does not send email, move mail to Trash, or permanently delete messages. Its Gmail authorization is read-only.

## How it works

    Gmail → exact sender rules → Clef typed decisions → guarded queue → optional Codex review

Destinations: Needs you, Review, Digest, Archive, and Holding. These are proposals in Observe mode. Clef selects from bounded options and returns probabilities; it does not generate free-form summaries or directly control Gmail.

The app is built with Node.js built-ins, SQLite, and a plain HTML/CSS/JavaScript interface. It has no npm dependencies. All shipped demo messages and test fixtures are fictional. No mailbox exports, credentials, personal configuration, test reports, or screenshots are included.

## Run locally

Requires Node.js 22.13 or newer. Windows is required for credential encryption and live provider setup; credentials use the current Windows account's DPAPI protection.

1. Clone this repository.
2. Double-click **Start Mailroom.cmd** on Windows, or run `npm start` for the demo interface.
3. Open **http://127.0.0.1:4317**.
4. Select **Load example decisions** to explore without connecting an account.

Keep the process running for background classification. It polls every five minutes after both providers are connected. It is not an installed background service, and the computer must remain awake. UTC is the public default for date display and follow-up dates.

## Connect your own accounts

### Cloudflare Clef

In Cloudflare Workers AI, open **Use REST API**, create an account-scoped Workers AI token using the provider's template, and copy the token and Account ID into Mailroom's Connections page. The app tests a fictional message before storing the connection. Model use may incur provider charges.

### Gmail

Enable Gmail API in your own Google Cloud project, configure the Google Auth Platform consent screen, and create a **Desktop app** OAuth client. If using test mode, add your own email as a test user. Select the downloaded client JSON in Mailroom and complete Google's consent flow. The app requests only `gmail.readonly`.

Initial ingestion covers the last seven days; subsequent runs use Gmail history. Expired history triggers a documented seven-day catch-up, not an unlimited mailbox recovery. OAuth testing restrictions and organization policies may require reconnection or additional configuration.

## Privacy boundaries

- Credentials live in an encrypted local `data/credentials.dpapi` file. Never commit or share it, even though it is encrypted.
- Emails, policy, queue records and audit logs live in `data/triage.sqlite`. **The SQLite database is not encrypted by this app.**
- Email content selected for classification is transmitted to Cloudflare. Local-first storage does not mean inference stays on your computer.
- Optional Codex review sends selected content to the services involved in that review.
- Set `TRIAGE_DATA_DIR` to use a different runtime folder. Do not point it at a shared or tracked directory.
- The server binds to loopback only. It is not designed for public hosting, shared-machine access, or exposure through a tunnel.
- The project has no telemetry or analytics.

See [SECURITY.md](SECURITY.md) for limitations and safe contribution practices.

## Optional Codex workflow

This repository does not install Codex schedules. A connected Gmail account in Codex can be used for assisted review, but the standalone background process cannot borrow that account's authorization.

Configure your own schedules if desired. [CODEX-RUNBOOK.md](CODEX-RUNBOOK.md) describes queue review, limits, health checks and confirmed action receipts. Keep Observe mode until a representative evaluation is reviewed. Archive and Holding proposals must not be treated as permission to delete mail.

## Commands

    npm test
    npm run release:check
    npm run hooks:install
    node --disable-warning=ExperimentalWarning cli.mjs health
    node --disable-warning=ExperimentalWarning cli.mjs queue
    node --disable-warning=ExperimentalWarning cli.mjs message MESSAGE_ID
    node --disable-warning=ExperimentalWarning cli.mjs digest
    node --disable-warning=ExperimentalWarning cli.mjs waiting
    node --disable-warning=ExperimentalWarning cli.mjs audit

The `ack` command records an external action only after its provider confirms success. It accepts structured JSON on stdin and does not itself modify Gmail. Do not run a live mailbox workflow in public CI.

### Optional GitHub Actions

`scripts/ci-template.yml` is an inactive workflow template. To enable it, copy it to `.github/workflows/ci.yml` using an account authorized to manage workflows, and deliberately add that path to the publication allowlist and release checker. It runs only synthetic tests and the source privacy check with read-only repository permissions. No live provider secrets are needed. CI is not enabled by the initial release.

## Current limitations

- This is an early prototype, not a production email security or urgent-alert system.
- Model certainty is not a calibrated accuracy guarantee. Conservative thresholds can route most messages to Review.
- Attachments are not automatically read, and long or incomplete context prevents silent hiding.
- A later success can supersede an older failure; thread reconciliation still needs review.
- Notifications require separately configured Codex scheduling and verified delivery.
- No independent outage watchdog, automatic startup, or automatic Trash release is installed.
- The settings support only one Gmail account per data folder.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). This project is available under the [MIT license](LICENSE). Clef is a separate model with its own terms; its weights are not bundled here. Mailroom is not an official Cloudflare, Google or OpenAI product.

## Provider documentation

- [Clef API](https://developers.cloudflare.com/workers-ai/models/clef/)
- [Official Clef model card](https://huggingface.co/Cloudflare/clef)
- [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)
