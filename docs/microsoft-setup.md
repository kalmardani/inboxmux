# Microsoft setup

inboxmux reads Outlook.com and Microsoft 365 mailboxes through Microsoft Graph with your own app registration. One registration serves any number of accounts.

## 1. Register the app

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com/) and go to **Applications > App registrations > New registration**.
2. Name it `inboxmux`.
3. Supported account types. Pick **Accounts in any organizational directory and personal Microsoft accounts** to connect both work and Outlook.com addresses. Pick a narrower option if you only need one kind.
4. Redirect URI. Platform **Public client/native (mobile & desktop)**, value `http://localhost:8765/oauth/microsoft/callback`. Adjust the port if you change `uiPort`.
5. Register, then copy the **Application (client) ID**.

You need an Entra tenant to create a registration. A Microsoft 365 work account belongs to one, although creating registrations may be restricted to administrators. With only a personal Outlook.com account, create a tenant first, for example through a free Azure account. The registration can live in any tenant you control and still sign in personal accounts.

## 2. Permissions

Under **API permissions > Add a permission > Microsoft Graph > Delegated permissions** add:

- `User.Read`
- `Mail.ReadWrite`
- `offline_access`
- `Mail.Send` (sending is on by default, leave it out only if you switch sending off)

Personal accounts consent for themselves during sign in. In many organisations an administrator has to grant consent for `Mail.ReadWrite`. The sign in page tells you when that is the case.

No client secret is needed. inboxmux uses the authorization code flow with PKCE as a public client.

## 3. Tell inboxmux

```bash
inboxmux setup microsoft --client-id 00000000-0000-0000-0000-000000000000
inboxmux ui
```

Click **Connect a Microsoft account** and sign in. Repeat for each account.

## Work accounts that need administrator approval

Most Microsoft 365 organisations do not let users approve an unverified app for mail access on their own. The sign in page then shows **Admin approval required**. This was the case for both work tenants inboxmux was first tested with, including the tenant that holds the app registration.

inboxmux shows the approval link after such a sign in, and the command line prints it too.

```bash
inboxmux admin-consent              # any organisation, the administrator signs in to their own
inboxmux admin-consent contoso.com  # one specific organisation
```

The administrator opens the link, reviews the permissions (`User.Read`, `Mail.ReadWrite`, plus `Mail.Send` when sending is enabled) and accepts for the organisation. After that every user of that organisation can connect without the approval screen. The link redirects to localhost at the end. On the administrator's machine that page will not load, which is expected, the approval is already saved.

Organisations that allow user consent only for apps from verified publishers can also approve inboxmux once you complete publisher verification for your app registration in the Entra admin center.

## Tenant

The default tenant `common` accepts work and personal accounts. Other values:

| Tenant | Accounts |
|--------|----------|
| `organizations` | Work and school accounts only |
| `consumers` | Personal Microsoft accounts only |
| a tenant id or domain | One organisation |

```bash
inboxmux setup microsoft --client-id <id> --tenant organizations
```

## Notes

- Microsoft rotates refresh tokens on every use. inboxmux stores the new one automatically.
- inboxmux requests immutable message ids, so ids stay valid after a message is archived or moved.
- `Mail.Send` is requested when sending is on at the time you connect, which is the default. If you connect with sending off and switch it on later, reconnect the account.
- Labels map to Outlook categories, starring maps to the follow up flag, archive moves the message to the Archive folder, spam to Junk Email.
- Files up to 2.5 MB are attached in one request, larger ones through an upload session in 3.75 MB chunks.
