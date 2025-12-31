import { Hono } from "hono"

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>copilot-api admin</title>
    <style>
      :root {
        --bg: #0b1020;
        --panel: #121a33;
        --text: #e6e9f2;
        --muted: #aab3d0;
        --border: #243055;
        --good: #28c37b;
        --bad: #ff5b5b;
        --warn: #ffb020;
        --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
        --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto,
          Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        font-family: var(--sans);
      }
      a { color: inherit; }
      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 16px;
        border-bottom: 1px solid var(--border);
        background: linear-gradient(180deg, rgba(18,26,51,.9), rgba(11,16,32,.9));
        position: sticky;
        top: 0;
        z-index: 10;
        backdrop-filter: blur(6px);
      }
      header h1 {
        margin: 0;
        font-size: 14px;
        letter-spacing: .2px;
        font-weight: 650;
      }
      header nav {
        display: flex;
        gap: 10px;
      }
      header nav a {
        padding: 6px 10px;
        border: 1px solid var(--border);
        border-radius: 8px;
        text-decoration: none;
        color: var(--muted);
      }
      header nav a.active {
        color: var(--text);
        border-color: #3a4a7e;
        background: rgba(255,255,255,.04);
      }
      .header-right {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .token-controls {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .token-controls input {
        min-width: 160px;
      }
      main {
        padding: 16px;
        max-width: 1200px;
        margin: 0 auto;
      }
      .panel {
        border: 1px solid var(--border);
        background: rgba(18,26,51,.65);
        border-radius: 12px;
        padding: 12px;
        margin-bottom: 16px;
      }
      .row {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: end;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
      }
      input, select {
        background: rgba(0,0,0,.18);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 10px;
        min-width: 180px;
        outline: none;
      }
      button {
        background: rgba(255,255,255,.06);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px 10px;
        cursor: pointer;
      }
      button:hover { border-color: #3a4a7e; }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      th, td {
        border-bottom: 1px solid rgba(36,48,85,.7);
        padding: 8px 8px;
        vertical-align: top;
      }
      th {
        text-align: left;
        color: var(--muted);
        font-weight: 600;
      }
      .mono { font-family: var(--mono); }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px;
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--muted);
      }
      .pill.good { color: var(--good); border-color: rgba(40,195,123,.35); }
      .pill.bad { color: var(--bad); border-color: rgba(255,91,91,.35); }
      .pill.warn { color: var(--warn); border-color: rgba(255,176,32,.35); }
      .muted { color: var(--muted); }
      pre {
        margin: 0;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: rgba(0,0,0,.25);
        overflow: auto;
        font-size: 12px;
      }
      .split {
        display: grid;
        grid-template-columns: 1fr;
        gap: 12px;
      }
      @media (min-width: 960px) {
        .split { grid-template-columns: 1fr 1fr; }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>copilot-api / admin</h1>
      <div class="header-right">
        <nav>
          <a href="#/accounts" data-nav="accounts">Accounts</a>
          <a href="#/requests" data-nav="requests">Requests</a>
        </nav>
        <div class="token-controls">
          <input id="adminToken" type="password" placeholder="x-admin-token" />
          <button id="adminTokenSave">Set</button>
          <button id="adminTokenClear">Clear</button>
          <span id="adminTokenStatus" class="muted"></span>
        </div>
      </div>
    </header>

    <main id="app"></main>

    <script type="module">
      const app = document.getElementById('app')
      const navLinks = [...document.querySelectorAll('a[data-nav]')]

      const ADMIN_TOKEN_STORAGE_KEY = 'adminToken'

      function getAdminToken() {
        return sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || ''
      }

      function setAdminToken(value) {
        const token = (value || '').trim()
        if (!token) sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY)
        else sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token)
      }

      function refreshAdminTokenUi() {
        const el = document.getElementById('adminTokenStatus')
        if (!el) return
        el.textContent = getAdminToken() ? 'token set' : ''
      }

      function initAdminTokenControls() {
        const input = document.getElementById('adminToken')
        const saveBtn = document.getElementById('adminTokenSave')
        const clearBtn = document.getElementById('adminTokenClear')

        if (saveBtn && input) {
          saveBtn.addEventListener('click', () => {
            setAdminToken(input.value)
            input.value = ''
            refreshAdminTokenUi()
          })
        }

        if (clearBtn && input) {
          clearBtn.addEventListener('click', () => {
            setAdminToken('')
            input.value = ''
            refreshAdminTokenUi()
          })
        }

        refreshAdminTokenUi()
      }

      initAdminTokenControls()

      function setActiveNav(key) {
        for (const a of navLinks) {
          a.classList.toggle('active', a.dataset.nav === key)
        }
      }

      function fmtMs(ms) {
        if (ms == null) return ''
        return new Date(ms).toISOString()
      }

      function fmtNum(x) {
        if (x == null || Number.isNaN(Number(x))) return ''
        return String(x)
      }

      function pill(text, kind) {
        return '<span class="pill ' + (kind || '') + '">' + escapeHtml(text) + '</span>'
      }

      function qs() {
        return new URLSearchParams(location.hash.includes('?') ? location.hash.split('?')[1] : '')
      }

      async function api(path) {
        const token = getAdminToken()
        const headers = token ? { 'x-admin-token': token } : {}
        const res = await fetch(path, { headers })
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          throw new Error('HTTP ' + res.status + ': ' + txt)
        }
        return await res.json()
      }

      async function renderAccounts() {
        setActiveNav('accounts')
        app.innerHTML = [
          '<div class="panel">',
          '  <div class="row">',
          '    <label>Stats window',
          '      <select id="since">',
          '        <option value="86400000">Last 24h</option>',
          '        <option value="604800000">Last 7d</option>',
          '      </select>',
          '    </label>',
          '    <button id="refresh">Refresh</button>',
          '    <span class="muted" id="meta"></span>',
          '  </div>',
          '</div>',
          '<div class="panel">',
          '  <table>',
          '    <thead>',
          '      <tr>',
          '        <th>Account</th>',
          '        <th>Status</th>',
          '        <th>Remaining</th>',
          '        <th>Requests</th>',
          '        <th>Errors</th>',
          '        <th>Tokens</th>',
          '        <th>Avg ms</th>',
          '        <th>Last req</th>',
          '      </tr>',
          '    </thead>',
          '    <tbody id="rows"></tbody>',
          '  </table>',
          '</div>',
        ].join('')

        const sinceEl = document.getElementById('since')
        const refresh = document.getElementById('refresh')
        const rowsEl = document.getElementById('rows')
        const metaEl = document.getElementById('meta')

        async function load() {
          rowsEl.innerHTML = '<tr><td colspan="8" class="muted">Loading...</td></tr>'
          const windowMs = Number(sinceEl.value)
          const sinceMs = Date.now() - windowMs
          const [accounts, meta] = await Promise.all([
            api('/api/admin/accounts?since_ms=' + sinceMs + '&include_stats=1'),
            api('/api/admin/meta'),
          ])

          metaEl.textContent = 'DB v' + meta.userVersion + ' · ' + meta.dbPath

          rowsEl.innerHTML = accounts.items.map((a) => {
            const failed = a.runtime?.failed
            const statusPill = failed ? pill('failed', 'bad') : pill('ok', 'good')
            const rem = a.runtime?.unlimited ? pill('unlimited', 'good') : fmtNum(a.runtime?.remaining)
            const stats = a.stats || {}
            const last = stats.last_request_at_ms ? fmtMs(stats.last_request_at_ms) : ''
            const accountId = a.account_id
            const failureReason = failed
              ? '<div class="muted">' + escapeHtml(a.runtime?.failureReason || '') + '</div>'
              : ''

            return '<tr>'
              + '<td class="mono"><a href="#/requests?account_id='
              + encodeURIComponent(accountId)
              + '">' + escapeHtml(accountId) + '</a></td>'
              + '<td>' + statusPill + failureReason + '</td>'
              + '<td>' + rem + '</td>'
              + '<td>' + fmtNum(stats.request_count) + '</td>'
              + '<td>' + fmtNum(stats.error_count) + '</td>'
              + '<td>' + fmtNum(stats.tokens_total) + '</td>'
              + '<td>' + fmtNum(Math.round(stats.avg_duration_ms || 0)) + '</td>'
              + '<td class="mono">' + last + '</td>'
              + '</tr>'
          }).join('')
        }

        refresh.addEventListener('click', () => load())
        await load()
      }

      function buildRequestsQuery(extra = {}) {
        const p = qs()
        const out = new URLSearchParams()

        const keys = [
          'account_id','upstream_model','client_model','upstream_endpoint','path',
          'status','has_error','from_ms','to_ms','limit','cursor_id'
        ]
        for (const k of keys) {
          const v = p.get(k)
          if (v != null && v !== '') out.set(k, v)
        }
        for (const [k, v] of Object.entries(extra)) {
          if (v == null || v === '') out.delete(k)
          else out.set(k, String(v))
        }
        return out
      }

      async function renderRequests() {
        setActiveNav('requests')
        app.innerHTML = [
          '<div class="panel">',
          '  <div class="row">',
          '    <label>Account',
          '      <input id="account_id" placeholder="octocat" />',
          '    </label>',
          '    <label>Upstream model',
          '      <input id="upstream_model" placeholder="gpt-5" />',
          '    </label>',
          '    <label>Endpoint',
          '      <input id="upstream_endpoint" placeholder="/responses" />',
          '    </label>',
          '    <label>Status',
          '      <input id="status" placeholder="200" />',
          '    </label>',
          '    <label>Has error',
          '      <select id="has_error">',
          '        <option value="">(any)</option>',
          '        <option value="1">yes</option>',
          '        <option value="0">no</option>',
          '      </select>',
          '    </label>',
          '    <label>From (ms)',
          '      <input id="from_ms" placeholder="" />',
          '    </label>',
          '    <label>To (ms)',
          '      <input id="to_ms" placeholder="" />',
          '    </label>',
          '    <button id="apply">Apply</button>',
          '    <button id="more">Load more</button>',
          '  </div>',
          '</div>',
          '<div class="panel">',
          '  <table>',
          '    <thead>',
          '      <tr>',
          '        <th>Time</th>',
          '        <th>Path</th>',
          '        <th>Endpoint</th>',
          '        <th>Account</th>',
          '        <th>Model</th>',
          '        <th>Tokens</th>',
          '        <th>Cost</th>',
          '        <th>Quota</th>',
          '        <th>Dur</th>',
          '        <th>Status</th>',
          '      </tr>',
          '    </thead>',
          '    <tbody id="rows"></tbody>',
          '  </table>',
          '</div>',
        ].join('')

        const rowsEl = document.getElementById('rows')
        const applyBtn = document.getElementById('apply')
        const moreBtn = document.getElementById('more')

        const fields = ['account_id','upstream_model','upstream_endpoint','status','has_error','from_ms','to_ms']
        for (const f of fields) {
          const el = document.getElementById(f)
          const v = qs().get(f) || ''
          el.value = v
        }

        let nextCursor = qs().get('cursor_id') || ''
        let loading = false

        function setHashFromForm(cursorId) {
          const out = new URLSearchParams()
          for (const f of fields) {
            const v = document.getElementById(f).value.trim()
            if (v) out.set(f, v)
          }
          out.set('limit', '50')
          if (cursorId) out.set('cursor_id', cursorId)
          location.hash = '#/requests?' + out.toString()
        }

        async function load(reset) {
          if (loading) return
          loading = true
          try {
            const q = buildRequestsQuery({ limit: 50, cursor_id: reset ? '' : nextCursor })
            const data = await api('/api/admin/requests?' + q.toString())

            if (reset) rowsEl.innerHTML = ''

            for (const r of data.items) {
              const status = r.http_status
              const statusP = status >= 400 ? pill(status, 'bad') : pill(status, 'good')
              const when = fmtMs(r.started_at_ms)
              const quota = r.premium_unlimited_after
                ? '∞'
                : (r.premium_remaining_after != null ? fmtNum(r.premium_remaining_after) : '')
              const dur = r.duration_ms != null ? fmtNum(r.duration_ms) : ''
              const acct = r.account_id || ''
              const model = r.upstream_model || ''
              const tokens = r.tokens_total != null ? fmtNum(r.tokens_total) : ''

              rowsEl.insertAdjacentHTML('beforeend',
                '<tr>'
                + '<td class="mono">' + when + '</td>'
                + '<td class="mono"><a href="#/request/' + encodeURIComponent(r.request_id) + '">' + escapeHtml(r.path) + '</a></td>'
                + '<td class="mono">' + escapeHtml(r.upstream_endpoint || '') + '</td>'
                + '<td class="mono">' + escapeHtml(acct) + '</td>'
                + '<td class="mono">' + escapeHtml(model) + '</td>'
                + '<td class="mono">' + tokens + '</td>'
                + '<td class="mono">' + (r.cost_units ?? '') + '</td>'
                + '<td class="mono">' + quota + '</td>'
                + '<td class="mono">' + dur + '</td>'
                + '<td>' + statusP + '</td>'
                + '</tr>'
              )
            }

            nextCursor = data.next_cursor_id || ''
            moreBtn.disabled = !data.has_more
          } catch (e) {
            rowsEl.innerHTML = '<tr><td colspan="10" class="muted">' + escapeHtml(String(e)) + '</td></tr>'
          } finally {
            loading = false
          }
        }

        applyBtn.addEventListener('click', () => setHashFromForm(''))
        moreBtn.addEventListener('click', () => load(false))

        await load(true)
      }

      async function renderRequestDetail(requestId) {
        setActiveNav('requests')
        app.innerHTML = '<div class="panel"><div class="muted">Loading...</div></div>'
        const data = await api('/api/admin/requests/' + encodeURIComponent(requestId))
        const r = data.item
        if (!r) {
          app.innerHTML = '<div class="panel"><div class="muted">Not found</div></div>'
          return
        }

        app.innerHTML = [
          '<div class="panel">',
          '  <div class="row">',
          '    <div class="mono">request_id: ' + escapeHtml(r.request_id) + '</div>',
          '    <div class="mono">status: ' + r.http_status + '</div>',
          '    <div class="mono">dur_ms: ' + (r.duration_ms ?? '') + '</div>',
          '    <div class="mono">ttfb_ms: ' + (r.ttfb_ms ?? '') + '</div>',
          '  </div>',
          '</div>',
          '',
          '<div class="split">',
          '  <div class="panel">',
          '    <h3 style="margin:0 0 8px 0; font-size: 13px;">Summary</h3>',
          '    <table>',
          '      <tbody>',
          '        <tr><th>time</th><td class="mono">' + fmtMs(r.started_at_ms) + '</td></tr>',
          '        <tr><th>path</th><td class="mono">' + escapeHtml(r.path) + '</td></tr>',
          '        <tr><th>endpoint</th><td class="mono">' + escapeHtml(r.upstream_endpoint || '') + '</td></tr>',
          '        <tr><th>account</th><td class="mono">' + escapeHtml(r.account_id || '') + '</td></tr>',
          '        <tr><th>model</th><td class="mono">' + escapeHtml(r.upstream_model || '') + '</td></tr>',
          '        <tr><th>client</th><td class="mono">' + escapeHtml(r.client_ip || '') + ' ' + (r.user_agent ? '(' + escapeHtml(r.user_agent) + ')' : '') + '</td></tr>',
          '        <tr><th>tokens</th><td class="mono">in=' + (r.tokens_input ?? '') + ' out=' + (r.tokens_output ?? '') + ' total=' + (r.tokens_total ?? '') + ' cached=' + (r.tokens_cached_input ?? '') + '</td></tr>',
          '        <tr><th>quota</th><td class="mono">before=' + (r.premium_remaining_before ?? '') + ' after=' + (r.premium_remaining_after ?? '') + ' diff=' + (r.premium_remaining_diff ?? '') + '</td></tr>',
          '      </tbody>',
          '    </table>',
          '  </div>',
          '',
          '  <div class="panel">',
          '    <h3 style="margin:0 0 8px 0; font-size: 13px;">Raw</h3>',
          '    <pre class="mono">' + escapeHtml(JSON.stringify(r, null, 2)) + '</pre>',
          '  </div>',
          '</div>',
        ].join('')
      }

      function escapeHtml(s) {
        return String(s)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;')
      }

      function route() {
        const h = location.hash || '#/accounts'
        const [path] = h.slice(1).split('?')
        if (path === '/accounts') return renderAccounts()
        if (path === '/requests') return renderRequests()
        if (path.startsWith('/request/')) {
          const requestId = decodeURIComponent(path.slice('/request/'.length))
          return renderRequestDetail(requestId)
        }
        location.hash = '#/accounts'
      }

      window.addEventListener('hashchange', route)
      route()
    </script>
  </body>
</html>
`

export const adminRoutes = new Hono()

adminRoutes.get("/", (c) => c.html(html))
