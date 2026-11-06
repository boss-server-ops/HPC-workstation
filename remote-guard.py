"""Read-only process/session inspection, Python 3.6+. Never reads credentials."""
import json
import base64
import glob
import os
import re
import socket
import signal
import subprocess
import sys
import time

UUID = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')
HOME = os.path.expanduser('~')


def profile_directory():
    try:
        with open(os.path.expanduser('~/.local/state/hpc-claude-board/runtime-v3/claude-profile.json')) as stream:
            profile = json.load(stream)
    except (OSError, ValueError):
        profile = {'configDir': '.claude'}
    return os.path.expanduser(os.path.join(HOME, profile.get('configDir', '.claude')))


def is_claude_process(comm, args):
    if args and os.path.basename(args[0]) in ('ugrep', 'bfs'):
        return False
    return 'claude' in comm.lower() or any('/claude-code/' in a and a.endswith('.js') for a in args[:3])


def session_identity(args):
    resume, explicit = None, None
    for i, arg in enumerate(args):
        key, separator, value = arg.partition('=')
        if not separator and i + 1 < len(args):
            value = args[i + 1]
        if key in ('--resume', '-r', '--session-id') and UUID.match(value):
            if key == '--session-id':
                explicit = value.lower()
            else:
                resume = value.lower()
    return explicit or (None if '--fork-session' in args else resume)


def process(pid, proc_root='/proc'):
    try:
        root = os.path.join(proc_root, str(int(pid)))
        if os.stat(root).st_uid != os.getuid():
            return None
        with open(root + '/stat') as stream:
            fields = stream.read().rsplit(') ', 1)[1].split()
        if fields[0] == 'Z':
            return None
        with open(root + '/cmdline', 'rb') as stream:
            args = stream.read(65536).decode('utf8', 'replace').split('\0')
        with open(root + '/comm') as stream:
            comm = stream.read().strip()
        if not is_claude_process(comm, args):
            return None
        session_id = session_identity(args)
        account = 'claude' if os.path.realpath(os.path.join(HOME, '.claude')) == os.path.realpath(profile_directory()) else 'external'
        with open(root + '/environ', 'rb') as stream:
            # Only expose the profile classification, never the environment itself.
            for field in stream.read(1024 * 1024).split(b'\0'):
                if field.startswith(b'CLAUDE_CONFIG_DIR='):
                    value = field.split(b'=', 1)[1].decode('utf8', 'replace')
                    account = 'claude' if os.path.realpath(value) == os.path.realpath(profile_directory()) else 'external'
        return dict(pid=int(pid), procStart=fields[19], ppid=int(fields[1]), sessionId=session_id,
                    cwd=os.readlink(root + '/cwd'), account=account)
    except (OSError, ValueError, IndexError):
        return None


def metadata_matches(record, proc, domain):
    return record.get('pidDomain') == domain and str(record.get('procStart')) == proc['procStart'] and int(record.get('pid', -1)) == proc['pid']


def ancestor_terminal(pid, panes):
    for _ in range(25):
        if pid in panes:
            return panes[pid]
        try:
            with open('/proc/{}/stat'.format(pid)) as stream:
                pid = int(stream.read().rsplit(') ', 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
        if pid <= 1:
            break
    return None


def tmux_panes(server):
    try:
        output = subprocess.check_output(['tmux', '-L', server, 'list-panes', '-a', '-F',
                                          '#{pane_pid}|#{session_name}|#{pane_id}|#{pane_tty}|#{session_attached}'],
                                         stderr=subprocess.DEVNULL, timeout=4).decode()
        panes = {}
        for line in output.splitlines():
            pid, name, pane, tty, attached = line.split('|')
            panes[int(pid)] = dict(server=server, name=name, pane=pane, tty=tty, attached=int(attached))
        return panes
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}


def owner_starting(owner, terminals):
    if not owner or owner.get('hostname') != socket.gethostname():
        return False
    # A shell left behind after /exit is not a live Claude session. Only a live
    # bootstrap or the brief handover to a newly created tmux counts as starting.
    try:
        root = '/proc/{}'.format(int(owner['pid']))
        with open(root + '/stat') as stream:
            fields = stream.read().rsplit(') ', 1)[1].split()
        if fields[0] != 'Z' and fields[19] == str(owner.get('procStart')):
            with open(root + '/cmdline', 'rb') as stream:
                args = stream.read(65536).split(b'\0')
            if any(arg.endswith(b'/runtime-v3/start.py') for arg in args[:3]):
                return True
    except (OSError, ValueError, KeyError, IndexError):
        pass
    age = time.time() - owner.get('createdAt', 0)
    return 0 <= age < 15 and owner.get('terminal') in terminals


def inventory(session_id):
    with open('/etc/machine-id') as stream:
        machine = stream.read().strip()
    domain = 'linux:{}:{}'.format(machine, os.readlink('/proc/self/ns/pid'))
    records, seen = [], set()
    for profile in (profile_directory(),):
        directory = os.path.realpath(os.path.join(HOME, profile, 'sessions'))
        if directory in seen or not os.path.isdir(directory):
            continue
        seen.add(directory)
        for entry in os.scandir(directory):
            if not entry.name.endswith('.json'):
                continue
            try:
                with open(entry.path) as stream:
                    item = json.load(stream)
                if item.get('sessionId', '').lower() == session_id:
                    records.append({key: item.get(key) for key in ('pid', 'procStart', 'pidDomain', 'sessionId', 'cwd')})
            except (OSError, ValueError, AttributeError):
                continue
    board_panes = tmux_panes('hpc-claude-board')
    original_panes = tmux_panes('default')
    active, unknown = [], []
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit():
            continue
        proc = process(entry.name)
        if not proc:
            continue
        for record in records:
            if metadata_matches(record, proc, domain):
                proc['sessionId'] = session_id
        if proc['sessionId'] == session_id or not proc['sessionId']:
            board_location = ancestor_terminal(proc['pid'], board_panes)
            proc['terminal'] = board_location['name'] if board_location else None
            proc['location'] = board_location or ancestor_terminal(proc['pid'], original_panes)
            (active if proc['sessionId'] else unknown).append(proc)
    unverified = []
    for record in records:
        if record.get('pidDomain') != domain or any(p['pid'] == record.get('pid') for p in active):
            continue
        try:
            with open('/proc/{}/stat'.format(int(record['pid']))) as stream:
                fields = stream.read().rsplit(') ', 1)[1].split()
            if fields[0] != 'Z' and fields[19] == str(record.get('procStart')):
                unverified.append(record['pid'])
        except (OSError, ValueError, IndexError):
            pass
    owner = None
    owner_path = os.path.join(HOME, '.local/state/hpc-claude-board/session-owners', session_id, 'owner.json')
    try:
        with open(owner_path) as stream:
            owner = json.load(stream)
    except (OSError, ValueError):
        pass
    history_exists = any(glob.glob(os.path.join(HOME, profile, 'projects', '*', session_id + '.jsonl')) for profile in (profile_directory(),))
    terminals = list(set(p['name'] for p in board_panes.values()))
    return dict(hostname=socket.gethostname(), machineId=machine, domain=domain, active=active, unknown=unknown, historyExists=history_exists,
                references=records, unverified=unverified, owner=owner, ownerStarting=owner_starting(owner, terminals), terminals=terminals)


def preview(session_id, expected):
    info = inventory(session_id)
    proc = next((p for p in info['active'] if metadata_matches(expected, p, info['domain'])), None)
    if not proc or not proc.get('location'):
        raise ValueError('该进程已结束或原终端无法读取，请重新检查会话位置。')
    location = proc['location']
    output = subprocess.check_output(['tmux', '-L', location['server'], 'capture-pane', '-p',
                                      '-t', location['pane'], '-S', '-180'],
                                     stderr=subprocess.DEVNULL, timeout=5).decode('utf8', 'replace')
    # Check again after reading so a replaced process/pane cannot be presented as
    # the original session. This operation never attaches or sends terminal input.
    after = inventory(session_id)
    if not any(metadata_matches(expected, p, after['domain']) and p.get('location') == location for p in after['active']):
        raise ValueError('原终端状态已变化，请重新检查会话位置。')
    return dict(output=output[-80000:], location=location, hostname=info['hostname'], pid=proc['pid'])


def verified_process(session_id, expected):
    info = inventory(session_id)
    return next((p for p in info['active'] if metadata_matches(expected, p, info['domain'])), None)


def terminate_duplicate(session_id, expected):
    # Called only with a server-held, explicitly confirmed recovery plan. Send
    # SIGTERM to this exact Claude PID, never its shell, tmux server or job group.
    proc = verified_process(session_id, expected)
    if not proc:
        raise ValueError('待结束进程的身份已变化，请重新检查并确认。')
    os.kill(proc['pid'], signal.SIGTERM)
    for _ in range(30):
        if not verified_process(session_id, expected):
            return dict(terminated=True, pid=proc['pid'])
        time.sleep(0.2)
    raise ValueError('该 Claude 尚未退出，未执行强制结束。请检查原终端输出。')


def attach_existing(session_id, expected):
    proc = verified_process(session_id, expected)
    if not proc or not proc.get('location'):
        raise ValueError('原会话已结束或终端不可用，请重新检查会话位置。')
    location = proc['location']
    # Select the existing pane containing Claude, without running --resume or
    # creating another session. The web hub enforces read-only input centrally.
    readonly = bool(expected.get('readOnly'))
    if not readonly:
        subprocess.check_call(['tmux', '-L', location['server'], 'select-window', '-t', location['pane']], stdout=subprocess.DEVNULL)
        subprocess.check_call(['tmux', '-L', location['server'], 'select-pane', '-t', location['pane']], stdout=subprocess.DEVNULL)
    print('HPC connected', flush=True)
    os.environ['TERM'] = 'xterm-256color'
    args = ['tmux', '-L', location['server'], 'attach-session']
    os.execvp('tmux', args + ['-t', '=' + location['name']])


if __name__ == '__main__':
    session_id = sys.argv[1].lower()
    if not UUID.match(session_id):
        sys.exit('Invalid session ID')
    try:
        actions = dict(preview=preview, terminate=terminate_duplicate, attach=attach_existing)
        result = actions[sys.argv[2]](session_id, json.loads(base64.b64decode(sys.argv[3]))) if len(sys.argv) > 2 and sys.argv[2] in actions else inventory(session_id)
        print(json.dumps(result, ensure_ascii=True))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps(dict(error=str(error)), ensure_ascii=True))
        sys.exit(1)
