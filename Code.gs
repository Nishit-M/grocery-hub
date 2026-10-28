/**
 * Grocery Hub – Google Sheet ⇄ Firestore bridge.
 *
 * The app keeps its live data in Cloud Firestore. This script, bound to the
 * "Grocery Hub" Google Sheet:
 *   • setup()          – creates any missing tab / header row, never overwrites data,
 *                        and installs the hourly sync.
 *   • importFromSheet() – ONE TIME: copies Master_Items (staples), any existing
 *                        Shopping_List rows and Control values into Firestore.
 *   • syncNow()        – every hour (and from the menu): copies Firestore back into
 *                        Master_Items, Shopping_List and Control so the Summary,
 *                        Monthly Spend and Staples Status formulas keep working.
 *                        Also pushes the Members tab to Firestore (who may sign in).
 *   • pushMembers()    – sends the Members tab to Firestore right away.
 *
 * The script never writes to Summary, Monthly Spend or Staples Status.
 * Required Script Property: FIREBASE_PROJECT_ID (Project Settings → Script Properties).
 */

var TABS = {
  MASTER: 'Master_Items',
  LIST: 'Shopping_List',
  CONTROL: 'Control',
  MEMBERS: 'Members'
};
var HEADERS = {
  Master_Items: ['Item_ID', 'Item Name', 'Category', 'Default Qty', 'Default Unit', 'Status'],
  Shopping_List: ['List_ID', 'Item Name', 'Category', 'Quantity', 'Unit', 'Bought?', 'Price', 'Store',
    'Date Added', 'Added By', 'Bought By', 'Bought On', 'Archived?'],
  Members: ['Name', 'Email', 'Active']
};
// Control keeps your existing layout: Last Reset stays in C2 because Summary!B14 reads Control!$C$2.
var CONTROL_HEADERS = ['Control_ID', 'Panel Name', 'Last Reset', 'Monthly Budget', 'Last App Sync'];

/* ------------------------------------------------------------------ menu */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Grocery Hub')
    .addItem('Sync now (app → sheet)', 'syncNow')
    .addItem('Push Members tab to app', 'pushMembers')
    .addSeparator()
    .addItem('Set up / repair tabs', 'setup')
    .addItem('Import from sheet (first time only)', 'importFromSheet')
    .addToUi();
}

/* ------------------------------------------------------------------ setup */
function setup() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone('Asia/Kolkata');
  try { ss.setSpreadsheetLocale('en_IN'); } catch (e) { /* locale already set */ }

  var master = ensureTab_(ss, TABS.MASTER, HEADERS.Master_Items);
  var list = ensureTab_(ss, TABS.LIST, HEADERS.Shopping_List);

  // Control: keep existing columns, add any missing header to the right, add the MAIN row.
  var control = ss.getSheetByName(TABS.CONTROL) || ss.insertSheet(TABS.CONTROL);
  var ch = control.getRange(1, 1, 1, CONTROL_HEADERS.length).getValues()[0];
  for (var i = 0; i < CONTROL_HEADERS.length; i++) {
    if (!ch[i]) control.getRange(1, i + 1).setValue(CONTROL_HEADERS[i]);
  }
  if (!control.getRange('A2').getValue()) control.getRange('A2:B2').setValues([['MAIN', 'Grocery Control Panel']]);
  control.getRange('C2').setNumberFormat('dd/mm/yyyy hh:mm');
  control.getRange('D2').setNumberFormat('₹#,##0');
  control.getRange('E2').setNumberFormat('dd/mm/yyyy hh:mm');

  // Members: Name | Email | Active, four placeholders on first run.
  var members = ss.getSheetByName(TABS.MEMBERS);
  if (!members) {
    members = ss.insertSheet(TABS.MEMBERS);
    members.getRange(1, 1, 1, 3).setValues([HEADERS.Members]).setFontWeight('bold');
    var owner = '';
    try { owner = Session.getEffectiveUser().getEmail(); } catch (e) { /* not available */ }
    members.getRange(2, 1, 4, 3).setValues([
      ['Member 1', owner, true], ['Member 2', '', true], ['Member 3', '', true], ['Member 4', '', true]
    ]);
    members.getRange('C2:C50').insertCheckboxes();
    members.setFrozenRows(1);
    members.setColumnWidth(2, 260);
  }

  // Seed common staples only if Master_Items is completely empty.
  if (master.getLastRow() < 2) seedStaples_(master);

  // Date formats for the copied list.
  list.getRange('I2:I').setNumberFormat('dd/mm/yyyy hh:mm');
  list.getRange('L2:L').setNumberFormat('dd/mm/yyyy hh:mm');

  // Gentle warning if someone edits app-owned tabs by hand (the next sync overwrites them).
  [master, list].forEach(function (sh) {
    var has = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).some(function (p) {
      return p.getDescription() === 'Grocery Hub sync';
    });
    if (!has) sh.protect().setDescription('Grocery Hub sync').setWarningOnly(true);
  });

  var msg;
  if (getProjectId_(true)) {
    installTrigger_();
    msg = 'Setup complete. Hourly sync is on. Next: fill in Members emails, then Grocery Hub → Import from sheet (first time only).';
  } else {
    msg = 'Tabs are ready. Now add the Script Property FIREBASE_PROJECT_ID (Project Settings → Script Properties) and run setup again.';
  }
  notify_(msg);
}

function ensureTab_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function installTrigger_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'syncNow'; });
  if (!exists) ScriptApp.newTrigger('syncNow').timeBased().everyHours(1).create();
}

function seedStaples_(sh) {
  var seed = [
    ['Onions', 'Vegetables', 2, 'kg'], ['Tomatoes', 'Vegetables', 1, 'kg'], ['Potatoes', 'Vegetables', 2, 'kg'],
    ['Green Chillies', 'Vegetables', 250, 'g'], ['Coriander Leaves', 'Vegetables', 1, 'bunch'],
    ['Bananas', 'Fruits', 1, 'dozen'], ['Apples', 'Fruits', 1, 'kg'],
    ['Milk', 'Dairy', 1, 'L'], ['Curd', 'Dairy', 500, 'g'], ['Paneer', 'Dairy', 200, 'g'],
    ['Rice', 'Grains & Pulses', 5, 'kg'], ['Atta', 'Grains & Pulses', 5, 'kg'], ['Toor Dal', 'Grains & Pulses', 1, 'kg'],
    ['Moong Dal', 'Grains & Pulses', 500, 'g'], ['Turmeric Powder', 'Spices & Masala', 100, 'g'],
    ['Red Chilli Powder', 'Spices & Masala', 200, 'g'], ['Mustard Seeds', 'Spices & Masala', 100, 'g'],
    ['Sunflower Oil', 'Oils & Ghee', 1, 'L'], ['Ghee', 'Oils & Ghee', 500, 'ml'],
    ['Sugar', 'Sugar & Salt', 1, 'kg'], ['Salt', 'Sugar & Salt', 1, 'kg'],
    ['Cashews', 'Dry Fruits & Nuts', 250, 'g'], ['Almonds', 'Dry Fruits & Nuts', 250, 'g'],
    ['Tea Powder', 'Snacks & Beverages', 250, 'g'], ['Biscuits', 'Snacks & Beverages', 2, 'pack'],
    ['Maggi Noodles', 'Instant & Ready Foods', 1, 'pack'], ['Poha', 'Instant & Ready Foods', 500, 'g'],
    ['Tomato Ketchup', 'Sauces & Pickles', 1, 'bottle'], ['Mango Pickle', 'Sauces & Pickles', 1, 'bottle'],
    ['Bread', 'Bakery', 1, 'pack'], ['Eggs', 'Meat / Fish / Eggs', 1, 'dozen'], ['Chicken', 'Meat / Fish / Eggs', 1, 'kg'],
    ['Frozen Peas', 'Frozen', 500, 'g'], ['Agarbatti', 'Pooja Items', 1, 'pack'], ['Camphor', 'Pooja Items', 1, 'box'],
    ['Toothpaste', 'Personal Care', 1, 'pcs'], ['Bath Soap', 'Personal Care', 4, 'pcs'],
    ['Dishwash Liquid', 'Household Cleaning', 1, 'bottle'], ['Detergent Powder', 'Household Cleaning', 1, 'kg'],
    ['Garbage Bags', 'Kitchen & Disposables', 1, 'pack'], ['Aluminium Foil', 'Kitchen & Disposables', 1, 'pcs']
  ];
  var rows = seed.map(function (s) { return [Utilities.getUuid().slice(0, 8), s[0], s[1], s[2], s[3], 'Staple']; });
  sh.getRange(2, 1, rows.length, 6).setValues(rows);
}

/* ------------------------------------------------------------------ one-time import */
function importFromSheet() {
  var ss = SpreadsheetApp.getActive();
  var existing = fsGet_(fsBase_() + '/staples?pageSize=1');
  if (existing.documents && existing.documents.length) {
    notify_('Already imported – the app now owns the data. Use "Sync now" to copy the app data into the sheet.');
    return;
  }
  var pid = getProjectId_();
  var writes = [];

  // Staples
  var master = readTab_(ss.getSheetByName(TABS.MASTER));
  master.forEach(function (r, i) {
    var name = cleanName_(r['Item Name']);
    if (!name) return;
    var id = safeId_(r['Item_ID']) || Utilities.getUuid().slice(0, 8);
    writes.push(upsertWrite_(pid, 'staples', id, {
      name: name,
      category: String(r['Category'] || 'Kitchen & Disposables'),
      qty: Number(r['Default Qty']) > 0 ? Number(r['Default Qty']) : 1,
      unit: String(r['Default Unit'] || 'pcs'),
      status: String(r['Status']) === 'Inactive' ? 'Inactive' : 'Staple',
      sort: i + 1
    }));
  });

  // Existing list rows (if any)
  var openKeys = {};
  readTab_(ss.getSheetByName(TABS.LIST)).forEach(function (r) {
    var name = cleanName_(r['Item Name']);
    if (!name) return;
    var id = safeId_(r['List_ID']) || Utilities.getUuid();
    var bought = bool_(r['Bought?']);
    var archived = bool_(r['Archived?']);
    var key = nameKey_(name);
    var price = (r['Price'] === '' || r['Price'] == null) ? null : Number(r['Price']);
    writes.push(upsertWrite_(pid, 'list', id, {
      name: name, nameKey: key,
      category: String(r['Category'] || 'Kitchen & Disposables'),
      qty: Number(r['Quantity']) > 0 ? Number(r['Quantity']) : 1,
      unit: String(r['Unit'] || 'pcs'),
      bought: bought, price: isNaN(price) ? null : price,
      store: String(r['Store'] || ''),
      dateAdded: asDate_(r['Date Added']) || new Date(),
      addedBy: String(r['Added By'] || ''), addedByEmail: '',
      boughtBy: String(r['Bought By'] || ''), boughtByEmail: '',
      boughtOn: bought ? (asDate_(r['Bought On']) || new Date()) : null,
      archived: archived, archivedOn: archived ? (asDate_(r['Bought On']) || new Date()) : null
    }));
    if (!bought && !archived && !openKeys[key]) {
      openKeys[key] = true;
      writes.push(upsertWrite_(pid, 'openKeys', keyId_(key), { listId: id, name: name, at: new Date() }));
    }
  });

  // Control
  var control = ss.getSheetByName(TABS.CONTROL);
  var lastReset = control ? asDate_(control.getRange('C2').getValue()) : null;
  var budget = control ? Number(control.getRange('D2').getValue()) : 0;
  writes.push(upsertWrite_(pid, 'control', 'main', { lastReset: lastReset, budget: budget > 0 ? budget : null }));

  fsCommit_(writes);
  pushMembers();
  notify_('Imported ' + master.length + ' staples into the app. From now on, add and edit staples in the app.');
}

/* ------------------------------------------------------------------ members */
function pushMembers() {
  var ss = SpreadsheetApp.getActive();
  var pid = getProjectId_();
  var rows = readTab_(ss.getSheetByName(TABS.MEMBERS));
  var want = {};
  rows.forEach(function (r) {
    var email = String(r['Email'] || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return;
    want[email] = { name: cleanName_(r['Name']) || email.split('@')[0], active: r['Active'] === '' ? true : bool_(r['Active']) };
  });
  var writes = Object.keys(want).map(function (email) { return upsertWrite_(pid, 'members', email, want[email]); });
  fsList_('members').forEach(function (d) {
    if (!want[d.id]) writes.push({ delete: docName_(pid, 'members', d.id) });
  });
  if (writes.length) fsCommit_(writes);
  notify_(Object.keys(want).length + ' member(s) can sign in.');
}

/* ------------------------------------------------------------------ hourly sync: Firestore → sheet */
function syncNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return; // another sync is running
  try {
    var ss = SpreadsheetApp.getActive();
    pushMembers();

    // Master_Items ← staples (skip if the app has no staples yet, so the sheet is never wiped)
    var staples = fsList_('staples');
    if (staples.length) {
      staples.sort(function (a, b) {
        return (Number(a.data.sort) || 1e9) - (Number(b.data.sort) || 1e9) || String(a.data.name).localeCompare(String(b.data.name));
      });
      writeRows_(ss.getSheetByName(TABS.MASTER), HEADERS.Master_Items.length, staples.map(function (d) {
        var x = d.data;
        return [d.id, x.name || '', x.category || '', num_(x.qty), x.unit || '', x.status || 'Staple'];
      }));
    }

    // Shopping_List ← list (all rows, archived too, oldest first)
    var list = fsList_('list');
    list.sort(function (a, b) { return time_(a.data.dateAdded) - time_(b.data.dateAdded); });
    var listSheet = ss.getSheetByName(TABS.LIST);
    if (list.length || staples.length) {
      writeRows_(listSheet, HEADERS.Shopping_List.length, list.map(function (d) {
        var x = d.data;
        return [
          d.id, x.name || '', x.category || '', num_(x.qty), x.unit || '',
          x.bought === true, (x.price == null || x.price === '') ? '' : Number(x.price), x.store || '',
          x.dateAdded instanceof Date ? x.dateAdded : '', x.addedBy || '', x.boughtBy || '',
          x.boughtOn instanceof Date ? x.boughtOn : '', x.archived === true
        ];
      }));
    }

    // Control ← control/main
    var ctl = fsGet_(fsBase_() + '/control/main', true);
    var control = ss.getSheetByName(TABS.CONTROL);
    if (ctl && ctl.fields) {
      var c = decodeFields_(ctl.fields);
      control.getRange('C2').setValue(c.lastReset instanceof Date ? c.lastReset : '');
      control.getRange('D2').setValue(c.budget == null ? '' : Number(c.budget));
    }
    control.getRange('E2').setValue(new Date());
  } finally {
    lock.releaseLock();
  }
}

function writeRows_(sh, width, rows) {
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, width).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, width).setValues(rows);
}

/* ------------------------------------------------------------------ Firestore REST */
function getProjectId_(quiet) {
  var pid = PropertiesService.getScriptProperties().getProperty('FIREBASE_PROJECT_ID');
  if (!pid && !quiet) throw new Error('Missing Script Property FIREBASE_PROJECT_ID (Project Settings → Script Properties).');
  return pid ? String(pid).trim() : '';
}
function fsBase_() {
  return 'https://firestore.googleapis.com/v1/projects/' + getProjectId_() + '/databases/(default)/documents';
}
function docName_(pid, coll, id) {
  return 'projects/' + pid + '/databases/(default)/documents/' + coll + '/' + id;
}
function fsFetch_(url, method, body, allow404) {
  var opts = {
    method: method,
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      // Bill/quota the call to the Firebase project instead of the hidden Apps Script project.
      'X-Goog-User-Project': getProjectId_()
    }
  };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  var res = UrlFetchApp.fetch(url, opts);
  var code = res.getResponseCode();
  if (allow404 && code === 404) return null;
  if (code >= 300) throw new Error('Firestore ' + code + ': ' + res.getContentText().slice(0, 600));
  var txt = res.getContentText();
  return txt ? JSON.parse(txt) : {};
}
function fsGet_(url, allow404) { return fsFetch_(url, 'get', null, allow404); }
function fsList_(coll) {
  var out = [], token = '';
  do {
    var url = fsBase_() + '/' + coll + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : '');
    var r = fsGet_(url);
    (r.documents || []).forEach(function (d) {
      out.push({ id: d.name.split('/').pop(), data: decodeFields_(d.fields || {}) });
    });
    token = r.nextPageToken || '';
  } while (token);
  return out;
}
function fsCommit_(writes) {
  for (var i = 0; i < writes.length; i += 400) {
    fsFetch_(fsBase_() + ':commit', 'post', { writes: writes.slice(i, i + 400) });
  }
}
function upsertWrite_(pid, coll, id, obj) {
  return { update: { name: docName_(pid, coll, id), fields: encodeFields_(obj) } };
}
function encodeFields_(obj) {
  var f = {};
  Object.keys(obj).forEach(function (k) { f[k] = encodeValue_(obj[k]); });
  return f;
}
function encodeValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue_) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields_(v) } };
  return { stringValue: String(v) };
}
function decodeFields_(fields) {
  var o = {};
  Object.keys(fields).forEach(function (k) { o[k] = decodeValue_(fields[k]); });
  return o;
}
function decodeValue_(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Date(String(v.timestampValue).replace(/(\.\d{3})\d+/, '$1'));
  if ('mapValue' in v) return decodeFields_(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue_);
  return null;
}

/* ------------------------------------------------------------------ small helpers */
// Reads a tab into objects keyed by header name (no fixed column letters).
function readTab_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var head = values.shift().map(function (h) { return String(h).trim(); });
  return values.filter(function (r) { return r.some(function (c) { return c !== ''; }); }).map(function (r) {
    var o = {};
    head.forEach(function (h, i) { if (h) o[h] = r[i]; });
    return o;
  });
}
function cleanName_(s) { return String(s == null ? '' : s).trim().replace(/\s+/g, ' '); }
function nameKey_(s) { return cleanName_(s).toLowerCase(); }
// Same encoding as keyId() in app.js – keep them identical.
function keyId_(k) { return k.replace(/[^a-z0-9]/g, function (c) { return '_' + c.charCodeAt(0).toString(16); }); }
function safeId_(v) { var s = String(v == null ? '' : v).trim().replace(/\//g, '-'); return s && s !== '.' && s !== '..' ? s : ''; }
function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function asDate_(v) { if (v instanceof Date && !isNaN(v)) return v; if (!v) return null; var d = new Date(v); return isNaN(d) ? null : d; }
function num_(v) { var n = Number(v); return isNaN(n) ? '' : n; }
function time_(v) { return v instanceof Date ? v.getTime() : 0; }
function notify_(msg) {
  console.log(msg);
  try { SpreadsheetApp.getActive().toast(msg, 'Grocery Hub', 10); } catch (e) { /* no UI */ }
}
