"""Atomically claim a session across nodes, then reuse/create its tmux terminal."""
import base64
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = os.path.expanduser('~/.local/state/hpc-claude-board')


def atomic_json(path, value):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
    os.replace(tmp, path)


def proc_start(pid):
    try:
        with open('/proc/{}/stat'.format(int(pid))) as stream:
            return stream.read().rsplit(') ', 1)[1].split()[19]
    except (OSError, ValueError, IndexError):
        return None


def has_terminal(name):
    return subprocess.call(['tmux', '-L', 'hpc-claude-board', 'has-session', '-t', '=' + name],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0


def session_inventory(session_id):
    from guard import inventory
    return inventory(session_id)


def reusable_terminal(current, project_path):
    if current.get('unverified') or any(p['cwd'] == project_path or p['cwd'].startswith(project_path + '/') for p in current.get('unknown', [])):
        sys.exit('Session ownership cannot be verified; no new Claude was started.')
    active = current.get('active', [])
    if len(active) > 1:
        sys.exit('Duplicate Claude processes detected. Reconnect through the board.')
    if active:
        if not active[0].get('terminal'):
            sys.exit('Claude is running in another terminal. Reconnect through the board.')
        return active[0]['terminal']
    return None


def claim(payload):
    session_id = payload.get('sessionId')
    if not session_id:
        return
    directory = os.path.join(ROOT, 'session-owners', session_id)
    os.makedirs(os.path.dirname(directory), mode=0o700, exist_ok=True)
    for _ in range(40):
        try:
            os.mkdir(directory, 0o700)  # Atomic on the shared home filesystem.
            atomic_json(os.path.join(directory, 'owner.json'), dict(hostname=socket.gethostname(),
                        terminal=payload['name'], account=payload['account'], pid=os.getpid(), procStart=proc_start(os.getpid()), createdAt=time.time()))
            return
        except FileExistsError:
            if os.path.islink(directory):
                sys.exit('Invalid session ownership directory')
            try:
                with open(os.path.join(directory, 'owner.json')) as stream:
                    owner = json.load(stream)
            except (OSError, ValueError):
                time.sleep(0.1)
                continue
            if owner.get('hostname') != socket.gethostname():
                sys.exit('Session is reserved on {}. Reconnect through the board; a second Claude was not started.'.format(owner.get('hostname')))
            current = session_inventory(session_id)
            running = reusable_terminal(current, payload['path'])
            if running:
                if running != payload['name']:
                    sys.exit('Session changed during reconnect. Retry from the board; no new Claude was started.')
                payload['name'] = running
                payload['reuse'] = True
                return
            if current.get('ownerStarting'):
                time.sleep(0.1)
                continue
            # Only this node may retire its dead reservation. A separate atomic
            # directory serializes reclamation; never overwrite another owner.
            reclaim = directory + '.reclaim'
            try:
                os.mkdir(reclaim, 0o700)
            except FileExistsError:
                time.sleep(0.1)
                continue
            try:
                with open(os.path.join(directory, 'owner.json')) as stream:
                    latest = json.load(stream)
                current = session_inventory(session_id)
                if latest == owner and not reusable_terminal(current, payload['path']) and not current.get('ownerStarting'):
                    os.unlink(os.path.join(directory, 'owner.json'))
                    os.rmdir(directory)
            except (OSError, ValueError):
                pass
            finally:
                os.rmdir(reclaim)
    sys.exit('Session is starting or its owner could not be verified. Retry from the board; no second Claude was started.')


def main(payload):
    if not os.path.isdir(payload['path']):
        sys.exit('Project directory does not exist')
    if not shutil.which('tmux'):
        sys.exit('tmux is required')
    if payload.get('sessionId') and not re.match(r'^[0-9a-f-]{36}$', payload['sessionId']):
        sys.exit('Invalid session ID')
    os.makedirs(ROOT, mode=0o700, exist_ok=True)
    if os.path.islink(ROOT) or os.stat(ROOT).st_uid != os.getuid():
        sys.exit('Invalid board state directory')
    claim(payload)
    if payload.get('reuse'):
        if not has_terminal(payload['name']):
            sys.exit('The existing terminal ended. Refresh the board; no new Claude was started.')
        print('HPC connected', flush=True)
        os.execvp('tmux', ['tmux', '-L', 'hpc-claude-board', 'attach-session', '-t', '=' + payload['name']])
    if payload.get('sessionId'):
        current = session_inventory(payload['sessionId'])
        if current['active'] or current.get('unverified'):
            sys.exit('This session is already running. Reconnect through the board; no second Claude was started.')
        verified = set(payload.get('checkedReferences', []))
        for ref in current['references']:
            key = '{}|{}|{}'.format(ref.get('pidDomain'), ref.get('pid'), ref.get('procStart'))
            if ref.get('pidDomain') != current['domain'] and key not in verified:
                sys.exit('New cross-node session activity detected. Refresh the board before starting.')
    rc = os.path.join(ROOT, payload['name'] + '.bashrc')
    fd, tmp = tempfile.mkstemp(dir=ROOT)
    with os.fdopen(fd, 'w') as stream:
        stream.write(payload['rc'])
    os.replace(tmp, rc)
    config = os.path.join(ROOT, 'tmux.conf')
    settings = "set -g mouse on\nset -g history-limit 50000\nset -g status off\nbind-key -T root WheelUpPane if-shell -F -t = '#{pane_in_mode}' 'send-keys -M' 'copy-mode -et=; send-keys -X -N 5 scroll-up'\n"
    fd, tmp = tempfile.mkstemp(dir=ROOT)
    with os.fdopen(fd, 'w') as stream:
        stream.write(settings)
    os.replace(tmp, config)
    subprocess.call(['tmux', '-L', 'hpc-claude-board', 'source-file', config], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('HPC connected', flush=True)
    args = ['tmux', '-f', config, '-L', 'hpc-claude-board', 'new-session']
    if not payload.get('sessionId'):
        args.append('-A')
    os.execvp('tmux', args + ['-s', payload['name'], '-c', payload['path'], 'bash --rcfile ' + shlex.quote(rc) + ' -i'])


if __name__ == '__main__':
    main(json.loads(base64.b64decode(sys.argv[1]).decode('utf8')))
