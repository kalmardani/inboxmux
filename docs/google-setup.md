# Google setup

inboxmux talks to the Gmail API with your own OAuth client. One client is enough for any number of Gmail accounts, including Google Workspace accounts that allow third party apps.

## 1. Project and API

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project, for example `inboxmux`.
2. Under **APIs & Services > Library**, enable the **Gmail API**.

## 2. Consent screen

1. Go to **APIs & Services > OAuth consent screen** (in newer consoles **Google Auth Platform > Branding** and **Audience**).
2. User type **External** for personal Gmail. Use **Internal** if every account belongs to one Workspace organisation.
3. Fill in the app name and your email. No logo or domain verification is needed for personal use.
4. Under **Data access** add the scope `https://www.googleapis.com/auth/gmail.modify`.
5. Set the publishing status to **In production**.

The publishing status matters. While an External app is in **Testing**, Google expires its refresh tokens after seven days and every account has to be reconnected weekly. In production without verification, Google shows an unverified app warning during sign in (Advanced, then Go to the app) and allows up to 100 users, which is plenty for personal use.

## 3. OAuth client

1. **APIs & Services > Credentials > Create credentials > OAuth client ID**.
2. Application type **Desktop app**.
3. Download the JSON file.

Desktop clients accept any loopback redirect, so no redirect URI has to be registered. If you use a **Web application** client instead, register `http://localhost:8765/oauth/google/callback` (adjust the port if you change `uiPort`).

## 4. Tell inboxmux

```bash
inboxmux setup google --client-file ~/Downloads/client_secret_XXXX.json
inboxmux ui
```

Click **Connect a Gmail account**, pick the account, and keep the Gmail permission ticked on the consent screen. Repeat for each account. The send-as aliases verified in Gmail settings are picked up automatically and can be used as `from` in `create_draft`.

## Scope

inboxmux asks for `gmail.modify`, which covers reading, labels, drafts and sending, but not permanent deletion. Google offers no narrower scope that still allows drafts. Sending stays disabled inside inboxmux until you turn it on.

## Existing refresh tokens

If you already have a refresh token issued by the same client, you can import it instead of signing in again.

```bash
printf '%s' "$REFRESH_TOKEN" | inboxmux import google
```

A token without `gmail.modify` (for example `gmail.readonly`) can still search and read. Drafts and label changes then fail with a reconnect hint.
