import importlib.util
import json
import os
import socket
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('start', os.path.join(os.path.dirname(__file__), '..', 'remote-start.py'))
start = importlib.util.module_from_spec(spec)
spec.loader.exec_module(start)


class ResumeAfterExitTest(unittest.TestCase):
    def test_leftover_shell_reservation_is_replaced_without_destroying_shell(self):
        with tempfile.TemporaryDirectory() as root:
            session = '11111111-2222-4333-8444-555555555555'
            directory = os.path.join(root, 'session-owners', session)
            os.makedirs(directory)
            owner = dict(hostname=socket.gethostname(), terminal='old-shell', pid=99999, procStart='old')
            with open(os.path.join(directory, 'owner.json'), 'w') as stream:
                json.dump(owner, stream)
            payload = dict(sessionId=session, name='fresh-terminal', path='/project', account='claude')
            empty = dict(active=[], unknown=[], unverified=[], ownerStarting=False)
            with patch.object(start, 'ROOT', root), patch.object(start, 'session_inventory', return_value=empty), patch.object(start, 'has_terminal', return_value=True), patch.object(start.subprocess, 'call') as commands:
                start.claim(payload)
                self.assertFalse(payload.get('reuse', False))
                with open(os.path.join(directory, 'owner.json')) as stream:
                    self.assertEqual(json.load(stream)['terminal'], 'fresh-terminal')
                commands.assert_not_called()

    def test_actual_running_claude_is_reused_but_empty_tmux_is_not(self):
        self.assertIsNone(start.reusable_terminal(dict(active=[], unknown=[]), '/project'))
        self.assertEqual(start.reusable_terminal(dict(active=[dict(terminal='live')], unknown=[]), '/project'), 'live')
        with self.assertRaises(SystemExit):
            start.reusable_terminal(dict(active=[], unknown=[dict(cwd='/project/worktree')]), '/project')
