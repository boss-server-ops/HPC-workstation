import importlib.util
import json
import os
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('remote_index', os.path.join(os.path.dirname(__file__), '..', 'remote-index.py'))
index = importlib.util.module_from_spec(spec)
spec.loader.exec_module(index)


class SessionMetadataTest(unittest.TestCase):
    def test_working_directory_changes_do_not_move_project(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, 'session.jsonl')
            with open(path, 'w', encoding='utf8') as stream:
                for item in [dict(type='user', cwd='/data/project', message=dict(content='中文项目')),
                             dict(type='assistant', cwd='/data/project/staging', message=dict(content='done'))]:
                    stream.write(json.dumps(item) + '\n')
            cwd, title, valid = index.metadata(path)
            self.assertEqual(cwd, '/data/project')
            self.assertEqual(title, '中文项目')
            self.assertTrue(valid)

    def test_large_middle_and_incomplete_last_record_are_skipped(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, 'session.jsonl')
            with open(path, 'wb') as stream:
                stream.write(json.dumps(dict(type='user', cwd='/data/project', message=dict(content='first'))).encode() + b'\n')
                stream.write(b'x' * (index.LIMIT * 3) + b'\n')
                stream.write(json.dumps(dict(type='custom-title', customTitle='renamed')).encode() + b'\n')
                stream.write(b'{"partial":')
            cwd, title, valid = index.metadata(path)
            self.assertEqual(cwd, '/data/project')
            self.assertEqual(title, 'renamed')
            self.assertTrue(valid)

    def test_subagent_records_are_not_user_sessions(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, 'session.jsonl')
            with open(path, 'w') as stream:
                stream.write(json.dumps(dict(type='user', isSidechain=True, cwd='/wrong', message=dict(content='agent'))) + '\n')
            self.assertFalse(index.metadata(path)[2])


if __name__ == '__main__':
    unittest.main()
