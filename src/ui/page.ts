import type { AccountMeta } from '../types.js'

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = `
:root{--bg:#f7f6f3;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#2f5d50;--accent-ink:#fff;--bad:#a33a2a;--ok:#2f6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ecebe7;--muted:#9a9993;--line:#33322f;--accent:#7fb8a4;--accent-ink:#0f1a16;--bad:#e08c7c;--ok:#8fcf9b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 12px}
p.sub{color:var(--muted);margin:0 0 24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
.muted{color:var(--muted);font-size:13px}.ok{color:var(--ok)}.bad{color:var(--bad)}
button,.btn{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-block}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.danger{color:var(--bad)}
form.inline{display:inline}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
input[type=text],input[type=password]{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink);min-width:0;width:100%}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.notice{border-left:3px solid var(--accent);padding:8px 12px;background:var(--card);margin-bottom:16px}
.notice.error{border-color:var(--bad)}
code{font-size:13px}
@media (max-width:640px){th:nth-child(3),td:nth-child(3){display:none}}
`

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`
}

export interface HomeView {
  accounts: AccountMeta[]
  csrf: string
  googleReady: boolean
  microsoftReady: boolean
  microsoftTenant: string
  redirectBase: string
  capabilities: { send: boolean; trash: boolean }
  configDir: string
  message?: { kind: 'info' | 'error'; text: string }
}

function providerName(p: AccountMeta['provider']): string {
  return p === 'google' ? 'Gmail' : 'Microsoft'
}

export function homePage(v: HomeView): string {
  const csrf = `<input type="hidden" name="csrf" value="${esc(v.csrf)}">`
  const rows = v.accounts
    .map(
      (a) => `<tr>
  <td><strong>${esc(a.email)}</strong><div class="muted">${esc(a.aliases.filter((x) => x !== a.email).join(', '))}</div></td>
  <td>${providerName(a.provider)}</td>
  <td><form class="inline row" method="post" action="/accounts/label">${csrf}<input type="hidden" name="email" value="${esc(a.email)}">
      <input type="text" name="label" value="${esc(a.label ?? '')}" placeholder="label" style="width:110px" aria-label="Label for ${esc(a.email)}"><button>Save</button></form></td>
  <td class="${a.status === 'ok' ? 'ok' : 'bad'}">${a.status === 'ok' ? 'Connected' : 'Reconnect needed'}</td>
  <td><div class="row">
    <form class="inline" method="post" action="/accounts/check">${csrf}<input type="hidden" name="email" value="${esc(a.email)}"><button>Check</button></form>
    <form class="inline" method="post" action="/connect/${a.provider}">${csrf}<button>Reconnect</button></form>
    <form class="inline" method="post" action="/accounts/remove">${csrf}<input type="hidden" name="email" value="${esc(a.email)}"><button class="danger">Remove</button></form>
  </div></td></tr>`,
    )
    .join('')

  const google = v.googleReady
    ? `<form method="post" action="/connect/google">${csrf}<button class="primary">Connect a Gmail account</button></form>`
    : `<p class="muted">Add your Google OAuth client (Desktop app type). Guide: docs/google-setup.md</p>
       <form method="post" action="/setup/google">${csrf}
       <p><input type="text" name="clientId" placeholder="Client ID" aria-label="Google client ID"></p>
       <p><input type="password" name="clientSecret" placeholder="Client secret" aria-label="Google client secret"></p>
       <button>Save Google client</button></form>`
  const microsoft = v.microsoftReady
    ? `<form method="post" action="/connect/microsoft">${csrf}<button class="primary">Connect a Microsoft account</button></form>
       <p class="muted">Tenant: <code>${esc(v.microsoftTenant)}</code></p>`
    : `<p class="muted">Add your Entra app registration (public client). Redirect URI to register: <code>${esc(v.redirectBase)}/oauth/microsoft/callback</code>. Guide: docs/microsoft-setup.md</p>
       <form method="post" action="/setup/microsoft">${csrf}
       <p><input type="text" name="clientId" placeholder="Application (client) ID" aria-label="Microsoft client ID"></p>
       <p><input type="text" name="tenant" placeholder="Tenant (common)" aria-label="Microsoft tenant"></p>
       <button>Save Microsoft app</button></form>`

  const message = v.message
    ? `<div class="notice${v.message.kind === 'error' ? ' error' : ''}">${esc(v.message.text)}</div>`
    : ''

  return layout(
    'inboxmux accounts',
    `<h1>inboxmux</h1><p class="sub">Mailboxes available to your MCP clients. Changes apply to running servers right away.</p>
${message}
<div class="card">${
      v.accounts.length
        ? `<table><thead><tr><th>Account</th><th>Provider</th><th>Label</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="muted">No accounts connected yet.</p>'
    }</div>
<h2>Add an account</h2>
<div class="grid"><div class="card"><strong>Gmail</strong>${google}</div><div class="card"><strong>Microsoft 365 / Outlook.com</strong>${microsoft}</div></div>
<h2>Settings</h2>
<div class="card"><p>Sending: <strong>${v.capabilities.send ? 'enabled' : 'disabled'}</strong>. Trash: <strong>${v.capabilities.trash ? 'enabled' : 'disabled'}</strong>.</p>
<p class="muted">Change these in <code>${esc(v.configDir)}/config.json</code> (capabilities.send, capabilities.trash). Drafts are always allowed.</p></div>`,
  )
}

export function resultPage(title: string, text: string, ok: boolean, copyable?: string): string {
  const extra = copyable
    ? `<p><textarea readonly rows="4" style="width:100%;font:13px ui-monospace,monospace" aria-label="Link to copy">${esc(copyable)}</textarea></p>`
    : ''
  return layout(
    title,
    `<h1>${esc(title)}</h1><div class="notice${ok ? '' : ' error'}">${esc(text)}</div>${extra}<p><a class="btn" href="/">Back to accounts</a></p>`,
  )
}
