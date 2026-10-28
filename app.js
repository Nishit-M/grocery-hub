/* Grocery Hub — app logic (plain ES module, no build step).
   Data lives in Cloud Firestore; the Firebase SDK keeps an offline copy on the phone,
   applies every change on screen immediately, queues writes while offline and syncs
   them (in order) when the connection returns. */

// Keep this version in sync with FIREBASE_SDK in service-worker.js.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, onSnapshot, writeBatch, getDocs, getDocFromServer,
  Timestamp, disableNetwork, enableNetwork
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

/* ------------------------------------------------------------------ constants */
const CFG = self.GH_CONFIG || {};
const APP_VERSION = CFG.APP_VERSION || '0';

const CATEGORIES = [
  'Vegetables', 'Fruits', 'Dairy', 'Grains & Pulses', 'Spices & Masala', 'Oils & Ghee',
  'Sugar & Salt', 'Dry Fruits & Nuts', 'Snacks & Beverages', 'Instant & Ready Foods',
  'Sauces & Pickles', 'Bakery', 'Meat / Fish / Eggs', 'Frozen', 'Pooja Items',
  'Personal Care', 'Household Cleaning', 'Kitchen & Disposables'
];
const CAT_ICONS = {
  'Vegetables': '🥕', 'Fruits': '🍎', 'Dairy': '🥛', 'Grains & Pulses': '🌾', 'Spices & Masala': '🌶️',
  'Oils & Ghee': '🫒', 'Sugar & Salt': '🧂', 'Dry Fruits & Nuts': '🥜', 'Snacks & Beverages': '🍪',
  'Instant & Ready Foods': '🍜', 'Sauces & Pickles': '🫙', 'Bakery': '🍞', 'Meat / Fish / Eggs': '🥚',
  'Frozen': '🧊', 'Pooja Items': '🪔', 'Personal Care': '🧴', 'Household Cleaning': '🧽',
  'Kitchen & Disposables': '🍽️', 'Other': '🛒'
};
const catTile = cat => CAT_ICONS[cat] ? `<span class="cat-ic" aria-hidden="true">${CAT_ICONS[cat]}</span>` : '';
const UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'pack', 'dozen', 'bunch', 'bottle', 'box'];
const STORES = [
  'Reliance Smart', 'More', 'National Mart', 'Ushodaya', 'Local Kirana', 'Vegetable Market',
  'BigBasket', 'Blinkit', 'Zepto', 'Swiggy Instamart'
];
const STEPS = { kg: 0.25, g: 50, L: 0.5, ml: 100 };
const stepFor = unit => STEPS[unit] || 1;

const MSG = {
  DUPLICATE: 'Already on the list – tap it to change the quantity.',
  DUPLICATE_REMOTE: 'Already on the list – someone else just added it.',
  NOT_MEMBER: "This Google account isn't on the household list.",
  NOT_FOUND: 'That item was changed or removed on another phone.',
  ALREADY_BOUGHT: 'That item was already bought on another phone.',
  NETWORK: "No connection – your change is saved and will sync when you're back online.",
  QUOTA: 'The free daily limit was reached. Please try again tomorrow.',
  DENIED: 'The server rejected that change. Tap Refresh now in Settings and try again.',
  STAPLE_EXISTS: 'A staple with that name already exists.',
  UNKNOWN: 'Something went wrong. Please try again.'
};

/* ------------------------------------------------------------------ helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const INR0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const INR2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = n => { const v = Math.round((Number(n) || 0) * 100) / 100; return (Number.isInteger(v) ? INR0 : INR2).format(v); };
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '';
const fmtQty = q => Number(q).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const qtyLabel = (q, u) => `${fmtQty(q)} ${u || ''}`.trim();
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ');
const nameKey = s => cleanName(s).toLowerCase();
// Firestore-safe document id for a name key (same function exists in Code.gs).
const keyId = k => k.replace(/[^a-z0-9]/g, c => '_' + c.charCodeAt(0).toString(16));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  }));
const toDate = v => (v == null || v === '') ? null : (typeof v.toDate === 'function' ? v.toDate() : new Date(v));
const ts = d => Timestamp.fromDate(d);
const monthStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const monthLabel = d => d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
const catIndex = c => { const i = CATEGORIES.indexOf(c); return i < 0 ? 999 : i; };
const byName = (a, b) => a.name.localeCompare(b.name, 'en-IN', { sensitivity: 'base' });
const num = v => { const n = parseFloat(String(v).replace(/[,₹\s]/g, '')); return Number.isFinite(n) ? n : NaN; };

const local = {
  get(k, d) { try { const v = localStorage.getItem('gh.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('gh.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } }
};

/* ------------------------------------------------------------------ state */
const S = {
  user: null,
  me: null,                       // { email, name }
  staples: new Map(),             // id -> staple
  items: new Map(),               // id -> active (unarchived) list row
  month: new Map(),               // id -> row bought this calendar month (archived or not)
  control: { lastReset: null, budget: null },
  loaded: { items: false, staples: false },
  pendingDocs: { items: 0, staples: 0, control: 0 },
  writesInFlight: 0,
  fromCache: true,
  online: navigator.onLine,
  tab: local.get('tab', 'list'),
  collapsed: new Set(local.get('collapsed', [])),
  stapleQuery: '',
  historyKey: null,
  installPrompt: null,
  swReg: null,
  updateReady: false
};

let app, auth, db;
let unsubs = [];
let monthUnsub = null;
let monthSubKey = '';
let dataStarted = false;

const configured = CFG.firebase && CFG.firebase.apiKey && !String(CFG.firebase.apiKey).startsWith('PASTE');

if (configured) {
  app = initializeApp(CFG.firebase);
  auth = getAuth(app);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
}

/* ------------------------------------------------------------------ errors */
function codeOf(err) {
  const c = (err && err.code) || '';
  if (c.includes('unavailable') || c.includes('network')) return 'NETWORK';
  if (c.includes('not-found')) return 'NOT_FOUND';
  if (c.includes('resource-exhausted')) return 'QUOTA';
  if (c.includes('permission-denied')) return 'DENIED';
  return 'UNKNOWN';
}
function reportError(err, overrides = {}) {
  const code = codeOf(err);
  console.warn('[Grocery Hub]', code, err);
  toast(overrides[code] || MSG[code] || MSG.UNKNOWN, { error: true });
}

/* ------------------------------------------------------------------ writes */
// Every write goes through here. Firestore applies it locally at once (optimistic UI),
// keeps it queued across restarts while offline, and rolls it back if the server rejects it.
function commit(batch, overrides) {
  S.writesInFlight++;
  updateStatus();
  return batch.commit()
    .then(() => true)
    .catch(err => { reportError(err, overrides); return false; })
    .finally(() => { S.writesInFlight--; updateStatus(); });
}
const listRef = id => doc(db, 'list', id);
const openKeyRef = key => doc(db, 'openKeys', keyId(key));
const controlRef = () => doc(db, 'control', 'main');

function activeUnbought(key, exceptId) {
  for (const r of S.items.values()) if (!r.bought && r.key === key && r.id !== exceptId) return r;
  return null;
}

function addItem({ name, category, qty, unit }, { retried = false } = {}) {
  name = cleanName(name);
  const key = nameKey(name);
  const dup = activeUnbought(key);
  if (dup) return { dup };
  const id = uuid();
  const now = new Date();
  const b = writeBatch(db);
  b.set(listRef(id), {
    name, nameKey: key, category, qty: Number(qty), unit,
    bought: false, price: null, store: '',
    dateAdded: ts(now), addedBy: S.me.name, addedByEmail: S.me.email,
    boughtBy: '', boughtByEmail: '', boughtOn: null,
    archived: false, archivedOn: null
  });
  // One "open key" per unbought name: the server refuses a second one, which blocks
  // duplicates even when two phones add the same item at the same moment.
  b.set(openKeyRef(key), { listId: id, name, at: ts(now) });
  commit(b, { DENIED: MSG.DUPLICATE_REMOTE }).then(ok => {
    if (ok || retried) return;
    // The server said "duplicate". Check with the server whether that open key really points to an
    // unbought row; if not (a stale key), clear it and retry once.
    setTimeout(async () => {
      if (activeUnbought(key)) return;
      try {
        const k = await getDocFromServer(openKeyRef(key));
        if (!k.exists()) return addItem({ name, category, qty, unit }, { retried: true });
        const owner = await getDocFromServer(listRef(k.data().listId));
        const live = owner.exists() && !owner.data().bought && !owner.data().archived;
        if (live) return;
        const fix = writeBatch(db);
        fix.delete(openKeyRef(key));
        if (await commit(fix)) addItem({ name, category, qty, unit }, { retried: true });
      } catch (e) { /* offline or denied – leave it; the user can try again */ }
    }, 1500);
  });
  return { id };
}

function updateItem(r, fields) {
  const b = writeBatch(db);
  b.update(listRef(r.id), fields);
  return commit(b);
}

function markBought(r) {
  const now = new Date();
  const b = writeBatch(db);
  b.update(listRef(r.id), { bought: true, boughtBy: S.me.name, boughtByEmail: S.me.email, boughtOn: ts(now) });
  b.delete(openKeyRef(r.key));
  commit(b, { DENIED: MSG.ALREADY_BOUGHT });
  snack(`${r.name} moved to cart`, () => undoBought(r, true));
}

function undoBought(r, fromSnack = false) {
  if (activeUnbought(r.key, r.id)) { toast(MSG.DUPLICATE, { error: true }); return; }
  const b = writeBatch(db);
  b.update(listRef(r.id), { bought: false, boughtBy: '', boughtByEmail: '', boughtOn: null });
  b.set(openKeyRef(r.key), { listId: r.id, name: r.name, at: ts(new Date()) });
  commit(b, { DENIED: MSG.DUPLICATE_REMOTE });
  if (!fromSnack) toast(`${r.name} moved back to To Buy`);
}

function removeItem(r) {
  if (r.bought) return;
  const snapshot = { ...r };
  const b = writeBatch(db);
  b.delete(listRef(r.id));
  b.delete(openKeyRef(r.key));
  commit(b, { DENIED: MSG.ALREADY_BOUGHT });
  snack(`${r.name} removed`, () => restoreItem(snapshot));
}

function restoreItem(r) {
  if (activeUnbought(r.key)) { toast(MSG.DUPLICATE, { error: true }); return; }
  const b = writeBatch(db);
  b.set(listRef(r.id), {
    name: r.name, nameKey: r.key, category: r.category, qty: r.qty, unit: r.unit,
    bought: false, price: r.price, store: r.store || '',
    dateAdded: ts(r.dateAdded || new Date()), addedBy: r.addedBy, addedByEmail: r.addedByEmail || '',
    boughtBy: '', boughtByEmail: '', boughtOn: null, archived: false, archivedOn: null
  });
  b.set(openKeyRef(r.key), { listId: r.id, name: r.name, at: ts(new Date()) });
  commit(b, { DENIED: MSG.DUPLICATE_REMOTE });
}

async function resetMonth() {
  const cart = cartRows();
  if (!cart.length) return;
  const total = cart.reduce((s, r) => s + (r.price || 0), 0);
  const ok = await confirmBox(
    `Archive ${cart.length} purchased item${cart.length === 1 ? '' : 's'} (${money(total)}) and start a new month? Unbought items will stay on the list.`,
    'Archive & reset');
  if (!ok) return;
  const prevReset = S.control.lastReset;
  const now = new Date();
  const ids = cart.map(r => r.id);
  // A batch holds at most 500 writes; chunk to be safe.
  for (let i = 0; i < ids.length; i += 450) {
    const b = writeBatch(db);
    ids.slice(i, i + 450).forEach(id => b.update(listRef(id), { archived: true, archivedOn: ts(now) }));
    if (i === 0) b.set(controlRef(), { lastReset: ts(now) }, { merge: true });
    commit(b);
  }
  snack(`Archived ${ids.length} item${ids.length === 1 ? '' : 's'} – new month started`, () => {
    for (let i = 0; i < ids.length; i += 450) {
      const b = writeBatch(db);
      ids.slice(i, i + 450).forEach(id => b.update(listRef(id), { archived: false, archivedOn: null }));
      if (i === 0) b.set(controlRef(), { lastReset: prevReset ? ts(prevReset) : null }, { merge: true });
      commit(b);
    }
  });
}

function upsertStaple(st) {
  const key = nameKey(st.name);
  for (const s of S.staples.values()) {
    if (s.id !== st.id && nameKey(s.name) === key) { toast(MSG.STAPLE_EXISTS, { error: true }); return false; }
  }
  const id = st.id || uuid().slice(0, 8);
  const sort = st.id ? (S.staples.get(st.id)?.sort ?? 0)
    : Math.max(0, ...[...S.staples.values()].map(s => s.sort || 0)) + 1;
  const b = writeBatch(db);
  b.set(doc(db, 'staples', id), {
    name: cleanName(st.name), category: st.category, qty: Number(st.qty), unit: st.unit,
    status: st.status || 'Staple', sort
  }, { merge: true });
  commit(b);
  return true;
}

function setStapleStatus(st, status) {
  const b = writeBatch(db);
  b.update(doc(db, 'staples', st.id), { status });
  commit(b);
}

function setBudget(amount) {
  const b = writeBatch(db);
  b.set(controlRef(), { budget: amount > 0 ? amount : null }, { merge: true });
  commit(b);
}

/* ------------------------------------------------------------------ derived data */
const toBuyRows = () => [...S.items.values()].filter(r => !r.bought);
const cartRows = () => [...S.items.values()].filter(r => r.bought)
  .sort((a, b) => (b.boughtOn?.getTime() || 0) - (a.boughtOn?.getTime() || 0));
function isCarried(r) {
  return !r.bought && S.control.lastReset && r.dateAdded && r.dateAdded < S.control.lastReset;
}
function totals() {
  const cart = cartRows();
  const start = monthStart(), end = addMonths(start, 1);
  let spent = 0;
  for (const r of S.month.values()) {
    if (r.bought && r.boughtOn && r.boughtOn >= start && r.boughtOn < end) spent += r.price || 0;
  }
  return {
    toBuy: toBuyRows().length,
    inCart: cart.length,
    cartTotal: cart.reduce((s, r) => s + (r.price || 0), 0),
    spent,
    missing: cart.filter(r => r.price == null).length
  };
}
function groupByCategory(rows) {
  const map = new Map();
  rows.forEach(r => {
    const c = CATEGORIES.includes(r.category) ? r.category : 'Other';
    if (!map.has(c)) map.set(c, []);
    map.get(c).push(r);
  });
  return [...map.entries()].sort((a, b) => catIndex(a[0]) - catIndex(b[0]))
    .map(([cat, list]) => [cat, list.sort(byName)]);
}

/* ------------------------------------------------------------------ data sync */
function rowFrom(d) {
  const x = d.data({ serverTimestamps: 'estimate' });
  return {
    id: d.id,
    name: x.name || '',
    key: x.nameKey || nameKey(x.name),
    category: x.category || 'Other',
    qty: Number(x.qty) || 1,
    unit: x.unit || 'pcs',
    bought: !!x.bought,
    price: (x.price == null || x.price === '') ? null : Number(x.price),
    store: x.store || '',
    dateAdded: toDate(x.dateAdded),
    addedBy: x.addedBy || '',
    addedByEmail: x.addedByEmail || '',
    boughtBy: x.boughtBy || '',
    boughtOn: toDate(x.boughtOn),
    archived: !!x.archived,
    pending: d.metadata.hasPendingWrites
  };
}
function stapleFrom(d) {
  const x = d.data();
  return {
    id: d.id, name: x.name || '', category: x.category || 'Other',
    qty: Number(x.qty) || 1, unit: x.unit || 'pcs', status: x.status || 'Staple', sort: Number(x.sort) || 0
  };
}

function listen(ref, next) {
  const u = onSnapshot(ref, { includeMetadataChanges: true }, next, err => {
    if (codeOf(err) === 'DENIED') { showDenied(); return; }
    reportError(err);
  });
  unsubs.push(u);
  return u;
}

function startData() {
  if (dataStarted) return;
  dataStarted = true;

  listen(query(collection(db, 'list'), where('archived', '==', false)), snap => {
    S.items = new Map(snap.docs.map(d => [d.id, rowFrom(d)]));
    S.pendingDocs.items = snap.docs.filter(d => d.metadata.hasPendingWrites).length;
    S.fromCache = snap.metadata.fromCache;
    S.loaded.items = true;
    scheduleRender();
  });
  listen(collection(db, 'staples'), snap => {
    S.staples = new Map(snap.docs.map(d => [d.id, stapleFrom(d)]));
    S.pendingDocs.staples = snap.docs.filter(d => d.metadata.hasPendingWrites).length;
    S.loaded.staples = true;
    scheduleRender();
  });
  listen(controlRef(), snap => {
    const x = snap.exists() ? snap.data() : {};
    S.control = { lastReset: toDate(x.lastReset), budget: x.budget == null ? null : Number(x.budget) };
    S.pendingDocs.control = snap.metadata.hasPendingWrites ? 1 : 0;
    scheduleRender();
  });
  subscribeMonth();
}

// Rows bought this calendar month (including archived ones) for "Spent this month".
function subscribeMonth() {
  const start = monthStart();
  const k = monthKey(start);
  if (k === monthSubKey && monthUnsub) return;
  if (monthUnsub) monthUnsub();
  monthSubKey = k;
  S.month = new Map();
  monthUnsub = onSnapshot(query(collection(db, 'list'), where('boughtOn', '>=', ts(start))), snap => {
    S.month = new Map(snap.docs.map(d => [d.id, rowFrom(d)]));
    scheduleRender();
  }, err => reportError(err));
}

function stopData() {
  unsubs.forEach(u => u());
  unsubs = [];
  if (monthUnsub) monthUnsub();
  monthUnsub = null; monthSubKey = '';
  dataStarted = false;
  S.items = new Map(); S.staples = new Map(); S.month = new Map();
  S.loaded = { items: false, staples: false };
}

/* ------------------------------------------------------------------ auth */
let memberUnsub = null;

function watchMember(user) {
  const email = (user.email || '').toLowerCase();
  const cached = local.get('me', null);
  if (cached && cached.email === email) {
    S.me = cached;
    startData();
    showApp();
  }
  if (memberUnsub) memberUnsub();
  memberUnsub = onSnapshot(doc(db, 'members', email), snap => {
    if (!snap.exists() || snap.data().active === false) {
      if (!snap.metadata.fromCache) showDenied();
      return;
    }
    const x = snap.data();
    S.me = { email, name: x.name || user.displayName || email };
    local.set('me', S.me);
    startData();
    showApp();
    scheduleRender();
  }, err => {
    if (codeOf(err) === 'DENIED') showDenied();
    else if (!S.me) reportError(err);
  });
}

async function doSignIn() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  $('#signinError').textContent = '';
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    const fallback = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/web-storage-unsupported'];
    if (fallback.includes(e.code)) return signInWithRedirect(auth, provider);
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    if (e.code === 'auth/unauthorized-domain') {
      $('#signinError').textContent = `This website (${location.hostname}) is not yet allowed in Firebase → Authentication → Settings → Authorized domains.`;
      return;
    }
    if (e.code === 'auth/network-request-failed') { $('#signinError').textContent = 'No connection. Connect to the internet to sign in.'; return; }
    $('#signinError').textContent = 'Sign-in failed: ' + (e.code || e.message);
  }
}

async function doSignOut() {
  const ok = await confirmBox('Sign out of this phone? Changes not yet synced will be sent next time this account signs in.', 'Sign out');
  if (!ok) return;
  local.set('me', null);
  S.me = null;
  stopData();
  if (memberUnsub) { memberUnsub(); memberUnsub = null; }
  await signOut(auth);
}

/* ------------------------------------------------------------------ screens */
const SCREENS = ['screen-loading', 'screen-signin', 'screen-denied', 'screen-setup', 'tab-list', 'tab-staples', 'tab-history', 'tab-settings'];
function showOnly(id) { SCREENS.forEach(s => { $('#' + s).hidden = s !== id; }); }

function showSignIn() {
  showOnly('screen-signin');
  $('#menuBtn').hidden = true; closeMenu(); $('#fab').hidden = true; $('#memberChip').hidden = true;
}
function showDenied() {
  stopData();
  local.set('me', null);
  S.me = null;
  $('#deniedEmail').textContent = S.user ? S.user.email : '';
  showOnly('screen-denied');
  $('#menuBtn').hidden = true; closeMenu(); $('#fab').hidden = true; $('#memberChip').hidden = true;
}
function showApp() {
  $('#menuBtn').hidden = false;
  $('#memberChip').hidden = false;
  goto(S.tab, false);
}

const TAB_TITLES = { list: 'Grocery Hub', staples: 'Staples', history: 'History', settings: 'Settings' };
function openMenu() {
  const d = $('#drawer');
  if (d.open) return;
  const me = S.me;
  $('#drawerFoot').textContent = me ? `Signed in as ${me.name || me.email || ''} · v${APP_VERSION}` : `v${APP_VERSION}`;
  d.showModal();
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  const cur = d.querySelector('[aria-current="page"]');
  if (cur) cur.focus();
}
function closeMenu() {
  const d = $('#drawer');
  if (d && d.open) d.close();
}
function goto(tab, focus = true) {
  if (!['list', 'staples', 'history', 'settings'].includes(tab)) tab = 'list';
  S.tab = tab;
  local.set('tab', tab);
  const ready = S.loaded.items || S.items.size;
  showOnly(ready ? 'tab-' + tab : 'screen-loading');
  $$('#tabbar button').forEach(b => {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('#fab').hidden = !(tab === 'list' && ready);
  $('#brand').textContent = TAB_TITLES[tab];
  document.title = tab === 'list' ? 'Grocery Hub' : TAB_TITLES[tab] + ' · Grocery Hub';
  closeMenu();
  if (tab === 'history') ensureHistory();
  render();
  if (focus) { window.scrollTo(0, 0); $('#main').focus({ preventScroll: true }); }
}

/* ------------------------------------------------------------------ rendering */
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  if (!S.me) return;
  const ready = S.loaded.items || S.items.size;
  if (ready && !$('#screen-loading').hidden) goto(S.tab, false);
  const initials = S.me.name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
  $('#memberChip').textContent = initials;
  $('#memberChip').setAttribute('aria-label', `${S.me.name} — Settings`);
  updateStatus();
  if (!ready) return;
  renderPicker();
  if (S.tab === 'list') renderList();
  else if (S.tab === 'staples') renderStaples();
  else if (S.tab === 'history') renderHistory();
  else if (S.tab === 'settings') renderSettings();
}

function groupHTML(id, title, count, inner, extra = '') {
  const open = !S.collapsed.has(id);
  const tile = catTile(title);
  return `<details class="group${tile ? ' has-ic' : ''}" data-group="${esc(id)}" ${open ? 'open' : ''}>
    <summary>${tile}<h3>${esc(title)}</h3>${extra}<span class="count">${count}</span></summary>
    <ul class="rows">${inner}</ul></details>`;
}

// Collapsible category for long staple lists: only one open at a time (see the 'toggle' listener).
function accordionHTML(acc, cat, rows, rowHTML) {
  const onCount = rows.filter(st => activeUnbought(nameKey(st.name))).length;
  return `<details class="group acc has-ic" data-acc="${acc}" data-cat="${esc(cat)}" ${openCat[acc] === cat ? 'open' : ''}>
    <summary>${catTile(cat)}<h3>${esc(cat)}</h3>${onCount ? `<span class="on-count">${onCount} on list</span>` : ''}<span class="count">${rows.length}</span></summary>
    <ul class="rows">${typeof rowHTML === 'string' ? rowHTML : rows.map(rowHTML).join('')}</ul></details>`;
}

function renderList() {
  const t = totals();
  const budget = S.control.budget;
  let budgetHTML = '';
  if (budget > 0) {
    const pct = (t.spent / budget) * 100;
    const cls = pct > 100 ? 'red' : pct > 80 ? 'orange' : '';
    budgetHTML = `<div class="budget">
      <div class="top"><span>Budget this month</span><span><b>${money(t.spent)}</b> of ${money(budget)} (${Math.round(pct)}%)</span></div>
      <div class="track" role="progressbar" aria-label="Spent this month against budget" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, Math.round(pct))}">
        <div class="fill ${cls}" style="width:${Math.min(100, pct)}%"></div></div></div>`;
  }
  $('#listSummary').innerHTML = `
    <div class="cards">
      <div class="card"><div class="label">Items to buy</div><div class="value">${t.toBuy}</div></div>
      <div class="card"><div class="label">Items in cart</div><div class="value">${t.inCart}</div></div>
      <div class="card"><div class="label">Cart total</div><div class="value">${money(t.cartTotal)}</div></div>
      <div class="card"><div class="label">Spent this month</div><div class="value">${money(t.spent)}</div></div>
      <div class="card wide ${t.missing ? 'warn' : ''}"><div class="label">Missing prices</div><div class="value">${t.missing}</div></div>
    </div>${budgetHTML}`;

  const toBuy = toBuyRows();
  const cart = cartRows();
  let html = `<div class="section-head"><h2>To Buy</h2>
    ${toBuy.length ? `<button class="btn" type="button" data-act="share" aria-label="Share the To Buy list">Share</button>` : ''}</div>`;
  if (!toBuy.length) {
    html += `<div class="empty">Nothing to buy. Tap <b>+</b> or add from <b>Staples</b>.</div>`;
  } else {
    for (const [cat, rows] of groupByCategory(toBuy)) {
      const inner = rows.map(r => {
        const carried = isCarried(r);
        return `<li class="row ${carried ? 'carried' : ''} ${r.pending ? 'pending' : ''}" data-row="${esc(r.id)}">
          <button type="button" class="row-main" data-act="edit" data-id="${esc(r.id)}"
            aria-label="Edit ${esc(r.name)}, ${esc(qtyLabel(r.qty, r.unit))}${carried ? ', carried over from last month' : ''}">
            <span class="name">${esc(r.name)}</span>
            <span class="meta">${esc(qtyLabel(r.qty, r.unit))} · added by ${esc(r.addedBy || '—')}${carried ? ' · carried over' : ''}</span>
          </button>
          <button type="button" class="icon-btn ok" data-act="buy" data-id="${esc(r.id)}" aria-label="Mark ${esc(r.name)} as bought"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
        </li>`;
      }).join('');
      html += groupHTML('buy:' + cat, cat, rows.length, inner);
    }
  }

  html += `<div class="section-head"><h2>In Cart</h2></div>`;
  if (!cart.length) {
    html += `<div class="empty">Tap ✔ on an item when it's in your basket.</div>`;
  } else {
    const inner = cart.map(r => {
      const missing = r.price == null;
      return `<li class="row ${missing ? 'missing' : ''} ${r.pending ? 'pending' : ''}" data-row="${esc(r.id)}">
        <button type="button" class="row-main" data-act="editCart" data-id="${esc(r.id)}"
          aria-label="Enter price and store for ${esc(r.name)}${missing ? ', price missing' : ', price ' + esc(money(r.price))}">
          <span class="row-line"><span class="name">${esc(r.name)}</span><span class="price">${missing ? 'Add price' : esc(money(r.price))}</span></span>
          <span class="meta">${esc(qtyLabel(r.qty, r.unit))}${r.store ? ' · ' + esc(r.store) : ''} · by ${esc(r.boughtBy || '—')}</span>
        </button>
        <button type="button" class="icon-btn" data-act="unbuy" data-id="${esc(r.id)}" aria-label="Move ${esc(r.name)} back to To Buy"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg></button>
      </li>`;
    }).join('');
    html += groupHTML('cart', 'Bought', cart.length, inner, `<span class="subtotal">${esc(money(t.cartTotal))}</span>`);
    html += `<div class="list-actions"><button class="btn danger" type="button" data-act="reset">Reset Monthly List</button></div>`;
  }
  $('#listBody').innerHTML = html;
}

function renderStaples() {
  const q = nameKey(S.stapleQuery);
  const active = [...S.staples.values()].filter(s => s.status !== 'Inactive' && (!q || nameKey(s.name).includes(q) || nameKey(s.category).includes(q)));
  if (!S.staples.size && S.loaded.staples) {
    $('#staplesBody').innerHTML = `<div class="empty">No staples yet. Run <b>Grocery Hub → Import from sheet</b> in the Google Sheet, or add staples in Settings.</div>`;
    return;
  }
  if (!active.length) {
    $('#staplesBody').innerHTML = `<div class="empty">No staples match “${esc(S.stapleQuery)}”.<br><br>
      <button class="btn primary" type="button" data-act="openAdd" data-name="${esc(S.stapleQuery)}">Add “${esc(cleanName(S.stapleQuery))}” to the list</button></div>`;
    return;
  }
  let html = '';
  for (const [cat, rows] of groupByCategory(active)) {
    const inner = rows.map(s => {
      const onList = activeUnbought(nameKey(s.name));
      return `<li class="row">
        <button type="button" class="row-main" data-act="addStaple" data-sid="${esc(s.id)}"
          aria-label="${onList ? esc(s.name) + ' is on the list' : 'Add ' + esc(s.name) + ', ' + esc(qtyLabel(s.qty, s.unit))}">
          <span class="name">${esc(s.name)}</span>
          <span class="meta">${onList ? `<span class="tag">On list</span> ${esc(qtyLabel(onList.qty, onList.unit))}` : esc(qtyLabel(s.qty, s.unit))}</span>
        </button>
        ${onList
          ? `<button type="button" class="icon-btn" data-act="removeStaple" data-sid="${esc(s.id)}" aria-label="Remove ${esc(s.name)} from the list"><svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`
          : `<button type="button" class="icon-btn ok" data-act="addStaple" data-sid="${esc(s.id)}" aria-label="Add ${esc(s.name)} to the list"><svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>`}
      </li>`;
    }).join('');
    // While searching, every matching group is shown open; otherwise categories form an accordion.
    html += q ? groupHTML('search:' + cat, cat, rows.length, inner) : accordionHTML('staples', cat, rows, inner);
  }
  $('#staplesBody').innerHTML = html;
}

/* ---------- history */
let historyCache = { key: null, rows: null, loading: false, error: null };

function fillHistorySelect() {
  const sel = $('#historyMonth');
  if (sel.options.length) return;
  const now = monthStart();
  const opts = [];
  for (let i = 0; i < 24; i++) {
    const d = addMonths(now, -i);
    opts.push(`<option value="${monthKey(d)}">${esc(monthLabel(d))}${i === 0 ? ' (this month)' : ''}</option>`);
  }
  opts.push('<option value="all">All months (summary)</option>');
  sel.innerHTML = opts.join('');
  S.historyKey = S.historyKey || monthKey(addMonths(now, -1));
  sel.value = S.historyKey;
}

async function ensureHistory(force = false) {
  fillHistorySelect();
  const key = S.historyKey;
  if (!force && historyCache.key === key && (historyCache.rows || historyCache.loading)) return;
  historyCache = { key, rows: null, loading: true, error: null };
  renderHistory();
  try {
    let q;
    if (key === 'all') {
      q = query(collection(db, 'list'), where('bought', '==', true));
    } else {
      const [y, m] = key.split('-').map(Number);
      const start = new Date(y, m - 1, 1), end = new Date(y, m, 1);
      q = query(collection(db, 'list'), where('boughtOn', '>=', ts(start)), where('boughtOn', '<', ts(end)));
    }
    const snap = await getDocs(q);
    if (historyCache.key !== key) return;
    historyCache.rows = snap.docs.map(rowFrom).filter(r => r.bought && r.boughtOn);
  } catch (e) {
    historyCache.error = e;
  }
  historyCache.loading = false;
  if (S.tab === 'history') renderHistory();
}

function storeBucket(s) { return STORES.includes(s) ? s : (s ? 'Other stores' : 'No store'); }

function renderHistory() {
  const body = $('#historyBody');
  if (historyCache.loading) { body.innerHTML = '<div class="skel-row"></div><div class="skel-row"></div><div class="skel-row"></div>'; return; }
  if (historyCache.error) {
    body.innerHTML = `<div class="empty">Couldn't load history. ${esc(MSG[codeOf(historyCache.error)] || '')}<br><br>
      <button class="btn" type="button" data-act="reloadHistory">Try again</button></div>`;
    return;
  }
  const rows = historyCache.rows || [];
  if (!rows.length) { body.innerHTML = '<div class="empty">Nothing was bought in this period.</div>'; return; }

  if (S.historyKey === 'all') {
    const months = new Map(); const storeSet = new Set();
    rows.forEach(r => {
      const mk = monthKey(r.boughtOn); const sb = storeBucket(r.store);
      storeSet.add(sb);
      if (!months.has(mk)) months.set(mk, { total: 0, count: 0, stores: {} });
      const m = months.get(mk);
      m.total += r.price || 0; m.count++; m.stores[sb] = (m.stores[sb] || 0) + (r.price || 0);
    });
    const order = [...STORES, 'Other stores', 'No store'];
    const cols = order.filter(s => storeSet.has(s));
    const keys = [...months.keys()].sort().reverse();
    const grand = { total: 0, count: 0, stores: {} };
    const trs = keys.map(k => {
      const m = months.get(k); const [y, mo] = k.split('-').map(Number);
      grand.total += m.total; grand.count += m.count;
      cols.forEach(c => { grand.stores[c] = (grand.stores[c] || 0) + (m.stores[c] || 0); });
      return `<tr><td>${esc(monthLabel(new Date(y, mo - 1, 1)))}</td>${cols.map(c => `<td>${m.stores[c] ? esc(money(m.stores[c])) : '–'}</td>`).join('')}<td><b>${esc(money(m.total))}</b></td><td>${m.count}</td></tr>`;
    }).join('');
    body.innerHTML = `<div class="table-wrap"><table>
      <caption class="sr-only">Spend by month and store</caption>
      <thead><tr><th scope="col">Month</th>${cols.map(c => `<th scope="col">${esc(c)}</th>`).join('')}<th scope="col">Total</th><th scope="col">Items</th></tr></thead>
      <tbody>${trs}</tbody>
      <tfoot><tr><td>All</td>${cols.map(c => `<td>${esc(money(grand.stores[c] || 0))}</td>`).join('')}<td>${esc(money(grand.total))}</td><td>${grand.count}</td></tr></tfoot>
    </table></div>`;
    return;
  }

  const groups = new Map();
  rows.forEach(r => { const s = r.store || 'No store'; if (!groups.has(s)) groups.set(s, []); groups.get(s).push(r); });
  const total = rows.reduce((s, r) => s + (r.price || 0), 0);
  const notReset = rows.filter(r => !r.archived).length;
  const sorted = [...groups.entries()].sort((a, b) =>
    b[1].reduce((s, r) => s + (r.price || 0), 0) - a[1].reduce((s, r) => s + (r.price || 0), 0));
  let html = `<div class="hist-total">
    <div class="card"><div class="label">Month total</div><div class="value">${esc(money(total))}</div></div>
    <div class="card"><div class="label">Items bought</div><div class="value">${rows.length}</div></div></div>`;
  if (notReset) html += `<p class="muted">${notReset} item${notReset === 1 ? ' is' : 's are'} still in the cart (not reset yet) and ${notReset === 1 ? 'is' : 'are'} included, marked “in cart”.</p>`;
  for (const [store, list] of sorted) {
    const sub = list.reduce((s, r) => s + (r.price || 0), 0);
    const inner = list.sort((a, b) => a.boughtOn - b.boughtOn).map(r => `<li class="row ${r.price == null ? 'missing' : ''}">
      <div class="row-main" style="cursor:default">
        <span class="row-line"><span class="name">${esc(r.name)}</span><span class="price">${r.price == null ? 'No price' : esc(money(r.price))}</span></span>
        <span class="meta">${esc(qtyLabel(r.qty, r.unit))} · ${esc(fmtDate(r.boughtOn))} · ${esc(r.boughtBy || '—')} ${r.archived ? '' : '<span class="tag grey">in cart</span>'}</span>
      </div></li>`).join('');
    html += groupHTML('hist:' + store, store, list.length, inner, `<span class="subtotal">${esc(money(sub))}</span>`);
  }
  body.innerHTML = html;
}

/* ---------- settings */
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function renderSettings() {
  const theme = local.get('theme', 'system');
  let install;
  if (isStandalone()) install = '<p>✅ Grocery Hub is installed on this device.</p>';
  else if (S.installPrompt) install = '<p>Add Grocery Hub to your home screen for one-tap access.</p><button class="btn primary" type="button" data-act="install">Install app</button>';
  else if (isIOS()) install = '<p>On iPhone/iPad: open this page in <b>Safari</b> → tap <b>Share</b> (□↑) → <b>Add to Home Screen</b>.</p>';
  else install = '<p><b>Android Chrome:</b> ⋮ menu → <b>Install app</b>.<br><b>Desktop Chrome/Edge:</b> click the install icon in the address bar.</p>';

  const online = navigator.onLine;
  const pending = pendingCount();
  const syncText = !online ? `Offline${pending ? ` – ${pending} change${pending === 1 ? '' : 's'} waiting` : ''}`
    : pending ? `Syncing ${pending} change${pending === 1 ? '' : 's'}…` : S.fromCache ? 'Connecting…' : 'Live – changes appear on every phone within a second or two.';

  $('#settingsBody').innerHTML = `
    <div class="panel">
      <h3>Member</h3>
      <p>Signed in as <b>${esc(S.me.name)}</b><br><span class="muted">${esc(S.me.email)}</span></p>
      <button class="btn" type="button" data-act="signout">Switch member (sign out)</button>
    </div>
    <div class="panel">
      <h3>Monthly budget</h3>
      <form class="inline-form" data-form="budget">
        <label for="budgetInput" class="sr-only">Monthly budget in rupees</label>
        <input id="budgetInput" type="text" inputmode="decimal" autocomplete="off" placeholder="e.g. 15000" value="${S.control.budget > 0 ? esc(S.control.budget) : ''}">
        <button class="btn primary" type="submit">Save</button>
      </form>
      <p class="muted" style="margin-top:8px">Leave empty and save to hide the budget bar.</p>
    </div>
    <div class="panel">
      <h3>Staples</h3>
      <p>${[...S.staples.values()].filter(s => s.status !== 'Inactive').length} active · ${[...S.staples.values()].filter(s => s.status === 'Inactive').length} inactive</p>
      <div class="btn-row" style="justify-content:flex-start">
        <button class="btn" type="button" data-act="manageStaples">Manage staples</button>
        <button class="btn" type="button" data-act="editStaple">+ New staple</button>
      </div>
    </div>
    <div class="panel">
      <h3>Sync</h3>
      <p>${esc(syncText)}</p>
      <button class="btn" type="button" data-act="refresh">Refresh now</button>
    </div>
    <div class="panel">
      <h3>Install app</h3>
      ${install}
    </div>
    <div class="panel">
      <h3 id="themeLabel">Theme</h3>
      <div class="radio-row" role="radiogroup" aria-labelledby="themeLabel">
        ${['system', 'light', 'dark'].map(t => `<label><input type="radio" name="theme" value="${t}" ${theme === t ? 'checked' : ''}> ${t[0].toUpperCase() + t.slice(1)}</label>`).join('')}
      </div>
    </div>
    <div class="panel">
      <h3>About</h3>
      <p class="muted">Grocery Hub version ${esc(APP_VERSION)}${S.updateReady ? ' · update ready' : ''}</p>
      ${S.updateReady ? '<button class="btn primary" type="button" data-act="applyUpdate">Reload to update</button>' : ''}
    </div>`;
}

/* ------------------------------------------------------------------ status, banners */
function pendingCount() {
  return S.pendingDocs.items + S.pendingDocs.staples + S.pendingDocs.control;
}
function updateStatus() {
  const online = navigator.onLine;
  const pending = Math.max(pendingCount(), S.writesInFlight > 0 && !online ? S.writesInFlight : 0);
  const dot = $('#syncDot');
  dot.className = 'sync-dot' + (!online ? ' offline' : pending ? ' pending' : '');
  dot.setAttribute('aria-label', !online ? 'Offline' : pending ? 'Syncing changes' : 'Synced');
  const parts = [];
  if (!online) {
    parts.push(`<div class="banner"><span class="grow">Offline${pending ? ` – ${pending} change${pending === 1 ? '' : 's'} waiting` : ' – showing saved list'}</span></div>`);
  }
  if (S.updateReady) {
    parts.push('<div class="banner info"><span class="grow">Update available</span><button class="btn primary" type="button" data-act="applyUpdate">Reload</button></div>');
  }
  if (S.installPrompt && !isStandalone() && !local.get('installDismissed', false) && S.me) {
    parts.push('<div class="banner info"><span class="grow">Install Grocery Hub on this phone?</span><button class="btn primary" type="button" data-act="install">Install app</button><button class="icon-btn ghost" type="button" data-act="dismissInstall" aria-label="Dismiss install suggestion">✕</button></div>');
  }
  const html = parts.join('');
  const box = $('#banners');
  if (box.innerHTML !== html) box.innerHTML = html;
}

/* ------------------------------------------------------------------ toast & snackbar */
let toastTimer = null;
let snackUndo = null;
// Open sheets/menus are modal: everything outside them is drawn underneath and can't be tapped.
// So the toast lives inside the top-most open dialog (or <body>), and is shown as a popover so it
// is drawn above everything.
function placeToast() {
  const el = $('#toast');
  if (el.hidden) return;
  const host = [...document.querySelectorAll('dialog[open]')].pop() || document.body;
  if (el.parentElement !== host) host.appendChild(el);
  if (el.showPopover) { try { if (el.matches(':popover-open')) el.hidePopover(); el.showPopover(); } catch (e) {} }
}
['#sheet', '#confirm', '#drawer'].forEach(sel => $(sel).addEventListener('close', () => {
  if ($(sel).contains($('#toast'))) requestAnimationFrame(placeToast);
}));
function hideToast() {
  const el = $('#toast');
  el.hidden = true; snackUndo = null;
  if (el.hidePopover) { try { el.hidePopover(); } catch (e) {} }
}
function toast(msg, { error = false, undo = null, ms = 4000 } = {}) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  snackUndo = undo;
  el.className = 'toast' + (error ? ' error' : '');
  el.innerHTML = `<span class="msg">${esc(msg)}</span>${undo ? '<button type="button" data-act="undo">Undo</button>' : ''}<button type="button" data-act="closeToast" aria-label="Dismiss message">✕</button>`;
  el.hidden = false;
  placeToast();
  toastTimer = setTimeout(() => hideToast(), ms);
}
const snack = (msg, undo) => toast(msg, { undo, ms: 5000 });

/* ------------------------------------------------------------------ confirm */
let confirmResolve = null;
function confirmBox(text, okLabel = 'OK') {
  const dlg = $('#confirm');
  $('#confirmText').textContent = text;
  $('#confirmYes').textContent = okLabel;
  dlg.showModal();
  return new Promise(res => { confirmResolve = res; });
}
function closeConfirm(val) {
  $('#confirm').close();
  if (confirmResolve) { confirmResolve(val); confirmResolve = null; }
}
$('#confirm').addEventListener('cancel', () => { if (confirmResolve) { confirmResolve(false); confirmResolve = null; } });

/* ------------------------------------------------------------------ bottom sheet */
let sheetSubmit = null;
let pickerQuery = null;   // non-null while the "Add items" picker is showing
const openCat = { picker: null, staples: null };   // one open category per accordion
function openSheet(title, bodyHTML, onSubmit, focusSel, { tall = false } = {}) {
  pickerQuery = null;
  $('#sheet').classList.toggle('tall', tall);
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = bodyHTML;
  sheetSubmit = onSubmit;
  const dlg = $('#sheet');
  if (!dlg.open) dlg.showModal();
  const f = focusSel ? $(focusSel, dlg) : null;
  if (f) setTimeout(() => f.focus(), 30);
}
function closeSheet() { const d = $('#sheet'); if (d.open) d.close(); sheetSubmit = null; pickerQuery = null; }
$('#sheetForm').addEventListener('submit', e => {
  e.preventDefault();
  if (sheetSubmit) sheetSubmit(new FormData(e.target), e.submitter);
});
$('#sheet').addEventListener('click', e => { if (e.target === e.currentTarget) closeSheet(); }); // tap on backdrop
$('#sheet').addEventListener('close', () => { pickerQuery = null; });
$('#drawer').addEventListener('click', e => { if (e.target === e.currentTarget) closeMenu(); }); // tap outside the menu
$('#drawer').addEventListener('close', () => { $('#menuBtn').setAttribute('aria-expanded', 'false'); });

const optionList = (list, sel, placeholder) =>
  (placeholder ? `<option value="" ${sel ? '' : 'selected'} disabled>${esc(placeholder)}</option>` : '') +
  list.map(v => `<option ${v === sel ? 'selected' : ''}>${esc(v)}</option>`).join('');
const storeDatalist = () => `<datalist id="storeList">${STORES.map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist>`;
function qtyFields(qty, unit) {
  return `<div class="two">
    <div class="field"><label for="f-qty">Quantity</label>
      <div class="stepper">
        <button type="button" data-step="-1" aria-label="Decrease quantity">−</button>
        <input id="f-qty" name="qty" type="number" inputmode="decimal" min="0" step="any" value="${esc(fmtQty(qty).replace(/,/g, ''))}" required>
        <button type="button" data-step="1" aria-label="Increase quantity">+</button>
      </div></div>
    <div class="field"><label for="f-unit">Unit</label><select id="f-unit" name="unit">${optionList(UNITS, unit)}</select></div>
  </div>`;
}
function readQty(fd) {
  const q = num(fd.get('qty'));
  if (!(q > 0)) { toast('Quantity must be more than 0.', { error: true }); return null; }
  return Math.round(q * 1000) / 1000;
}

/* Add item */
function openAddSheet(prefill = '', { fromPicker = false } = {}) {
  const body = `
    <div class="field"><label for="f-name">Item</label>
      <input id="f-name" name="name" type="text" autocomplete="off" autocapitalize="words" enterkeyhint="next" value="${esc(prefill)}" required
        aria-describedby="dupMsg" aria-controls="suggestions">
      <ul id="suggestions" class="suggest" hidden aria-label="Matching staples"></ul>
      <div id="dupMsg" aria-live="polite"></div>
    </div>
    <div class="field"><label for="f-cat">Category</label>
      <select id="f-cat" name="category" required>${optionList(CATEGORIES, '', 'Choose a category…')}</select></div>
    ${qtyFields(1, 'pcs')}
    <div class="field switch-row" id="saveStapleRow">
      <label for="f-savestaple">Also save to Staples</label>
      <input id="f-savestaple" name="saveStaple" type="checkbox" class="switch" role="switch" checked>
    </div>
    <button class="btn primary block big" type="submit">Add to list</button>
    ${fromPicker ? '<button class="btn block" type="button" data-act="openPicker" style="margin-top:8px">Back to staples</button>' : ''}`;
  openSheet('New item', body, fd => {
    const name = cleanName(fd.get('name'));
    const category = fd.get('category');
    if (!name) { toast('Type an item name.', { error: true }); $('#f-name').focus(); return; }
    if (!category) { toast('Choose a category.', { error: true }); $('#f-cat').focus(); return; }
    const qty = readQty(fd); if (qty == null) return;
    const unit = fd.get('unit');
    const res = addItem({ name, category, qty, unit });
    if (res.dup) { closeSheet(); revealRow(res.dup.id); toast(MSG.DUPLICATE); return; }
    const isStaple = [...S.staples.values()].some(s => nameKey(s.name) === nameKey(name));
    const saved = fd.get('saveStaple') && !isStaple && upsertStaple({ name, category, qty, unit, status: 'Staple' });
    if (fromPicker) openPicker(); else closeSheet();
    toast(saved ? `${name} added and saved to Staples` : `${name} added`);
  }, '#f-name');
  if (prefill) onNameInput();
}

/* Add items picker (opened by +) */
function openPicker(query = '') {
  const body = `
    <div class="picker">
      <div class="picker-search"><label for="f-pick" class="sr-only">Search staples</label>
        <input id="f-pick" type="search" placeholder="Search staples or type a new item" value="${esc(query)}" autocomplete="off" autocapitalize="words" enterkeyhint="done"></div>
      <div class="picker-list" id="pickerList"></div>
      <button class="btn primary block big" type="button" data-act="closeSheet">Done</button>
    </div>`;
  openSheet('Add items', body, () => {}, null, { tall: true });
  if (!query) openCat.picker = null;
  pickerQuery = query;
  renderPicker();
}
function pickerQty(st, dir) {
  const r = activeUnbought(nameKey(st.name));
  if (!r) return;
  const step = stepFor(r.unit);
  if (dir < 0 && r.qty <= step) { removeItem(r); renderPicker(); return; }
  let next = Math.round((r.qty + dir * step) / step) * step;
  if (dir > 0 && next <= r.qty) next = r.qty + step;
  if (dir < 0 && next >= r.qty) next = r.qty - step;
  next = Math.round(next * 1000) / 1000;
  if (!(next > 0)) { removeItem(r); renderPicker(); return; }
  r.qty = next;            // show the change instantly; the snapshot confirms it
  updateItem(r, { qty: next });
  renderPicker();
}
function renderPicker() {
  const box = $('#pickerList');
  if (pickerQuery == null || !box) return;
  const raw = pickerQuery.trim();
  const q = nameKey(raw);
  const active = [...S.staples.values()].filter(s => s.status !== 'Inactive');
  const hits = active.filter(s => !q || nameKey(s.name).includes(q) || nameKey(s.category).includes(q));
  const exact = active.some(s => nameKey(s.name) === q);
  const plus = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  const minus = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
  const trash = '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>';
  let html = '';
  if (!exact) {
    const label = raw ? `Add “${esc(cleanName(raw))}” as new item` : 'New item (not in Staples)';
    html += `<button type="button" class="picker-new" data-act="pickNew"><span class="pick-ic">${plus}</span><span>${label}</span></button>`;
  }
  if (!hits.length) {
    html += `<div class="empty">${active.length ? `No staples match “${esc(raw)}”.` : 'No staples yet.'}</div>`;
  }
  const pickRow = st => {
    const on = activeUnbought(nameKey(st.name));
    if (on) {
      return `<li class="row on">
        <div class="row-main static"><span class="name">${esc(st.name)}</span><span class="meta">On list</span></div>
        <div class="mini-step" role="group" aria-label="Quantity of ${esc(st.name)}">
          <button type="button" data-act="pickQty" data-dir="-1" data-sid="${esc(st.id)}" aria-label="${on.qty <= stepFor(on.unit) ? 'Remove ' + esc(st.name) + ' from the list' : 'Less ' + esc(st.name)}">${on.qty <= stepFor(on.unit) ? trash : minus}</button>
          <span class="mini-qty" aria-live="polite">${esc(qtyLabel(on.qty, on.unit))}</span>
          <button type="button" data-act="pickQty" data-dir="1" data-sid="${esc(st.id)}" aria-label="More ${esc(st.name)}">${plus}</button>
        </div>
      </li>`;
    }
    return `<li class="row">
      <button type="button" class="row-main" data-act="pickAdd" data-sid="${esc(st.id)}"
        aria-label="Add ${esc(st.name)}, ${esc(qtyLabel(st.qty, st.unit))}">
        <span class="name">${esc(st.name)}</span>
        <span class="meta">${esc(qtyLabel(st.qty, st.unit))}</span>
      </button>
      <span class="pick-ic" aria-hidden="true">${plus}</span>
    </li>`;
  };
  for (const [cat, rows] of groupByCategory(hits)) {
    html += q
      ? `<div class="picker-cat">${catTile(cat)}${esc(cat)}</div><ul class="rows picker-group">${rows.map(pickRow).join('')}</ul>`
      : accordionHTML('picker', cat, rows, pickRow);
  }
  box.innerHTML = html;
}

function stapleMatches(text) {
  const q = nameKey(text);
  if (!q) return [];
  const all = [...S.staples.values()].filter(s => s.status !== 'Inactive');
  const starts = all.filter(s => nameKey(s.name).startsWith(q));
  const contains = all.filter(s => !nameKey(s.name).startsWith(q) && nameKey(s.name).includes(q));
  return [...starts.sort(byName), ...contains.sort(byName)].slice(0, 6);
}

function onNameInput() {
  const input = $('#f-name'); if (!input) return;
  const text = input.value;
  const list = $('#suggestions');
  const exact = [...S.staples.values()].find(s => nameKey(s.name) === nameKey(text));
  const matches = exact ? [] : stapleMatches(text);
  list.hidden = !matches.length;
  list.innerHTML = matches.map(s => `<li><button type="button" data-act="pickStaple" data-sid="${esc(s.id)}">
    <span>${esc(s.name)}</span><small>${esc(qtyLabel(s.qty, s.unit))} · ${esc(s.category)}</small></button></li>`).join('');
  if (exact) fillFromStaple(exact, false);
  const sw = $('#saveStapleRow'); if (sw) sw.hidden = !!exact;
  const dup = activeUnbought(nameKey(text));
  $('#dupMsg').innerHTML = dup ? `<div class="warn-msg"><span>${esc(MSG.DUPLICATE)}</span>
    <button class="btn" type="button" data-act="showDup" data-id="${esc(dup.id)}">Show it</button></div>` : '';
}

function fillFromStaple(s, setName = true) {
  if (setName) $('#f-name').value = s.name;
  $('#f-cat').value = CATEGORIES.includes(s.category) ? s.category : '';
  $('#f-qty').value = s.qty;
  $('#f-unit').value = s.unit;
  $('#suggestions').hidden = true;
}

/* Edit a To Buy row */
function openEditSheet(r) {
  const body = `
    <p class="muted" style="margin-top:0">Added by ${esc(r.addedBy || '—')} on ${esc(fmtDate(r.dateAdded))}${isCarried(r) ? ' · carried over' : ''}</p>
    ${qtyFields(r.qty, r.unit)}
    <div class="field"><label for="f-cat">Category</label><select id="f-cat" name="category">${optionList(CATEGORIES, r.category)}</select></div>
    <div class="field"><label for="f-store">Store (optional)</label>
      <input id="f-store" name="store" type="text" list="storeList" autocomplete="off" value="${esc(r.store)}">${storeDatalist()}</div>
    <div class="btn-row spread">
      <button class="btn danger" type="button" data-act="deleteItem" data-id="${esc(r.id)}">Delete</button>
      <button class="btn primary" type="submit">Save</button>
    </div>`;
  openSheet(r.name, body, fd => {
    const qty = readQty(fd); if (qty == null) return;
    updateItem(r, { qty, unit: fd.get('unit'), category: fd.get('category'), store: cleanName(fd.get('store')) });
    closeSheet();
  });
}

/* Edit an In Cart row (price focus) */
function openCartSheet(r) {
  const body = `
    <div class="field"><label for="f-price">Price paid for this line (₹)</label>
      <input id="f-price" name="price" type="text" inputmode="decimal" autocomplete="off" placeholder="Total paid, e.g. 120" value="${r.price == null ? '' : esc(r.price)}"></div>
    <div class="field"><label for="f-store">Store</label>
      <input id="f-store" name="store" type="text" list="storeList" autocomplete="off" value="${esc(r.store)}">${storeDatalist()}</div>
    ${qtyFields(r.qty, r.unit)}
    <p class="muted">Bought by ${esc(r.boughtBy || '—')} on ${esc(fmtDate(r.boughtOn))}</p>
    <div class="btn-row spread">
      <button class="btn" type="button" data-act="unbuy" data-id="${esc(r.id)}">↩ Not bought</button>
      <button class="btn primary" type="submit">Save</button>
    </div>`;
  openSheet(r.name, body, fd => {
    const raw = String(fd.get('price') || '').trim();
    let price = null;
    if (raw) {
      price = num(raw);
      if (!(price >= 0)) { toast('Enter the price as a number, e.g. 120.50', { error: true }); return; }
      price = Math.round(price * 100) / 100;
    }
    const qty = readQty(fd); if (qty == null) return;
    updateItem(r, { price, store: cleanName(fd.get('store')), qty, unit: fd.get('unit') });
    closeSheet();
  }, '#f-price');
}

/* Manage staples */
function openManageStaples(filter = '') {
  const body = `
    <div class="field"><label for="f-stq" class="sr-only">Search staples</label>
      <input id="f-stq" type="search" placeholder="Search staples…" value="${esc(filter)}" autocomplete="off"></div>
    <div class="staple-list"><ul class="rows" id="manageList"></ul></div>
    <div class="btn-row"><button class="btn primary" type="button" data-act="editStaple">+ New staple</button></div>`;
  openSheet('Manage staples', body, () => {});
  renderManageList(filter);
}
function renderManageList(filter) {
  const el = $('#manageList'); if (!el) return;
  const q = nameKey(filter);
  const rows = [...S.staples.values()]
    .filter(s => !q || nameKey(s.name).includes(q))
    .sort((a, b) => catIndex(a.category) - catIndex(b.category) || byName(a, b));
  el.innerHTML = rows.map(s => `<li class="row ${s.status === 'Inactive' ? 'carried' : ''}">
    <button type="button" class="row-main" data-act="editStaple" data-sid="${esc(s.id)}" aria-label="Edit staple ${esc(s.name)}">
      <span class="name">${esc(s.name)}</span>
      <span class="meta">${esc(s.category)} · ${esc(qtyLabel(s.qty, s.unit))}${s.status === 'Inactive' ? ' · Inactive' : ''}</span>
    </button></li>`).join('') || '<li class="row"><span class="muted" style="padding:8px">No staples found.</span></li>';
}
function openStapleEditor(st) {
  const s = st || { name: '', category: '', qty: 1, unit: 'pcs', status: 'Staple' };
  const body = `
    <div class="field"><label for="f-name">Name</label><input id="f-name" name="name" type="text" value="${esc(s.name)}" required autocapitalize="words"></div>
    <div class="field"><label for="f-cat">Category</label><select id="f-cat" name="category" required>${optionList(CATEGORIES, s.category, 'Choose a category…')}</select></div>
    ${qtyFields(s.qty, s.unit)}
    <div class="btn-row spread">
      ${st ? (s.status === 'Inactive'
        ? `<button class="btn" type="button" data-act="reactivateStaple" data-sid="${esc(s.id)}">Reactivate</button>`
        : `<button class="btn danger" type="button" data-act="deactivateStaple" data-sid="${esc(s.id)}">Deactivate</button>`) : '<span></span>'}
      <button class="btn primary" type="submit">${st ? 'Save' : 'Add staple'}</button>
    </div>
    ${st ? '<p class="muted">Deactivated staples are hidden but never deleted, so past reports stay correct.</p>' : ''}`;
  openSheet(st ? 'Edit staple' : 'New staple', body, fd => {
    const name = cleanName(fd.get('name'));
    if (!name) { toast('Type a name.', { error: true }); return; }
    if (!fd.get('category')) { toast('Choose a category.', { error: true }); return; }
    const qty = readQty(fd); if (qty == null) return;
    if (upsertStaple({ id: st && st.id, name, category: fd.get('category'), qty, unit: fd.get('unit'), status: s.status })) {
      toast(st ? 'Staple saved' : `${name} added to staples`);
      openManageStaples();
    }
  }, st ? null : '#f-name');
}

/* ------------------------------------------------------------------ actions */
function revealRow(id) {
  if (S.tab !== 'list') goto('list', false);
  const r = S.items.get(id);
  if (r && !r.bought) {
    const gid = 'buy:' + (CATEGORIES.includes(r.category) ? r.category : 'Other');
    if (S.collapsed.has(gid)) { S.collapsed.delete(gid); local.set('collapsed', [...S.collapsed]); }
  }
  render();
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-row="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  });
}

function shareList() {
  const groups = groupByCategory(toBuyRows());
  if (!groups.length) return;
  const text = 'Grocery list\n\n' + groups.map(([cat, rows]) =>
    `*${cat}*\n` + rows.map(r => `• ${r.name} – ${qtyLabel(r.qty, r.unit)}`).join('\n')).join('\n\n');
  if (navigator.share) {
    navigator.share({ text }).catch(err => { if (err && err.name !== 'AbortError') window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener'); });
  } else {
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  }
}

async function refreshNow() {
  toast('Refreshing…');
  try {
    await disableNetwork(db);
    await enableNetwork(db);
    subscribeMonth();
    if (S.tab === 'history') ensureHistory(true);
    toast('Up to date');
  } catch (e) { reportError(e); }
}

function addStapleToList(s) {
  const dup = activeUnbought(nameKey(s.name));
  if (dup) { toast(`${s.name} is already on the list (${qtyLabel(dup.qty, dup.unit)}).`); return; }
  addItem({ name: s.name, category: s.category, qty: s.qty, unit: s.unit });
  toast(`${s.name} added – ${qtyLabel(s.qty, s.unit)}`);
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act], [data-step]');
  if (!el) return;
  if (el.dataset.step) { stepQty(Number(el.dataset.step)); return; }
  const id = el.dataset.id;
  const row = id ? S.items.get(id) : null;
  const st = el.dataset.sid ? S.staples.get(el.dataset.sid) : null;
  switch (el.dataset.act) {
    case 'signin': doSignIn(); break;
    case 'signout': doSignOut(); break;
    case 'retryMember': if (S.user) watchMember(S.user); break;
    case 'goto': goto(el.dataset.tab); break;
    case 'openMenu': openMenu(); break;
    case 'closeMenu': closeMenu(); break;
    case 'openAdd': openAddSheet(el.dataset.name || ''); break;
    case 'openPicker': openPicker(); break;
    case 'pickNew': openAddSheet(cleanName(pickerQuery || ''), { fromPicker: true }); break;
    case 'pickAdd': if (st) { addStapleToList(st); renderPicker(); } break;
    case 'pickQty': if (st) { pickerQty(st, Number(el.dataset.dir)); } break;
    case 'closeSheet': closeSheet(); break;
    case 'edit': if (row) openEditSheet(row); break;
    case 'editCart': if (row) openCartSheet(row); break;
    case 'buy': if (row && !row.bought) markBought(row); break;
    case 'unbuy': if (row && row.bought) { closeSheet(); undoBought(row); } break;
    case 'deleteItem': if (row) { closeSheet(); removeItem(row); } break;
    case 'reset': resetMonth(); break;
    case 'share': shareList(); break;
    case 'addStaple': if (st) addStapleToList(st); break;
    case 'removeStaple': if (st) { const r = activeUnbought(nameKey(st.name)); if (r) removeItem(r); } break;
    case 'pickStaple': if (st) { fillFromStaple(st); onNameInput(); $('#f-qty').focus(); } break;
    case 'showDup': closeSheet(); revealRow(id); break;
    case 'manageStaples': openManageStaples(); break;
    case 'editStaple': openStapleEditor(st); break;
    case 'deactivateStaple': if (st) { setStapleStatus(st, 'Inactive'); toast(`${st.name} deactivated`); openManageStaples(); } break;
    case 'reactivateStaple': if (st) { setStapleStatus(st, 'Staple'); toast(`${st.name} reactivated`); openManageStaples(); } break;
    case 'refresh': refreshNow(); break;
    case 'reloadHistory': ensureHistory(true); break;
    case 'install': doInstall(); break;
    case 'dismissInstall': local.set('installDismissed', true); updateStatus(); break;
    case 'applyUpdate': applyUpdate(); break;
    case 'undo': { const fn = snackUndo; hideToast(); if (fn) { fn(); renderPicker(); } break; }
    case 'closeToast': hideToast(); break;
    case 'confirmYes': closeConfirm(true); break;
    case 'confirmNo': closeConfirm(false); break;
  }
});

function stepQty(dir) {
  const input = $('#f-qty'); const unit = $('#f-unit');
  if (!input || !unit) return;
  const step = stepFor(unit.value);
  const cur = num(input.value) || 0;
  let next = Math.round((cur + dir * step) / step) * step;
  if (dir < 0 && next <= 0) next = cur > step ? step : cur; // never reach 0
  if (dir > 0 && next <= cur) next = cur + step;
  input.value = String(Math.round(next * 1000) / 1000);
}

document.addEventListener('input', e => {
  if (e.target.id === 'f-name' && $('#suggestions')) onNameInput();
  else if (e.target.id === 'stapleSearch') { S.stapleQuery = e.target.value; renderStaples(); }
  else if (e.target.id === 'f-stq') renderManageList(e.target.value);
  else if (e.target.id === 'f-pick') { pickerQuery = e.target.value; renderPicker(); }
});
document.addEventListener('change', e => {
  if (e.target.name === 'theme') { setTheme(e.target.value); }
  else if (e.target.id === 'historyMonth') { S.historyKey = e.target.value; ensureHistory(); }
});
document.addEventListener('submit', e => {
  if (e.target.dataset.form === 'budget') {
    e.preventDefault();
    const raw = $('#budgetInput').value.trim();
    const v = raw ? num(raw) : 0;
    if (raw && !(v >= 0)) { toast('Enter the budget as a number.', { error: true }); return; }
    setBudget(v);
    toast(v > 0 ? `Budget set to ${money(v)}` : 'Budget removed');
  }
});
// Remember which category groups are collapsed.
document.addEventListener('toggle', e => {
  const d = e.target;
  if (d instanceof HTMLDetailsElement && d.dataset.acc) {
    const acc = d.dataset.acc, cat = d.dataset.cat;
    if (d.open) {
      openCat[acc] = cat;
      document.querySelectorAll(`details[data-acc="${acc}"][open]`).forEach(o => { if (o !== d) o.open = false; });
      requestAnimationFrame(() => d.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    } else if (openCat[acc] === cat) openCat[acc] = null;
    return;
  }
  if (!(d instanceof HTMLDetailsElement) || !d.dataset.group || d.dataset.group.startsWith('search:')) return;
  if (d.open) S.collapsed.delete(d.dataset.group); else S.collapsed.add(d.dataset.group);
  local.set('collapsed', [...S.collapsed]);
}, true);

function setTheme(t) {
  local.set('theme', t);
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/* ------------------------------------------------------------------ PWA: install & update */
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  S.installPrompt = e;
  updateStatus();
  if (S.tab === 'settings') renderSettings();
});
window.addEventListener('appinstalled', () => { S.installPrompt = null; updateStatus(); toast('Grocery Hub installed'); });
async function doInstall() {
  if (!S.installPrompt) { goto('settings'); return; }
  S.installPrompt.prompt();
  try { await S.installPrompt.userChoice; } catch (e) { /* ignore */ }
  S.installPrompt = null;
  updateStatus();
  if (S.tab === 'settings') renderSettings();
}

function markUpdateReady(reg) {
  S.swReg = reg; S.updateReady = true; updateStatus();
  if (S.tab === 'settings') renderSettings();
}
function applyUpdate() {
  const w = S.swReg && S.swReg.waiting;
  if (w) w.postMessage({ type: 'SKIP_WAITING' }); else location.reload();
}
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js', { updateViaCache: 'none' }).then(reg => {
      if (reg.waiting && navigator.serviceWorker.controller) markUpdateReady(reg);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) markUpdateReady(reg);
        });
      });
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(err => console.warn('Service worker registration failed', err));
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  });
}

/* ------------------------------------------------------------------ lifecycle */
window.addEventListener('online', () => { S.online = true; updateStatus(); if (db) enableNetwork(db).catch(() => {}); });
window.addEventListener('offline', () => { S.online = false; updateStatus(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !dataStarted) return;
  subscribeMonth();          // a new calendar month may have started
  scheduleRender();
});
setInterval(() => { if (dataStarted) subscribeMonth(); }, 60 * 1000);

function boot() {
  if (!configured) { showOnly('screen-setup'); return; }
  $('#stapleSearch').value = '';
  getRedirectResult(auth).catch(e => { if (e && e.code !== 'auth/no-auth-event') $('#signinError').textContent = 'Sign-in failed: ' + (e.code || e.message); });
  onAuthStateChanged(auth, user => {
    S.user = user;
    if (!user) { stopData(); S.me = null; showSignIn(); return; }
    watchMember(user);
  });
}
boot();
