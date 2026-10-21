# Contributing

Use synthetic messages and reserved example domains (`example.test`, `example.com`, `example.org`, `example.net`). Do not paste real provider output, mail, account identifiers, credentials or screenshots into issues, pull requests or tests.

The project intentionally has no npm dependencies. Node.js 22.13 or newer is required. Run `npm test` and `npm run release:check` before committing. Install the optional local pre-commit hook with `npm run hooks:install`.

The `.gitignore` is a default-deny allowlist. When adding a new source file, update both the allowlist and `scripts/release-check.mjs` deliberately. Never use `git add -f` to add runtime files. The release check inspects the staged tree and rejects unexpected paths, symlinks, non-example email addresses, personal machine paths, binary artifacts and common secret formats.

The scanner is a guardrail, not a guarantee that a file is safe. Review `git diff --cached` and the complete staged file list, including commit author metadata. The optional CI template is inactive until installed; when enabled, use fictional fixtures only and never supply live provider credentials or mailbox exports.

Keep Observe mode as the default. Do not add message sending, permanent deletion, broader OAuth scopes or public network exposure as incidental changes. Tests should verify behavior and failure handling rather than simply repeat implementation details.
