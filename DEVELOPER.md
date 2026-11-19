# inboxmux developer guide

This file explains how inboxmux is put together, why it is built this way, and where the traps are. Read it before changing anything non trivial.

## What it is in one paragraph

inboxmux is a local MCP server (stdio) that exposes several mailboxes through one tool set. Accounts are connected through a small loopback web UI with OAuth 2.0 authorization code and PKCE. Refresh tokens are stored encrypted, the master key sits in the OS keychain. Each tool call resolves an account by email or label, picks the provider adapter (Gmail REST API or Microsoft Graph), and returns JSON text. Sending and trash are on by default. Every send or trash call goes through the MCP client's approval prompt, and the config can remove either tool.

## Stack

- TypeScript, compiled by `tsc` (TypeScript 7), ES modules, Node 20.12 or newer
- `@modelcontextprotocol/sdk` 1.32 (MCP protocol version 2025-11-25), `zod` 4 for tool schemas and config validation
- `@napi-rs/keyring` as an optional dependency for the OS keychain
- `vitest` for tests
- No HTTP framework, no Google or Microsoft SDK. Both APIs are called with `fetch`, which keeps the dependency tree small and auditable

## Layout

```text
src/
  index.ts            CLI entry and command dispatch (mcp, ui, accounts, label, remove, setup, import, doctor)
  server.ts           MCP tool definitions, input schemas, gating, audit log, response size limit
  config.ts           config.json schema and INBOXMUX_* overrides
  store.ts            account list (accounts.json), per account encrypted refresh tokens, file lock
  crypto.ts           master key lookup (env, keychain, key file) and AES-256-GCM
  tokens.ts           access token cache, deduplicated refresh, rotation write back
  oauth.ts            authorization URL, code exchange, refresh, revoke for both providers
  http.ts             fetch with timeout and retry, error mapping, authed client per account
  fsutil.ts           atomic write and lock file
  log.ts              stderr logger (stdout belongs to MCP)
  types.ts            shared types, MailProvider interface, UserFacingError
  providers/
    gmail.ts          Gmail adapter, query builder, MIME walking
    graph.ts          Microsoft Graph adapter, $search and $filter builder, page token guard
    mime.ts           address parsing, RFC 2047, RFC 5322 message builder
    text.ts           HTML to text, entities, invisible character stripping, truncation
    index.ts          provider factory and per process registry
  ui/
    server.ts         loopback account manager, OAuth callbacks, CSRF and Host checks
    page.ts           HTML templates with escaping
test/                 unit and integration tests, see below
docs/                 user facing setup guides and security notes
```

Dependencies point inward. `server.ts` knows only the `MailProvider` interface and an account directory. Providers know only an `AuthedClient`. Nothing below `index.ts` reads environment variables except `config.ts`, `crypto.ts` and `log.ts`.

## Data on disk

Everything lives in the config folder (`$INBOXMUX_HOME`, else `$XDG_CONFIG_HOME/inboxmux`, else `~/.config/inboxmux`), files `0600`, folder `0700`.

| File | Content |
|------|---------|
| `config.json` | Client ids, Google client secret, capabilities, allowlist, ports. Validated strictly, unknown keys are an error |
| `accounts.json` | `{ version: 1, accounts: [...] }`. Metadata in clear, `token` is `v1.<iv>.<tag>.<ciphertext>` with the email as AAD |
| `accounts.lock` | Exists only while a write is in progress. Stale after 10 seconds |
| `master.key` | Only when no keychain is available |
| `audit.log` | JSON lines for write tools, no bodies |

The keychain entry is service `inboxmux`, account `master-key`. On macOS the item ACL trusts the Node binary that created it. Running inboxmux with a different Node binary later triggers a one time keychain prompt.

## Request flow

1. The MCP client calls a tool. zod validates the input shape, `server.ts` validates the semantics (one account vs `all`, required fields).
2. `AccountStore.resolve` reads `accounts.json` fresh from disk, so accounts added in the UI appear without a restart.
3. `ProviderRegistry` returns the cached adapter for that account. The adapter asks `TokenManager` for an access token, which refreshes when less than a minute is left and shares one refresh between concurrent calls.
4. `authedClient` adds the bearer token, retries idempotent requests on 429 and 5xx with backoff (honouring Retry-After up to 10 s), retries once with a forced refresh on 401, and maps failures to `UserFacingError`.
5. The tool returns pretty printed JSON capped at 400 000 characters. Message bodies are capped by `maxChars` before that.

## Design decisions

**Bring your own OAuth client.** A shared client id would need Google restricted scope verification (a paid security assessment) and would make every user depend on the maintainer's quota and consent screen. Personal clients avoid both.

**Gmail scope `gmail.modify` only.** It covers read, labels, drafts, send and trash. `gmail.compose` alone cannot read, `gmail.readonly` cannot write drafts. When sending is switched off, the restriction is enforced in inboxmux.

**Microsoft `Mail.Send` follows the send setting.** It is requested when sending is on at connect time (the default). An account connected with sending off never holds send rights.

**Sending on by default (0.2).** People install a mail tool to handle mail, and a read and draft only default sent everyone to the config file first. The barrier against prompt injection is the client's approval prompt: send and trash tools carry `destructiveHint`, Claude and Codex ask before each call, and the server instructions ask the model to show recipients, subject and text before sending. `sendAllowlist` and the capability switches remain for stricter setups.

**One send path.** `send_message` creates a draft and sends it, so the allowlist always checks the recipients the provider actually saved (reply all expands them server side) and a blocked message stays as a draft for the user.

**Tools are removed, not refused.** With a capability off, its tools are not registered at all. A model cannot call or be talked into calling a tool it does not see.

**Local attachments.** The model passes file paths. `attachments.ts` resolves links with `realpath`, requires the result to sit below one of `attachmentSources`, refuses any hidden path segment below that folder and anything inside the config folder, and caps the total at 25 MB. The client shows the paths in its approval prompt.

**Forwarding.** Gmail has no forward endpoint, so inboxmux builds the forward itself (new text, the original header block and body, the original attachments by part id, `Fwd:` subject, same thread). Graph uses `createForward`, which copies the attachments server side. HTML forwards on Graph patch the new text in right after the `<body>` tag, because `comment` is text only.

**Large messages.** The Gmail JSON draft endpoint rejects requests near 5 MB, so raw messages above 3.5 MB go through the upload endpoint as `multipart/related`. Graph accepts about 4 MB per request, so files above 2.5 MB use an upload session in 320 KiB multiples. The session URL is pre-authenticated, checked to be HTTPS on an Outlook host, and called without the bearer token (`AuthedClient.external`).

**Moves.** `update_message` takes `moveTo`. Gmail has labels, so a move adds the target label and drops `INBOX` and `SPAM`, and a trashed message is untrashed first. Graph moves to `inbox`, `archive`, `junkemail` or a folder found by id or name. Trash stays a separate tool.

**Stable attachment ids for Gmail.** Gmail returns a new `attachmentId` on every message fetch. inboxmux exposes the MIME `partId` and resolves the current attachment id at download time.

**Immutable ids for Graph.** Every Graph request sends `Prefer: IdType="ImmutableId"`, otherwise archiving or moving a message changes its id and breaks follow up calls.

**Graph search strategy.** Graph rejects `$search` combined with `$filter` on messages. Queries with free text or address or subject terms become a KQL `$search`. Queries with only dates, unread or attachment flags become `$filter` with `$orderby=receivedDateTime desc`, which requires `receivedDateTime` to be the first filter clause, hence the `ge 1900-01-01` default. Unread on the `$search` path is filtered client side, so a page can come back shorter than `limit`.

**Search across accounts.** `account: "all"` runs every account in parallel with the same per account limit and merges by date. A failing account becomes an `error` entry in `accounts`, the others still return. Paging is per account.

**No HTML parser dependency.** `htmlToText` is regex based. It is good enough for reading mail and keeps the attack surface small. It removes scripts, styles, comments and invisible characters and keeps link targets.

**Post/redirect/get in the UI.** Every POST ends in a 303 to `/?flash=<id>` so a reload never repeats an action.

## Traps found while building

- `Referrer-Policy: no-referrer` makes Chromium send `Origin: null` on same origin form posts, which the CSRF check rightly rejects. The UI uses `same-origin`.
- The CSP `form-action` directive also applies to redirects after a form post, so the provider sign in origins must be listed there.
- Browsers may resolve `localhost` to `::1`. The UI listens on `127.0.0.1` and `::1`.
- Google refresh tokens of an External app in Testing status expire after seven days. The setup guide tells users to publish the app.
- On the consent screen Google lets users untick individual scopes. The callback checks that `gmail.modify` was actually granted.
- Microsoft rotates refresh tokens. `TokenManager` writes the new token back, under the store lock.
- stdout is the MCP channel. All logging goes through `log.ts` to stderr.

## Tests

```bash
npm test          # vitest, about 60 tests, no network
npm run typecheck
```

| File | Covers |
|------|--------|
| `store.test.ts` | encryption, AAD binding, tamper detection, labels, reconnect, damaged file |
| `mime.test.ts` | address parsing, RFC 2047 both ways, header injection, multipart, attachments with encoded and sanitised filenames, HTML to text |
| `gmail.test.ts` | query builder, metadata search, charset decoding, part id attachments, threaded reply with alias, forward with original attachments, upload endpoint and 25 MB cap, moves and untrash, label creation, id encoding |
| `graph.test.ts` | `$search` and `$filter` paths, page token host guard, Prefer header, reply drafts, category merge, moves, folder creation, `createForward`, inline and chunked attachments without the token, upload host guard |
| `http.test.ts` | retry rules, 401 refresh, error mapping |
| `server.test.ts` | MCP over an in memory transport, tool gating, annotations, cross account search with a failing account, input validation, audit log, one step send, allowlist keeps the draft, local attachment rules (hidden, links, config folder, outside), moves, folder creation, saved attachment path safety |
| `config.test.ts` | defaults, file and environment switches, `~` expansion, strict keys |
| `ui.test.ts` | Host check, login link, CSRF and Origin, full Google OAuth flow against a fake token endpoint, replayed state, HTML escaping, removal with revocation |

Tests run with `INBOXMUX_MASTER_KEY` and `INBOXMUX_NO_KEYCHAIN=1` and a temporary config folder, so they never touch the real keychain or accounts.

### Live check

A quick end to end run against real accounts after `npm run build`.

```bash
inboxmux doctor                       # every account refreshes
inboxmux ui                           # connect, check, label in the browser
```

Then from an MCP client call `list_accounts`, `search_messages` with `account: "all"`, `get_message`, `get_thread`, `list_folders` and `create_draft`. A token without `gmail.modify` must fail the draft with the reconnect hint, not with an internal error. For the write path send a message to yourself with a local attachment, forward it to yourself, move it to spam and back with `moveTo: "inbox"`, and trash and restore it.

## Release

1. Update `CHANGELOG.md` and the version in `package.json`.
2. `npm run typecheck && npm test && npm run build`.
3. Tag `vX.Y.Z` and push. CI runs on Linux, macOS and Windows with Node 20, 22 and 24. GitHub Actions are pinned to commit SHAs.

## Roadmap ideas

- IMAP and SMTP adapter behind the same `MailProvider` interface
- Streamable HTTP transport with OAuth for remote clients
- Calendar tools for the same accounts
