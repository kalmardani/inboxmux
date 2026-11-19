# Security notes

inboxmux handles two sensitive things, long lived OAuth refresh tokens and the content of your mailboxes. This page lists the trust boundaries, the threats considered for version 0.2 and how each one is handled.

## Trust boundaries

| Boundary | Inside | Outside |
|----------|--------|---------|
| MCP stdio | inboxmux process | MCP client and the language model driving it |
| Provider APIs | inboxmux | Google and Microsoft endpoints, and every sender whose mail they return |
| Local web UI | inboxmux process | Any web page open in the same browser |
| Disk | Encrypted token store, config, audit log | Other users and processes on the machine |

Message content crosses the provider boundary and then the MCP boundary. It is written by strangers and treated as untrusted data everywhere.

## Threats and mitigations

| Threat | Mitigation |
|--------|------------|
| Prompt injection in a message makes the model send mail or trash messages | Send and trash tools are marked destructive, so MCP clients ask the user before every call. Server instructions tell the model to send only on the user's request and to show recipients, subject and text first. Responses carry an untrusted content notice. `sendAllowlist` limits recipients and is checked on the saved draft. `capabilities.send` and `capabilities.trash` remove the tools. Trash is reversible |
| Prompt injection exfiltrates mail or local files by sending them | The approval prompt shows recipients and attachment paths. Local files are read only below `attachmentSources` (home folder by default), after resolving links. Hidden files and folders anywhere below the source (`.ssh`, `.aws`, `.env`, `.config`) and the inboxmux config folder are refused. 25 MB cap per message |
| Attachment upload URL sends data or the token elsewhere | Microsoft upload sessions are only used when the returned URL is HTTPS on an Outlook host, and the bearer token is never sent to it |
| Model passes crafted ids to reach other API paths | Ids are validated against a strict character set and URL encoded into a single path segment |
| Paging token redirects the bearer token to another host (SSRF) | Microsoft next links are wrapped and only accepted when they start with the Graph base URL |
| Header injection in drafts (adding Bcc recipients) | Every header value is rejected when it contains CR, LF or NUL |
| Attachment filename escapes the attachments folder | Filenames are reduced to a safe basename, the final path is checked to stay inside the folder |
| Stolen `accounts.json` | Refresh tokens are AES-256-GCM encrypted, the key is in the OS keychain. Each ciphertext is bound to its account with additional authenticated data |
| Another web page drives the local UI (CSRF, DNS rebinding) | Loopback bind, Host allowlist, secret login link per run, `SameSite=Strict` cookie, form token and Origin check on every POST, strict CSP, `X-Frame-Options: DENY` |
| OAuth code interception or injection | PKCE (S256) plus a random, single use, ten minute state value |
| Secrets in logs | Logs go to stderr, never include tokens or message bodies. Unexpected errors return a generic message to the model |
| Two processes writing the store at once | Every write is a locked read, modify, atomic rename cycle |

## Residual risks

- The model sees the content of every message it reads. Anything you would not paste into a chat should not be read through inboxmux.
- When the same MCP session also has a tool that can fetch URLs or post anywhere, a malicious message can try to make the model leak data through that tool. Keep approvals on for such tools, or run mail work in a session without them.
- With sending on, the approval prompt of the MCP client is the main barrier between a malicious message and an outgoing mail. Never auto-approve `send_message`, `send_draft` or `trash_message`, and switch sending off where you only read.
- `gmail.modify` allows sending. When sending is switched off, the restriction lives in inboxmux, not in the Google token.
- If the keychain is unavailable, the key falls back to a `0600` file next to the token store. That protects against other users, not against software running as you.
- Version 0.2 has not been through an external security review.

## Reporting

Please report vulnerabilities privately through GitHub security advisories on the repository instead of opening a public issue.
