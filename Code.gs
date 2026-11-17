/**
 * AGSB Claims — Google Apps Script (bound to the "AGSB Mileage Claims" Google Sheet).
 * Mileage claims: each trip is a row in the Claims tab, approved per month on the Approvals tab.
 * Meal & expense claims: each item is a row in the Expenses tab, with its receipt saved to Google Drive
 * (folder named in Settings!B4), approved per month on the Expense Approvals tab.
 * The same script is used in each company's own claims Sheet (Amboi Group, RedCube Solutions).
 * Settings (rate, access code, employees, claim types, saved routes, expense types) are read from the Settings tab.
 */

const CLAIMS_TAB = 'Claims';
const SETTINGS_TAB = 'Settings';
const APPROVALS_TAB = 'Approvals';
const FORM_TAB = 'Claim Form';
const DECIDED = ['Approved', 'Rejected', 'Paid'];
const MAX_LINES = 40;     // trips per submission
const MAX_KM = 3000;      // sanity limit for one trip line

const EXP_TAB = 'Expenses';
const EXP_APPROVALS_TAB = 'Expense Approvals';
const EXP_FORM_TAB = 'Expense Claim Form';
const RECEIPT_FOLDER = 'AGSB Claim Receipts';   // used when Settings!B4 is empty
const MAX_ITEMS = 30;        // expense items per submission
const MAX_AMOUNT = 5000;     // sanity limit for one expense item (RM)
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const RECEIPT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/**
 * Web app entry. Without parameters it serves the browser form.
 * With ?api=config or ?api=month it answers the AGSB Claims mobile app in JSON.
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.api) {
    return api_(function () {
      if (p.api === 'config') return getConfig();
      if (p.api === 'month') return getMonthClaims(p.employee, p.month, p.code);
      if (p.api === 'expenses') return getMonthExpenses(p.employee, p.month, p.code);
      if (p.api === 'receipt') return getReceipt(p.employee, p.file, p.code);
      throw new Error('Unknown request.');
    });
  }
  return HtmlService.createHtmlOutputFromFile('Form')
    .setTitle('AGSB Mileage Claim')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Mobile app submits here: body = JSON {action:'submit', sid, payload}. */
function doPost(e) {
  return api_(function () {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'submit') return submitOnce_(String(body.sid || ''), body.payload || {}, submitClaims);
    if (body.action === 'submitExpense') return submitOnce_(String(body.sid || ''), body.payload || {}, submitExpenses);
    throw new Error('Unknown request.');
  });
}

function api_(fn) {
  let out;
  try { out = { ok: true, data: fn() }; }
  catch (err) { out = { ok: false, error: String((err && err.message) || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Each claim from the app carries a one-off id. If the phone loses signal after the claim was saved
 * and sends it again, the saved result is returned instead of adding the trips twice.
 */
function submitOnce_(sid, payload, fn) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) return fn(payload);
  const props = PropertiesService.getScriptProperties();
  const key = 'sid_' + sid;
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const done = props.getProperty(key);
    if (done) return JSON.parse(done);
    const res = fn(payload, true);
    props.setProperty(key, JSON.stringify(res));
    return res;
  } finally {
    lock.releaseLock();
  }
}

/** Reads the Settings tab: B2 rate, B3 access code, A:C employees, E types, G:H routes, L expense types (from row 6). */
function readSettings_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SETTINGS_TAB);
  const rate = Number(sh.getRange('B2').getValue()) || 0;
  const code = String(sh.getRange('B3').getDisplayValue() || '').trim();
  const folder = String(sh.getRange('B4').getDisplayValue() || '').trim() || RECEIPT_FOLDER;
  const last = sh.getLastRow();
  const rows = last >= 6 ? sh.getRange(6, 1, last - 5, 12).getValues() : [];
  const employees = [], types = [], routes = [], expenseTypes = [];
  rows.forEach(function (r) {
    const name = String(r[0] || '').trim();
    if (name) employees.push({ name: name, vehicle: String(r[1] || '').trim() });
    const type = String(r[4] || '').trim();
    if (type) types.push(type);
    const dest = String(r[6] || '').trim();
    const km = Number(r[7]);
    if (dest && km > 0) routes.push({ dest: dest, km: km });
    const et = String(r[11] || '').trim();
    if (et) expenseTypes.push(et);
  });
  if (!expenseTypes.length) expenseTypes.push('Meal', 'Other');
  return { rate: rate, code: code, employees: employees, types: types, routes: routes, expenseTypes: expenseTypes, folder: folder, tz: ss.getSpreadsheetTimeZone() };
}

/** Called by the form when it opens. Never returns the access code itself. */
function getConfig() {
  const s = readSettings_();
  const vehicles = {};
  s.employees.forEach(function (e) { vehicles[e.name] = e.vehicle ? [e.vehicle] : []; });
  const sh = SpreadsheetApp.getActive().getSheetByName(CLAIMS_TAB);
  const last = lastDataRow_(sh);
  if (last >= 2) {
    const names = sh.getRange(2, 2, last - 1, 1).getValues();
    const vehs = sh.getRange(2, 11, last - 1, 1).getValues();
    for (let i = names.length - 1; i >= 0; i--) {      // newest first
      const n = names[i][0], v = String(vehs[i][0] || '').trim().toUpperCase();
      if (v && vehicles[n] && vehicles[n].indexOf(v) < 0) vehicles[n].unshift(v);
    }
  }
  return { rate: s.rate, needCode: !!s.code, employees: s.employees, types: s.types, routes: s.routes, vehicles: vehicles, expenseTypes: s.expenseTypes };
}

/** Last row with a date in column C (array formulas make getLastRow unreliable). */
function lastDataRow_(sh) {
  const vals = sh.getRange(1, 3, sh.getMaxRows(), 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i][0] !== '' && vals[i][0] !== null) return i + 1;
  }
  return 1;
}

function norm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/**
 * Turns a travel-date cell into 'yyyy-MM-dd' ('' if it is not a date).
 * Works whether the cell came back as a Date, a date serial number, or text such as 01/07/2025 or 2025-07-01.
 */
function ymd_(v, tz) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'object' && typeof v.getTime === 'function') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  if (typeof v === 'number') {
    const d = new Date(Math.round((v - 25569) * 86400000));
    return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
  }
  const t = String(v).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}

function checkCode_(s, code) {
  if (s.code && String(code || '').trim() !== s.code) throw new Error('The access code is not correct.');
}

/** Claims already in the sheet for one employee and month (shown under the form). */
function getMonthClaims(employee, month, code) {
  const s = readSettings_();
  employee = String(employee || '').trim();
  checkCode_(s, code);
  if (!/^\d{4}-\d{2}$/.test(month || '')) return { rows: [], total: 0, status: '' };
  const status = approvalStatus_(APPROVALS_TAB, employee, month);
  const sh = SpreadsheetApp.getActive().getSheetByName(CLAIMS_TAB);
  const last = lastDataRow_(sh);
  if (last < 2) return { rows: [], total: 0, status: status };
  const vals = sh.getRange(2, 2, last - 1, 10).getValues(); // B..K
  const out = [], vehicles = [];
  let total = 0;
  vals.forEach(function (r) {
    if (String(r[0]).trim() !== employee) return;
    const d = ymd_(r[1], s.tz);
    if (!d || d.slice(0, 7) !== month) return;
    const amt = (Number(r[5]) || 0) * (Number(r[6]) || 0);
    const v = String(r[9] || '').trim();
    if (v && vehicles.indexOf(v) < 0) vehicles.push(v);
    total += amt;
    out.push({ date: d, type: r[2], purpose: r[3], dest: r[4], km: Number(r[5]) || 0, amount: amt });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return { rows: out, total: total, status: status, vehicles: vehicles, rate: s.rate };
}

/** Status of one claim month from the Approvals tab ('' when nothing was submitted). */
function approvalStatus_(tab, employee, month) {
  const ap = SpreadsheetApp.getActive().getSheetByName(tab);
  if (!ap) return '';
  const row = findApprovalRow_(ap, employee, month);
  if (!row) return '';
  const v = ap.getRange(row, 3, 1, 3).getDisplayValues()[0];
  return v[0] + (v[1] ? ' by ' + v[1] : '') + (v[2] ? ' on ' + v[2].split(' ')[0] : '');
}

/**
 * Saves a claim. payload = {employee, month: 'yyyy-MM', code, lines: [{date:'yyyy-MM-dd', type, purpose, dest, km}]}
 * Every line is checked first; nothing is saved unless all lines pass.
 */
function submitClaims(payload, haveLock) {
  const lock = LockService.getScriptLock();
  if (!haveLock) lock.waitLock(20000);
  try {
    const s = readSettings_();
    checkCode_(s, payload.code);
    const emp = s.employees.filter(function (e) { return e.name === payload.employee; })[0];
    if (!emp) throw new Error('Pick your name from the list.');
    const month = String(payload.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Pick the month you are claiming for.');
    const lines = (payload.lines || []).filter(function (l) { return l && (l.date || l.dest || l.km); });
    if (!lines.length) throw new Error('Add at least one trip.');
    if (lines.length > MAX_LINES) throw new Error('Please submit at most ' + MAX_LINES + ' trips at a time.');
    if (!(s.rate > 0)) throw new Error('The rate in Settings!B2 is missing. Please tell the admin.');
    const vehicle = String(payload.vehicle || '').replace(/\s+/g, ' ').trim().toUpperCase();
    if (!vehicle) throw new Error('Enter the vehicle number used for these trips.');
    if (vehicle.length > 15) throw new Error('The vehicle number looks too long.');

    const sh = SpreadsheetApp.getActive().getSheetByName(CLAIMS_TAB);
    const last = lastDataRow_(sh);
    const existing = {};
    if (last >= 2) {
      sh.getRange(2, 2, last - 1, 6).getValues().forEach(function (r) { // B..G
        const d = ymd_(r[1], s.tz);
        if (String(r[0]).trim() === emp.name && d) existing[d + '|' + norm_(r[4]) + '|' + Number(r[5])] = true;
      });
    }

    const errors = [], rows = [], seen = {};
    const now = new Date();
    let total = 0;
    lines.forEach(function (l, i) {
      const n = 'Trip ' + (i + 1) + ': ';
      const date = String(l.date || '');
      const dest = String(l.dest || '').replace(/\s+/g, ' ').trim();
      const purpose = String(l.purpose || '').replace(/\s+/g, ' ').trim();
      const type = String(l.type || '').trim();
      const km = Number(l.km);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(n + 'date is missing'); return; }
      if (date.slice(0, 7) !== month) { errors.push(n + 'date is not in the month you picked'); return; }
      if (s.types.indexOf(type) < 0) { errors.push(n + 'pick a type'); return; }
      if (!purpose) { errors.push(n + 'purpose of travel is missing'); return; }
      if (!dest) { errors.push(n + 'destination is missing'); return; }
      if (!(km > 0) || km > MAX_KM) { errors.push(n + 'km must be between 1 and ' + MAX_KM); return; }
      const key = date + '|' + norm_(dest) + '|' + km;
      if (existing[key]) { errors.push(n + 'you already claimed this trip (same date, destination and km)'); return; }
      if (seen[key]) { errors.push(n + 'same trip entered twice in this form'); return; }
      seen[key] = true;
      rows.push([now, emp.name, Utilities.parseDate(date, s.tz, 'yyyy-MM-dd'), type, purpose, dest, km, s.rate]);
      total += km * s.rate;
    });
    if (errors.length) throw new Error(errors.join('\n'));

    const start = last + 1;
    const need = start + rows.length - 1 - sh.getMaxRows();
    if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 200);
    sh.getRange(start, 1, rows.length, 8).setValues(rows);                       // A:H (I:J are formulas)
    sh.getRange(start, 11, rows.length, 1).setValues(rows.map(function () { return [vehicle]; }));  // K
    sh.getRange(start, 1, rows.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sh.getRange(start, 3, rows.length, 1).setNumberFormat('dd/mm/yyyy');
    markPending_(APPROVALS_TAB, emp.name, month, now, s.tz, 'trips');
    SpreadsheetApp.flush();
    return { count: rows.length, total: total, employee: emp.name, month: month, vehicle: vehicle };
  } finally {
    if (!haveLock) lock.releaseLock();
  }
}

/* ---------------- Approvals ---------------- */

/** Row number in Approvals for an employee + month (0 if none). */
function findApprovalRow_(ap, emp, month) {
  const last = lastRowInCol_(ap, 1);
  if (last < 2) return 0;
  const v = ap.getRange(2, 1, last - 1, 2).getDisplayValues();
  for (let i = 0; i < v.length; i++) if (v[i][0] === emp && v[i][1] === month) return i + 2;
  return 0;
}

function lastRowInCol_(sh, col) {
  const vals = sh.getRange(1, col, sh.getMaxRows(), 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) if (vals[i][0] !== '' && vals[i][0] !== null) return i + 1;
  return 1;
}

/** Creates the Approvals row for a new claim month, or sets it back to Pending when trips are added later. */
function markPending_(tab, emp, month, now, tz, what) {
  const ap = SpreadsheetApp.getActive().getSheetByName(tab);
  const stamp = Utilities.formatDate(now, tz, 'dd/MM/yyyy HH:mm');
  const row = findApprovalRow_(ap, emp, month);
  if (!row) {
    const r = lastRowInCol_(ap, 1) + 1;
    if (r > ap.getMaxRows()) ap.insertRowsAfter(ap.getMaxRows(), 200);
    ap.getRange(r, 2).setNumberFormat('@');
    ap.getRange(r, 1, 1, 6).setValues([[emp, month, 'Pending', '', '', 'Submitted via form ' + stamp]]);
    return;
  }
  const status = String(ap.getRange(row, 3).getValue());
  if (DECIDED.indexOf(status) >= 0) {
    ap.getRange(row, 3, 1, 4).setValues([['Pending', '', '', 'More ' + what + ' added ' + stamp + ' after it was ' + status]]);
  }
}

/**
 * Simple trigger: keeps each claim form's Status / Approved by in sync with its approvals tab
 * (Claim Form ↔ Approvals, Expense Claim Form ↔ Expense Approvals).
 */
function onEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet();
  const tab = sh.getName() === FORM_TAB ? APPROVALS_TAB : sh.getName() === EXP_FORM_TAB ? EXP_APPROVALS_TAB : '';
  if (!tab) return;
  const a1 = e.range.getA1Notation();
  if (a1 === 'C7' || a1 === 'C8') loadApproval_(sh, tab);
  else if (a1 === 'F9' || a1 === 'F10') saveApproval_(sh, a1, tab);
}

function loadApproval_(sh, tab) {
  const ap = SpreadsheetApp.getActive().getSheetByName(tab);
  const row = findApprovalRow_(ap, sh.getRange('C7').getDisplayValue(), sh.getRange('C8').getDisplayValue());
  const v = row ? ap.getRange(row, 3, 1, 3).getValues()[0] : ['', '', ''];
  sh.getRange('F9:F11').setValues([[v[0]], [v[1]], [v[2]]]);
}

function saveApproval_(sh, a1, tab) {
  const emp = sh.getRange('C7').getDisplayValue(), month = sh.getRange('C8').getDisplayValue();
  if (!emp || !month) return;
  const ap = SpreadsheetApp.getActive().getSheetByName(tab);
  let row = findApprovalRow_(ap, emp, month);
  if (!row) {
    row = lastRowInCol_(ap, 1) + 1;
    ap.getRange(row, 2).setNumberFormat('@');
    ap.getRange(row, 1, 1, 3).setValues([[emp, month, 'Pending']]);
  }
  const status = sh.getRange('F9').getDisplayValue() || 'Pending';
  const by = sh.getRange('F10').getDisplayValue();
  ap.getRange(row, 3, 1, 2).setValues([[status, by]]);
  if (a1 === 'F9') {
    const when = DECIDED.indexOf(status) >= 0 ? new Date() : '';
    ap.getRange(row, 5).setValue(when);
    sh.getRange('F11').setValue(when);
  }
}


/* ---------------- Meal & expense claims ---------------- */

/**
 * Saves a meal / expense claim with its receipts.
 * payload = {employee, month:'yyyy-MM', code, items:[{date:'yyyy-MM-dd', type, desc, ref, amount,
 *            receipt:{mime, data (base64), name}}]}
 * Every item is checked first; nothing is saved unless all items pass.
 */
function submitExpenses(payload, haveLock) {
  const lock = LockService.getScriptLock();
  if (!haveLock) lock.waitLock(25000);
  try {
    const s = readSettings_();
    checkCode_(s, payload.code);
    const emp = s.employees.filter(function (e) { return e.name === payload.employee; })[0];
    if (!emp) throw new Error('Pick your name from the list.');
    const month = String(payload.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Pick the month you are claiming for.');
    const items = (payload.items || []).filter(function (it) { return it; });
    if (!items.length) throw new Error('Add at least one item.');
    if (items.length > MAX_ITEMS) throw new Error('Please submit at most ' + MAX_ITEMS + ' items at a time.');

    const sh = SpreadsheetApp.getActive().getSheetByName(EXP_TAB);
    if (!sh) throw new Error('The Expenses tab is missing from the claims sheet. Please tell the admin.');
    const last = lastDataRow_(sh);
    const existing = {};
    if (last >= 2) {
      sh.getRange(2, 2, last - 1, 6).getValues().forEach(function (r) { // B..G
        const d = ymd_(r[1], s.tz);
        if (String(r[0]).trim() === emp.name && d) existing[d + '|' + Number(r[5]).toFixed(2) + '|' + norm_(r[4] || r[3])] = true;
      });
    }

    const errors = [], clean = [], seen = {};
    items.forEach(function (it, i) {
      const n = 'Item ' + (i + 1) + ': ';
      const date = String(it.date || '');
      const type = String(it.type || '').trim();
      const desc = String(it.desc || '').replace(/\s+/g, ' ').trim();
      const ref = String(it.ref || '').replace(/\s+/g, ' ').trim();
      const amount = Math.round(Number(it.amount) * 100) / 100;
      const rc = it.receipt || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { errors.push(n + 'date is missing'); return; }
      if (date.slice(0, 7) !== month) { errors.push(n + 'date is not in the month you picked'); return; }
      if (s.expenseTypes.indexOf(type) < 0) { errors.push(n + 'pick a type'); return; }
      if (!desc) { errors.push(n + 'description is missing'); return; }
      if (!(amount > 0) || amount > MAX_AMOUNT) { errors.push(n + 'amount must be between RM 0.01 and RM ' + MAX_AMOUNT); return; }
      if (!rc.data || !RECEIPT_TYPES[rc.mime]) { errors.push(n + 'attach a photo or PDF of the receipt'); return; }
      const key = date + '|' + amount.toFixed(2) + '|' + norm_(ref || desc);
      if (existing[key]) { errors.push(n + 'you already claimed this receipt (same date, amount and receipt no./description)'); return; }
      if (seen[key]) { errors.push(n + 'same item entered twice in this form'); return; }
      seen[key] = true;
      let bytes;
      try { bytes = Utilities.base64Decode(rc.data); } catch (err) { errors.push(n + 'the receipt file could not be read'); return; }
      if (bytes.length > MAX_FILE_BYTES) { errors.push(n + 'the receipt file is too big (max 8 MB)'); return; }
      clean.push({ date: date, type: type, desc: desc, ref: ref, amount: amount, mime: rc.mime, bytes: bytes });
    });
    if (errors.length) throw new Error(errors.join('\n'));

    // Save receipts: <receipt folder from Settings!B4> / <employee> / <yyyy-MM>
    const folder = subFolder_(subFolder_(rootFolder_(s.folder), emp.name), month);
    const now = new Date();
    const stamp = Utilities.formatDate(now, s.tz, 'yyyyMMdd-HHmmss');
    const rows = [];
    let total = 0;
    clean.forEach(function (c, i) {
      const name = c.date + ' ' + c.type + ' RM' + c.amount.toFixed(2) + ' ' + emp.name + ' (' + stamp + '-' + (i + 1) + ').' + RECEIPT_TYPES[c.mime];
      const file = folder.createFile(Utilities.newBlob(c.bytes, c.mime, name));
      rows.push([now, emp.name, Utilities.parseDate(c.date, s.tz, 'yyyy-MM-dd'), c.type, c.desc, c.ref, c.amount, file.getUrl()]);
      total += c.amount;
      rows[rows.length - 1].fileId = file.getId();
    });

    const start = last + 1;
    const need = start + rows.length - 1 - sh.getMaxRows();
    if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 200);
    sh.getRange(start, 1, rows.length, 8).setValues(rows.map(function (r) { return r.slice(0, 8); }));   // A:H (I is a formula)
    sh.getRange(start, 10, rows.length, 2).setValues(rows.map(function (r) { return [stamp, r.fileId]; })); // J:K
    sh.getRange(start, 1, rows.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');
    sh.getRange(start, 3, rows.length, 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(start, 6, rows.length, 1).setNumberFormat('@');
    sh.getRange(start, 7, rows.length, 1).setNumberFormat('#,##0.00');
    markPending_(EXP_APPROVALS_TAB, emp.name, month, now, s.tz, 'items');
    SpreadsheetApp.flush();
    return { count: rows.length, total: total, employee: emp.name, month: month };
  } finally {
    if (!haveLock) lock.releaseLock();
  }
}

/** Expense items already in the sheet for one employee and month. */
function getMonthExpenses(employee, month, code) {
  const s = readSettings_();
  employee = String(employee || '').trim();
  checkCode_(s, code);
  if (!/^\d{4}-\d{2}$/.test(month || '')) return { rows: [], total: 0, status: '' };
  const status = approvalStatus_(EXP_APPROVALS_TAB, employee, month);
  const sh = SpreadsheetApp.getActive().getSheetByName(EXP_TAB);
  if (!sh) return { rows: [], total: 0, status: status };
  const last = lastDataRow_(sh);
  if (last < 2) return { rows: [], total: 0, status: status };
  const vals = sh.getRange(2, 2, last - 1, 10).getValues(); // B..K
  const out = [];
  let total = 0;
  vals.forEach(function (r) {
    if (String(r[0]).trim() !== employee) return;
    const d = ymd_(r[1], s.tz);
    if (!d || d.slice(0, 7) !== month) return;
    const amt = Number(r[5]) || 0;
    total += amt;
    out.push({ date: d, type: r[2], desc: r[3], ref: String(r[4] || ''), amount: amt, file: String(r[9] || '') });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return { rows: out, total: total, status: status };
}

/** One receipt as base64, only for the employee who claimed it (used for the printable claim form). */
function getReceipt(employee, fileId, code) {
  const s = readSettings_();
  checkCode_(s, code);
  employee = String(employee || '').trim();
  fileId = String(fileId || '');
  const sh = SpreadsheetApp.getActive().getSheetByName(EXP_TAB);
  const last = sh ? lastDataRow_(sh) : 1;
  let ok = false;
  if (last >= 2 && fileId) {
    const v = sh.getRange(2, 2, last - 1, 10).getValues();
    for (let i = 0; i < v.length; i++) if (String(v[i][0]).trim() === employee && String(v[i][9]) === fileId) { ok = true; break; }
  }
  if (!ok) throw new Error('Receipt not found.');
  const blob = DriveApp.getFileById(fileId).getBlob();
  return { mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

function rootFolder_(name) {
  name = name || RECEIPT_FOLDER;
  const it = DriveApp.getFoldersByName(name);
  return it.hasNext() ? it.next() : DriveApp.createFolder(name);
}
function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
