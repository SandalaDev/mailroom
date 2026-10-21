# Security and privacy

This prototype handles email and provider credentials. Publishing its source does not publish runtime data; distributing a runtime folder or backup can expose both. The repository starts from a clean history and uses a default-deny file allowlist, but those controls do not replace review.

## Never publish

- Email exports, real message bodies, sender lists, Gmail IDs or private preferences.
- SQLite databases, journals, logs, screenshots or test reports containing real data.
- API tokens, OAuth client files, refresh tokens or DPAPI credential files.
- Archives of a configured installation or copies of a data folder.

Even an encrypted credential file must stay private. If a credential reaches Git history, revoke it immediately. Deleting it from the latest version does not remove it from old commits or existing clones.

## Runtime limits

Credentials are encrypted with Windows DPAPI for the current Windows account. Local email and policy data in SQLite are not encrypted by the application. Someone able to run code as that Windows user may be able to access both data and credentials. Protect the machine and its backups.

The loopback server validates Host, Origin and a per-process request key, and exposes only an explicit static asset set. It must not be bound to a public interface or placed behind a public tunnel. These checks do not defend against malware or a fully compromised local browser profile.

Email, HTML, and model outputs are untrusted. Mailroom renders email as text, does not fetch remote email images, validates fixed model outputs, and uses retention guards. These measures reduce risk; they do not prove resistance to all prompt injection or classification errors. No email-authored instruction can authorize a tool call, policy change, reply or deletion.

The standalone Gmail OAuth scope is read-only. Optional Codex tools can have broader permissions; that workflow must independently enforce its allowed actions. A ledger receipt is not an atomic transaction with Gmail and is not proof of OS notification delivery.

## Report a vulnerability

Do not include credentials or real emails in a public issue. Use GitHub's **Security → Report a vulnerability** if private vulnerability reporting is enabled. If unavailable, open a public issue containing only a request for a private reporting channel. Use synthetic reproductions.

Only the current main branch is maintained. No response-time or security warranty is offered.
