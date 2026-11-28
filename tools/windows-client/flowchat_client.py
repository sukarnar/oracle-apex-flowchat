#!/usr/bin/env python3
"""FlowChat Windows client.

Lists the FlowChat flows registered for the signed-in Windows user and runs them in a console
conversation, through the FC_AUTOMATE REST API (db/23_fc_automate.sql, 24_fc_automate_ords.sql):

    POST <url>/flows  {"user"}                                  -> the flows this person may run
    POST <url>/turn   {"flowId", "user", "sessionId", "reply"}  -> one step of a conversation

<url> is the module's base, e.g. https://host/ords/myschema/flowchat/automate

The person is the Windows sign-in: the UPN (jane.doe@corp.example.com) on a domain or Entra-joined
PC, else DOMAIN\\user. Python 3.8+, standard library only.

    py flowchat_client.py                    window: your flows, Export, Run (same as "gui")
    py flowchat_client.py setup --url URL    save the URL and the API key (asked, not echoed);
                                             --all-users saves it for everyone on the PC (admin)
    py flowchat_client.py whoami             the Windows identity sent to FlowChat
    py flowchat_client.py flows [--json | --csv FILE]
    py flowchat_client.py run [FLOW_ID]      a conversation in this console

Settings come from FLOWCHAT_URL / FLOWCHAT_KEY, else %APPDATA%\\FlowChat\\client.json (this user),
else %PROGRAMDATA%\\FlowChat\\client.json (deployed by IT). On Windows the key is stored encrypted
with DPAPI.
"""
import argparse
import base64
import csv
import ctypes
import datetime
import getpass
import io
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

APP_NAME = 'FlowChat'
VERSION = '1.0'
TIMEOUT = 30
IS_WINDOWS = os.name == 'nt'


# --------------------------------------------------------------------------- identity
def windows_identity():
    """{'upn', 'sam', 'user'}: the sign-in names of the current Windows user. 'user' is the one sent:
    the UPN when the PC is in a domain or Entra ID, else DOMAIN\\user (MACHINE\\user for a local account)."""
    upn = sam = None
    if IS_WINDOWS:
        fn = ctypes.windll.secur32.GetUserNameExW

        def name_ex(fmt):
            size = ctypes.c_ulong(0)
            fn(fmt, None, ctypes.byref(size))
            if not size.value:
                return None
            buf = ctypes.create_unicode_buffer(size.value + 1)
            return buf.value if fn(fmt, buf, ctypes.byref(size)) else None
        upn = name_ex(8)    # NameUserPrincipal: jane.doe@corp.example.com (domain / Entra accounts only)
        sam = name_ex(2)    # NameSamCompatible: CORP\jdoe
    if not sam:
        sam = (os.environ.get('USERDOMAIN', '') + '\\' if IS_WINDOWS else '') + getpass.getuser()
    return {'upn': upn, 'sam': sam, 'user': upn or sam}


def identity_for(settings):
    ident = windows_identity()
    # IT can pin which name is sent so it matches the names mapped in FC_AUTOMATE_USERS.
    if settings.get('identity') == 'sam':
        ident['user'] = ident['sam']
    return ident


# --------------------------------------------------------------------------- settings and the key
class _Blob(ctypes.Structure):
    _fields_ = [('cbData', ctypes.c_ulong), ('pbData', ctypes.POINTER(ctypes.c_char))]


def _dpapi(data, protect, machine=False):
    crypt = ctypes.windll.crypt32
    src = _Blob(len(data), ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(ctypes.c_char)))
    out = _Blob()
    flags = 0x1 | (0x4 if machine else 0)    # CRYPTPROTECT_UI_FORBIDDEN | CRYPTPROTECT_LOCAL_MACHINE
    fn = crypt.CryptProtectData if protect else crypt.CryptUnprotectData
    if not fn(ctypes.byref(src), None, None, None, None, flags, ctypes.byref(out)):
        raise OSError('DPAPI failed (%d)' % ctypes.GetLastError())
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


def protect_key(key, machine=False):
    if IS_WINDOWS:
        return {'key_dpapi': base64.b64encode(_dpapi(key.encode('utf-8'), True, machine)).decode('ascii')}
    return {'key': key}


def unprotect_key(cfg):
    if cfg.get('key_dpapi'):
        return _dpapi(base64.b64decode(cfg['key_dpapi']), False).decode('utf-8')
    return cfg.get('key')


def config_paths():
    paths = []
    if os.environ.get('APPDATA'):
        paths.append(os.path.join(os.environ['APPDATA'], APP_NAME, 'client.json'))
    else:
        paths.append(os.path.join(os.path.expanduser('~'), '.flowchat', 'client.json'))
    if os.environ.get('PROGRAMDATA'):
        paths.append(os.path.join(os.environ['PROGRAMDATA'], APP_NAME, 'client.json'))
    return paths


def load_settings():
    """{'url', 'key', 'identity', 'source'}; later sources only fill what earlier ones left empty."""
    s = {'url': os.environ.get('FLOWCHAT_URL'), 'key': os.environ.get('FLOWCHAT_KEY'),
         'identity': None, 'source': 'environment' if os.environ.get('FLOWCHAT_URL') else None}
    for p in config_paths():
        if not os.path.exists(p):
            continue
        try:
            with open(p, encoding='utf-8') as f:
                cfg = json.load(f)
        except (OSError, ValueError) as e:
            raise SystemExit('Cannot read %s: %s' % (p, e))
        if not s['url'] and cfg.get('url'):
            s['url'], s['source'] = cfg['url'], p
        if not s['key']:
            try:
                s['key'] = unprotect_key(cfg)
            except OSError:
                pass     # encrypted for another user or machine
        s['identity'] = s['identity'] or cfg.get('identity')
    return s


def save_settings(url, key, path=None, machine=False):
    path = path or config_paths()[0]
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cfg = {'url': normalize_url(url)}
    cfg.update(protect_key(key, machine))
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)
    return path


def normalize_url(url):
    url = (url or '').strip().rstrip('/')
    for tail in ('/turn', '/flows'):
        if url.endswith(tail):
            url = url[: -len(tail)]
    return url


# --------------------------------------------------------------------------- API
class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class FlowChatApi:
    def __init__(self, url, key, user):
        if not url or not key:
            raise ApiError(0, 'Not set up yet: run "flowchat_client.py setup --url <URL>" (or set FLOWCHAT_URL and FLOWCHAT_KEY).')
        self.url, self.key, self.user = normalize_url(url), key, user

    def _post(self, path, body):
        req = urllib.request.Request(self.url + '/' + path, data=json.dumps(body).encode('utf-8'), method='POST',
                                     headers={'Content-Type': 'application/json', 'Accept': 'application/json',
                                              'X-FlowChat-Key': self.key,
                                              'User-Agent': 'FlowChat-Windows-Client/' + VERSION})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, _error_text(e)) from None
        except urllib.error.URLError as e:
            raise ApiError(0, 'Cannot reach FlowChat at %s: %s' % (self.url, e.reason)) from None
        except ValueError:
            raise ApiError(0, 'FlowChat did not answer with JSON. Check the URL.') from None

    def list_flows(self):
        return self._post('flows', {'user': self.user})

    def turn(self, flow_id, session_id='', reply=None):
        return self._post('turn', {'flowId': flow_id, 'user': self.user, 'sessionId': session_id or '', 'reply': reply})


def _error_text(e):
    try:
        msg = json.loads(e.read().decode('utf-8')).get('error')
    except Exception:
        msg = None      # ORDS answers 404 with an HTML page
    if e.code == 401:
        return 'The API key was refused. Ask IT for a new key and run setup again.'
    if e.code == 404:
        return ('Nothing at this URL. It should end in /flowchat/automate (check the ORDS schema alias), '
                'and the REST module must be installed and up to date (24_fc_automate_ords.sql).')
    return msg or 'HTTP %d' % e.code


# --------------------------------------------------------------------------- Adaptive Card in a console
def card_lines(items, out=None):
    """The readable part of a card body: TextBlocks and FactSets (inputs are asked separately)."""
    out = [] if out is None else out
    for b in items or []:
        t = b.get('type')
        if t == 'TextBlock' and b.get('text'):
            prefix = '! ' if b.get('color') == 'attention' else ''
            out.append(prefix + str(b['text']))
        elif t == 'FactSet':
            for f in b.get('facts', []):
                out.append('  %s %s' % (f.get('title', ''), f.get('value', '')) if str(f.get('title', '')).endswith('.')
                           else '  %s: %s' % (f.get('title', ''), f.get('value', '')))
        elif t in ('Container', 'Column'):
            card_lines(b.get('items'), out)
        elif t == 'ColumnSet':
            for c in b.get('columns', []):
                card_lines(c.get('items'), out)
    return out


def card_inputs(items, out=None):
    out = [] if out is None else out
    for b in items or []:
        t = b.get('type', '')
        if t.startswith('Input.'):
            out.append(b)
        elif t in ('Container', 'Column'):
            card_inputs(b.get('items'), out)
        elif t == 'ColumnSet':
            for c in b.get('columns', []):
                card_inputs(c.get('items'), out)
    return out


class Quit(Exception):
    pass


class Press(Exception):
    """The person pressed button n while being asked for an input (typed :n)."""
    def __init__(self, n):
        super().__init__(n)
        self.n = n


def _read(ask, prompt, n_actions):
    s = ask(prompt).strip()
    if s.lower() in (':q', 'quit', 'exit'):
        raise Quit()
    if s.startswith(':') and s[1:].isdigit() and 1 <= int(s[1:]) <= n_actions:
        raise Press(int(s[1:]))
    return s


def ask_input(inp, ask, say, n_actions):
    """One card input -> its value (a string), checked as Teams would check it."""
    t, label, current = inp.get('type'), inp.get('label'), inp.get('value')
    required = bool(inp.get('isRequired'))
    keep = ' [Enter keeps: %s]' % current if current not in (None, '') else ''
    if t == 'Input.ChoiceSet':
        choices = inp.get('choices', [])
        if label:
            say(label)
        for i, c in enumerate(choices, 1):
            say('  %d. %s' % (i, c.get('title')))
        while True:
            s = _read(ask, ('Choose 1-%d' % len(choices)) + ('' if required else ' (Enter to skip)') + keep + ': ', n_actions)
            if not s:
                if current not in (None, ''):
                    return str(current)
                if not required:
                    return ''
            elif s.isdigit() and 1 <= int(s) <= len(choices):
                return str(choices[int(s) - 1].get('value'))
            else:
                hit = [c for c in choices if s.lower() in (str(c.get('value')).lower(), str(c.get('title')).lower())]
                if hit:
                    return str(hit[0].get('value'))
            say(inp.get('errorMessage') or 'Please choose one of the numbers.')
    if t == 'Input.Toggle':
        while True:
            s = _read(ask, (label or inp.get('title') or 'Yes or no') + ' (y/n): ', n_actions).lower()
            if s in ('y', 'yes'):
                return str(inp.get('valueOn', 'true'))
            if s in ('n', 'no', ''):
                return str(inp.get('valueOff', 'false'))
    hint = {'Input.Date': ' (YYYY-MM-DD)', 'Input.Time': ' (HH:MM)'}.get(t, '')
    if t == 'Input.Number' and (inp.get('min') is not None or inp.get('max') is not None):
        hint = ' (%s to %s)' % (inp.get('min', ''), inp.get('max', ''))
    if inp.get('placeholder'):
        hint += ' e.g. ' + str(inp['placeholder'])
    prompt = (label or 'Your answer') + hint + ('' if required else ' (Enter to skip)') + keep + ': '
    while True:
        s = _read(ask, prompt, n_actions)
        if not s and current not in (None, ''):
            return str(current)
        if not s:
            if not required:
                return ''
            say(inp.get('errorMessage') or 'Please answer this.')
            continue
        if t == 'Input.Number':
            try:
                v = float(s)
            except ValueError:
                say('Please enter a number.')
                continue
            if (inp.get('min') is not None and v < inp['min']) or (inp.get('max') is not None and v > inp['max']):
                say('Please enter a number from %s to %s.' % (inp.get('min', ''), inp.get('max', '')))
                continue
        elif t == 'Input.Date':
            try:
                datetime.date.fromisoformat(s)
            except ValueError:
                say('Please enter a date as YYYY-MM-DD.')
                continue
        elif inp.get('maxLength') and len(s) > int(inp['maxLength']):
            say('Please use at most %d characters.' % int(inp['maxLength']))
            continue
        return s


def interact(card, ask, say):
    """Shows the card's buttons, asks for what is needed, and returns the card's response ("data")."""
    actions = [a for a in card.get('actions', []) if a.get('type') == 'Action.Submit']
    inputs = card_inputs(card.get('body'))
    if not actions:
        return None
    if len(actions) > 1 or not inputs:
        say('   ' + '   '.join('[%d] %s' % (i, a.get('title')) for i, a in enumerate(actions, 1)))
    takes_inputs = lambda a: a.get('associatedInputs') != 'none'
    values = {}
    chosen = None
    if inputs and takes_inputs(actions[0]):
        # A question: answer it (the first button, usually Next, sends it); :n presses button n instead.
        if len(actions) > 1:
            say('   (answer, or type :n to press button n)')
        try:
            for inp in inputs:
                values[inp['id']] = ask_input(inp, ask, say, len(actions))
            chosen = actions[0]
        except Press as p:
            chosen = actions[p.n - 1]
            if takes_inputs(chosen):
                values = {}
                for inp in inputs:
                    values[inp['id']] = ask_input(inp, ask, say, 0)
    else:
        while chosen is None:
            s = ask('Choose 1-%d: ' % len(actions)).strip()
            if s.lower() in (':q', 'quit', 'exit'):
                raise Quit()
            if s.startswith(':'):
                s = s[1:]
            if s.isdigit() and 1 <= int(s) <= len(actions):
                chosen = actions[int(s) - 1]
            else:
                hit = [a for a in actions if str(a.get('title')).lower() == s.lower()]
                chosen = hit[0] if hit else None
        if takes_inputs(chosen):
            for inp in inputs:
                values[inp['id']] = ask_input(inp, ask, say, 0)
    data = dict(values)
    data.update(chosen.get('data') or {})
    return data


def run_conversation(api, flow_id, ask=input, say=print):
    """Runs one flow to the end. Returns the final status (completed, cancelled, failed, refused, quit)."""
    r = api.turn(flow_id)
    while True:
        say('')
        for line in card_lines(r.get('card', {}).get('body')):
            say(line)
        if r.get('done'):
            return r.get('status') or 'completed'
        try:
            data = interact(r.get('card', {}), ask, say)
        except (Quit, EOFError, KeyboardInterrupt):
            say('Stopped. Run the flow again to start over.')
            return 'quit'
        if data is None:
            say('This step can\'t be answered here.')
            return r.get('status') or 'in_progress'
        r = api.turn(flow_id, r.get('sessionId'), data)


# --------------------------------------------------------------------------- commands
def api_from_settings():
    s = load_settings()
    ident = identity_for(s)
    return FlowChatApi(s['url'], s['key'], ident['user']), ident, s


def flows_csv(flows):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\n')
    w.writerow(['flowId', 'name', 'version', 'description'])
    for f in flows:
        w.writerow([f.get('flowId'), f.get('name'), f.get('version') or '', f.get('description') or ''])
    return buf.getvalue()


def cmd_setup(a):
    url = a.url or input('FlowChat URL (ends in /flowchat/automate): ').strip()
    key = a.key or getpass.getpass('API key (not shown): ').strip()
    if not url or not key:
        raise SystemExit('Both the URL and the key are needed.')
    if a.all_users:
        if len(config_paths()) < 2:
            raise SystemExit('--all-users needs %PROGRAMDATA% (Windows).')
        try:
            path = save_settings(url, key, config_paths()[1], machine=True)
        except PermissionError:
            raise SystemExit('Run this from an administrator prompt to write ' + config_paths()[1])
        print('Saved to ' + path + ' for everyone on this PC (key encrypted for this machine)')
    else:
        path = save_settings(url, key)
        print('Saved to ' + path + (' (key encrypted for this Windows user)' if IS_WINDOWS else ''))
    ident = identity_for(load_settings())
    try:
        data = FlowChatApi(url, key, ident['user']).list_flows()
        print('Connected as %s (FlowChat user %s): %d flow(s).' % (ident['user'], data.get('appUser'), len(data.get('flows', []))))
    except ApiError as e:
        print('Saved, but the check failed: ' + str(e))
        return 1
    return 0


def cmd_whoami(a):
    s = load_settings()
    ident = identity_for(s)
    print('Sent to FlowChat: ' + ident['user'])
    print('UPN:              ' + (ident['upn'] or '(none: not a domain or Entra ID account)'))
    print('DOMAIN\\user:      ' + ident['sam'])
    print('Settings:         ' + (s.get('source') or '(not set up)'))
    return 0


def cmd_flows(a):
    api, ident, _ = api_from_settings()
    data = api.list_flows()
    flows = data.get('flows', [])
    if a.json:
        print(json.dumps(data, indent=2))
    elif a.csv:
        with open(a.csv, 'w', encoding='utf-8-sig', newline='') as f:   # BOM: Excel reads it as UTF-8
            f.write(flows_csv(flows))
        print('Wrote %d flow(s) to %s' % (len(flows), a.csv))
    else:
        print('Flows for %s (FlowChat user %s):' % (ident['user'], data.get('appUser')))
        if not flows:
            print('  (none registered for your account)')
        w = max([len(f['flowId']) for f in flows] + [7])
        for f in flows:
            mark = ' *' if f['flowId'] == data.get('defaultFlow') else ''
            print('  %-*s  %s%s' % (w, f['flowId'], f.get('name') or '', mark))
            if f.get('description'):
                print('  %-*s  %s' % (w, '', f['description']))
        if data.get('defaultFlow'):
            print('  * default flow')
    return 0


def cmd_run(a):
    ensure_console()
    api, ident, _ = api_from_settings()
    flow_id = a.flow_id
    if not flow_id:
        data = api.list_flows()
        flows = data.get('flows', [])
        if not flows:
            print('No flows are registered for %s.' % ident['user'])
            return 1
        for i, f in enumerate(flows, 1):
            print('  %d. %s (%s)' % (i, f.get('name'), f['flowId']))
        while not flow_id:
            s = input('Which flow? ').strip()
            if s.isdigit() and 1 <= int(s) <= len(flows):
                flow_id = flows[int(s) - 1]['flowId']
            elif any(f['flowId'] == s for f in flows):
                flow_id = s
            elif s.lower() in ('q', ':q', ''):
                return 0
    print('Running %s as %s. Type :q to stop.' % (flow_id, ident['user']))
    status = run_conversation(api, flow_id)
    if a.pause:
        input('\nPress Enter to close.')
    return 0 if status in ('completed', 'quit') else 1


def ensure_console():
    """A console for "run" when started without one (pythonw.exe, or a --noconsole EXE)."""
    if IS_WINDOWS and sys.stdout is None:
        ctypes.windll.kernel32.AllocConsole()
        sys.stdin = open('CONIN$', 'r', encoding='utf-8')
        sys.stdout = sys.stderr = open('CONOUT$', 'w', encoding='utf-8', buffering=1)


def run_in_new_console(flow_id):
    if getattr(sys, 'frozen', False):
        cmd = [sys.executable, 'run', flow_id, '--pause']
    else:
        exe = sys.executable
        if exe.lower().endswith('pythonw.exe'):
            exe = exe[:-len('pythonw.exe')] + 'python.exe'
        cmd = [exe, os.path.abspath(__file__), 'run', flow_id, '--pause']
    flags = subprocess.CREATE_NEW_CONSOLE if IS_WINDOWS else 0
    subprocess.Popen(cmd, creationflags=flags)


# --------------------------------------------------------------------------- window
def cmd_gui(a):
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    class App:
        def __init__(self, root):
            self.root, self.flows, self.data = root, [], {}
            root.title('FlowChat')
            root.geometry('720x420')
            root.minsize(520, 300)
            top = ttk.Frame(root, padding=(10, 10, 10, 0))
            top.pack(fill='x')
            self.who = tk.StringVar(value='Signed in as ' + identity_for(load_settings())['user'])
            ttk.Label(top, textvariable=self.who).pack(side='left')
            ttk.Button(top, text='Settings…', command=self.settings).pack(side='right')
            mid = ttk.Frame(root, padding=10)
            mid.pack(fill='both', expand=True)
            cols = ('name', 'flowId', 'version', 'description')
            self.tree = ttk.Treeview(mid, columns=cols, show='headings', selectmode='browse')
            for c, title, w in zip(cols, ('Name', 'Flow ID', 'Version', 'Description'), (200, 140, 60, 280)):
                self.tree.heading(c, text=title)
                self.tree.column(c, width=w, stretch=(c in ('name', 'description')))
            sb = ttk.Scrollbar(mid, orient='vertical', command=self.tree.yview)
            self.tree.configure(yscrollcommand=sb.set)
            self.tree.pack(side='left', fill='both', expand=True)
            sb.pack(side='right', fill='y')
            self.tree.bind('<Double-1>', lambda e: self.run())
            bottom = ttk.Frame(root, padding=(10, 0, 10, 10))
            bottom.pack(fill='x')
            self.status = tk.StringVar()
            ttk.Label(bottom, textvariable=self.status).pack(side='left')
            for text, cmd in (('Run', self.run), ('Export…', self.export), ('Copy', self.copy), ('Refresh', self.refresh)):
                ttk.Button(bottom, text=text, command=cmd).pack(side='right', padx=(6, 0))
            root.after(50, self.refresh)

        def refresh(self):
            self.tree.delete(*self.tree.get_children())
            self.flows = []
            try:
                api, ident, _ = api_from_settings()
                self.status.set('Loading…')
                self.root.update_idletasks()
                self.data = api.list_flows()
            except ApiError as e:
                self.status.set('')
                if e.status == 0 and 'Not set up' in str(e):
                    self.status.set('Not set up: open Settings.')
                    return
                messagebox.showerror('FlowChat', str(e))
                return
            self.flows = self.data.get('flows', [])
            self.who.set('Signed in as %s (FlowChat user %s)' % (ident['user'], self.data.get('appUser')))
            for f in self.flows:
                self.tree.insert('', 'end', iid=f['flowId'],
                                 values=(f.get('name') or '', f['flowId'], f.get('version') or '', f.get('description') or ''))
            if self.flows:
                self.tree.selection_set(self.data.get('defaultFlow') or self.flows[0]['flowId'])
            self.status.set('%d flow(s) registered for your account' % len(self.flows))

        def selected(self):
            sel = self.tree.selection()
            return sel[0] if sel else None

        def run(self):
            fid = self.selected()
            if fid:
                run_in_new_console(fid)

        def export(self):
            path = filedialog.asksaveasfilename(title='Export flows', defaultextension='.csv', initialfile='flowchat-flows.csv',
                                                filetypes=[('CSV', '*.csv'), ('JSON', '*.json')])
            if not path:
                return
            with open(path, 'w', encoding='utf-8-sig' if path.lower().endswith('.csv') else 'utf-8', newline='') as f:
                f.write(json.dumps(self.data, indent=2) if path.lower().endswith('.json') else flows_csv(self.flows))
            self.status.set('Exported %d flow(s) to %s' % (len(self.flows), path))

        def copy(self):
            self.root.clipboard_clear()
            self.root.clipboard_append(flows_csv(self.flows).replace(',', '\t'))
            self.status.set('Copied %d flow(s): paste into Excel or an email' % len(self.flows))

        def settings(self):
            s = load_settings()
            d = tk.Toplevel(self.root)
            d.title('FlowChat settings')
            d.transient(self.root)
            d.grab_set()
            frm = ttk.Frame(d, padding=12)
            frm.pack(fill='both', expand=True)
            url, key = tk.StringVar(value=s.get('url') or ''), tk.StringVar()
            ttk.Label(frm, text='URL (ends in /flowchat/automate)').grid(row=0, column=0, sticky='w')
            ttk.Entry(frm, textvariable=url, width=60).grid(row=1, column=0, sticky='we', pady=(0, 8))
            ttk.Label(frm, text='API key' + (' (leave empty to keep the saved one)' if s.get('key') else '')).grid(row=2, column=0, sticky='w')
            ttk.Entry(frm, textvariable=key, show='•', width=60).grid(row=3, column=0, sticky='we', pady=(0, 8))

            def save():
                k = key.get().strip() or s.get('key')
                if not url.get().strip() or not k:
                    messagebox.showerror('FlowChat', 'Both the URL and the key are needed.', parent=d)
                    return
                save_settings(url.get(), k)
                d.destroy()
                self.refresh()
            ttk.Button(frm, text='Save', command=save).grid(row=4, column=0, sticky='e')

    root = tk.Tk()
    App(root)
    if getattr(a, 'smoke_test', False):        # used by the tests: build the window, load, close
        root.update()
        root.after(400, root.destroy)
    root.mainloop()
    return 0


# --------------------------------------------------------------------------- main
def main(argv=None):
    p = argparse.ArgumentParser(prog='flowchat_client', description='FlowChat: your flows on Windows.')
    sub = p.add_subparsers(dest='cmd')
    s = sub.add_parser('setup', help='save the URL and API key')
    s.add_argument('--url')
    s.add_argument('--key', help='better left out: you are asked for it without echo')
    s.add_argument('--all-users', action='store_true',
                   help='save in %%PROGRAMDATA%% for everyone on this PC (administrator)')
    sub.add_parser('whoami', help='the Windows identity sent to FlowChat')
    f = sub.add_parser('flows', help='list the flows registered for you')
    f.add_argument('--json', action='store_true')
    f.add_argument('--csv', metavar='FILE')
    r = sub.add_parser('run', help='run a flow in this console')
    r.add_argument('flow_id', nargs='?')
    r.add_argument('--pause', action='store_true', help=argparse.SUPPRESS)
    g = sub.add_parser('gui', help='the window (default)')
    g.add_argument('--smoke-test', action='store_true', help=argparse.SUPPRESS)
    a = p.parse_args(argv)
    try:
        return {'setup': cmd_setup, 'whoami': cmd_whoami, 'flows': cmd_flows, 'run': cmd_run,
                'gui': cmd_gui, None: cmd_gui}[a.cmd](a)
    except ApiError as e:
        print('FlowChat: ' + str(e), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    sys.exit(main())
