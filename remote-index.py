"""Read bounded session metadata only; compatible with HPC Python 3.6."""
import datetime
import hashlib
import json
import os
import re
import socket
import subprocess
import time

HOME = os.path.expanduser('~')
UUID = re.compile(r'^[0-9a-fA-F-]{36}$')
LIMIT = 256 * 1024


def profile_directory():
    try:
        with open(os.path.expanduser('~/.local/state/hpc-claude-board/runtime-v3/claude-profile.json')) as stream:
            profile = json.load(stream)
    except (OSError, ValueError):
        profile = {'configDir': '.claude'}
    return os.path.expanduser(os.path.join(HOME, profile.get('configDir', '.claude')))


def records(path):
    size = os.path.getsize(path)
    with open(path, 'rb') as stream:
        head = stream.read(LIMIT)
        if size > LIMIT:
            stream.seek(max(LIMIT, size - LIMIT))
            tail = stream.read(LIMIT).split(b'\n')[1:]
        else:
            tail = []
    for line in head.split(b'\n') + tail:
        try:
            record = json.loads(line.decode('utf-8'))
            if isinstance(record, dict):
                yield record
        except (ValueError, UnicodeDecodeError):
            pass


def metadata(path):
    cwd, title, prompt = None, None, None
    is_session = False
    for record in records(path):
        if record.get('isSidechain'):
            continue
        if record.get('cwd') and not cwd:
            cwd = record['cwd']
        if record.get('type') in ('user', 'assistant'):
            is_session = True
        if record.get('customTitle'):
            title = record['customTitle']
        if record.get('type') == 'summary' and not title:
            title = record.get('summary')
        if record.get('type') == 'user' and not prompt and not record.get('isMeta'):
            content = record.get('message', {}).get('content', '')
            if isinstance(content, list):
                content = ' '.join(part.get('text', '') for part in content if isinstance(part, dict) and part.get('type') == 'text')
            if isinstance(content, str) and content.strip() and not content.lstrip().startswith(('<', '[Request interrupted')):
                prompt = re.sub(r'\s+', ' ', content).strip()[:160]
    return cwd, str(title or prompt or '未命名会话')[:160], is_session


def scan():
    grouped, seen = {}, set()
    roots = [(profile_directory(), 'claude')]
    directories = [HOME]
    try:
        directories += [entry.path for entry in os.scandir(HOME) if not entry.name.startswith('.') and entry.is_dir()]
    except OSError:
        pass
    encoded_dirs = {re.sub(r'[^a-zA-Z0-9]', '-', path): path for path in directories}
    for root, command in roots:
        projects = os.path.realpath(os.path.join(HOME, root, 'projects'))
        if projects in seen or not os.path.isdir(projects):
            continue
        seen.add(projects)
        for folder in os.scandir(projects):
            if not folder.is_dir():
                continue
            candidates = []
            for entry in os.scandir(folder.path):
                if entry.name.endswith('.jsonl') and UUID.match(entry.name[:-6]) and entry.is_file():
                    candidates.append((entry.stat().st_mtime, entry.path, entry.name[:-6]))
            candidates.sort(reverse=True)
            fallback = encoded_dirs.get(folder.name)
            for modified, path, session_id in candidates[:30]:
                try:
                    cwd, title, is_session = metadata(path)
                except OSError:
                    continue
                # The history directory is the stable project identity. A Claude
                # tool may cd into a staging/worktree folder during the session.
                cwd = fallback or cwd
                if not cwd or not is_session:
                    continue
                # Each installation indexes only its configured Claude profile.
                project_id = hashlib.sha256((cwd + '\0' + projects).encode()).hexdigest()[:16]
                if project_id not in grouped:
                    grouped[project_id] = dict(id=project_id, path=cwd, name=os.path.basename(cwd) or cwd,
                                               command=command, exists=os.path.isdir(cwd), sessions=[], totalOnDisk=len(candidates))
                grouped[project_id]['sessions'].append(dict(id=session_id, title=title, updatedAt=modified))
    projects = list(grouped.values())
    for project in projects:
        project['sessions'].sort(key=lambda item: item['updatedAt'], reverse=True)
        project['updatedAt'] = project['sessions'][0]['updatedAt']
    projects.sort(key=lambda item: item['updatedAt'], reverse=True)
    terminals = []
    try:
        output = subprocess.check_output(['tmux', '-L', 'hpc-claude-board', 'list-sessions', '-F', '#{session_name}|#{session_attached}'], stderr=subprocess.DEVNULL, timeout=5).decode()
        terminals = [dict(name=line.split('|')[0], attached=int(line.split('|')[1])) for line in output.splitlines() if '|' in line]
    except (OSError, subprocess.SubprocessError):
        pass
    connection = os.environ.get('SSH_CONNECTION', '').split()
    return dict(hostname=socket.gethostname(), home=HOME, nodeAddress=connection[2] if len(connection) == 4 else '',
                scannedAt=time.time(), projects=projects, directories=sorted(directories), terminals=terminals)


if __name__ == '__main__':
    print(json.dumps(scan(), ensure_ascii=True))
