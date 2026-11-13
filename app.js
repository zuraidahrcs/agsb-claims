/* AGSB Claims — mobile app. Talks to the Apps Script web app set in config.js. */
(function () {
  'use strict';
  var API = String(window.AGSB_API_URL || '').trim();
  var K = { cfg: 'agsb.app.cfg', me: 'agsb.app.me', draft: 'agsb.app.draft', out: 'agsb.app.outbox', month: 'agsb.app.monthcache' };
  var CFG = null, ME = null, DRAFT = null, vehAuto = true, sending = false, installEvt = null;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function get(k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function put(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rm(n) { return 'RM ' + (Number(n) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function monthName(ym) { var p = ym.split('-'); return new Date(+p[0], +p[1] - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
  function lastDay(ym) { var p = ym.split('-'); return ym + '-' + pad(new Date(+p[0], +p[1], 0).getDate()); }
  function months(n) { var out = [], d = new Date(); d.setDate(1); for (var i = 0; i < n; i++) { out.push(ymOf(d)); d.setMonth(d.getMonth() - 1); } return out; }
  function sid() { var a = new Uint8Array(12); (window.crypto || window.msCrypto).getRandomValues(a); return Array.prototype.map.call(a, function (b) { return pad(b.toString(16)); }).join(''); }
  function online() { return navigator.onLine !== false; }
  function apiReady() { return /^https:\/\/script\.google(usercontent)?\.com\//.test(API) || /^http:\/\/localhost[:/]/.test(API); }

  /* ---------- server ---------- */
  function NetErr(msg) { var e = new Error(msg || 'No internet connection.'); e.net = true; return e; }
  function handle(res) {
    if (!res.ok) throw NetErr('The claims server did not answer (' + res.status + ').');
    return res.json().catch(function () { throw NetErr('The claims server sent an unexpected reply. Check the link in config.js.'); })
      .then(function (j) { if (!j.ok) throw new Error(j.error || 'Something went wrong.'); return j.data; });
  }
  function apiGet(params) {
    var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k] || ''); }).join('&');
    return fetch(API + (API.indexOf('?') < 0 ? '?' : '&') + q, { redirect: 'follow' }).catch(function () { throw NetErr(); }).then(handle);
  }
  function apiPost(body) {
    // text/plain keeps this a "simple" request, which Apps Script accepts from another website.
    return fetch(API, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) })
      .catch(function () { throw NetErr(); }).then(handle);
  }

  /* ---------- views ---------- */
  function show(v) {
    ['vSetup', 'vMsg', 'vNew', 'vDone', 'vMine', 'vMe'].forEach(function (id) { $(id).classList.toggle('hidden', id !== v); });
    var tab = v === 'vDone' ? 'vNew' : v;
    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.classList.toggle('on', b.dataset.v === tab); });
    $('nav').classList.toggle('hidden', v === 'vSetup' || v === 'vMsg');
    if (v === 'vMine') loadMine();
    if (v === 'vMe') renderMe();
    if (v === 'vNew') renderOutboxNote();
    window.scrollTo(0, 0);
  }
  function msg(html) { $('msgBody').innerHTML = html; show('vMsg'); }
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.onclick = function () { show(b.dataset.v); }; });

  function setNet() {
    var n = get(K.out, []).filter(function (o) { return o.state === 'waiting'; }).length;
    $('net').textContent = online() ? (n ? 'Sending…' : 'Online') : 'Offline' + (n ? ' · ' + n + ' waiting' : '');
    $('net').classList.toggle('off', !online());
    var all = get(K.out, []).length;
    $('qBadge').textContent = all; $('qBadge').classList.toggle('hidden', !all);
  }

  /* ---------- start ---------- */
  function start() {
    if (!apiReady()) {
      msg('<h2>Almost ready</h2><p class="hint">Open <b>config.js</b> and paste the claim form web app link (it ends in <b>/exec</b>), then reload this page.</p>');
      return;
    }
    CFG = get(K.cfg, null); ME = get(K.me, null);
    if (CFG) boot();
    else msg('Loading the claim lists…');
    refreshConfig().then(function () { if (!$('vMsg').classList.contains('hidden')) boot(); })
      .catch(function (e) { if (!CFG) msg('<h2>Can\'t load</h2><p class="hint">' + esc(e.message) + '</p><p class="hint">Connect to the internet once to set up the app.</p><button class="pri" onclick="location.reload()">Try again</button>'); });
    flush();
  }
  function refreshConfig() {
    return apiGet({ api: 'config' }).then(function (c) {
      c.syncedAt = new Date().toISOString(); CFG = c; put(K.cfg, c); fillLists(); return c;
    });
  }
  function boot() {
    if (!CFG) return;
    if (!ME || !CFG.employees.some(function (e) { return e.name === ME.employee; })) { setupView(); return; }
    fillLists(); loadDraft(); show('vNew'); setNet();
  }

  /* ---------- setup ---------- */
  function setupView() {
    $('sEmp').innerHTML = '<option value="">Choose your name</option>' + CFG.employees.map(function (e) { return '<option>' + esc(e.name) + '</option>'; }).join('');
    if (ME) { $('sEmp').value = ME.employee; $('sCode').value = ME.code || ''; }
    $('sCodeWrap').classList.toggle('hidden', !CFG.needCode);
    $('sErr').textContent = '';
    show('vSetup');
  }
  $('sGo').onclick = function () {
    var emp = $('sEmp').value, code = $('sCode').value.trim();
    if (!emp) { $('sErr').textContent = 'Choose your name.'; return; }
    if (CFG.needCode && !code) { $('sErr').textContent = 'Enter the access code from your admin.'; return; }
    var btn = this; btn.disabled = true; btn.textContent = 'Checking…';
    var done = function () { ME = { employee: emp, code: code }; put(K.me, ME); btn.disabled = false; btn.textContent = 'Continue'; vehAuto = true; DRAFT = null; boot(); };
    apiGet({ api: 'month', employee: emp, month: ymOf(new Date()), code: code }).then(done, function (e) {
      if (e.net) done(); // offline: check the code when the first claim is sent
      else { btn.disabled = false; btn.textContent = 'Continue'; $('sErr').textContent = e.message; }
    });
  };

  /* ---------- lists ---------- */
  function fillLists() {
    if (!CFG) return;
    $('routeList').innerHTML = CFG.routes.map(function (r) { return '<option value="' + esc(r.dest) + '">' + r.km + ' km</option>'; }).join('');
    $('chips').innerHTML = CFG.routes.slice(0, 12).map(function (r, i) { return '<button type="button" class="chip" data-r="' + i + '">' + esc(r.dest) + ' · ' + r.km + ' km</button>'; }).join('');
    var ms = months(12).map(function (m) { return '<option value="' + m + '">' + monthName(m) + '</option>'; }).join('');
    var keep1 = $('month').value, keep2 = $('mMonth').value;
    $('month').innerHTML = ms; $('mMonth').innerHTML = ms;
    if (keep1) $('month').value = keep1; if (keep2) $('mMonth').value = keep2;
    if (ME) {
      var list = (CFG.vehicles && CFG.vehicles[ME.employee]) || [];
      $('vehList').innerHTML = list.map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
      $('whoRate').textContent = ME.employee + ' · RM ' + Number(CFG.rate).toFixed(2) + ' per km';
    }
  }
  function routeKm(dest) { var v = String(dest || '').trim().toLowerCase(); for (var i = 0; i < CFG.routes.length; i++) if (CFG.routes[i].dest.toLowerCase() === v) return CFG.routes[i].km; return null; }
  function guessType(p) {
    var s = String(p || '').toLowerCase();
    var map = [[/^market/, 'Marketing'], [/^train/, 'Training'], [/^meet/, 'Meeting'], [/^disc/, 'Discussion'], [/^(survey|site)/, 'Survey / Site visit']];
    for (var i = 0; i < map.length; i++) if (map[i][0].test(s) && CFG.types.indexOf(map[i][1]) >= 0) return map[i][1];
    return null;
  }

  /* ---------- new claim ---------- */
  function blank() { return { date: '', type: CFG.types[0] || '', purpose: '', dest: '', km: '' }; }
  function defaultMonth() { var d = new Date(); if (d.getDate() <= 7) d.setMonth(d.getMonth() - 1, 1); return ymOf(d); }
  function loadDraft() {
    DRAFT = get(K.draft, null);
    if (!DRAFT || DRAFT.employee !== ME.employee || months(12).indexOf(DRAFT.month) < 0) DRAFT = { employee: ME.employee, month: defaultMonth(), vehicle: '', trips: [blank()] };
    $('month').value = DRAFT.month;
    var list = (CFG.vehicles && CFG.vehicles[ME.employee]) || [];
    if (!DRAFT.vehicle) { DRAFT.vehicle = list[0] || ''; vehAuto = true; } else vehAuto = false;
    $('vehicle').value = DRAFT.vehicle;
    renderTrips();
  }
  function saveDraft() { put(K.draft, DRAFT); }
  function purposes() { // the person's recent purposes, for quick re-use
    var seen = {}, out = [];
    DRAFT.trips.concat(get('agsb.app.purposes', [])).forEach(function (p) { var v = String(typeof p === 'string' ? p : (p && p.purpose) || '').trim(); if (v && !seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); } });
    $('purposeList').innerHTML = out.slice(0, 30).map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
  }
  function renderTrips() {
    var ym = DRAFT.month, min = ym + '-01', max = lastDay(ym);
    var opts = CFG.types.map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
    $('trips').innerHTML = DRAFT.trips.map(function (t, i) {
      return '<div class="trip" data-i="' + i + '"><div class="top"><b>Trip ' + (i + 1) + '</b><span class="amt">' + (t.km ? rm(t.km * CFG.rate) : '') + '</span></div>' +
        '<div class="two"><label class="f"><span>Date *</span><input type="date" data-k="date" min="' + min + '" max="' + max + '" value="' + esc(t.date) + '"></label>' +
        '<label class="f"><span>Type *</span><select data-k="type">' + opts + '</select></label></div>' +
        '<label class="f"><span>Purpose of travel *</span><input data-k="purpose" list="purposeList" placeholder="e.g. Marketing KDN IABAC" value="' + esc(t.purpose) + '"></label>' +
        '<label class="f"><span>Destination *</span><input data-k="dest" list="routeList" placeholder="e.g. Office to Putrajaya (2 ways)" value="' + esc(t.dest) + '"></label>' +
        '<div class="two"><label class="f"><span>Km travelled *</span><input data-k="km" type="number" min="0" step="0.1" inputmode="decimal" value="' + esc(t.km) + '"></label><span></span></div>' +
        '<div class="acts"><button type="button" class="ghost" data-copy>Copy to next day</button><button type="button" class="ghost" data-del>Remove</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#trips .trip'), function (el) { el.querySelector('select').value = DRAFT.trips[+el.dataset.i].type; });
    totals(); purposes();
  }
  function totals() {
    var km = 0, n = 0;
    DRAFT.trips.forEach(function (t) { if (Number(t.km) > 0) { km += Number(t.km); n++; } });
    $('tot').textContent = rm(km * CFG.rate);
    $('totSub').textContent = n + ' trip' + (n === 1 ? '' : 's') + ' · ' + km.toLocaleString('en-MY') + ' km';
  }
  $('trips').addEventListener('input', function (e) {
    var el = e.target, card = el.closest('.trip'); if (!card || !el.dataset.k) return;
    var t = DRAFT.trips[+card.dataset.i], k = el.dataset.k;
    t[k] = el.value;
    if (k === 'dest') { var km = routeKm(el.value); if (km != null && (!t.km || t.kmAuto)) { t.km = String(km); t.kmAuto = true; card.querySelector('[data-k=km]').value = t.km; } }
    if (k === 'km') t.kmAuto = false;
    if (k === 'purpose' && !t.typeTouched) { var g = guessType(el.value); if (g) { t.type = g; card.querySelector('select').value = g; } }
    if (k === 'type') t.typeTouched = true;
    card.querySelector('.amt').textContent = t.km ? rm(t.km * CFG.rate) : '';
    card.classList.remove('bad'); totals(); saveDraft();
  });
  $('trips').addEventListener('change', function (e) {
    if (e.target.tagName !== 'SELECT') return;
    var t = DRAFT.trips[+e.target.closest('.trip').dataset.i]; t.type = e.target.value; t.typeTouched = true; saveDraft();
  });
  $('trips').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return; var i = +b.closest('.trip').dataset.i;
    if (b.hasAttribute('data-del')) { DRAFT.trips.splice(i, 1); if (!DRAFT.trips.length) DRAFT.trips.push(blank()); }
    if (b.hasAttribute('data-copy')) {
      var c = JSON.parse(JSON.stringify(DRAFT.trips[i]));
      if (c.date) { var d = new Date(c.date + 'T00:00:00'); d.setDate(d.getDate() + 1); var nd = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); c.date = nd.slice(0, 7) === DRAFT.month ? nd : ''; }
      DRAFT.trips.splice(i + 1, 0, c);
    }
    saveDraft(); renderTrips();
  });
  $('chips').addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (!b) return; var r = CFG.routes[+b.dataset.r];
    var idx = -1; for (var i = 0; i < DRAFT.trips.length; i++) if (!DRAFT.trips[i].dest) { idx = i; break; }
    if (idx < 0) { DRAFT.trips.push(blank()); idx = DRAFT.trips.length - 1; }
    DRAFT.trips[idx].dest = r.dest; DRAFT.trips[idx].km = String(r.km); DRAFT.trips[idx].kmAuto = true;
    saveDraft(); renderTrips();
    var card = document.querySelector('.trip[data-i="' + idx + '"]'); if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('addTrip').onclick = function () { DRAFT.trips.push(blank()); saveDraft(); renderTrips(); var c = document.querySelector('.trip:last-child'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('month').onchange = function () {
    DRAFT.month = this.value;
    DRAFT.trips.forEach(function (t) { if (t.date && t.date.slice(0, 7) !== DRAFT.month) t.date = ''; });
    saveDraft(); renderTrips();
  };
  $('vehicle').oninput = function () { vehAuto = false; DRAFT.vehicle = this.value; saveDraft(); };

  function validate(lines) {
    var errs = [];
    if (!DRAFT.vehicle.trim()) errs.push('Enter the vehicle number.');
    if (!lines.length) errs.push('Add at least one trip.');
    lines.forEach(function (t, i) {
      var n = 'Trip ' + (i + 1) + ': ', km = Number(t.km);
      if (!t.date) errs.push(n + 'pick the date.');
      else if (t.date.slice(0, 7) !== DRAFT.month) errs.push(n + 'the date is not in ' + monthName(DRAFT.month) + '.');
      if (!String(t.purpose || '').trim()) errs.push(n + 'purpose of travel is missing.');
      if (!String(t.dest || '').trim()) errs.push(n + 'destination is missing.');
      if (!(km > 0) || km > 3000) errs.push(n + 'km must be between 1 and 3000.');
    });
    return errs;
  }
  function markBad(text) {
    (String(text).match(/Trip (\d+)/g) || []).forEach(function (m) { var c = document.querySelector('.trip[data-i="' + (+m.split(' ')[1] - 1) + '"]'); if (c) c.classList.add('bad'); });
  }

  $('submit').onclick = function () {
    var lines = DRAFT.trips.filter(function (t) { return t.date || t.dest || t.km || t.purpose; });
    var errs = validate(lines);
    if (errs.length) { $('errs').textContent = errs.join('\n'); markBad(errs.join('\n')); return; }
    DRAFT.trips = lines; renderTrips(); $('errs').textContent = '';
    var item = {
      sid: sid(), state: 'waiting', created: new Date().toISOString(),
      payload: { employee: ME.employee, month: DRAFT.month, vehicle: DRAFT.vehicle.trim().toUpperCase(), code: ME.code,
        lines: lines.map(function (t) { return { date: t.date, type: t.type, purpose: t.purpose.trim(), dest: t.dest.trim(), km: t.km }; }) },
      total: lines.reduce(function (s, t) { return s + Number(t.km) * CFG.rate; }, 0)
    };
    var out = get(K.out, []); out.push(item); put(K.out, out);
    rememberPurposes(lines);
    var btn = this; btn.disabled = true; btn.textContent = 'Sending…'; setNet();
    sendOne(item).then(function (res) {
      btn.disabled = false; btn.textContent = 'Submit claim';
      clearDraft();
      $('doneH').textContent = 'Claim submitted';
      $('doneTxt').textContent = res.count + ' trip' + (res.count === 1 ? '' : 's') + ' · ' + rm(res.total) + ' for ' + monthName(res.month) + ' (' + res.vehicle + '). Your claim is now waiting for approval.';
      show('vDone');
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Submit claim';
      if (e.net) {
        clearDraft();
        $('doneH').textContent = 'Saved on this phone';
        $('doneTxt').textContent = 'There is no connection right now. Your claim (' + rm(item.total) + ') will be sent automatically when you are back online. Keep the app installed until it is sent.';
        show('vDone');
      } else {
        removeOut(item.sid);
        $('errs').textContent = 'Nothing was saved. ' + e.message; markBad(e.message);
      }
    });
  };
  function clearDraft() { DRAFT = { employee: ME.employee, month: DRAFT.month, vehicle: DRAFT.vehicle, trips: [blank()] }; saveDraft(); }
  function rememberPurposes(lines) {
    var old = get('agsb.app.purposes', []);
    put('agsb.app.purposes', lines.map(function (t) { return t.purpose.trim(); }).concat(old).slice(0, 40));
  }
  $('again').onclick = function () { loadDraft(); show('vNew'); };
  $('toMine').onclick = function () { $('mMonth').value = (get(K.out, []).slice(-1)[0] || {}).payload ? get(K.out, []).slice(-1)[0].payload.month : DRAFT.month; show('vMine'); };

  /* ---------- sending & outbox ---------- */
  function removeOut(id) { put(K.out, get(K.out, []).filter(function (o) { return o.sid !== id; })); setNet(); }
  function updateOut(id, patch) { put(K.out, get(K.out, []).map(function (o) { return o.sid === id ? Object.assign(o, patch) : o; })); setNet(); }
  function sendOne(item) {
    return apiPost({ action: 'submit', sid: item.sid, payload: item.payload }).then(function (res) { removeOut(item.sid); return res; });
  }
  function flush() {
    if (sending || !online() || !apiReady()) return;
    var waiting = get(K.out, []).filter(function (o) { return o.state === 'waiting'; });
    if (!waiting.length) { setNet(); return; }
    sending = true; setNet();
    var chain = Promise.resolve(), sent = 0;
    waiting.forEach(function (item) {
      chain = chain.then(function () {
        return sendOne(item).then(function () { sent++; }).catch(function (e) {
          if (e.net) throw e; // still offline: stop and try again later
          updateOut(item.sid, { state: 'failed', error: e.message });
        });
      });
    });
    chain.catch(function () {}).then(function () {
      sending = false; setNet(); renderOutboxNote();
      if (!$('vMine').classList.contains('hidden')) loadMine();
      if (sent) toast(sent + ' saved claim' + (sent === 1 ? ' was' : 's were') + ' sent.');
    });
  }
  function toast(t) {
    var d = document.createElement('div'); d.className = 'note'; d.textContent = t;
    d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom,0px));z-index:9;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.15)';
    document.body.appendChild(d); setTimeout(function () { d.remove(); }, 3500);
  }
  function renderOutboxNote() {
    var out = get(K.out, []), w = out.filter(function (o) { return o.state === 'waiting'; }).length, f = out.length - w;
    var h = '';
    if (w) h += '<div class="note">' + w + ' claim' + (w === 1 ? ' is' : 's are') + ' saved on this phone and will be sent when you are online.</div>';
    if (f) h += '<div class="note err">' + f + ' claim' + (f === 1 ? '' : 's') + ' could not be saved. Open <b>My claims</b> to fix ' + (f === 1 ? 'it' : 'them') + '.</div>';
    $('outboxNote').innerHTML = h;
  }
  function renderQueue() {
    var out = get(K.out, []);
    if (!out.length) { $('mQueue').innerHTML = ''; return; }
    $('mQueue').innerHTML = '<div class="card"><h2>On this phone</h2>' + out.map(function (o) {
      var p = o.payload;
      return '<div class="line"><div class="m"><div><b>' + esc(monthName(p.month)) + '</b> · ' + p.lines.length + ' trips · ' + rm(o.total) + '</div>' +
        (o.state === 'failed' ? '<div class="errors" style="margin:4px 0">' + esc(o.error) + '</div><button data-fix="' + o.sid + '">Fix and resend</button> <button class="ghost" data-drop="' + o.sid + '">Delete</button>'
          : '<div class="hint">Waiting for connection</div>') + '</div></div>';
    }).join('') + '</div>';
  }
  $('mQueue').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var id = b.dataset.fix || b.dataset.drop, item = get(K.out, []).filter(function (o) { return o.sid === id; })[0]; if (!item) return;
    if (b.dataset.drop) { if (confirmDrop()) { removeOut(id); renderQueue(); renderOutboxNote(); } return; }
    removeOut(id);
    DRAFT = { employee: ME.employee, month: item.payload.month, vehicle: item.payload.vehicle, trips: item.payload.lines.map(function (l) { return { date: l.date, type: l.type, purpose: l.purpose, dest: l.dest, km: String(l.km), typeTouched: true }; }) };
    saveDraft(); loadDraft(); show('vNew'); $('errs').textContent = item.error; markBad(item.error);
  });
  function confirmDrop() { return window.confirm('Delete this claim from the phone? It has not been sent.'); }

  /* ---------- my claims ---------- */
  function loadMine() {
    if (!ME) return;
    var ym = $('mMonth').value || DRAFT && DRAFT.month || ymOf(new Date());
    $('mMonth').value = ym;
    renderQueue();
    var cache = get(K.month, {}), key = ME.employee + '|' + ym;
    if (cache[key]) drawMine(cache[key], true); else $('mBody').textContent = 'Loading…';
    apiGet({ api: 'month', employee: ME.employee, month: ym, code: ME.code }).then(function (r) {
      cache = get(K.month, {}); cache[key] = r; put(K.month, cache);
      if ($('mMonth').value === ym) drawMine(r, false);
    }).catch(function (e) {
      if ($('mMonth').value !== ym) return;
      if (cache[key]) drawMine(cache[key], true, e.net ? 'Offline: showing what was last loaded.' : e.message);
      else $('mBody').innerHTML = '<span class="errors">' + esc(e.net ? 'You are offline. Connect to see this month.' : e.message) + '</span>';
    });
  }
  function drawMine(r, stale, note) {
    if (!r.rows.length) { $('mBody').innerHTML = (note ? '<div class="note">' + esc(note) + '</div>' : '') + 'Nothing submitted for this month.'; return; }
    var st = String(r.status || 'Pending'), word = st.split(' ')[0];
    var km = r.rows.reduce(function (s, x) { return s + x.km; }, 0);
    $('mBody').innerHTML = (note ? '<div class="note">' + esc(note) + '</div>' : '') +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px"><span class="big">' + rm(r.total) + '</span><span class="status ' + esc(word) + '">' + esc(word) + '</span></div>' +
      '<div class="hint" style="margin-bottom:8px">' + r.rows.length + ' trips · ' + km.toLocaleString('en-MY') + ' km' + (st !== word ? ' · ' + esc(st.slice(word.length + 1)) : '') + '</div>' +
      r.rows.map(function (x) {
        var d = new Date(x.date + 'T00:00:00');
        return '<div class="line"><div class="d">' + d.getDate() + '<small>' + d.toLocaleDateString('en-GB', { weekday: 'short' }) + '</small></div>' +
          '<div class="m"><div>' + esc(x.purpose || x.type) + '</div><div class="hint">' + esc(x.dest) + '</div></div>' +
          '<div class="r">' + rm(x.amount).replace('RM ', '') + '<small>' + x.km + ' km</small></div></div>';
      }).join('');
  }
  $('mMonth').onchange = loadMine;

  /* ---------- me ---------- */
  function renderMe() {
    $('meName').textContent = ME ? ME.employee : '';
    $('meRate').textContent = CFG ? 'Rate: RM ' + Number(CFG.rate).toFixed(2) + ' per km' : '';
    $('meSynced').textContent = CFG && CFG.syncedAt ? 'Last refreshed ' + new Date(CFG.syncedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    var standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    $('installCard').classList.toggle('hidden', !!standalone);
    $('installBtn').classList.toggle('hidden', !installEvt);
  }
  $('meSwitch').onclick = setupView;
  $('meRefresh').onclick = function () {
    var b = this; b.disabled = true; b.textContent = 'Refreshing…';
    refreshConfig().then(function () { b.textContent = 'Done'; renderMe(); if (DRAFT) renderTrips(); })
      .catch(function (e) { b.textContent = e.net ? 'Offline, try later' : e.message; })
      .then(function () { setTimeout(function () { b.disabled = false; b.textContent = 'Refresh now'; }, 1500); });
  };
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; if (!$('vMe').classList.contains('hidden')) renderMe(); });
  $('installBtn').onclick = function () { if (!installEvt) return; installEvt.prompt(); installEvt.userChoice.then(function () { installEvt = null; renderMe(); }); };

  window.addEventListener('online', function () { setNet(); flush(); });
  window.addEventListener('offline', setNet);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) flush(); });
  setInterval(flush, 60000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(function () {});
  start();
})();
