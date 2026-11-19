# Changelog

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
