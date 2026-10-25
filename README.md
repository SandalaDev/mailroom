# Mailroom

Local-first email triage using Cloudflare's Clef decision model, with optional Codex review of exceptions.

**Prototype · Observe mode by default · Windows credential storage**

Mailroom proposes where emails belong, records why a decision needs review, and keeps an audit trail. It never sends email or permanently deletes messages. Gmail authorization is read-only by default; optional cleanup permission enables separately confirmed archive, Trash, and restore actions in Organize mode.

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

Enable Gmail API in your own Google Cloud project, configure the Google Auth Platform consent screen, and create a **Desktop app** OAuth client. If using test mode, add your own email as a test user. Select the downloaded client JSON in Mailroom and complete Google's consent flow. The default connection requests `gmail.readonly`. To apply cleanup actions, explicitly select **Allow reviewed cleanup** and reconnect; this requests `gmail.modify`. Google grants broader capabilities with that scope, but the app implements only confirmed archive, Trash, and restore operations. The permission shown by the app reflects the scope Google actually granted.

Initial ingestion covers the last seven days; subsequent runs use Gmail history. Expired history triggers a documented seven-day catch-up, not an unlimited mailbox recovery. OAuth testing restrictions and organization policies may require reconnection or additional configuration.

## Intelligent cleanup

Open **Cleanup** to scan historical mail, separately from the seven-day inbox sync. Save an age threshold, minimum size, and either all received mail (including Spam) or Spam only. A scan continues across Gmail pages automatically, with a default review limit of 1,000 messages and model budget of 10,000 neurons per run. **Pause** checkpoints the current page; **Resume scan** continues remaining IDs without repeating completed classifications. The daily app model budget also applies. Set minimum age to 0 to scan any age; a positive value includes every older message, with no maximum lookback. **Start a fresh scan** restarts pagination while preserving resolved choices. Classifications may incur Cloudflare charges.

Recommendations are **Keep**, **Archive**, **Review**, or **Delete candidate**, with reasons and approximate message sizes. Important senders, starred mail, important records, local corrections, attachments, conversation context and active projects are guarded. Age alone never authorizes deletion. Inspect a message and any attachments in Gmail; you can save your own cleanup decision after confirming your review. That records a proposal and does not move mail.

Select individual messages, review the exact selection, and explicitly confirm the action. Mailbox changes require cleanup permission and Organize mode. Keep dismisses proposals locally without changing Gmail. Archive removes Inbox and Spam labels while preserving unrelated labels and unread status. Delete moves individual messages to Trash; it does not permanently delete them. **Resolved / history** offers separately confirmed restoration from Trash when a valid post-action snapshot is available. Restore removes Trash; it does not recreate original Inbox placement. Changed messages, conversations, rules or local corrections invalidate prior approvals. Ambiguous network outcomes are shown for manual reconciliation in Gmail, never automatically retried.

**Archiving frees no space. Spam and Trash still count toward storage.** Gmail normally permanently deletes Trash after 30 days; recover before then or manage permanent deletion yourself in Gmail. Size totals are estimates of candidate messages, not a live quota reading or immediate reclaimed space. See [Google's deletion guide](https://support.google.com/mail/answer/7401?hl=en) and [storage guide](https://support.google.com/mail/answer/9312312?hl=en). Gmail's Spam folder normally clears after 30 days, so choose a short age such as 7 days for Spam-only scans; search all received mail for years of accumulated unwanted messages.

Periodic reviews are off by default. Choose a daily, weekly, or 30-day review and optionally a minimum matching-message backlog. Each scheduled review runs through pages within the configured review and model limits; it never moves mail. Pending reviews appear in the Cleanup badge while the server and computer are running. There is no separate notification service. Resolved candidates are suppressed in later scans. Cleanup records and action receipts remain in the local, unencrypted database.

## Model usage and subscriptions

A usage meter appears on every screen. The selected Workers Paid plan has a $5/month base fee, separate from Workers AI usage. Both Workers plans include 10,000 neurons per UTC day; paid overage is $0.011 per thousand neurons. Clef is $0.24/million input tokens (21,818 neurons/million); Clef Flash is $0.038/million (3,455 neurons/million), with no output-token charge. Rates were checked on 25 October 2026 against [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

The ledger records connection tests, normal classification and cleanup calls, including reported input usage from invalid model responses. Neurons and costs are estimates; calls without usage retain conservative budget reservations. Historical cleanup token usage was not logged and cannot be reconstructed. The meter shows this app's share of the included daily allowance, not account-wide remaining quota or a verified invoice. Other workloads share the provider allocation. The plan label is user-selected, not read from billing. Usage details let you set a daily app budget. No OpenAI API connection is added; reviews in the chat use the existing Codex workflow.

Cleanup supports filtering by sender, paged results, and selecting up to 50 visible messages for a reviewed action. The local operator bridge lets this chat inspect reports and control scans through the running app. It uses a per-process session key and never exports provider credentials:

    node cli.mjs operator report
    node cli.mjs operator message MESSAGE_ID

Operator scan, pause, review, preview, apply and subscription-ack commands accept structured JSON on stdin. Mailbox changes still require Organize mode and explicit reviewed confirmation.

New trial and renewal emails are detected locally and placed in **Subscriptions**. Exact full dates are candidates, never trusted without checking the source; ambiguous or missing dates stay for review. The chosen reminder offsets are 3 days and 1 day before, in Africa/Lusaka. A separately configured Codex heartbeat uses the existing Google Calendar connector, checks duplicates, and records confirmed event IDs. Review-first is the default, adjustable on Subscriptions. This code does not independently connect to Google Calendar or silently create events. Local scheduled checks need the computer, desktop app, and local server running; already-created Calendar reminders are delivered by Google Calendar.

## Privacy boundaries

- Credentials live in an encrypted local `data/credentials.dpapi` file. Never commit or share it, even though it is encrypted.
- Emails, policy, queue records and audit logs live in `data/triage.sqlite`. **The SQLite database is not encrypted by this app.**
- Email content selected for classification is transmitted to Cloudflare. Local-first storage does not mean inference stays on your computer.
- Optional Codex review sends selected content to the services involved in that review.
- Set `TRIAGE_DATA_DIR` to use a different runtime folder. Do not point it at a shared or tracked directory.
- The server binds to loopback only. It is not designed for public hosting, shared-machine access, or exposure through a tunnel.
- The project has no telemetry or analytics.

See [SECURITY.md](SECURITY.md) for limitations and safe contribution practices.

Brand and UI tokens: see [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).

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
