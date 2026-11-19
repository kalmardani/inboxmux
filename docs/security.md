# Security notes

inboxmux handles two sensitive things, long lived OAuth refresh tokens and the content of your mailboxes. This page lists the trust boundaries, the threats considered for version 0.1 and how each one is handled.

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
| Prompt injection in a message makes the model send mail or delete messages | Sending and trash tools are not registered unless enabled in config. Sending checks recipients against `sendAllowlist` on the saved draft. Tool annotations mark send and trash as destructive so clients prompt. Responses carry an untrusted content notice |
| Prompt injection exfiltrates data through a draft | Drafts never leave the mailbox without a human or an enabled `send_draft`. Draft attachments from local files are not supported in 0.1 |
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
- `gmail.modify` technically allows sending. The restriction lives in inboxmux, not in the Google token.
- If the keychain is unavailable, the key falls back to a `0600` file next to the token store. That protects against other users, not against software running as you.
- Version 0.1 has not been through an external security review.

## Reporting

Please report vulnerabilities privately through GitHub security advisories on the repository instead of opening a public issue.
