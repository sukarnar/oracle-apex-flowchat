# Run: py tests/windows_client_test.py   (needs Node for tools/automate-dev-server.js)
# The Windows client (tools/windows-client/flowchat_client.py) against the local stand-in for the
# FC_AUTOMATE endpoints, with this machine's Windows identity mapped to JDOE.
import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.path.join(ROOT, 'tools', 'windows-client', 'flowchat_client.py')
sys.path.insert(0, os.path.dirname(CLIENT))
import flowchat_client as fc  # noqa: E402

KEY = 'test-key-123'
IDENT = fc.windows_identity()['user']


class Script:
    """Answers prompts from a list, and records everything said and asked."""
    def __init__(self, answers):
        self.answers, self.log = list(answers), []

    def ask(self, prompt):
        self.log.append('? ' + prompt)
        if not self.answers:
            raise AssertionError('ran out of answers at: ' + prompt + '\n' + '\n'.join(self.log[-15:]))
        a = self.answers.pop(0)
        self.log.append('> ' + a)
        return a

    def say(self, text=''):
        self.log.append(str(text))

    def text(self):
        return '\n'.join(self.log)


class WindowsClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = subprocess.Popen(
            ['node', os.path.join(ROOT, 'tools', 'automate-dev-server.js'), '--port', '0', '--key', KEY,
             '--default', 'it_helpdesk', '--map', IDENT + '=JDOE:it_helpdesk,trip_booking'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        line = cls.srv.stdout.readline()
        if not line.startswith('listening on '):
            raise RuntimeError('dev server: ' + line + cls.srv.stdout.read())
        cls.url = 'http://127.0.0.1:%s/flowchat/automate' % line.split()[-1]
        cls.tmp = tempfile.TemporaryDirectory()

    @classmethod
    def tearDownClass(cls):
        cls.srv.kill()
        cls.srv.wait()
        cls.srv.stdout.close()
        cls.tmp.cleanup()

    def api(self, key=KEY, user=IDENT):
        return fc.FlowChatApi(self.url, key, user)

    def env(self):
        e = dict(os.environ, FLOWCHAT_URL=self.url, FLOWCHAT_KEY=KEY,
                 APPDATA=os.path.join(self.tmp.name, 'appdata'), PROGRAMDATA=os.path.join(self.tmp.name, 'programdata'))
        return e

    def test_lists_the_flows_registered_for_the_windows_user(self):
        data = self.api().list_flows()
        self.assertEqual(data['appUser'], 'JDOE')
        self.assertEqual(data['user'], IDENT.lower())
        self.assertEqual([f['flowId'] for f in data['flows']], ['trip_booking', 'it_helpdesk'])
        self.assertEqual(data['flows'][1]['name'], 'IT help desk')
        self.assertEqual(data['defaultFlow'], 'it_helpdesk')

    def test_unknown_person_wrong_key_and_unregistered_flow_are_refused(self):
        with self.assertRaises(fc.ApiError) as e:
            self.api(user='CORP\\nobody').list_flows()
        self.assertEqual(e.exception.status, 403)
        self.assertIn('not linked', str(e.exception))
        with self.assertRaises(fc.ApiError) as e:
            self.api(key='wrong').list_flows()
        self.assertEqual(e.exception.status, 401)
        with self.assertRaises(fc.ApiError) as e:
            self.api().turn('loan_application')
        self.assertEqual(e.exception.status, 403)
        self.assertIn('not registered for your account', str(e.exception))
        with self.assertRaises(fc.ApiError) as e:
            fc.FlowChatApi(self.url.replace('/flowchat/automate', '/nope'), KEY, IDENT).list_flows()
        self.assertEqual(e.exception.status, 404)
        self.assertIn('/flowchat/automate', str(e.exception))

    def test_a_help_desk_ticket_in_the_console(self):
        s = Script([
            '5',                        # area: Printer (6 options: a list, then Next)
            ':2',                       # at the title question, press [2] Back
            '5',                        # Printer again
            'Paper jams on floor 3',    # title
            '',                         # details: optional
            '2',                        # who's affected: [2] My team
            '2',                        # how much: [2] Some
            '1',                        # remote access: [1] Yes
            '2', 'impact',              # summary: [2] Change, then the answer to change
            '3',                        # Everyone in the office
            '1',                        # [1] Log ticket
        ])
        status = fc.run_conversation(self.api(), 'it_helpdesk', s.ask, s.say)
        out = s.text()
        self.assertEqual(status, 'completed', out)
        self.assertIn('Hi JDOE', out)
        self.assertIn('[1] Just me   [2] My team   [3] Everyone in the office', out)
        self.assertIn('Area: Printer', out)
        self.assertRegex(out, r'Logged IT-\d+ with priority P2')

    def test_quit_stops_the_conversation(self):
        s = Script([':q'])
        self.assertEqual(fc.run_conversation(self.api(), 'it_helpdesk', s.ask, s.say), 'quit')

    def test_required_answers_and_choices_are_checked(self):
        inp = {'type': 'Input.Text', 'id': 'answer', 'isRequired': True, 'maxLength': 5}
        s = Script(['', 'toolong', 'ok'])
        self.assertEqual(fc.ask_input(inp, s.ask, s.say, 2), 'ok')
        self.assertIn('Please answer this.', s.text())
        self.assertIn('at most 5 characters', s.text())
        ch = {'type': 'Input.ChoiceSet', 'id': 'pick', 'isRequired': True,
              'choices': [{'title': 'Red', 'value': 'R'}, {'title': 'Blue', 'value': 'B'}]}
        s = Script(['9', 'blue'])
        self.assertEqual(fc.ask_input(ch, s.ask, s.say, 1), 'B')
        s = Script(['x', '2026-02-30', '2026-03-01'])
        self.assertEqual(fc.ask_input({'type': 'Input.Date', 'id': 'd', 'isRequired': True}, s.ask, s.say, 1), '2026-03-01')

    def test_cli_flows_csv_and_json(self):
        path = os.path.join(self.tmp.name, 'flows.csv')
        r = subprocess.run([sys.executable, CLIENT, 'flows', '--csv', path], env=self.env(), capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(path, encoding='utf-8-sig') as f:
            lines = f.read().splitlines()
        self.assertEqual(lines[0], 'flowId,name,version,description')
        self.assertTrue(lines[1].startswith('trip_booking,Book a trip,'))
        r = subprocess.run([sys.executable, CLIENT, 'flows', '--json'], env=self.env(), capture_output=True, text=True)
        self.assertEqual(json.loads(r.stdout)['appUser'], 'JDOE')
        r = subprocess.run([sys.executable, CLIENT, 'flows'], env=self.env(), capture_output=True, text=True)
        self.assertIn('it_helpdesk', r.stdout)
        self.assertIn('* default flow', r.stdout)

    def test_setup_saves_an_encrypted_key_that_load_settings_reads(self):
        env = self.env()
        del env['FLOWCHAT_URL'], env['FLOWCHAT_KEY']
        r = subprocess.run([sys.executable, CLIENT, 'setup', '--url', self.url + '/flows', '--key', KEY],
                           env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('Connected as', r.stdout)
        with open(os.path.join(env['APPDATA'], 'FlowChat', 'client.json'), encoding='utf-8') as f:
            saved = json.load(f)
        self.assertEqual(saved['url'], self.url)                    # /flows trimmed
        self.assertNotIn(KEY, json.dumps(saved))                    # only the DPAPI blob
        r = subprocess.run([sys.executable, CLIENT, 'flows', '--json'], env=env, capture_output=True, text=True)
        self.assertEqual(json.loads(r.stdout)['appUser'], 'JDOE')

    def test_setup_for_all_users_is_read_when_the_user_has_no_settings(self):
        env = self.env()
        del env['FLOWCHAT_URL'], env['FLOWCHAT_KEY']
        env['APPDATA'] = os.path.join(self.tmp.name, 'appdata-empty')
        env['PROGRAMDATA'] = os.path.join(self.tmp.name, 'programdata-all')
        r = subprocess.run([sys.executable, CLIENT, 'setup', '--all-users', '--url', self.url, '--key', KEY],
                           env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.exists(os.path.join(env['PROGRAMDATA'], 'FlowChat', 'client.json')))
        self.assertFalse(os.path.exists(os.path.join(env['APPDATA'], 'FlowChat', 'client.json')))
        r = subprocess.run([sys.executable, CLIENT, 'whoami'], env=env, capture_output=True, text=True)
        self.assertIn('programdata-all', r.stdout)

    def test_the_window_opens_and_loads(self):
        r = subprocess.run([sys.executable, CLIENT, 'gui', '--smoke-test'], env=self.env(), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
