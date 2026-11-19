# inboxmux

One MCP server for many mailboxes. Connect any number of Gmail and Microsoft 365 or Outlook.com accounts once, then use all of them from Claude, Codex or any other MCP client through a single set of tools.

Most built-in mail connectors attach exactly one account. inboxmux runs on your own machine, keeps the OAuth tokens encrypted in your OS keychain, and lets the assistant search every inbox in one call.

```text
Claude Code / Claude Desktop / Codex / any MCP client
                    |  stdio
                 inboxmux  ── encrypted token store (OS keychain)
               /    |     \
          Gmail   Gmail   Microsoft Graph (Outlook.com, Microsoft 365)
```

## Features

- Several Gmail and Microsoft accounts side by side, each with an optional short label (`work`, `home`)
- `search_messages` with `account: "all"` searches every mailbox in parallel and merges the results newest first
- Structured filters (from, to, subject, dates, unread, attachments, folder) plus each provider's native search syntax
- Read messages and whole conversations as clean text, save attachments to a local folder
- Mark read, star or flag, archive, Gmail labels and Outlook categories
- Drafts, replies and reply all with correct threading, including Gmail send-as aliases
- Sending and trashing are off by default and can be enabled separately, with a recipient allowlist
- A local web page to connect, label, check and remove accounts
- No cloud service in between. Your mail goes from the provider API straight to your MCP client

## Requirements

- Node.js 20.12 or newer
- For Gmail, a Google Cloud OAuth client of type Desktop app ([guide](docs/google-setup.md))
- For Microsoft, an Entra ID app registration ([guide](docs/microsoft-setup.md))

Each user brings their own OAuth client. inboxmux ships no shared client ID, so nobody else's quota, consent screen or verification status sits between you and your mail.

## Quick start

```bash
git clone https://github.com/kalmardani/inboxmux.git
cd inboxmux
npm install
npm link            # makes the inboxmux command available
```

Register your OAuth clients once.

```bash
inboxmux setup google --client-file ~/Downloads/client_secret_XXXX.json
inboxmux setup microsoft --client-id 00000000-0000-0000-0000-000000000000
```

Open the account manager and connect as many accounts as you like.

```bash
inboxmux ui
```

The command prints a login link that is valid while the command runs and opens it in your browser. The page listens on localhost only.

Check that everything works.

```bash
inboxmux doctor
```

## Add it to your MCP client

The server command is `inboxmux mcp`. Use the absolute path of `node` if your client does not inherit your shell `PATH` (desktop apps often do not).

**Claude Code**

```bash
claude mcp add --scope user inboxmux -- inboxmux mcp
```

**Codex**

```bash
codex mcp add inboxmux -- inboxmux mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "inboxmux": { "command": "/absolute/path/to/node", "args": ["/absolute/path/to/inboxmux/dist/index.js", "mcp"] }
  }
}
```

Accounts added later in `inboxmux ui` show up in a running server without a restart.

## Tools

| Tool | What it does | Writes |
|------|--------------|--------|
| `list_accounts` | Connected mailboxes, labels, aliases, status, enabled capabilities | no |
| `search_messages` | Search one account or `all`, with filters and paging | no |
| `get_message` | One message as text or HTML, with attachment list | no |
| `get_thread` | A whole conversation, oldest first | no |
| `list_folders` | Gmail labels or Outlook folders | no |
| `update_message` | Read or unread, star or flag, archive, add or remove labels | reversible |
| `create_draft` | New draft, reply or reply all, optional send-as alias | draft only |
| `get_attachment` | Saves an attachment to the attachments folder and returns the path | local file |
| `send_draft` | Sends a draft. Only registered when sending is enabled | yes |
| `trash_message` | Moves a message to trash. Only registered when trash is enabled | yes |

Every tool takes `account` as an email address or a label. Message and thread ids belong to the account they came from.

## Safety model

Mail is private data that strangers can write into, which makes it a prime channel for prompt injection. inboxmux limits what an injected instruction could achieve.

- **No sending by default.** `send_draft` and `trash_message` are not even registered unless you enable them. The assistant writes drafts, you press send in your mail app.
- **Recipient allowlist.** With sending enabled, `sendAllowlist` can restrict recipients to exact addresses or `@domain` entries. The server checks the saved draft, not the model's claim.
- **Untrusted content is labelled.** Every response that carries message content includes a notice that the content comes from outside senders. Invisible Unicode characters are stripped from bodies.
- **Narrow tools.** No raw HTTP or query passthrough beyond the provider search string. Ids are validated and URL encoded, paging tokens are bound to the provider host.
- **Tokens at rest.** Refresh tokens are encrypted with AES-256-GCM. The key lives in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service), or in `INBOXMUX_MASTER_KEY`, or as a last resort in a `0600` key file. Access tokens are kept in memory only.
- **Local UI hardening.** Loopback only, Host header check against DNS rebinding, secret login link per run, `SameSite=Strict` session cookie, CSRF token and Origin check on every form, PKCE and single use state for OAuth, strict CSP.
- **Audit log.** Every write action is appended to `audit.log` in the config folder, without message bodies.

Your MCP client still decides which tool calls run. Keep approval prompts on for write tools. Be careful when the same session also has tools that can reach the internet, because together with mail access that forms the combination prompt injection needs. More detail in [docs/security.md](docs/security.md).

## Configuration

Settings live in `~/.config/inboxmux/config.json` (or `$INBOXMUX_HOME`, or `$XDG_CONFIG_HOME/inboxmux`).

```json
{
  "google": { "clientId": "....apps.googleusercontent.com", "clientSecret": "..." },
  "microsoft": { "clientId": "GUID", "tenant": "common" },
  "capabilities": { "send": false, "trash": false },
  "sendAllowlist": ["@mycompany.com", "friend@example.com"],
  "attachmentsDir": "/Users/me/Downloads/inboxmux",
  "uiPort": 8765
}
```

Environment variables override the file.

| Variable | Meaning |
|----------|---------|
| `INBOXMUX_HOME` | Config folder |
| `INBOXMUX_GOOGLE_CLIENT_ID`, `INBOXMUX_GOOGLE_CLIENT_SECRET` | Google OAuth client |
| `INBOXMUX_MICROSOFT_CLIENT_ID`, `INBOXMUX_MICROSOFT_CLIENT_SECRET`, `INBOXMUX_MICROSOFT_TENANT` | Microsoft app |
| `INBOXMUX_ALLOW_SEND`, `INBOXMUX_ALLOW_TRASH` | `1` or `true` to enable |
| `INBOXMUX_ATTACHMENTS_DIR` | Where `get_attachment` saves files |
| `INBOXMUX_UI_PORT` | Port of the account manager (default 8765) |
| `INBOXMUX_MASTER_KEY` | Base64 encoded 32 byte key instead of the keychain |
| `INBOXMUX_NO_KEYCHAIN` | `1` to skip the keychain |
| `INBOXMUX_LOG` | `debug` for verbose stderr logging |

Changing the Microsoft tenant or enabling sending later requires reconnecting Microsoft accounts so they grant `Mail.Send`.

## Command line

```text
inboxmux mcp                      run the MCP server on stdio
inboxmux ui [--no-open] [--port]  account manager in the browser
inboxmux accounts                 list accounts
inboxmux label <account> <label>  set a label (use - to clear)
inboxmux remove <account>         disconnect and revoke
inboxmux doctor                   check config, key storage and every account
inboxmux setup google|microsoft   register OAuth clients
inboxmux import google            import an existing Google refresh token from stdin
```

## Scope and roadmap

Version 0.1 covers Gmail and Microsoft Graph mailboxes over stdio. The Gmail adapter has been used against real mailboxes. The Microsoft adapter is covered by contract tests and its sign in flow was checked against two Microsoft 365 tenants, but it has not yet read a live mailbox, because both tenants required administrator approval. Reports from Microsoft users are welcome. Planned next are a generic IMAP and SMTP adapter, attachments on drafts, a remote Streamable HTTP mode for web and mobile clients, and calendar access.

## Development

See [DEVELOPER.md](DEVELOPER.md) for the architecture, the design decisions and the test setup.

## License

MIT
