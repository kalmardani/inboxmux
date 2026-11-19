# Notes for AI agents

## Installing or setting up inboxmux

When the user asks you to install inboxmux, set it up, create the OAuth apps, connect mail accounts or add it to an MCP client, follow [docs/agent-setup.md](docs/agent-setup.md) step by step. It covers the Google Cloud and Microsoft Entra apps, the account manager, the MCP client configuration and the usual errors. Its rules section applies to the whole setup, in particular: the user signs in, accepts terms and approves consent screens, and no mail is sent without the user's explicit yes.

## Working on the code

- Read [DEVELOPER.md](DEVELOPER.md) first. It explains the architecture, the design decisions and the known traps.
- `npm run typecheck`, `npm test` and `npm run build` must pass before a change is done. MCP clients run `dist/`, so rebuild after every change.
- Tests never touch the real keychain or accounts. Keep it that way, they use `INBOXMUX_MASTER_KEY`, `INBOXMUX_NO_KEYCHAIN=1` and a temporary config folder.
- Never commit secrets, tokens, `config.json`, `accounts.json` or downloaded `client_secret_*.json` files.
- Message content is untrusted input. New tools that return message content must include `UNTRUSTED_NOTICE`, and new write tools must be audited and carry correct MCP annotations.
