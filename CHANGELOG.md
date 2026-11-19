# Changelog

## 0.2.0

- Sending and trash are on by default, every call goes through the client's approval prompt. `capabilities.send` or `capabilities.trash` set to `false` removes the tools
- `send_message` sends a new message, reply, reply all or forward in one step, checked against `sendAllowlist` on the saved draft
- Forwarding with `forwardMessageId`, keeping the original attachments unless `includeOriginalAttachments` is false
- Local file attachments from `attachmentSources` (home folder by default), never hidden files or the config folder, 25 MB per message
- Large messages use the Gmail upload endpoint and Microsoft upload sessions, the session URL never receives the bearer token
- `update_message` takes `moveTo` for inbox, archive, spam or any folder or label, and restores messages from trash
- `create_folder` creates Gmail labels and Outlook folders
- `INBOXMUX_ALLOW_SEND` and `INBOXMUX_ALLOW_TRASH` accept `0`, `false`, `no` and `off`
- `docs/agent-setup.md`, a runbook an AI agent can follow to set everything up, OAuth apps included, plus `AGENTS.md` and `CLAUDE.md` pointing agents to it

## 0.1.0

First release.

- Gmail and Microsoft Graph (Outlook.com, Microsoft 365) adapters behind one MCP tool set
- Search across all accounts, structured filters, paging, message and thread reading, attachment download
- Read state, star or flag, archive, labels and categories
- Drafts, replies and reply all, Gmail send-as aliases
- Optional `send_draft` with recipient allowlist and optional `trash_message`, both off by default
- Local account manager UI with PKCE OAuth, CSRF and DNS rebinding protection
- Encrypted token store with OS keychain master key
- CLI with `ui`, `accounts`, `label`, `remove`, `setup`, `import`, `doctor` and `admin-consent`
- Clear guidance and an administrator approval link when a Microsoft 365 tenant blocks user consent
