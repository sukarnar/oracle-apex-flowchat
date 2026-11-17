/*!
 * <flow-chat> conversational form widget.
 *
 * Framework-agnostic Web Component. Talks the FlowChat turn protocol to an engine
 * (Oracle/ORDS, an APEX AJAX callback, or the in-browser reference engine) and mirrors
 * captured values into the host page through an adapter (APEX items, DOM selectors, custom).
 *
 *   <flow-chat flow="loan_application" transport="apex" adapter="apex"></flow-chat>
 *
 * Attributes
 *   flow          flow id (required)
 *   transport     apex | rest | local            (default rest; "local" requires configure())
 *   ajax-identifier  with transport apex: call the FlowChat Chat region plugin's AJAX callback
 *                 (set by the plugin) instead of the FC_START / FC_INPUT processes
 *   endpoint      base URL for rest transport     (e.g. /ords/myws/flowchat)
 *   adapter       apex | dom | none              (default: apex if window.apex exists, else dom)
 *   form          CSS selector scoping the dom adapter (default document)
 *   context       "slot:ref,slot:ref" values read from the page at start (ref = item name or selector)
 *   heading / subheading   header text
 *   on-complete   none | submit-page | reload    (submit-page = apex.page.submit or form.submit())
 *   submit-request APEX request value used by on-complete="submit-page" (default FC_COMPLETE)
 *   manual-start  don't start automatically; call el.start()
 *   theme         light | dark | auto            (default auto)
 *   version       pin a published version of the flow (default: the latest published version)
 *   resume        session | local   keep the conversation across page reloads (sessionStorage is
 *                 cleared when the tab closes; local keeps it until the conversation ends or expires)
 *
 * File answers (input kind "file") are read in the browser and sent base64-encoded; the APEX
 * transport sends large inputs in p_clob_01, so they aren't limited by the 32K item size.
 *
 * Events (bubble, composed): fc-turn, fc-field, fc-complete, fc-error
 */
(function () {
  'use strict';
  if (window.customElements && customElements.get('flow-chat')) return;

  // ------------------------------------------------------------------ transports
  function checkTurn(t) {
    if (typeof t === 'string') { try { t = JSON.parse(t); } catch (e) { throw new Error('Invalid JSON from server'); } }
    if (!t) throw new Error('Empty response from server');
    if (t.error) throw new Error(t.error);
    return t;
  }

  function RestTransport(endpoint, headers) {
    this.endpoint = String(endpoint || '').replace(/\/$/, '');
    this.headers = headers || {};
  }
  RestTransport.prototype._post = function (path, body) {
    return fetch(this.endpoint + path, {
      method: 'POST', credentials: 'include',
      headers: Object.assign({ 'Content-Type': 'application/json' }, this.headers),
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.text().then(function (txt) {
        var j = null; try { j = JSON.parse(txt); } catch (e) { /* not json */ }
        if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
        return checkTurn(j);
      });
    });
  };
  RestTransport.prototype.start = function (flowId, context, version) {
    var body = { flowId: flowId, context: context };
    if (version) body.version = Number(version);
    return this._post('/sessions', body);
  };
  RestTransport.prototype.input = function (sid, payload) { return this._post('/sessions/' + encodeURIComponent(sid) + '/input', payload); };

  // With ajaxId (the region plugin) both calls go to the plugin's AJAX callback, x04 = start | input.
  function ApexTransport(startProcess, inputProcess, ajaxId) {
    this.startProcess = startProcess || 'FC_START';
    this.inputProcess = inputProcess || 'FC_INPUT';
    this.ajaxId = ajaxId || null;
  }
  // x02 is limited to 32K, so a large JSON (a file answer) goes in p_clob_01 instead.
  ApexTransport.prototype._call = function (proc, x01, json, x03) {
    if (!window.apex || !apex.server) return Promise.reject(new Error('APEX JavaScript API not found on this page'));
    var data = { x01: x01 };
    if (json.length > 8000) data.p_clob_01 = json; else data.x02 = json;
    if (x03) data.x03 = String(x03);
    var self = this;
    return new Promise(function (resolve, reject) {
      var req;
      if (self.ajaxId) {
        data.x04 = proc === self.startProcess ? 'start' : 'input';
        req = apex.server.plugin(self.ajaxId, data, { dataType: 'text' });
      } else req = apex.server.process(proc, data, { dataType: 'text' });
      req.done(function (d) { try { resolve(checkTurn(d)); } catch (e) { reject(e); } })
        .fail(function (xhr, status, err) { reject(new Error(err || status || 'AJAX error')); });
    });
  };
  ApexTransport.prototype.start = function (flowId, context, version) { return this._call(this.startProcess, flowId, JSON.stringify(context || {}), version); };
  ApexTransport.prototype.input = function (sid, payload) { return this._call(this.inputProcess, sid, JSON.stringify(payload || {})); };

  function LocalTransport(engine) { this.engine = engine; }
  LocalTransport.prototype.start = function (flowId, context, version) {
    return this.engine.start(flowId, context, version ? { version: Number(version) } : undefined).then(checkTurn);
  };
  LocalTransport.prototype.input = function (sid, payload) { return this.engine.input(sid, payload).then(checkTurn); };

  // ------------------------------------------------------------------ adapters
  // The text a page field gets: plain values as they are; lists and files show their display text.
  function fieldText(u) {
    if (u.value === null || u.value === undefined) return '';
    if (typeof u.value === 'object') return u.display || '';
    return String(u.value);
  }
  var hostCssInjected = false;
  function injectHostCss() {
    if (hostCssInjected) return; hostCssInjected = true;
    var s = document.createElement('style');
    s.id = 'flowchat-host-css';
    s.textContent =
      '@keyframes fc-flash{0%{box-shadow:0 0 0 3px rgba(37,99,235,.55);background-color:rgba(37,99,235,.10)}' +
      '100%{box-shadow:0 0 0 0 rgba(37,99,235,0)}}.fc-flash{animation:fc-flash 1.6s ease-out}';
    document.head.appendChild(s);
  }
  function flash(el) {
    if (!el) return;
    injectHostCss();
    el.classList.remove('fc-flash'); void el.offsetWidth; el.classList.add('fc-flash');
    setTimeout(function () { el.classList.remove('fc-flash'); }, 1700);
  }

  function parseContextAttr(attr) {
    var out = [];
    String(attr || '').split(',').forEach(function (pair) {
      var p = pair.trim(); if (!p) return;
      var i = p.indexOf(':');
      out.push(i > 0 ? { slot: p.slice(0, i).trim(), ref: p.slice(i + 1).trim() } : { slot: p, ref: p });
    });
    return out;
  }

  function NoneAdapter() {}
  NoneAdapter.prototype.apply = function () {};
  NoneAdapter.prototype.readContext = function () { return {}; };

  function DomAdapter(root) { this.root = root || document; }
  DomAdapter.prototype.apply = function (u) {
    var sel = u.binding && u.binding.dom;
    if (!sel) return;
    var v = fieldText(u);
    this.root.querySelectorAll(sel).forEach(function (el) {
      if (el.type === 'file') return;   // a file input can't be set from script
      if (el.type === 'checkbox') el.checked = v === 'Y' || v === 'true';
      else if (el.type === 'radio') el.checked = el.value === v;
      else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (v !== '') flash(el);
    });
  };
  DomAdapter.prototype.readContext = function (pairs) {
    var root = this.root, ctx = {};
    pairs.forEach(function (p) {
      var el = root.querySelector(p.ref);
      if (el) ctx[p.slot] = el.type === 'checkbox' ? (el.checked ? 'Y' : 'N') : el.value;
    });
    return ctx;
  };

  function ApexAdapter() {}
  ApexAdapter.prototype.apply = function (u) {
    var name = u.binding && u.binding.apex;
    if (!name || !window.apex) return;
    var item = apex.item(name);
    if (!item || !item.node) return;
    var v = fieldText(u);
    // Display value is passed for popup LOVs; date items should use format mask YYYY-MM-DD.
    item.setValue(v, u.display || v);
    if (v !== '') flash(document.getElementById(name + '_CONTAINER') || item.node);
  };
  ApexAdapter.prototype.readContext = function (pairs) {
    var ctx = {};
    if (!window.apex) return ctx;
    pairs.forEach(function (p) { var it = apex.item(p.ref); if (it && it.node) ctx[p.slot] = it.getValue(); });
    return ctx;
  };

  // ------------------------------------------------------------------ styles
  var CSS = [
    ':host{--fc-accent:var(--ut-palette-primary,#2563eb);--fc-accent-text:var(--ut-palette-primary-contrast,#fff);',
    '--fc-bg:#fff;--fc-surface:#f3f5f9;--fc-text:#18202c;--fc-muted:#64708a;--fc-border:#e2e6ee;',
    '--fc-error:#b42318;--fc-error-bg:#fdecea;--fc-success:#067647;--fc-success-bg:#e7f6ee;',
    '--fc-radius:14px;--fc-height:560px;display:block;font:inherit;color:var(--fc-text)}',
    ':host([theme=dark]){--fc-bg:#161b24;--fc-surface:#222a37;--fc-text:#e8ecf3;--fc-muted:#97a1b6;--fc-border:#2e3747;',
    '--fc-error:#ff8a80;--fc-error-bg:#3a1f1f;--fc-success:#6ee7a8;--fc-success-bg:#163126}',
    '@media (prefers-color-scheme:dark){:host(:not([theme=light]):not([theme=dark])){--fc-bg:#161b24;--fc-surface:#222a37;',
    '--fc-text:#e8ecf3;--fc-muted:#97a1b6;--fc-border:#2e3747;--fc-error:#ff8a80;--fc-error-bg:#3a1f1f;--fc-success:#6ee7a8;--fc-success-bg:#163126}}',
    '*{box-sizing:border-box}',
    '.fc{display:flex;flex-direction:column;height:var(--fc-height);background:var(--fc-bg);border:1px solid var(--fc-border);',
    'border-radius:var(--fc-radius);overflow:hidden;box-shadow:0 8px 30px rgba(20,30,50,.08)}',
    'header{padding:14px 16px 12px;border-bottom:1px solid var(--fc-border);display:flex;align-items:center;gap:12px;position:relative}',
    '.avatar{width:34px;height:34px;border-radius:50%;background:var(--fc-accent);color:var(--fc-accent-text);display:grid;place-items:center;flex:none}',
    '.avatar svg{width:18px;height:18px}',
    '.titles{flex:1;min-width:0}.title{font-weight:600;font-size:15px}.sub{font-size:12px;color:var(--fc-muted)}',
    '.restart{background:none;border:1px solid var(--fc-border);color:var(--fc-muted);border-radius:8px;padding:5px 9px;font:inherit;font-size:12px;cursor:pointer}',
    '.restart:hover{color:var(--fc-text)}',
    '.progress{position:absolute;left:0;right:0;bottom:-1px;height:3px;background:transparent}',
    '.progress span{display:block;height:100%;width:0;background:var(--fc-accent);transition:width .4s ease}',
    '.log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}',
    '.msg{display:flex;max-width:85%;animation:fc-in .22s ease-out}',
    '@keyframes fc-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.msg.user{align-self:flex-end}',
    '.bubble{padding:9px 13px;border-radius:16px;font-size:14px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.bot .bubble{background:var(--fc-surface);border-bottom-left-radius:5px}',
    '.user .bubble{background:var(--fc-accent);color:var(--fc-accent-text);border-bottom-right-radius:5px}',
    '.error .bubble{background:var(--fc-error-bg);color:var(--fc-error)}',
    '.success .bubble{background:var(--fc-success-bg);color:var(--fc-success);font-weight:500}',
    '.msg.has-card{width:92%;max-width:92%}',
    '.card{width:100%;background:var(--fc-bg);border:1px solid var(--fc-border);border-radius:14px;padding:12px 14px;font-size:14px}',
    '.card-title{margin-bottom:8px;color:var(--fc-muted);font-size:13px}',
    '.row{display:grid;grid-template-columns:minmax(90px,40%) 1fr auto;gap:8px;align-items:baseline;padding:6px 0;border-top:1px dashed var(--fc-border)}',
    '.row:first-of-type{border-top:0}.row dt{color:var(--fc-muted);font-size:12.5px}.row dd{margin:0;font-weight:500;overflow-wrap:anywhere}',
    '.edit{background:none;border:0;color:var(--fc-accent);font:inherit;font-size:12.5px;cursor:pointer;padding:0 2px}',
    '.edit:disabled{color:var(--fc-muted);opacity:.5;cursor:default}',
    '.typing .bubble{display:flex;gap:4px;padding:12px 14px}',
    '.typing i{width:6px;height:6px;border-radius:50%;background:var(--fc-muted);animation:fc-dot 1s infinite ease-in-out}',
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}',
    '@keyframes fc-dot{0%,80%,100%{opacity:.3;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}',
    '.composer{border-top:1px solid var(--fc-border);padding:12px;display:flex;flex-direction:column;gap:8px}',
    '.composer:empty{display:none}',
    'form{display:flex;gap:8px}',
    'input{flex:1;min-width:0;font:inherit;font-size:14px;padding:10px 12px;border:1px solid var(--fc-border);border-radius:10px;',
    'background:var(--fc-bg);color:var(--fc-text);outline:none}',
    'input:focus{border-color:var(--fc-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--fc-accent) 20%,transparent)}',
    '.btn{font:inherit;font-size:14px;border-radius:10px;padding:9px 14px;cursor:pointer;border:1px solid var(--fc-border);background:var(--fc-bg);color:var(--fc-text)}',
    '.btn.primary{background:var(--fc-accent);border-color:var(--fc-accent);color:var(--fc-accent-text);font-weight:500}',
    '.btn:disabled{opacity:.55;cursor:default}',
    '.send{width:42px;padding:0;display:grid;place-items:center}.send svg{width:18px;height:18px}',
    '.chips{display:flex;flex-wrap:wrap;gap:8px}',
    '.chip{font:inherit;font-size:13.5px;padding:8px 13px;border-radius:999px;border:1px solid var(--fc-accent);background:transparent;color:var(--fc-accent);cursor:pointer}',
    '.chip:hover{background:var(--fc-accent);color:var(--fc-accent-text)}',
    '.tools{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}',
    '.link{background:none;border:0;padding:0;color:var(--fc-muted);font:inherit;cursor:pointer}.link:hover{color:var(--fc-text)}',
    '.hint{color:var(--fc-muted)}',
    '.busy .composer{opacity:.6;pointer-events:none}',
    '.row.ro{grid-template-columns:minmax(90px,40%) 1fr}',
    's.before{color:var(--fc-muted)}.arrow{color:var(--fc-muted)}',
    '.picks{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto}',
    '.pick{display:flex;flex-direction:column;align-items:flex-start;gap:2px;text-align:left;font:inherit;padding:9px 12px;',
    'border:1px solid var(--fc-border);border-radius:10px;background:var(--fc-bg);color:var(--fc-text);cursor:pointer}',
    '.pick:hover,.pick:focus-visible{border-color:var(--fc-accent);outline:none}',
    '.pick-title{font-weight:600;font-size:14px}.pick-sub{font-size:12.5px;color:var(--fc-muted)}',
    '.chip.changed{background:color-mix(in srgb,var(--fc-accent) 12%,transparent)}',
    '.chip:disabled{border-color:var(--fc-border);color:var(--fc-muted);cursor:not-allowed;background:transparent}',
    '.optlist{display:flex;flex-direction:column;max-height:200px;overflow-y:auto;border:1px solid var(--fc-border);border-radius:10px;margin-bottom:8px}',
    '.opt{font:inherit;font-size:14px;text-align:left;padding:8px 12px;border:0;border-bottom:1px solid var(--fc-border);background:var(--fc-bg);color:var(--fc-text);cursor:pointer}',
    '.opt:last-child{border-bottom:0}.opt:hover,.opt:focus-visible,.opt.cur{background:color-mix(in srgb,var(--fc-accent) 12%,var(--fc-bg));outline:none}',
    '.opt.cur{font-weight:600}.optnone{padding:8px 12px;font-size:13px;color:var(--fc-muted)}',
    '.items{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto}',
    '.item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 10px;border:1px solid var(--fc-border);border-radius:10px;font-size:13.5px}',
    '.item span{overflow-wrap:anywhere}.li{padding:5px 0;border-top:1px dashed var(--fc-border)}.li:first-of-type{border-top:0}',
    '.li small{display:block;color:var(--fc-muted);font-size:12px}',
    '.btns{display:flex;gap:8px;flex-wrap:wrap}',
    '.btn.danger{background:var(--fc-error);border-color:var(--fc-error);color:#fff;font-weight:500}',
    '.drop{display:flex;align-items:center;gap:10px;border:1.5px dashed var(--fc-border);border-radius:10px;padding:10px 12px;font-size:13.5px}',
    '.drop.over{border-color:var(--fc-accent);background:color-mix(in srgb,var(--fc-accent) 8%,transparent)}',
    '.drop .name{flex:1;min-width:0;color:var(--fc-muted);overflow-wrap:anywhere}',
    '.restored{opacity:.75}',
    '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}'
  ].join('');

  var ICON_BOT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function kb(n) { return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (Math.round(n / 104857.6) / 10) + ' MB'; }
  function acceptOk(accept, file) {
    var list = (Array.isArray(accept) ? accept : String(accept || '').split(',')).map(function (x) { return String(x).trim().toLowerCase(); }).filter(Boolean);
    if (!list.length) return true;
    var ext = (file.name.toLowerCase().match(/\.[^.]+$/) || [''])[0], type = String(file.type || '').toLowerCase();
    return list.some(function (a) { return a[0] === '.' ? a === ext : /\/\*$/.test(a) ? type.indexOf(a.slice(0, -1)) === 0 : a === type; });
  }
  function readBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).replace(/^data:[^,]*,/, '')); };
      r.onerror = function () { reject(new Error('The file could not be read.')); };
      r.readAsDataURL(file);
    });
  }
  function storageOf(mode) {
    try { return mode === 'local' ? window.localStorage : mode === 'session' ? window.sessionStorage : null; } catch (e) { return null; }
  }
  function isoLocal(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function resolveDate(s) {
    var d = new Date();
    if (s === 'today') return isoLocal(d);
    if (s === 'tomorrow') { d.setDate(d.getDate() + 1); return isoLocal(d); }
    return s || '';
  }

  // ------------------------------------------------------------------ element
  class FlowChatElement extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: 'open' });
      this._opts = {};
      this._sid = null;
      this._turn = null;
      this._busy = false;
    }

    connectedCallback() {
      if (this._mounted) return;
      this._mounted = true;
      this._build();
      if (!this.hasAttribute('manual-start')) setTimeout(() => this.start(), 0);
    }

    /** Programmatic configuration: { transport, adapter, context } */
    configure(opts) { Object.assign(this._opts, opts || {}); this._transportObj = null; this._adapterObj = null; return this; }

    get sessionId() { return this._sid; }

    _transport() {
      if (this._opts.transport) return this._opts.transport;
      if (this._transportObj) return this._transportObj;
      var t = (this.getAttribute('transport') || 'rest').toLowerCase();
      if (t === 'apex') this._transportObj = new ApexTransport(this.getAttribute('start-process'), this.getAttribute('input-process'),
                                                         this.getAttribute('ajax-identifier'));
      else if (t === 'rest') this._transportObj = new RestTransport(this.getAttribute('endpoint') || '/flowchat');
      else throw new Error('transport="' + t + '" needs el.configure({ transport })');
      return this._transportObj;
    }

    _adapter() {
      if (this._opts.adapter) return this._opts.adapter;
      if (this._adapterObj) return this._adapterObj;
      var a = (this.getAttribute('adapter') || (window.apex && apex.item ? 'apex' : 'dom')).toLowerCase();
      if (a === 'apex') this._adapterObj = new ApexAdapter();
      else if (a === 'none') this._adapterObj = new NoneAdapter();
      else {
        var sel = this.getAttribute('form');
        this._adapterObj = new DomAdapter(sel ? document.querySelector(sel) : document);
      }
      return this._adapterObj;
    }

    _build() {
      var style = h('style'); style.textContent = CSS;
      var wrap = h('div', 'fc');
      var header = h('header');
      var avatar = h('div', 'avatar'); avatar.innerHTML = ICON_BOT;
      var titles = h('div', 'titles');
      titles.append(h('div', 'title', this.getAttribute('heading') || 'Assistant'),
                    h('div', 'sub', this.getAttribute('subheading') || "I'll fill in the form with you"));
      var restart = h('button', 'restart', 'Start over');
      restart.type = 'button';
      restart.addEventListener('click', () => (this._sid && this._turn && this._turn.status === 'in_progress')
        ? this.send({ command: 'restart' }, 'Start over') : this.start(true));
      var prog = h('div', 'progress'); this._bar = h('span'); prog.append(this._bar);
      header.append(avatar, titles, restart, prog);
      this._log = h('div', 'log'); this._log.setAttribute('role', 'log'); this._log.setAttribute('aria-live', 'polite');
      this._composer = h('div', 'composer');
      wrap.append(header, this._log, this._composer);
      this._wrap = wrap;
      this._shadow.append(style, wrap);
    }

    /** Starts the conversation. With resume on, picks up a saved one first unless fresh is true. */
    async start(fresh) {
      this._log.textContent = '';
      this._composer.textContent = '';
      this._sid = null; this._turn = null; this._transcript = [];
      var flow = this.getAttribute('flow');
      if (fresh) this._forget();
      else if (await this._resume()) return;
      var ctx = Object.assign({}, this._adapter().readContext(parseContextAttr(this.getAttribute('context'))), this._opts.context);
      await this._exchange(() => this._transport().start(flow, ctx, this.getAttribute('version')));
    }

    // ---- resume after a reload: the transcript is kept in the browser, the state on the server
    _store() { return storageOf((this.getAttribute('resume') || '').toLowerCase()); }
    _storeKey() {
      return 'flowchat:' + (this.id || '') + ':' + this.getAttribute('flow') + ':' + (this.getAttribute('version') || '') + ':' + location.pathname;
    }
    _forget() { var s = this._store(); if (s) try { s.removeItem(this._storeKey()); } catch (e) { /* storage blocked */ } }
    _remember() {
      var s = this._store();
      if (!s || !this._sid) return;
      try { s.setItem(this._storeKey(), JSON.stringify({ sid: this._sid, at: Date.now(), transcript: this._transcript.slice(-120) })); }
      catch (e) { /* full or blocked: resume just won't happen */ }
    }
    async _resume() {
      var s = this._store(), saved = null;
      if (!s) return false;
      try { saved = JSON.parse(s.getItem(this._storeKey()) || 'null'); } catch (e) { saved = null; }
      if (!saved || !saved.sid || Date.now() - (saved.at || 0) > 864e5) { this._forget(); return false; }
      this._setBusy(true);
      var turn;
      try {
        turn = await this._transport().input(saved.sid, { command: 'resume' });
      } catch (e) {
        this._setBusy(false); this._forget(); return false;   // expired or another session: start fresh
      }
      this._setBusy(false);
      if (!turn || turn.status !== 'in_progress') { this._forget(); return false; }
      this._restoring = true;
      (saved.transcript || []).forEach((x) => { if (x.u !== undefined) this._addUser(x.u); else this._addBot(x.b); });
      this._restoring = false;
      this._log.querySelectorAll('.msg').forEach(function (m) { m.classList.add('restored'); });
      this._disableOldCards();
      this._transcript = (saved.transcript || []).slice();
      await this._applyTurn(turn);
      return true;
    }

    /** Send raw protocol input, e.g. {value:'x'} or {command:'back'}. echo = text shown as the user's bubble. */
    async send(payload, echo) {
      if (this._busy || !this._sid) return;
      this._disableOldCards();
      if (echo) this._addUser(echo);
      await this._exchange(() => this._transport().input(this._sid, payload));
    }

    async _exchange(fn) {
      this._setBusy(true);
      try {
        var turn = await fn();
        this._setBusy(false);
        await this._applyTurn(turn);
      } catch (e) {
        this._setBusy(false);
        console.error('[flow-chat]', e);
        this._addBot({ type: 'error', text: 'Something went wrong: ' + e.message });
        this._emit('fc-error', { error: e });
        if (this._turn) this._renderComposer(this._turn);
        else this._renderRetry();
      }
    }

    async _applyTurn(turn) {
      this._sid = turn.sessionId;
      this._turn = turn;
      var adapter = this._adapter();
      (turn.fieldUpdates || []).forEach((u) => {
        try { adapter.apply(u); } catch (e) { console.warn('[flow-chat] adapter', e); }
        this._emit('fc-field', u);
      });
      this._composer.textContent = '';
      var msgs = turn.messages || [];
      for (var i = 0; i < msgs.length; i++) {
        if (i > 0) await delay(220);
        this._addBot(msgs[i]);
      }
      this._setProgress(turn);
      this._renderComposer(turn);
      if (turn.status === 'in_progress') this._remember(); else this._forget();
      this._emit('fc-turn', turn);
      if (turn.status === 'completed') {
        this._emit('fc-complete', turn);
        this._onComplete();
      }
    }

    _onComplete() {
      var mode = (this.getAttribute('on-complete') || 'none').toLowerCase();
      if (mode === 'reload') setTimeout(() => location.reload(), 1500);
      if (mode === 'submit-page') {
        setTimeout(() => {
          if (window.apex && apex.page) apex.page.submit({ request: this.getAttribute('submit-request') || 'FC_COMPLETE', showWait: true });
          else { var f = this.getAttribute('form') && document.querySelector(this.getAttribute('form')); if (f && f.requestSubmit) f.requestSubmit(); }
        }, 1200);
      }
    }

    _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true, composed: true })); }

    _setBusy(b) {
      this._busy = b;
      this._wrap.classList.toggle('busy', b);
      if (b) {
        if (!this._typing) {
          this._typing = h('div', 'msg bot typing');
          var bub = h('div', 'bubble'); bub.append(h('i'), h('i'), h('i'));
          this._typing.append(bub);
        }
        this._log.append(this._typing); this._scroll();
      } else if (this._typing && this._typing.parentNode) {
        this._typing.remove();
      }
    }

    _setProgress(turn) {
      var p = turn.progress || { done: 0, total: 0 };
      var pct = turn.status === 'completed' ? 100 : (p.total ? Math.round((p.done / p.total) * 100) : 0);
      this._bar.style.width = pct + '%';
    }

    _scroll() { var l = this._log; requestAnimationFrame(function () { l.scrollTop = l.scrollHeight; }); }

    _addUser(text) {
      if (!this._restoring && this._transcript) this._transcript.push({ u: text });
      var m = h('div', 'msg user'); m.append(h('div', 'bubble', text));
      this._log.append(m); this._scroll();
    }

    _addBot(msg) {
      if (!this._restoring && this._transcript && !/^Something went wrong/.test(msg.text || '')) this._transcript.push({ b: msg });
      var m = h('div', 'msg bot' + (msg.type === 'error' ? ' error' : msg.type === 'success' ? ' success' : ''));
      if (msg.type === 'list') {
        // Line items so far, or the records a bulk update will change (read-only).
        var lc = h('div', 'card');
        lc.append(h('div', 'card-title', msg.text));
        (msg.items || []).forEach(function (it) {
          var li = h('div', 'li', it.title);
          if (it.subtitle) li.append(h('small', null, it.subtitle));
          lc.append(li);
        });
        m.classList.add('has-card');
        m.append(lc);
      } else if (msg.type === 'summary' || msg.type === 'record' || msg.type === 'changes') {
        // summary: answers with Edit · record: read-only current values · changes: old → new with Edit
        var card = h('div', 'card ' + (msg.type === 'record' ? 'record' : 'summary'));
        card.append(h('div', 'card-title', msg.text));
        var dl = h('dl'); dl.style.margin = '0';
        (msg.items || []).forEach((it) => {
          var row = h('div', 'row' + (msg.type === 'record' ? ' ro' : ''));
          var dd = h('dd');
          if (msg.type === 'changes') {
            dd.append(h('s', 'before', it.before || '(empty)'), h('span', 'arrow', ' → '), h('span', null, it.after || '(empty)'));
          } else {
            dd.textContent = it.display || '—';
          }
          row.append(h('dt', null, it.label), dd);
          if (msg.type !== 'record') {
            var b = h('button', 'edit', 'Edit'); b.type = 'button';
            b.setAttribute('aria-label', 'Edit ' + it.label);
            if (!it.editable) b.style.visibility = 'hidden';
            b.addEventListener('click', () => this.send({ command: 'edit', slot: it.slot }, 'Change ' + it.label.toLowerCase()));
            row.append(b);
          }
          dl.append(row);
        });
        card.append(dl);
        m.classList.add('has-card');
        m.append(card);
      } else {
        m.append(h('div', 'bubble', msg.text));
      }
      this._log.append(m); this._scroll();
    }

    _disableOldCards() { this._log.querySelectorAll('.card .edit').forEach(function (b) { b.disabled = true; }); }

    _renderRetry() {
      var c = this._composer; c.textContent = '';
      var b = h('button', 'btn primary', 'Try again'); b.type = 'button';
      b.addEventListener('click', () => this.start());
      c.append(b);
    }

    _renderOptionList(c, a, spec) {
      var opts = spec.options || [];
      var box = h('div', 'optlist'); box.setAttribute('role', 'listbox');
      box.setAttribute('aria-label', a.label || a.slot);
      var form = h('form');
      var inp = h('input'); inp.type = 'text'; inp.autocomplete = 'off';
      inp.setAttribute('aria-label', 'Search ' + (a.label || a.slot));
      inp.placeholder = spec.placeholder || 'Type to search ' + opts.length + ' options...';
      var shown = [];
      var pick = (o) => this.send({ value: o.value }, o.label || o.value);
      var draw = () => {
        var t = inp.value.trim().toLowerCase();
        box.textContent = '';
        shown = opts.filter((o) => !t || String(o.label || o.value).toLowerCase().indexOf(t) >= 0 || String(o.value).toLowerCase() === t);
        shown.slice(0, 200).forEach((o) => {
          var b = h('button', 'opt' + (a.value !== null && a.value !== undefined && String(a.value) === String(o.value) ? ' cur' : ''), o.label || o.value);
          b.type = 'button'; b.setAttribute('role', 'option');
          b.addEventListener('click', () => pick(o));
          box.append(b);
        });
        if (!shown.length) box.append(h('div', 'optnone', opts.length ? 'No match. Try fewer letters.' : 'Nothing to choose from.'));
        else if (shown.length > 200) box.append(h('div', 'optnone', (shown.length - 200) + ' more: keep typing to narrow it down.'));
      };
      inp.addEventListener('input', draw);
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' && box.firstChild && box.firstChild.focus) { e.preventDefault(); box.firstChild.focus(); }
      });
      box.addEventListener('keydown', (e) => {
        var el = e.target;
        if (e.key === 'ArrowDown' && el.nextSibling && el.nextSibling.focus) { e.preventDefault(); el.nextSibling.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (el.previousSibling && el.previousSibling.focus ? el.previousSibling : inp).focus(); }
      });
      var send = h('button', 'btn primary send'); send.type = 'submit'; send.innerHTML = ICON_SEND;
      send.setAttribute('aria-label', 'Send');
      form.append(inp, send);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        // Enter picks the only (or an exact) match; otherwise the server explains what it expects.
        var t = inp.value.trim().toLowerCase();
        var exact = shown.find((o) => String(o.label || o.value).toLowerCase() === t || String(o.value).toLowerCase() === t);
        if (exact || shown.length === 1) pick(exact || shown[0]);
        else if (t) this.send({ value: inp.value.trim() }, inp.value.trim());
        else inp.focus();
      });
      draw();
      c.append(box, form);
      return inp;
    }

    // File answer: pick or drop one file; type and size are checked here and again on the server.
    _renderFile(c, a, spec) {
      var maxKb = Math.min(Number(spec.maxSizeKb) || 5120, 20480);
      var drop = h('label', 'drop');
      var inp = h('input'); inp.type = 'file'; inp.hidden = true;
      if (spec.accept) inp.accept = Array.isArray(spec.accept) ? spec.accept.join(',') : String(spec.accept);
      var pick = h('span', 'btn', spec.buttonLabel || 'Choose file');
      var name = h('span', 'name', spec.placeholder || 'or drop it here (up to ' + kb(maxKb * 1024) + ')');
      drop.append(inp, pick, name);
      drop.tabIndex = 0;
      drop.setAttribute('aria-label', (a.label || 'File') + ': choose a file');
      drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
      var take = async (file) => {
        if (!file) return;
        if (!acceptOk(spec.accept, file)) { name.textContent = 'That type of file is not accepted here.'; return; }
        if (file.size > maxKb * 1024) { name.textContent = 'That file is too big (limit ' + kb(maxKb * 1024) + ').'; return; }
        if (!file.size) { name.textContent = 'That file is empty.'; return; }
        name.textContent = 'Reading ' + file.name + '…';
        try {
          var data = await readBase64(file);
          this.send({ file: { name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, data: data } },
                    '📎 ' + file.name + ' (' + kb(file.size) + ')');
        } catch (e) { name.textContent = e.message; }
      };
      inp.addEventListener('change', () => take(inp.files && inp.files[0]));
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer && e.dataTransfer.files[0]); });
      c.append(drop);
      return drop;
    }

    _renderComposer(turn) {
      var c = this._composer; c.textContent = '';
      if (turn.status !== 'in_progress' || !turn['await']) {
        var again = h('button', 'btn', this.getAttribute('restart-label') || 'Start again'); again.type = 'button';
        again.addEventListener('click', () => this.start(true));
        c.append(again);
        return;
      }
      var a = turn['await'], spec = a.input || {}, focusEl = null;

      if (a.type === 'summary') {
        var ok = h('button', 'btn primary', a.confirmLabel || 'Confirm'); ok.type = 'button';
        ok.addEventListener('click', () => this.send({ value: 'confirm' }, a.confirmLabel || 'Confirm'));
        c.append(ok); focusEl = ok;
      } else if (a.type === 'pick') {
        // Search results: one card per record; only opaque tokens go back to the server.
        var list = h('div', 'picks');
        (a.items || []).forEach((it) => {
          var b = h('button', 'pick'); b.type = 'button';
          b.append(h('span', 'pick-title', it.title), it.subtitle ? h('span', 'pick-sub', it.subtitle) : '');
          b.addEventListener('click', () => this.send({ pick: it.token }, it.title));
          list.append(b);
          if (!focusEl) focusEl = b;
        });
        c.append(list);
      } else if (a.type === 'fieldMenu') {
        var fchips = h('div', 'chips');
        (a.fields || []).forEach((f) => {
          var b = h('button', 'chip' + (f.changed ? ' changed' : ''), (f.changed ? '✓ ' : '') + f.label); b.type = 'button';
          b.title = f.editable ? 'Currently: ' + (f.display || 'empty') : (f.reason || 'Not editable');
          if (!f.editable) b.disabled = true;
          b.addEventListener('click', () => this.send({ field: f.field }, 'Change ' + f.label.toLowerCase()));
          fchips.append(b);
          if (!focusEl && f.editable) focusEl = b;
        });
        var done = h('button', 'btn primary', a.doneLabel || 'Done'); done.type = 'button';
        done.addEventListener('click', () => this.send({ command: 'done' }, a.doneLabel || 'Done'));
        c.append(fchips, done);
      } else if (a.type === 'listMenu') {
        // Repeat step: the items so far (each removable), Add and Done.
        if ((a.items || []).length) {
          var items = h('div', 'items');
          a.items.forEach((it) => {
            var row = h('div', 'item'); row.append(h('span', null, it.title));
            var rm = h('button', 'edit', a.removeLabel || 'Remove'); rm.type = 'button';
            rm.setAttribute('aria-label', (a.removeLabel || 'Remove') + ' ' + it.title);
            rm.addEventListener('click', () => this.send({ command: 'remove', index: it.index }, (a.removeLabel || 'Remove') + ' ' + it.title));
            row.append(rm);
            items.append(row);
          });
          c.append(items);
        }
        var btns = h('div', 'btns');
        var add = h('button', 'btn' + (a.canDone ? '' : ' primary'), a.addLabel || 'Add'); add.type = 'button';
        add.disabled = !a.canAdd;
        add.addEventListener('click', () => this.send({ command: 'add' }, a.addLabel || 'Add'));
        var fin = h('button', 'btn' + (a.canDone ? ' primary' : ''), a.doneLabel || 'Done'); fin.type = 'button';
        fin.disabled = !a.canDone;
        fin.addEventListener('click', () => this.send({ command: 'done' }, a.doneLabel || 'Done'));
        btns.append(add, fin);
        c.append(btns);
        focusEl = a.canDone ? fin : add;
      } else if (a.type === 'confirm') {
        // Bulk update: an explicit go-ahead, or cancel.
        var cb = h('div', 'btns');
        var yes = h('button', 'btn ' + (a.danger ? 'danger' : 'primary'), a.confirmLabel || 'Confirm'); yes.type = 'button';
        yes.addEventListener('click', () => this.send({ command: 'confirm' }, a.confirmLabel || 'Confirm'));
        var no = h('button', 'btn', a.cancelLabel || 'Cancel'); no.type = 'button';
        no.addEventListener('click', () => this.send({ command: 'cancel' }, a.cancelLabel || 'Cancel'));
        cb.append(yes, no);
        c.append(cb);
        focusEl = no;
      } else if (spec.kind === 'file') {
        focusEl = this._renderFile(c, a, spec);
      } else if (spec.kind === 'choice' && (spec.display === 'list' || (spec.display !== 'buttons' && (spec.options || []).length > 8))) {
        // Long lists (usually lookup lists from the server): type to filter, then pick.
        focusEl = this._renderOptionList(c, a, spec);
      } else if (spec.kind === 'choice' || spec.kind === 'yesno') {
        var chips = h('div', 'chips');
        var opts = spec.kind === 'yesno' ? [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] : (spec.options || []);
        opts.forEach((o) => {
          var b = h('button', 'chip', o.label || o.value); b.type = 'button';
          b.addEventListener('click', () => this.send({ value: o.value }, o.label || o.value));
          chips.append(b);
          if (!focusEl) focusEl = b;
        });
        c.append(chips);
      } else {
        var form = h('form');
        var inp = h('input');
        inp.name = a.slot;
        inp.setAttribute('aria-label', a.label || a.slot);
        inp.autocomplete = spec.autocomplete || { email: 'email', applicant_name: 'name', phone: 'tel' }[a.slot] || 'off';
        if (spec.kind === 'date') {
          inp.type = 'date';
          if (spec.minDate) inp.min = resolveDate(spec.minDate);
          if (spec.maxDate) inp.max = resolveDate(spec.maxDate);
        } else if (spec.kind === 'email') {
          inp.type = 'email';
        } else {
          inp.type = 'text';
          if (spec.kind === 'number') inp.inputMode = 'decimal';
          if (spec.inputMode) inp.inputMode = spec.inputMode;
          if (spec.maxLength) inp.maxLength = spec.maxLength;
        }
        inp.placeholder = spec.placeholder || 'Type your answer...';
        if (a.value !== null && a.value !== undefined) inp.value = String(a.value);
        var send = h('button', 'btn primary send'); send.type = 'submit'; send.innerHTML = ICON_SEND;
        send.setAttribute('aria-label', 'Send');
        form.append(inp, send);
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          var v = inp.value.trim();
          if (!v && spec.required !== false) { inp.focus(); return; }
          // Secret answers (one-time codes) are not echoed into the transcript.
          this.send({ value: v }, a.secret ? '•'.repeat(v.length) : (v || '(skipped)'));
        });
        c.append(form); focusEl = inp;
      }

      var tools = h('div', 'tools');
      if (a.type === 'ask' && a.sub) {
        // Editing one field of a loaded record: "back" keeps the current value.
        var keep = h('button', 'link', '↩ Keep current'); keep.type = 'button';
        keep.addEventListener('click', () => this.send({ command: 'back' }, 'Keep current'));
        tools.append(keep);
      } else if (turn.canGoBack) {
        var back = h('button', 'link', '↩ Back'); back.type = 'button';
        back.addEventListener('click', () => this.send({ command: 'back' }, 'Go back'));
        tools.append(back);
      } else tools.append(h('span'));
      if (a.type === 'pick' && a.allowNone) {
        var none = h('button', 'link', a.noneLabel || 'None of these'); none.type = 'button';
        none.addEventListener('click', () => this.send({ pick: null }, a.noneLabel || 'None of these'));
        tools.append(none);
      } else if (a.type === 'fieldMenu') {
        tools.append(h('span', 'hint', 'Pick a field to change'));
      } else if (a.actions && a.actions.length) {
        // Extra commands offered by the step, e.g. Verify's "Send a new code".
        var acts = h('span');
        a.actions.forEach((x) => {
          var b = h('button', 'link', x.label || x.command); b.type = 'button';
          b.addEventListener('click', () => this.send({ command: x.command }, x.label || x.command));
          acts.append(b);
        });
        tools.append(acts);
      } else if (spec.required === false && a.type === 'ask') {
        var skip = h('button', 'link', 'Skip'); skip.type = 'button';
        skip.addEventListener('click', () => this.send({ value: '' }, '(skipped)'));
        tools.append(skip);
      } else if (a.type === 'summary') {
        tools.append(h('span', 'hint', 'Review your answers'));
      } else if (turn.progress && turn.progress.total) {
        tools.append(h('span', 'hint', 'Step ' + Math.min(turn.progress.done + 1, turn.progress.total) + ' of ~' + turn.progress.total));
      }
      c.append(tools);
      if (focusEl) setTimeout(function () { focusEl.focus({ preventScroll: true }); }, 30);
    }
  }

  FlowChatElement.RestTransport = RestTransport;
  FlowChatElement.ApexTransport = ApexTransport;
  FlowChatElement.LocalTransport = LocalTransport;
  FlowChatElement.DomAdapter = DomAdapter;
  FlowChatElement.ApexAdapter = ApexAdapter;
  FlowChatElement.NoneAdapter = NoneAdapter;
  window.FlowChat = FlowChatElement;
  customElements.define('flow-chat', FlowChatElement);
})();
