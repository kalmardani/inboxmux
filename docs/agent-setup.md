# Setting up inboxmux with an AI agent

This guide is written for an AI agent with a shell, such as Claude Code or Codex, that sets up inboxmux for its user from start to finish. That includes the OAuth app, the accounts and the MCP client. A person can follow it just as well.

## For the person

Paste this into Claude Code, Codex or a similar agent, in any language:

```text
Set up inboxmux for me (https://github.com/kalmardani/inboxmux).
Follow docs/agent-setup.md from that repository step by step,
including the Google and Microsoft OAuth apps, connect my mail accounts,
and add the MCP server to the clients I use.
```

The agent does the commands and, if it has browser tools, most of the clicking. You still do the parts only you can do: signing in to Google Cloud and Microsoft Entra, passwords and two step verification, accepting terms, and approving each mailbox on its consent screen.

## Rules for the agent

- Speak the user's language. Do one step at a time and say what you did before moving on.
- The user types passwords, verification codes and recovery answers. Never type them yourself and never ask for them in chat.
- Accepting terms of service, ticking policy agreements and approving consent screens are the user's clicks. Point at the button and wait.
- Only use OAuth clients the user owns. Never borrow the client ID of another app, and never try to route around an organisation's admin approval policy.
- Nothing here costs money. Do not create a billing account, a paid subscription or any paid resource.
- Treat the Google client secret and every token as secrets. Do not print them in chat, do not commit them, do not put them in URLs.
- Do not send mail during setup. A test message is only allowed with the user's explicit yes, and only to the user's own address.
- Respect an existing installation. If `~/.config/inboxmux/config.json` exists, run `inboxmux doctor` first and only add what is missing.
- If you run in a mode that skips approval prompts (Claude Code bypass permissions, Codex full auto, scheduled or unattended runs), recommend switching sending off in step 5, because the approval prompt is what protects the user from a malicious email asking you to send mail.

## Step 0. Ask before you start

Find out, in one short message:

1. Which mailboxes to connect: Gmail or Google Workspace, Outlook.com, Microsoft 365 work accounts. Only the providers that appear here need an OAuth app.
2. Which MCP clients to configure: Claude Code, Codex, Claude Desktop, other.
3. Whether the assistant may send and trash mail (default yes, every call needs the user's approval in the client), or only read and draft.
4. Which folders may hold files to attach (default the home folder).

## Step 1. Prerequisites

```bash
node --version    # 20.12 or newer
npm --version
git --version
```

If Node is missing or too old, ask before installing. Common choices are nvm on macOS and Linux and the installer from nodejs.org or `winget install OpenJS.NodeJS.LTS` on Windows.

## Step 2. Install

```bash
git clone https://github.com/kalmardani/inboxmux.git ~/inboxmux
cd ~/inboxmux
npm install          # also builds dist/
node dist/index.js --version
```

Recent npm versions may report that the install scripts of `fsevents` were not run. That package only serves the test runner, inboxmux works without it. If `dist/` is missing after the install, run `npm run build`.

Note two absolute paths for later. On macOS and Linux:

```bash
command -v node                      # NODE, for example /Users/me/.nvm/versions/node/v24.x/bin/node
echo "$HOME/inboxmux/dist/index.js"  # INBOXMUX
```

On Windows use `where node` and `%USERPROFILE%\inboxmux\dist\index.js`.

Optionally run `npm link` inside the repository to get an `inboxmux` command. Where this guide writes `inboxmux`, `"$NODE" "$INBOXMUX"` works the same.

## Step 3. Google OAuth client (only for Gmail)

One client serves every Gmail account. Replace `PROJECT_ID` in the links once the project exists. With browser tools, drive the console yourself and hand over at each sign in, terms or policy checkbox. Without them, give the user one step at a time.

1. The user signs in at https://console.cloud.google.com with any Google account that should own the app. It does not have to be one of the mailboxes. A first visit may ask the user to accept the Google Cloud terms.
2. Create a project at https://console.cloud.google.com/projectcreate, name `inboxmux`, no organisation needed, then **Create**. No billing account is required. Note the project ID.
3. Enable the Gmail API at https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=PROJECT_ID with **Enable**.
4. Open https://console.cloud.google.com/auth/overview?project=PROJECT_ID and click **Get started**.
   - App name `inboxmux`, user support email the user's address.
   - Audience **External**. Choose **Internal** only if every mailbox belongs to one Google Workspace organisation and the project was created inside it.
   - Contact email the user's address.
   - The user ticks the Google API Services User Data Policy agreement, then **Create**.
5. Open https://console.cloud.google.com/auth/scopes?project=PROJECT_ID, click **Add or remove scopes**, enter `https://www.googleapis.com/auth/gmail.modify` under **Manually add scopes**, **Add to table**, **Update**, then **Save**.
6. Open https://console.cloud.google.com/auth/audience?project=PROJECT_ID, click **Publish app** and confirm. The status must read **In production**. In **Testing** Google expires refresh tokens after seven days and blocks accounts that are not listed as test users. Verification is not needed for personal use, up to 100 users.
7. Open https://console.cloud.google.com/auth/clients/create?project=PROJECT_ID, application type **Desktop app**, name `inboxmux desktop`, **Create**, then **Download JSON**. The file is named `client_secret_<...>.json` and usually lands in the Downloads folder.
8. Register it and remove the downloaded copy, inboxmux keeps the values in its own `0600` config file:

```bash
inboxmux setup google --client-file ~/Downloads/client_secret_XXXX.json
rm ~/Downloads/client_secret_XXXX.json
```

If the user already has a Desktop client in another project, reusing it is fine. A **Web application** client works only after adding `http://localhost:8765/oauth/google/callback` as a redirect URI, so prefer Desktop.

Google Workspace accounts can be blocked by the organisation. The Workspace admin can allow the app by its client ID under **Security > Access and data control > API controls > Manage third party app access**.

## Step 4. Microsoft app (only for Outlook.com and Microsoft 365)

One registration serves every Microsoft account.

1. The user signs in at https://entra.microsoft.com. A work account works if the organisation lets users register apps. Someone with only a personal Outlook.com address first needs an Entra tenant. The usual route is a free Azure account, which may ask for a card to verify identity. Creating that account is the user's decision, ask before starting it.
2. Open **Applications > App registrations > New registration**.
   - Name `inboxmux`.
   - Supported account types **Accounts in any organizational directory (Any Microsoft Entra ID tenant, Multitenant) and personal Microsoft accounts**, or a narrower choice if the user only has one kind.
   - Redirect URI platform **Public client/native (mobile & desktop)**, value `http://localhost:8765/oauth/microsoft/callback`.
   - **Register**.
3. On **Overview** copy the **Application (client) ID**, a GUID.
4. **API permissions > Add a permission > Microsoft Graph > Delegated permissions**, add `User.Read`, `Mail.ReadWrite`, `Mail.Send` and `offline_access`, then **Add permissions**. Leave out `Mail.Send` if the user chose read and draft only.
5. No client secret is needed, inboxmux is a public client with PKCE.
6. Register it:

```bash
inboxmux setup microsoft --client-id 00000000-0000-0000-0000-000000000000
```

Many Microsoft 365 organisations only let an administrator approve mail access. The consent page then says **Admin approval required**. Do not look for another client ID. Print the approval link and let the user send it to their administrator:

```bash
inboxmux admin-consent              # administrator of any organisation
inboxmux admin-consent contoso.com  # one specific organisation
```

## Step 5. Settings

Defaults need no file changes. Only when the user asked for something else, edit `~/.config/inboxmux/config.json` (`%USERPROFILE%\.config\inboxmux\config.json` on Windows). Keep every existing key, write valid JSON, keep the file private.

```json
{
  "capabilities": { "send": false, "trash": false },
  "sendAllowlist": ["@mycompany.com", "friend@example.com"],
  "attachmentSources": ["~/Documents", "~/Desktop"]
}
```

`capabilities` removes the send or trash tools when `false`. `sendAllowlist` limits recipients. `attachmentSources` lists the folders files may be attached from. Unknown keys are rejected, `inboxmux doctor` reports the exact problem.

## Step 6. Connect the mailboxes

The account manager runs until it is stopped, so start it in the background and read its output:

```bash
inboxmux ui --no-open
```

It prints a line like `Open: http://localhost:8765/?token=...`. Open that link in the user's browser, with your browser tool or by giving it to the user. The token is a session secret for this run, do not paste it anywhere else.

For each mailbox the user clicks **Connect a Gmail account** or **Connect a Microsoft account**, picks the account and signs in.

- Google then shows **Google hasn't verified this app**. That is expected for a personal app. The user clicks **Advanced**, then **Go to inboxmux (unsafe)**, and on the next screen keeps the Gmail permission ticked and clicks **Continue**.
- Microsoft shows the requested permissions. The user clicks **Accept**.
- The page ends with **Account connected**.

Optionally give accounts short labels, they can be used instead of the address:

```bash
inboxmux label someone@gmail.com home
inboxmux label someone@company.com work
```

Stop the account manager when done. Accounts added later with `inboxmux ui` appear in running MCP servers without a restart.

If port 8765 is taken, use `inboxmux ui --port 8766`. Google desktop clients accept any local port. For Microsoft add `http://localhost:8766/oauth/microsoft/callback` as a second redirect URI first.

## Step 7. Check

```bash
inboxmux doctor
```

Every account must show `ok`. Fix anything else with the troubleshooting table below before continuing.

## Step 8. Add the MCP server to the clients

Use the absolute paths from step 2. Desktop apps often do not inherit the shell `PATH`, so a bare `node` can fail.

**Claude Code**

```bash
claude mcp add --scope user inboxmux -- "$NODE" "$INBOXMUX" mcp
claude mcp get inboxmux    # should report Connected
```

**Codex**

```bash
codex mcp add inboxmux -- "$NODE" "$INBOXMUX" mcp
codex mcp list
```

**Claude Desktop.** Merge this into `claude_desktop_config.json` without removing other servers, then restart the app. The file is `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS and `%APPDATA%\Claude\claude_desktop_config.json` on Windows.

```json
{
  "mcpServers": {
    "inboxmux": { "command": "/absolute/path/to/node", "args": ["/absolute/path/to/inboxmux/dist/index.js", "mcp"] }
  }
}
```

**Other MCP clients.** Command is the node path, arguments are the script path and `mcp`, transport stdio.

## Step 9. Smoke test

The tools appear in new sessions. In a fresh session of each configured client:

1. Call `list_accounts`. Every connected mailbox should be listed with status `ok`.
2. Call `search_messages` with `account: "all"` and `limit: 3`. Results from each mailbox should come back.
3. Only if the user says yes, call `send_message` to the user's own address. The client shows an approval prompt first, which is the point of the test.

## Step 10. Hand over

Tell the user in a few lines:

- which mailboxes are connected and under which labels
- that config and encrypted tokens live in `~/.config/inboxmux`, with the key in the system keychain
- `inboxmux ui` adds or reconnects accounts, `inboxmux doctor` checks them
- sending and trash need their approval in the client, and how to switch them off (step 5)
- updating is `git pull && npm install` in the repository
- removal is `inboxmux remove <account>` per account, `claude mcp remove inboxmux` or `codex mcp remove inboxmux`, deleting `~/.config/inboxmux`, then deleting the Google project and the Entra app registration

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Google `Error 400: redirect_uri_mismatch` | A Web client without the redirect URI | Create a Desktop app client (step 3.7) |
| Google `Error 403: access_denied`, app is being tested | Publishing status still **Testing** | Publish the app (step 3.6), or add the account as a test user |
| Gmail stops working after about a week | Tokens issued while the app was in **Testing** | Publish the app, then reconnect each account in `inboxmux ui` |
| Google `Error 400: admin_policy_enforced` or app blocked | Workspace policy | The Workspace admin allows the client ID (end of step 3) |
| `insufficient_scope` or "has not granted the permission" | The Gmail box was unticked on the consent screen | Reconnect in `inboxmux ui` and keep the permission ticked |
| Microsoft **Admin approval required**, `AADSTS65001`, `AADSTS90094` | Organisation allows only admin consent | `inboxmux admin-consent`, the admin approves |
| Microsoft `AADSTS50011` | Redirect URI does not match | Check step 4.2, including the port |
| Microsoft `AADSTS7000218`, client secret required | Redirect URI registered under **Web** | Move it to **Mobile and desktop applications**, or set **Allow public client flows** to Yes under **Authentication** |
| Microsoft says the app is not enabled for consumers | Supported account types exclude personal accounts | Change the supported account types of the registration |
| `EADDRINUSE` when starting `inboxmux ui` | Port 8765 is busy | `--port 8766`, see step 6 |
| Client shows inboxmux as failed, `spawn node ENOENT` | The client cannot find `node` | Use the absolute node path (step 8) |
| `doctor` reports file key storage on Linux | No Secret Service running | Acceptable on a single user machine, or set `INBOXMUX_MASTER_KEY` |
