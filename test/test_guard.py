import importlib.util
import os
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('guard', os.path.join(os.path.dirname(__file__), '..', 'remote-guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class ProcessIdentityTest(unittest.TestCase):
    def test_native_search_helpers_are_not_duplicate_claude_instances(self):
        for helper in ('bfs', 'ugrep'):
            self.assertFalse(guard.is_claude_process('claude.exe', [helper, '--help']))
        self.assertTrue(guard.is_claude_process('claude.exe', ['claude', '--resume']))

    def test_explicit_fork_id_wins_regardless_of_argument_order(self):
        source='11111111-2222-4333-8444-555555555555'
        child='66666666-7777-4888-8999-000000000000'
        for args in (['--session-id',child,'--resume',source], ['--resume='+source,'--session-id='+child]):
            self.assertEqual(guard.session_identity(args),child)
        self.assertIsNone(guard.session_identity(['--resume',source,'--fork-session']))

    def test_reused_pid_does_not_count_as_active_session(self):
        record = dict(pid=12, procStart='100', pidDomain='node-a')
        self.assertFalse(guard.metadata_matches(record, dict(pid=12, procStart='200'), 'node-a'))
        self.assertFalse(guard.metadata_matches(record, dict(pid=12, procStart='100'), 'node-b'))
        self.assertTrue(guard.metadata_matches(record, dict(pid=12, procStart='100'), 'node-a'))

    def test_preview_reads_original_tmux_without_attaching_or_sending_input(self):
        identity = dict(pid=12, procStart='100', pidDomain='node-a')
        location = dict(server='default', name='910', pane='%10', tty='/dev/pts/12', attached=0)
        info = dict(domain='node-a', hostname='test-node', active=[dict(pid=12, procStart='100', location=location)])
        with patch.object(guard, 'inventory', return_value=info), patch.object(guard.subprocess, 'check_output', return_value=b'original output') as capture:
            result = guard.preview('test-session', identity)
            self.assertEqual(result['output'], 'original output')
            self.assertEqual(capture.call_args[0][0], ['tmux', '-L', 'default', 'capture-pane', '-p', '-t', '%10', '-S', '-180'])

    def test_preview_rejects_reused_pid_before_reading_terminal(self):
        info = dict(domain='node-a', active=[dict(pid=12, procStart='200', location={})])
        with patch.object(guard, 'inventory', return_value=info), patch.object(guard.subprocess, 'check_output') as capture:
            with self.assertRaises(ValueError):
                guard.preview('test-session', dict(pid=12, procStart='100', pidDomain='node-a'))
            capture.assert_not_called()

    def test_preview_discards_output_if_process_exits_during_capture(self):
        identity = dict(pid=12, procStart='100', pidDomain='node-a')
        info = dict(domain='node-a', hostname='test-node', active=[dict(pid=12, procStart='100', location=dict(server='default', name='910', pane='%10'))])
        with patch.object(guard, 'inventory', side_effect=[info, dict(domain='node-a', active=[])]), patch.object(guard.subprocess, 'check_output', return_value=b'output'):
            with self.assertRaises(ValueError):
                guard.preview('test-session', identity)

    def test_termination_targets_only_the_verified_claude_pid(self):
        identity = dict(pid=12, procStart='100', pidDomain='node-a')
        with patch.object(guard, 'verified_process', side_effect=[dict(pid=12), None]), patch.object(guard.os, 'kill') as kill:
            self.assertTrue(guard.terminate_duplicate('test-session', identity)['terminated'])
            kill.assert_called_once_with(12, guard.signal.SIGTERM)

    def test_termination_refuses_a_changed_process_identity(self):
        with patch.object(guard, 'verified_process', return_value=None), patch.object(guard.os, 'kill') as kill:
            with self.assertRaises(ValueError):
                guard.terminate_duplicate('test-session', dict(pid=12, procStart='100', pidDomain='node-a'))
            kill.assert_not_called()

    def test_attach_uses_original_tmux_and_never_starts_claude(self):
        proc = dict(location=dict(server='default', name='910', pane='%10'))
        with patch.object(guard, 'verified_process', return_value=proc), patch.object(guard.subprocess, 'check_call'), patch.object(guard.os, 'execvp') as attach:
            guard.attach_existing('test-session', dict(pid=12, readOnly=False))
            attach.assert_called_once_with('tmux', ['tmux', '-L', 'default', 'attach-session', '-t', '=910'])


if __name__ == '__main__':
    unittest.main()
