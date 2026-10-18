// Ops Desk - tiny framework-free SPA. State lives in `S`; render() redraws from state.
const $app = document.getElementById('app');
const S = {
  token: localStorage.getItem('token'), me: null, route: location.hash || '#/',
  // dashboard
  view: 'assigned_to_me', filters: { q: '', status: '', priority: '', type: '', team_id: '' },
  items: [], cursor: null, counts: null, listLoading: false,
  // item detail
  item: null, events: [], eventsCursor: null, members: [], banner: null, busy: false,
  // notifications
  notes: [], unread: 0, showNotes: false,
};
const DEMO = ['alice (admin, all teams)', 'bob (Support lead)', 'carol (Engineering lead)', 'dave (Payments lead)', 'erin (Compliance lead)', 'frank (Support member)', 'ivan (viewer)'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (s) => esc(String(s ?? '').replace(/_/g, ' '));
const when = (d) => new Date(d).toLocaleString();

/* ------------------------------ API ------------------------------ */
async function api(method, path, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/auth/login') { logout(); throw new Error('Session expired'); }
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

// One Idempotency-Key per logical action. It is reused if the SAME action is retried (e.g. after a network error)
// and forgotten once the server answered, so a double-click or a retry can never apply the action twice.
const keys = new Map();
const keyFor = (sig) => { if (!keys.has(sig)) keys.set(sig, crypto.randomUUID()); return keys.get(sig); };

function logout() { localStorage.removeItem('token'); S.token = null; S.me = null; render(); }

/* ------------------------------ data loaders ------------------------------ */
async function loadCounts() { S.counts = await api('GET', '/dashboard/counts'); }

async function loadItems({ more = false } = {}) {
  if (S.listLoading) return;
  S.listLoading = true;
  try {
    const p = new URLSearchParams({ limit: '25' });
    if (S.view !== 'all') p.set('view', S.view);
    for (const [k, v] of Object.entries(S.filters)) if (v) p.set(k, v);
    if (more && S.cursor) p.set('cursor', S.cursor);
    const r = await api('GET', `/items?${p}`);
    S.items = more ? [...S.items, ...r.items] : r.items;
    S.cursor = r.next_cursor;
  } finally { S.listLoading = false; }
}

async function loadItem(id) {
  const [item, act] = await Promise.all([api('GET', `/items/${id}`), api('GET', `/items/${id}/activity?limit=50`)]);
  S.item = item; S.events = act.events; S.eventsCursor = act.next_cursor;
  if (item.can.reassign) S.members = (await api('GET', `/teams/${item.team_id}/members`)).filter((m) => m.role !== 'viewer');
}

async function loadNotes() {
  const r = await api('GET', '/notifications');
  S.notes = r.notifications; S.unread = r.unread;
}

/* ------------------------------ routing ------------------------------ */
async function route() {
  S.route = location.hash || '#/';
  if (!S.token) return render();
  try {
    if (!S.me) S.me = await api('GET', '/me');
    const m = S.route.match(/^#\/item\/(\d+)/);
    if (m) { S.banner = null; S.item = null; render(); await loadItem(m[1]); }
    else if (S.route === '#/new') { /* form only */ }
    else await Promise.all([loadCounts(), loadItems()]);
    loadNotes().then(render).catch(() => {});
  } catch (e) { S.banner = { kind: 'error', text: e.status === 404 ? 'Item not found (or you do not have access).' : e.message }; }
  render();
}
window.addEventListener('hashchange', route);

// Polling instead of websockets: refetch while the tab is visible and nothing is being edited.
setInterval(async () => {
  if (!S.token || document.hidden || S.busy) return;
  if (document.activeElement?.matches('input, textarea, select')) return; // never clobber what the user is typing
  try {
    if (/^#\/item\//.test(S.route) && S.item && !S.banner) { await loadItem(S.item.id); render(); }
    else if (S.route === '#/' || S.route === '') { await Promise.all([loadCounts(), S.items.length <= 25 ? loadItems() : null]); render(); }
    await loadNotes(); 
  } catch { /* ignore transient errors */ }
}, 15000);

/* ------------------------------ actions ------------------------------ */
/**
 * Optimistic update with reconciliation:
 *  1. apply `optimistic(item)` locally and redraw immediately,
 *  2. send the request (with an idempotency key),
 *  3. on success replace local state with the server's truth; on failure roll back to the snapshot and explain why.
 */
async function mutate({ sig, optimistic, request }) {
  if (S.busy) return;                      // blocks double-clicks while a request is in flight
  S.busy = true; S.banner = null;
  const snapshot = structuredClone(S.item);
  if (optimistic) { optimistic(S.item); }
  render();
  try {
    const key = keyFor(sig);
    await request(key);
    keys.delete(sig);
    await loadItem(snapshot.id);
  } catch (e) {
    S.item = snapshot;                     // roll back
    if (e.status === 409 && e.data?.current) {
      keys.delete(sig);
      S.banner = { kind: 'error', conflict: true, text: `${e.message}. Your change was NOT applied.` };
    } else if (e.status) { keys.delete(sig); S.banner = { kind: 'error', text: e.message }; }
    else S.banner = { kind: 'error', text: 'Network problem - nothing was lost. Click again to retry safely (same request key).' };
  } finally { S.busy = false; render(); }
}

const A = {
  claim: () => mutate({
    sig: `claim:${S.item.id}`,
    optimistic: (it) => { it.assignee_id = S.me.id; it.assignee_name = S.me.name; it.can.claim = false; },
    request: (key) => api('POST', `/items/${S.item.id}/claim`, undefined, key),
  }),
  transition: (to) => {
    const comment = document.getElementById('tcomment')?.value.trim() || undefined;
    return mutate({
      sig: `t:${S.item.id}:${S.item.version}:${to}`,
      optimistic: (it) => { it.status = to; it.can.transitions = []; },
      request: (key) => api('POST', `/items/${S.item.id}/transition`, { to, version: S.item.version, comment }, key),
    });
  },
  priority: (priority) => mutate({
    sig: `p:${S.item.id}:${S.item.version}:${priority}`,
    optimistic: (it) => { it.priority = priority; },
    request: (key) => api('PATCH', `/items/${S.item.id}`, { version: S.item.version, priority }, key),
  }),
  assign: (v) => mutate({
    sig: `a:${S.item.id}:${S.item.version}:${v}`,
    request: (key) => api('PATCH', `/items/${S.item.id}`, { version: S.item.version, assignee_id: v ? Number(v) : null }, key),
  }),
  release: () => A.assign(''),
  async saveEdit() {
    const f = document.getElementById('editform');
    return mutate({
      sig: `e:${S.item.id}:${S.item.version}`,
      request: (key) => api('PATCH', `/items/${S.item.id}`, { version: S.item.version, title: f.title.value, description: f.description.value, due_date: f.due_date.value || null }, key),
    });
  },
  comment: () => {
    const el = document.getElementById('ctext'); const text = el.value.trim();
    if (!text) return;
    return mutate({
      sig: `c:${S.item.id}:${text}:${S.events.length}`,
      request: async (key) => { await api('POST', `/items/${S.item.id}/comments`, { text }, key); },
    });
  },
};

/* ------------------------------ views ------------------------------ */
const pill = (p) => `<span class="pill p-${esc(p)}">${label(p)}</span>`;
const status = (s) => `<span class="pill s-${esc(s)}">${label(s)}</span>`;

function header() {
  const notes = S.showNotes ? `<div class="notes">${S.notes.length ? S.notes.map((n) =>
    `<div class="note ${n.read_at ? '' : 'unread'}"><a href="#/item/${n.item_id}">${esc(n.message)}</a><div class="muted">${when(n.created_at)}</div></div>`).join('')
    : '<div class="muted">No notifications yet</div>'}</div>` : '';
  return `<header><span class="brand">Ops Desk</span><a href="#/">Dashboard</a><a href="#/new">+ New item</a><span class="grow"></span>
    <span class="bell"><button data-act="bell">Notifications${S.unread ? ` (${S.unread})` : ''}</button>${notes}</span>
    <span class="muted">${esc(S.me?.name)} - ${S.me?.teams.map((t) => `${esc(t.name)}:${esc(t.role)}`).join(', ')}</span>
    <button data-act="logout">Log out</button></header>`;
}

function loginView() {
  return `<div class="card login"><h2>Ops Desk</h2>${S.banner ? `<div class="error">${esc(S.banner.text)}</div>` : ''}
    <form id="loginform"><input name="email" placeholder="email" value="bob@demo.test" autofocus><input name="password" type="password" placeholder="password" value="password123">
    <button class="primary" style="width:100%">Log in</button></form>
    <p class="muted">Demo users (password <code>password123</code>):</p><table class="demo">${DEMO.map((d) => `<tr><td><code>${esc(d.split(' ')[0])}@demo.test</code></td><td class="muted">${esc(d.slice(d.indexOf('(')))}</td></tr>`).join('')}</table></div>`;
}

function dashboardView() {
  const tabs = [['assigned_to_me', 'Assigned to me'], ['unassigned_urgent', 'Unassigned urgent'], ['awaiting_my_approval', 'Awaiting my approval'], ['all', 'All items']];
  const f = S.filters;
  const opt = (name, vals) => `<select data-filter="${name}"><option value="">${name.replace('_id', '')}: any</option>${vals.map((v) => `<option value="${esc(v.v ?? v)}" ${String(f[name]) === String(v.v ?? v) ? 'selected' : ''}>${label(v.t ?? v)}</option>`).join('')}</select>`;
  return `<main>
    <div class="tabs">${tabs.map(([k, t]) => `<button class="tab ${S.view === k ? 'active' : ''}" data-view="${k}">${t}${S.counts && k !== 'all' ? `<b>${S.counts[k]}</b>` : ''}</button>`).join('')}</div>
    <div class="filters"><input id="q" placeholder="Search title / description..." value="${esc(f.q)}">
      ${opt('status', ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'])}${opt('priority', ['urgent', 'high', 'medium', 'low'])}
      ${opt('type', ['incident', 'customer_issue', 'payment', 'compliance', 'task'])}${opt('team_id', S.me.teams.map((t) => ({ v: t.id, t: t.name })))}
      <button data-act="clear">Clear</button></div>
    <div class="card" style="padding:0;overflow:auto"><table><thead><tr><th>#</th><th>Title</th><th>Type</th><th>Priority</th><th>Status</th><th>Team</th><th>Assignee</th><th>Updated</th></tr></thead><tbody>
    ${S.items.map((i) => `<tr class="row" data-open="${i.id}"><td>${i.id}</td><td>${esc(i.title)}</td><td>${label(i.type)}</td><td>${pill(i.priority)}</td><td>${status(i.status)}</td><td>${esc(i.team_name)}</td><td>${esc(i.assignee_name) || '<span class="muted">unassigned</span>'}</td><td class="muted">${when(i.updated_at)}</td></tr>`).join('')
      || `<tr><td colspan="8" class="muted">${S.listLoading ? 'Loading...' : 'Nothing here.'}</td></tr>`}</tbody></table></div>
    ${S.cursor ? '<button data-act="more">Load more</button>' : `<span class="muted">${S.items.length} item(s) shown</span>`}</main>`;
}

function eventText(e) {
  const d = e.data || {};
  switch (e.kind) {
    case 'created': return 'created this item';
    case 'status_changed': return `changed status <b>${label(d.from)}</b> -> <b>${label(d.to)}</b>${d.comment ? `<div class="muted">"${esc(d.comment)}"</div>` : ''}`;
    case 'assignee_changed': return d.to ? `assigned to <b>${esc(d.to_name || '#' + d.to)}</b> (${esc(d.via)})` : 'removed the assignee';
    case 'priority_changed': return `changed priority <b>${label(d.from)}</b> -> <b>${label(d.to)}</b>`;
    case 'edited': return `edited ${Object.keys(d).map(label).join(', ')}`;
    case 'comment': return `commented:<div>${esc(d.text)}</div>`;
    default: return esc(e.kind);
  }
}

function itemView() {
  const it = S.item;
  if (!it) return `<main>${banner()}<div class="muted">Loading...</div></main>`;
  const c = it.can;
  const b = S.busy ? 'disabled' : '';
  return `<main><a href="#/">&larr; Back</a>${banner()}
  <div class="grid"><div>
    <div class="card"><h2 style="margin-top:0">#${it.id} ${esc(it.title)}</h2><p style="white-space:pre-wrap">${esc(it.description) || '<span class="muted">No description</span>'}</p>
      <div class="actions">
        ${c.claim ? `<button class="primary" data-act="claim" ${b}>Claim</button>` : ''}
        ${c.release ? `<button data-act="release" ${b}>Release</button>` : ''}
        ${c.transitions.map((t) => `<button data-transition="${t}" ${b}>${it.status === 'awaiting_approval' ? (t === 'resolved' ? 'Approve -> resolved' : 'Reject -> in progress') : `Move to ${label(t)}`}</button>`).join('')}
        ${c.transitions.length ? '<input id="tcomment" placeholder="optional note for history">' : ''}
      </div>
      ${c.reassign ? `<div class="actions"><span class="muted">Reassign:</span><select id="assignsel" ${b}><option value="">- unassigned -</option>${S.members.map((m) => `<option value="${m.id}" ${m.id === it.assignee_id ? 'selected' : ''}>${esc(m.name)} (${esc(m.role)})</option>`).join('')}</select></div>` : ''}
    </div>
    ${c.edit ? `<div class="card"><b>Edit</b><form id="editform"><label>Title</label><input name="title" value="${esc(it.title)}"><label>Description</label><textarea name="description">${esc(it.description)}</textarea><label>Due date</label><input name="due_date" type="date" value="${esc(it.due_date ?? '')}"><p><button class="primary" ${b}>Save (v${it.version})</button></p></form></div>` : ''}
    ${c.comment ? `<div class="card"><b>Comment</b><textarea id="ctext" placeholder="Write a comment..."></textarea><p><button data-act="comment" ${b}>Add comment</button></p></div>` : '<div class="card muted">Your role (viewer) is read-only.</div>'}
  </div><div>
    <div class="card"><div class="kv"><div>Status</div><div>${status(it.status)}</div><div>Priority</div><div>${c.edit ? `<select id="prisel" ${b}>${['low', 'medium', 'high', 'urgent'].map((p) => `<option ${p === it.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>` : pill(it.priority)}</div>
      <div>Type</div><div>${label(it.type)}</div><div>Team</div><div>${esc(it.team_name)} <span class="muted">(you: ${esc(it.my_role)})</span></div><div>Assignee</div><div>${esc(it.assignee_name) || '<span class="muted">unassigned</span>'}</div>
      <div>Created by</div><div>${esc(it.created_by_name)}</div><div>Due</div><div>${esc(it.due_date) || '-'}</div><div>Version</div><div>${it.version}</div><div>Updated</div><div>${when(it.updated_at)}</div></div></div>
    <div class="card"><b>History</b>${S.events.map((e) => `<div class="event"><b>${esc(e.actor_name || 'system')}</b> ${eventText(e)}<div class="muted">${when(e.created_at)}</div></div>`).join('')}
      ${S.eventsCursor ? '<button data-act="moreevents">Older...</button>' : ''}</div>
  </div></div></main>`;
}

function newView() {
  const teams = S.me.teams.filter((t) => t.role !== 'viewer');
  return `<main><a href="#/">&larr; Back</a>${banner()}<div class="card" style="max-width:600px"><h2 style="margin-top:0">New work item</h2>
    ${teams.length ? `<form id="newform"><label>Title</label><input name="title" required maxlength="200"><label>Description</label><textarea name="description"></textarea>
      <label>Team</label><select name="team_id">${teams.map((t) => `<option value="${t.id}">${esc(t.name)} (${esc(t.role)})</option>`).join('')}</select>
      <label>Type</label><select name="type">${['incident', 'customer_issue', 'payment', 'compliance', 'task'].map((x) => `<option value="${x}">${label(x)}</option>`).join('')}</select>
      <label>Priority</label><select name="priority"><option>low</option><option selected>medium</option><option>high</option><option>urgent</option></select>
      <label>Due date</label><input name="due_date" type="date"><p><button class="primary" ${S.busy ? 'disabled' : ''}>Create</button></p></form>` : '<p class="muted">You are a viewer in all your teams and cannot create items.</p>'}</div></main>`;
}

function banner() {
  if (!S.banner) return '';
  return `<div class="${S.banner.kind === 'error' ? 'error' : 'info'}">${esc(S.banner.text)}${S.banner.conflict ? ' <button data-act="reload">This item changed - reload</button>' : ''}</div>`;
}

function render() {
  const focus = document.activeElement?.id;
  const typed = focus === 'q' ? document.getElementById('q').value : null;
  if (!S.token) { $app.innerHTML = loginView(); return; }
  if (!S.me) { $app.innerHTML = '<main class="muted">Loading...</main>'; return; }
  const body = /^#\/item\//.test(S.route) ? itemView() : S.route === '#/new' ? newView() : dashboardView();
  $app.innerHTML = header() + body;
  if (focus === 'q') { const el = document.getElementById('q'); el.focus(); el.setSelectionRange(typed.length, typed.length); }
}

/* ------------------------------ events ------------------------------ */
let searchTimer;
$app.addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  clearTimeout(searchTimer);
  const v = e.target.value;
  searchTimer = setTimeout(async () => { S.filters.q = v; await loadItems(); render(); }, 300); // debounce
});

$app.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.filter) { S.filters[t.dataset.filter] = t.value; await loadItems(); render(); }
  else if (t.id === 'prisel') A.priority(t.value);
  else if (t.id === 'assignsel') A.assign(t.value);
});

$app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'loginform') {
    try {
      const r = await api('POST', '/auth/login', { email: f.email.value, password: f.password.value });
      S.token = r.token; localStorage.setItem('token', r.token); S.banner = null; S.me = null; location.hash = '#/'; route();
    } catch (err) { S.banner = { kind: 'error', text: err.message }; render(); }
  } else if (f.id === 'editform') A.saveEdit();
  else if (f.id === 'newform') {
    if (S.busy) return;
    S.busy = true; S.banner = null; render();
    const body = { title: f.title.value, description: f.description.value, team_id: Number(f.team_id.value), type: f.type.value, priority: f.priority.value, due_date: f.due_date.value || null };
    const sig = `new:${JSON.stringify(body)}`;
    try { const item = await api('POST', '/items', body, keyFor(sig)); keys.delete(sig); S.busy = false; location.hash = `#/item/${item.id}`; }
    catch (err) { if (err.status) keys.delete(sig); S.banner = { kind: 'error', text: err.message }; S.busy = false; render(); }
  }
});

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act],[data-view],[data-open],[data-transition]');
  if (!el) { if (S.showNotes && !e.target.closest('.bell')) { S.showNotes = false; render(); } return; }
  if (el.dataset.open) { location.hash = `#/item/${el.dataset.open}`; return; }
  if (el.dataset.view) { S.view = el.dataset.view; await loadItems(); render(); return; }
  if (el.dataset.transition) return A.transition(el.dataset.transition);
  switch (el.dataset.act) {
    case 'logout': logout(); break;
    case 'claim': A.claim(); break;
    case 'release': A.release(); break;
    case 'comment': A.comment(); break;
    case 'clear': S.filters = { q: '', status: '', priority: '', type: '', team_id: '' }; await loadItems(); render(); break;
    case 'more': await loadItems({ more: true }); render(); break;
    case 'reload': S.banner = null; await loadItem(S.item.id); render(); break;
    case 'moreevents': { const r = await api('GET', `/items/${S.item.id}/activity?limit=50&cursor=${S.eventsCursor}`); S.events.push(...r.events); S.eventsCursor = r.next_cursor; render(); break; }
    case 'bell': S.showNotes = !S.showNotes; if (S.showNotes && S.unread) { await api('POST', '/notifications/read-all'); const prev = S.notes; await loadNotes(); S.notes = S.notes.length ? S.notes : prev; S.unread = 0; } render(); break;
  }
});

route();
