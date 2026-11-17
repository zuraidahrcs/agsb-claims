/* AGSB Claims — mobile app. Talks to the Apps Script web app set in config.js. */
(function () {
  'use strict';
  /* Companies: each has its own claims Sheet + web app link (config.js). Amboi Group keeps the original storage keys. */
  var COMPANIES = (window.AGSB_COMPANIES && window.AGSB_COMPANIES.length ? window.AGSB_COMPANIES
    : [{ id: 'agsb', name: 'Amboi Group', full: 'AMBOI GROUP SDN BHD', api: window.AGSB_API_URL }]);
  var CO = null, API = '', K = {}, SFX = '';
  function sfxOf(id) { return id === 'agsb' ? '' : '.' + id; }
  function setCompany(co) {
    CO = co; API = String(co.api || '').trim(); SFX = sfxOf(co.id);
    K = { cfg: 'agsb.app.cfg' + SFX, me: 'agsb.app.me' + SFX, draft: 'agsb.app.draft' + SFX, out: 'agsb.app.outbox' + SFX, month: 'agsb.app.monthcache' + SFX };
    document.getElementById('coName').textContent = co.name;
    document.title = co.name + ' Claims';
  }
  function coColor(id) { return id === 'rcs' ? '#c62828' : '#1f3a5f'; }
  var CFG = null, ME = null, DRAFT = null, vehAuto = true, sending = false, installEvt = null;
  var EDRAFT = null, EXPQ = [], KIND_NEW = 'm', KIND_MINE = 'm', LAST_MINE = null;

  /* Small key-value store in IndexedDB (receipt photos are too big for localStorage). */
  var idb = (function () {
    var dbp = null, mem = {};
    function db() {
      if (!dbp) dbp = new Promise(function (res, rej) {
        if (!window.indexedDB) { rej(new Error('no idb')); return; }
        var r = indexedDB.open('agsb-claims', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      });
      return dbp;
    }
    function tx(mode, fn) {
      return db().then(function (d) {
        return new Promise(function (res, rej) {
          var t = d.transaction('kv', mode), q = fn(t.objectStore('kv'));
          t.oncomplete = function () { res(q && q.result); };
          t.onerror = function () { rej(t.error); };
          t.onabort = function () { rej(t.error || new Error('Storage is full.')); };
        });
      });
    }
    return {
      get: function (k) { return tx('readonly', function (s) { return s.get(k); }).catch(function () { return mem[k]; }); },
      set: function (k, v) { mem[k] = v; return tx('readwrite', function (s) { return s.put(v, k); }).catch(function () {}); }
    };
  })();

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
    ['vCo', 'vSetup', 'vMsg', 'vNew', 'vDone', 'vMine', 'vMe'].forEach(function (id) { $(id).classList.toggle('hidden', id !== v); });
    var tab = v === 'vDone' ? 'vNew' : v;
    Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.classList.toggle('on', b.dataset.v === tab); });
    $('nav').classList.toggle('hidden', v === 'vSetup' || v === 'vMsg' || v === 'vCo');
    if (v === 'vMine') loadMine();
    if (v === 'vMe') renderMe();
    if (v === 'vNew') renderOutboxNote();
    window.scrollTo(0, 0);
  }
  function msg(html) { $('msgBody').innerHTML = html; show('vMsg'); }
  Array.prototype.forEach.call(document.querySelectorAll('nav button'), function (b) { b.onclick = function () { show(b.dataset.v); }; });

  function setNet() {
    var n = get(K.out, []).concat(EXPQ).filter(function (o) { return o.state === 'waiting'; }).length;
    $('net').textContent = online() ? (n ? 'Sending…' : 'Online') : 'Offline' + (n ? ' · ' + n + ' waiting' : '');
    $('net').classList.toggle('off', !online());
    var all = get(K.out, []).length + EXPQ.length;
    if (CO) put('agsb.app.pending' + SFX, all);
    $('qBadge').textContent = all; $('qBadge').classList.toggle('hidden', !all);
  }

  /* ---------- start ---------- */
  function chooseView() {
    $('coList').innerHTML = COMPANIES.map(function (c, i) {
      var n = get('agsb.app.pending' + sfxOf(c.id), 0);
      var ini = c.name.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
      return '<button class="co' + (CO && CO.id === c.id ? ' on' : '') + '" data-i="' + i + '"><span class="ic" style="background:' + coColor(c.id) + '">' + esc(ini) + '</span>' +
        '<span><b>' + esc(c.name) + '</b><span class="s">' + esc(c.full) + (n ? ' · ' + n + ' claim' + (n === 1 ? '' : 's') + ' on this phone' : '') + '</span></span></button>';
    }).join('');
    show('vCo');
  }
  $('coList').addEventListener('click', function (e) {
    var b = e.target.closest('button.co'); if (!b) return;
    var co = COMPANIES[+b.dataset.i];
    if (CO && CO.id === co.id && CFG && ME) { show('vNew'); return; }
    switchCompany(co);
  });
  function switchCompany(co) {
    put('agsb.app.company', co.id);
    setCompany(co);
    CFG = null; ME = null; DRAFT = null; EDRAFT = null; EXPQ = []; LAST_MINE = null; sending = false;
    ['month', 'mMonth', 'eMonth'].forEach(function (id) { $(id).innerHTML = ''; });
    $('trips').innerHTML = ''; $('eItems').innerHTML = ''; $('errs').textContent = ''; $('eErrs').textContent = '';
    setKindNew('m'); KIND_MINE = 'm'; segOn('segMine', 'm');
    start();
  }
  $('coBtn').onclick = chooseView;
  $('meCompany').onclick = chooseView;

  function start() {
    if (!CO) { chooseView(); return; }
    if (!apiReady()) {
      msg('<h2>Almost ready</h2><p class="hint"><b>' + esc(CO.name) + '</b> is not connected yet. Open <b>config.js</b> and paste its claim web app link (it ends in <b>/exec</b>), then reload this page.</p><button class="wide" onclick="document.getElementById(\'coBtn\').click()">Choose another company</button>');
      return;
    }
    CFG = get(K.cfg, null); ME = get(K.me, null);
    if (CFG) boot();
    else msg('Loading the claim lists…');
    refreshConfig().then(function () { if (!$('vMsg').classList.contains('hidden')) boot(); })
      .catch(function (e) { if (!CFG) msg('<h2>Can\'t load</h2><p class="hint">' + esc(e.message) + '</p><p class="hint">Connect to the internet once to set up the app.</p><button class="pri" onclick="location.reload()">Try again</button>'); });
    var cid = CO.id;
    idb.get('expOut' + SFX).then(function (q) { if (CO.id !== cid) return; EXPQ = q || []; setNet(); renderOutboxNote(); flush(); });
  }
  function refreshConfig() {
    return apiGet({ api: 'config' }).then(function (c) {
      c.syncedAt = new Date().toISOString(); CFG = c; put(K.cfg, c); fillLists(); return c;
    });
  }
  function boot() {
    if (!CFG) return;
    if (!ME || !CFG.employees.some(function (e) { return e.name === ME.employee; })) { setupView(); return; }
    fillLists(); loadDraft(); loadEDraft(); show('vNew'); setNet();
  }

  /* ---------- setup ---------- */
  function setupView() {
    $('sEmp').innerHTML = '<option value="">Choose your name</option>' + CFG.employees.map(function (e) { return '<option>' + esc(e.name) + '</option>'; }).join('');
    if (ME) { $('sEmp').value = ME.employee; $('sCode').value = ME.code || ''; }
    $('sCodeWrap').classList.toggle('hidden', !CFG.needCode);
    $('sCo').textContent = CO.full;
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
    var keep1 = $('month').value, keep2 = $('mMonth').value, keep3 = $('eMonth').value;
    $('month').innerHTML = ms; $('mMonth').innerHTML = ms; $('eMonth').innerHTML = ms;
    if (keep1) $('month').value = keep1; if (keep2) $('mMonth').value = keep2; if (keep3) $('eMonth').value = keep3;
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
  $('again').onclick = function () { if (KIND_NEW === 'e') renderItems(); else loadDraft(); show('vNew'); };
  $('toMine').onclick = function () {
    KIND_MINE = KIND_NEW; segOn('segMine', KIND_MINE);
    $('mMonth').value = KIND_NEW === 'e' ? EDRAFT.month : DRAFT.month; show('vMine');
  };

  /* ---------- sending & outbox ---------- */
  function removeOut(id) { put(K.out, get(K.out, []).filter(function (o) { return o.sid !== id; })); setNet(); }
  function updateOut(id, patch) { put(K.out, get(K.out, []).map(function (o) { return o.sid === id ? Object.assign(o, patch) : o; })); setNet(); }
  function sendOne(item) {
    return apiPost({ action: 'submit', sid: item.sid, payload: item.payload }).then(function (res) { removeOut(item.sid); return res; });
  }
  function flush() {
    if (sending || !online() || !apiReady()) return;
    var waiting = get(K.out, []).filter(function (o) { return o.state === 'waiting'; });
    var ewait = EXPQ.filter(function (o) { return o.state === 'waiting'; });
    if (!waiting.length && !ewait.length) { setNet(); return; }
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
    ewait.forEach(function (item) {
      chain = chain.then(function () {
        return sendExp(item).then(function () { sent++; }).catch(function (e) {
          if (e.net) throw e;
          item.state = 'failed'; item.error = e.message; saveExpQ();
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
    var out = get(K.out, []).concat(EXPQ), w = out.filter(function (o) { return o.state === 'waiting'; }).length, f = out.length - w;
    var h = '';
    if (w) h += '<div class="note">' + w + ' claim' + (w === 1 ? ' is' : 's are') + ' saved on this phone and will be sent when you are online.</div>';
    if (f) h += '<div class="note err">' + f + ' claim' + (f === 1 ? '' : 's') + ' could not be saved. Open <b>My claims</b> to fix ' + (f === 1 ? 'it' : 'them') + '.</div>';
    $('outboxNote').innerHTML = h;
  }
  function renderQueue() {
    var out = get(K.out, []).concat(EXPQ);
    if (!out.length) { $('mQueue').innerHTML = ''; return; }
    $('mQueue').innerHTML = '<div class="card"><h2>On this phone</h2>' + out.map(function (o) {
      var p = o.payload, isE = o.kind === 'e';
      return '<div class="line"><div class="m"><div><b>' + (isE ? 'Meal &amp; expenses' : 'Mileage') + ' · ' + esc(monthName(p.month)) + '</b> · ' + (isE ? p.items.length + ' items' : p.lines.length + ' trips') + ' · ' + rm(o.total) + '</div>' +
        (o.state === 'failed' ? '<div class="errors" style="margin:4px 0">' + esc(o.error) + '</div><button data-fix="' + o.sid + '">Fix and resend</button> <button class="ghost" data-drop="' + o.sid + '">Delete</button>'
          : '<div class="hint">Waiting for connection</div>') + '</div></div>';
    }).join('') + '</div>';
  }
  $('mQueue').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var id = b.dataset.fix || b.dataset.drop;
    var eitem = EXPQ.filter(function (o) { return o.sid === id; })[0];
    if (eitem) {
      if (b.dataset.drop) { if (confirmDrop()) { removeExpQ(id); renderQueue(); renderOutboxNote(); } return; }
      removeExpQ(id);
      EDRAFT = { employee: ME.employee, month: eitem.payload.month, items: eitem.payload.items.map(function (it) { return Object.assign({}, it, { amount: String(it.amount) }); }) };
      saveEDraft(); setKindNew('e'); show('vNew'); $('eMonth').value = EDRAFT.month; renderItems(); $('eErrs').textContent = eitem.error; markBadE(eitem.error);
      return;
    }
    var item = get(K.out, []).filter(function (o) { return o.sid === id; })[0]; if (!item) return;
    if (b.dataset.drop) { if (confirmDrop()) { removeOut(id); renderQueue(); renderOutboxNote(); } return; }
    removeOut(id);
    DRAFT = { employee: ME.employee, month: item.payload.month, vehicle: item.payload.vehicle, trips: item.payload.lines.map(function (l) { return { date: l.date, type: l.type, purpose: l.purpose, dest: l.dest, km: String(l.km), typeTouched: true }; }) };
    saveDraft(); loadDraft(); setKindNew('m'); show('vNew'); $('errs').textContent = item.error; markBad(item.error);
  });
  function confirmDrop() { return window.confirm('Delete this claim from the phone? It has not been sent.'); }

  /* ---------- my claims ---------- */
  function loadMine() {
    if (!ME) return;
    var ym = $('mMonth').value || DRAFT && DRAFT.month || ymOf(new Date());
    $('mMonth').value = ym;
    renderQueue();
    var kind = KIND_MINE, cache = get(K.month, {}), key = (kind === 'e' ? 'e|' : '') + ME.employee + '|' + ym;
    var draw = kind === 'e' ? drawMineExp : drawMine;
    LAST_MINE = null; $('mDownload').classList.add('hidden'); $('mDlHint').classList.add('hidden');
    if (cache[key]) draw(cache[key], true); else $('mBody').textContent = 'Loading…';
    apiGet({ api: kind === 'e' ? 'expenses' : 'month', employee: ME.employee, month: ym, code: ME.code }).then(function (r) {
      cache = get(K.month, {}); cache[key] = r; put(K.month, cache);
      if ($('mMonth').value === ym && KIND_MINE === kind) draw(r, false);
    }).catch(function (e) {
      if ($('mMonth').value !== ym || KIND_MINE !== kind) return;
      if (cache[key]) { draw(cache[key], true, e.net ? 'Offline: showing what was last loaded.' : e.message); return; }
      $('mBody').innerHTML = '<span class="errors">' + esc(e.net ? 'You are offline. Connect to see this month.' : e.message) + '</span>';
    });
  }
  function drawMine(r, stale, note) {
    if (!r.rows.length) { $('mBody').innerHTML = (note ? '<div class="note">' + esc(note) + '</div>' : '') + 'Nothing submitted for this month.'; return; }
    setDownload('m', r);
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

  /* ---------- claim kind switches ---------- */
  function segOn(id, k) { Array.prototype.forEach.call(document.querySelectorAll('#' + id + ' button'), function (b) { b.classList.toggle('on', b.dataset.k === k); }); }
  function setKindNew(k) {
    KIND_NEW = k; segOn('segNew', k);
    $('mileNew').classList.toggle('hidden', k !== 'm');
    $('expNew').classList.toggle('hidden', k !== 'e');
    if (k === 'e' && EDRAFT) renderItems();
  }
  $('segNew').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setKindNew(b.dataset.k); });
  $('segMine').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; KIND_MINE = b.dataset.k; segOn('segMine', KIND_MINE); loadMine(); });

  /* ---------- meal & expense claim ---------- */
  var MAX_RC = 5 * 1024 * 1024;
  function eblank() { return { date: '', type: (CFG.expenseTypes || ['Meal'])[0], desc: '', ref: '', amount: '', receipt: null }; }
  function loadEDraft() {
    idb.get('expDraft' + SFX).then(function (d) {
      EDRAFT = d && d.employee === ME.employee && months(12).indexOf(d.month) >= 0 ? d : { employee: ME.employee, month: defaultMonth(), items: [eblank()] };
      $('eMonth').value = EDRAFT.month;
      $('eWho').textContent = ME.employee;
      if (KIND_NEW === 'e') renderItems();
    });
  }
  var saveTimer = null;
  function saveEDraft() { var k = 'expDraft' + SFX, d = EDRAFT; clearTimeout(saveTimer); saveTimer = setTimeout(function () { idb.set(k, d); }, 300); }
  function saveExpQ() { idb.set('expOut' + SFX, EXPQ); setNet(); }
  function removeExpQ(id) { EXPQ = EXPQ.filter(function (o) { return o.sid !== id; }); saveExpQ(); }

  function renderItems() {
    if (!EDRAFT) return;
    var ym = EDRAFT.month, min = ym + '-01', max = lastDay(ym);
    var opts = (CFG.expenseTypes || []).map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
    $('eItems').innerHTML = EDRAFT.items.map(function (t, i) {
      var rc = t.receipt;
      var thumb = rc ? (rc.thumb ? '<div class="thumb" style="background-image:url(' + rc.thumb + ')"></div>' : '<div class="thumb">PDF</div>') : '<div class="thumb">No receipt</div>';
      return '<div class="trip" data-i="' + i + '"><div class="top"><b>Item ' + (i + 1) + '</b><span class="amt">' + (Number(t.amount) > 0 ? rm(t.amount) : '') + '</span></div>' +
        '<div class="two"><label class="f"><span>Date *</span><input type="date" data-k="date" min="' + min + '" max="' + max + '" value="' + esc(t.date) + '"></label>' +
        '<label class="f"><span>Type *</span><select data-k="type">' + opts + '</select></label></div>' +
        '<label class="f"><span>Description *</span><input data-k="desc" placeholder="e.g. Lunch with client during MDEC meeting" value="' + esc(t.desc) + '"></label>' +
        '<div class="two"><label class="f"><span>Receipt no. / Shop</span><input data-k="ref" placeholder="e.g. INV 10234" value="' + esc(t.ref) + '"></label>' +
        '<label class="f"><span>Amount *</span><span class="money"><input data-k="amount" type="number" min="0" step="0.01" inputmode="decimal" value="' + esc(t.amount) + '"></span></label></div>' +
        '<div class="rc">' + thumb + '<label class="pick' + (rc ? ' has' : '') + '">' + (rc ? 'Receipt attached ✓<br>Tap to change' : '📷 Add receipt photo or PDF *') +
        '<input type="file" accept="image/*,application/pdf" data-file="' + i + '"></label></div>' +
        '<div class="acts"><button type="button" class="ghost" data-del>Remove</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#eItems .trip'), function (el) { el.querySelector('select').value = EDRAFT.items[+el.dataset.i].type; });
    etotals();
  }
  function etotals() {
    var sum = 0, n = 0;
    EDRAFT.items.forEach(function (t) { if (Number(t.amount) > 0) { sum += Number(t.amount); n++; } });
    $('eTot').textContent = rm(sum);
    $('eTotSub').textContent = n + ' item' + (n === 1 ? '' : 's');
  }
  $('eItems').addEventListener('input', function (e) {
    var el = e.target, card = el.closest('.trip'); if (!card || !el.dataset.k) return;
    var t = EDRAFT.items[+card.dataset.i]; t[el.dataset.k] = el.value;
    if (el.dataset.k === 'amount') card.querySelector('.amt').textContent = Number(t.amount) > 0 ? rm(t.amount) : '';
    card.classList.remove('bad'); etotals(); saveEDraft();
  });
  $('eItems').addEventListener('change', function (e) {
    var el = e.target;
    if (el.tagName === 'SELECT') { EDRAFT.items[+el.closest('.trip').dataset.i].type = el.value; saveEDraft(); return; }
    if (el.type !== 'file' || !el.files || !el.files[0]) return;
    var i = +el.dataset.file, lab = el.parentNode;
    lab.firstChild.textContent = 'Preparing…';
    readReceipt(el.files[0]).then(function (rc) {
      EDRAFT.items[i].receipt = rc; saveEDraft(); $('eErrs').textContent = ''; renderItems();
    }).catch(function (err) { $('eErrs').textContent = 'Item ' + (i + 1) + ': ' + err.message; renderItems(); });
  });
  $('eItems').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-del]'); if (!b) return;
    var i = +b.closest('.trip').dataset.i;
    if (EDRAFT.items[i].receipt && !window.confirm('Remove this item and its receipt?')) return;
    EDRAFT.items.splice(i, 1); if (!EDRAFT.items.length) EDRAFT.items.push(eblank());
    saveEDraft(); renderItems();
  });
  $('eAdd').onclick = function () {
    var prev = EDRAFT.items[EDRAFT.items.length - 1], it = eblank();
    if (prev && prev.type) it.type = prev.type;
    EDRAFT.items.push(it); saveEDraft(); renderItems();
    var c = document.querySelector('#eItems .trip:last-child'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  $('eMonth').onchange = function () {
    EDRAFT.month = this.value;
    EDRAFT.items.forEach(function (t) { if (t.date && t.date.slice(0, 7) !== EDRAFT.month) t.date = ''; });
    saveEDraft(); renderItems();
  };

  /* Receipt photos are shrunk on the phone (max 1600 px, JPEG) so they upload fast; PDFs are sent as they are. */
  function fileToDataURL(f) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(new Error('The file could not be read.')); }; r.readAsDataURL(f); });
  }
  function loadImage(src) {
    return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = function () { rej(new Error('This photo could not be opened. Please use a JPG or PNG photo, or a PDF.')); }; im.src = src; });
  }
  function shrink(im, maxSide, q) {
    var w = im.naturalWidth || im.width, h = im.naturalHeight || im.height, k = Math.min(1, maxSide / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  }
  function readReceipt(f) {
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
      if (f.size > MAX_RC) return Promise.reject(new Error('This PDF is bigger than 5 MB. Please take a photo of the receipt instead.'));
      return fileToDataURL(f).then(function (u) { return { mime: 'application/pdf', data: u.split(',')[1], thumb: '', name: f.name }; });
    }
    if (f.type && !/^image\//.test(f.type)) return Promise.reject(new Error('Please choose a photo or a PDF of the receipt.'));
    var url = URL.createObjectURL(f);
    return loadImage(url).then(function (im) {
      var big = shrink(im, 1600, 0.75), small = shrink(im, 200, 0.6);
      URL.revokeObjectURL(url);
      return { mime: 'image/jpeg', data: big.split(',')[1], thumb: small, name: f.name };
    }, function (err) { URL.revokeObjectURL(url); throw err; });
  }

  function evalidate(items) {
    var errs = [];
    if (!items.length) errs.push('Add at least one item.');
    items.forEach(function (t, i) {
      var n = 'Item ' + (i + 1) + ': ', a = Number(t.amount);
      if (!t.date) errs.push(n + 'pick the date.');
      else if (t.date.slice(0, 7) !== EDRAFT.month) errs.push(n + 'the date is not in ' + monthName(EDRAFT.month) + '.');
      if (!String(t.desc || '').trim()) errs.push(n + 'description is missing.');
      if (!(a > 0) || a > 5000) errs.push(n + 'amount must be between RM 0.01 and RM 5,000.');
      if (!t.receipt) errs.push(n + 'attach a photo or PDF of the receipt.');
    });
    return errs;
  }
  function markBadE(text) {
    (String(text).match(/Item (\d+)/g) || []).forEach(function (m) { var c = document.querySelector('#eItems .trip[data-i="' + (+m.split(' ')[1] - 1) + '"]'); if (c) c.classList.add('bad'); });
  }
  function sendExp(item) {
    return apiPost({ action: 'submitExpense', sid: item.sid, payload: item.payload }).then(function (res) { removeExpQ(item.sid); return res; });
  }
  $('eSubmit').onclick = function () {
    var items = EDRAFT.items.filter(function (t) { return t.date || t.desc || t.amount || t.receipt; });
    var errs = evalidate(items);
    if (errs.length) { $('eErrs').textContent = errs.join('\n'); markBadE(errs.join('\n')); return; }
    EDRAFT.items = items; renderItems(); $('eErrs').textContent = '';
    var item = {
      kind: 'e', sid: sid(), state: 'waiting', created: new Date().toISOString(),
      payload: { employee: ME.employee, month: EDRAFT.month, code: ME.code,
        items: items.map(function (t) { return { date: t.date, type: t.type, desc: t.desc.trim(), ref: String(t.ref || '').trim(), amount: Number(t.amount), receipt: t.receipt }; }) },
      total: items.reduce(function (s, t) { return s + Number(t.amount); }, 0)
    };
    EXPQ.push(item); saveExpQ();
    var btn = this; btn.disabled = true; btn.textContent = 'Uploading receipts…';
    sendExp(item).then(function (res) {
      btn.disabled = false; btn.textContent = 'Submit claim';
      clearEDraft();
      $('doneH').textContent = 'Claim submitted';
      $('doneTxt').textContent = res.count + ' item' + (res.count === 1 ? '' : 's') + ' · ' + rm(res.total) + ' for ' + monthName(res.month) + ', with receipts. Your claim is now waiting for approval.';
      show('vDone');
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Submit claim';
      if (e.net) {
        clearEDraft();
        $('doneH').textContent = 'Saved on this phone';
        $('doneTxt').textContent = 'There is no connection right now. Your claim (' + rm(item.total) + ') and its receipts will be sent automatically when you are back online. Keep the app installed until it is sent.';
        show('vDone');
      } else {
        removeExpQ(item.sid);
        $('eErrs').textContent = 'Nothing was saved. ' + e.message; markBadE(e.message);
      }
    });
  };
  function clearEDraft() { EDRAFT = { employee: ME.employee, month: EDRAFT.month, items: [eblank()] }; idb.set('expDraft' + SFX, EDRAFT); }

  /* ---------- my claims: meal & expenses ---------- */
  function drawMineExp(r, stale, note) {
    if (!r.rows.length) { $('mBody').innerHTML = (note ? '<div class="note">' + esc(note) + '</div>' : '') + 'No meal or expense claims for this month.'; return; }
    setDownload('e', r);
    var st = String(r.status || 'Pending'), word = st.split(' ')[0];
    $('mBody').innerHTML = (note ? '<div class="note">' + esc(note) + '</div>' : '') +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px"><span class="big">' + rm(r.total) + '</span><span class="status ' + esc(word) + '">' + esc(word) + '</span></div>' +
      '<div class="hint" style="margin-bottom:8px">' + r.rows.length + ' item' + (r.rows.length === 1 ? '' : 's') + ' with receipts' + (st !== word ? ' · ' + esc(st.slice(word.length + 1)) : '') + '</div>' +
      r.rows.map(function (x) {
        var d = new Date(x.date + 'T00:00:00');
        return '<div class="line"><div class="d">' + d.getDate() + '<small>' + d.toLocaleDateString('en-GB', { weekday: 'short' }) + '</small></div>' +
          '<div class="m"><div>' + esc(x.type) + ': ' + esc(x.desc) + '</div><div class="hint">' + (x.ref ? esc(x.ref) + ' · ' : '') + '🧾 receipt saved</div></div>' +
          '<div class="r">' + rm(x.amount).replace('RM ', '') + '</div></div>';
      }).join('');
  }

  /* ---------- printable claim form (Save as PDF) ---------- */
  function setDownload(kind, r) {
    LAST_MINE = { kind: kind, month: $('mMonth').value, data: r };
    $('mDownload').classList.remove('hidden'); $('mDlHint').classList.remove('hidden');
  }
  function fmtDate(ymd) { var p = ymd.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
  function statusParts(st) {
    var m = String(st || '').match(/^(\w+)(?: by (.*?))?(?: on (.*))?$/) || [];
    return { word: m[1] || 'Pending', by: m[2] || '', on: m[3] || '' };
  }
  function printHtml(L, receipts) {
    var r = L.data, isE = L.kind === 'e', st = statusParts(r.status);
    var head = '<h1>' + esc(CO.full) + '</h1><h2>' + (isE ? 'Meal &amp; Expense Claim Form' : 'Claim Mileage Form') + '</h2>' +
      '<table class="info"><tr><td class="k">Name</td><td><b>' + esc(ME.employee) + '</b></td><td class="k">' + (isE ? 'Receipts' : 'Vehicle no.') + '</td><td>' +
      (isE ? r.rows.length + ' attached' : esc((r.vehicles || []).join(', '))) + '</td></tr>' +
      '<tr><td class="k">Month</td><td>' + esc(monthName(L.month)) + '</td><td class="k">' + (isE ? 'Status' : 'Rate') + '</td><td>' +
      (isE ? esc(st.word) : 'RM ' + Number(r.rate || CFG.rate).toFixed(2) + ' per km') + '</td></tr>' +
      (isE ? '' : '<tr><td class="k"></td><td></td><td class="k">Status</td><td>' + esc(st.word) + '</td></tr>') + '</table>';
    var rows, thead, total;
    if (isE) {
      thead = '<tr><th class="n">No.</th><th>Date</th><th>Type</th><th>Description</th><th>Receipt no. / Shop</th><th class="n">Amount (RM)</th></tr>';
      rows = r.rows.map(function (x, i) { return '<tr><td class="n">' + (i + 1) + '</td><td>' + fmtDate(x.date) + '</td><td>' + esc(x.type) + '</td><td>' + esc(x.desc) + '</td><td>' + esc(x.ref) + '</td><td class="n">' + rm(x.amount).replace('RM ', '') + '</td></tr>'; }).join('');
      total = '<tr class="tot"><td colspan="5">Total Claim Amount</td><td class="n">' + rm(r.total).replace('RM ', '') + '</td></tr>';
    } else {
      var km = r.rows.reduce(function (s, x) { return s + x.km; }, 0);
      thead = '<tr><th class="n">No.</th><th>Date of travel</th><th>Purpose of travel</th><th>Destination</th><th class="n">Km</th><th class="n">Amount (RM)</th></tr>';
      rows = r.rows.map(function (x, i) { return '<tr><td class="n">' + (i + 1) + '</td><td>' + fmtDate(x.date) + '</td><td>' + esc(x.purpose) + '</td><td>' + esc(x.dest) + '</td><td class="n">' + x.km + '</td><td class="n">' + rm(x.amount).replace('RM ', '') + '</td></tr>'; }).join('');
      total = '<tr class="tot"><td colspan="4">Total Claim Amount</td><td class="n">' + km.toLocaleString('en-MY') + '</td><td class="n">' + rm(r.total).replace('RM ', '') + '</td></tr>';
    }
    var sign = '<div class="sign"><div>Claimed by<div class="line"></div>' + esc(ME.employee) + '<br>Date:</div>' +
      '<div>Approved by<div class="line"></div>' + esc(st.by) + '<br>Date: ' + esc(st.on) + '</div></div>';
    var foot = '<div class="foot">Printed from AGSB Claims on ' + new Date().toLocaleDateString('en-GB') + ' · designed by rcs</div>';
    var rec = '';
    if (isE) {
      rec = '<div class="rpage"><h2>Receipts — ' + esc(ME.employee) + ', ' + esc(monthName(L.month)) + '</h2>' + r.rows.map(function (x, i) {
        var rc = receipts[i], cap = '<p><b>Item ' + (i + 1) + '</b> · ' + fmtDate(x.date) + ' · ' + esc(x.type) + ' · ' + rm(x.amount) + (x.ref ? ' · ' + esc(x.ref) : '') + '</p>';
        if (rc && /^image\//.test(rc.mime)) return '<div class="rbox"><img src="data:' + rc.mime + ';base64,' + rc.data + '">' + cap + '</div>';
        return '<div class="rbox" style="border:1px dashed #999;padding:12mm 4mm">' + (rc && rc.mime === 'application/pdf' ? 'PDF receipt: saved in the AGSB Claim Receipts folder in Google Drive' : 'Receipt could not be loaded') + cap + '</div>';
      }).join('') + '</div>';
    }
    return '<div class="pf">' + head + '<table class="items"><thead>' + thead + '</thead><tbody>' + rows + total + '</tbody></table>' + sign + foot + rec + '</div>';
  }
  $('mDownload').onclick = function () {
    var L = LAST_MINE; if (!L) return;
    var btn = this, receipts = [];
    function go() {
      $('printArea').innerHTML = printHtml(L, receipts);
      btn.disabled = false; btn.textContent = '⬇ Download claim form (PDF)';
      var imgs = $('printArea').querySelectorAll('img'), left = imgs.length;
      var fire = function () { setTimeout(function () { window.print(); }, 150); };
      if (!left) fire(); else Array.prototype.forEach.call(imgs, function (im) { if (im.complete) { if (!--left) fire(); } else im.onload = im.onerror = function () { if (!--left) fire(); }; });
    }
    if (L.kind !== 'e') { go(); return; }
    btn.disabled = true;
    var chain = Promise.resolve();
    L.data.rows.forEach(function (x, i) {
      chain = chain.then(function () {
        btn.textContent = 'Loading receipts ' + (i + 1) + ' of ' + L.data.rows.length + '…';
        if (!x.file) return;
        return apiGet({ api: 'receipt', employee: ME.employee, file: x.file, code: ME.code }).then(function (rc) { receipts[i] = rc; }, function (e) { if (e.net) throw e; });
      });
    });
    chain.then(go).catch(function (e) { btn.disabled = false; btn.textContent = '⬇ Download claim form (PDF)'; toast(e.net ? 'You are offline. Connect to download the receipts.' : e.message); });
  };
  window.addEventListener('afterprint', function () { $('printArea').innerHTML = ''; });

  /* ---------- me ---------- */
  function renderMe() {
    $('meName').textContent = ME ? ME.employee : '';
    $('meCo').textContent = 'Company: ' + CO.full;
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
  var saved = get('agsb.app.company', null);
  if (!saved && get('agsb.app.me', null)) saved = 'agsb';   // phones set up before companies were added
  var first = COMPANIES.filter(function (c) { return c.id === saved; })[0];
  if (first) setCompany(first);
  start();
})();
