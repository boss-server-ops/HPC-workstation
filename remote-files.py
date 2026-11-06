"""Bounded metadata and streamed file transfer, compatible with HPC Python 3.6."""
import base64
import hashlib
import json
import os
import stat
import sys
import tempfile
import signal

MAX_BYTES = 20 * 1024 * 1024 * 1024


def reply(value):
    sys.stdout.buffer.write((json.dumps(value, ensure_ascii=True) + '\n').encode('ascii'))
    sys.stdout.buffer.flush()


def absolute(value):
    if not isinstance(value, str) or '\x00' in value or len(value) > 4096:
        raise ValueError('无效路径')
    value = os.path.expanduser(value or '~')
    if not os.path.isabs(value):
        raise ValueError('请输入绝对路径，或以 ~/ 开头的路径')
    return os.path.normpath(value)


def filename(value):
    if not isinstance(value, str) or not value or value in ('.', '..') or '/' in value or '\x00' in value or len(value.encode('utf8')) > 255:
        raise ValueError('无效文件名')
    return value


def describe(entry):
    info = entry.stat(follow_symlinks=False)
    link = stat.S_ISLNK(info.st_mode)
    target_dir = entry.is_dir() if link else stat.S_ISDIR(info.st_mode)
    regular = entry.is_file() if link else stat.S_ISREG(info.st_mode)
    return dict(name=entry.name, path=entry.path, directory=target_dir, file=regular,
                symlink=link, size=info.st_size, modified=info.st_mtime,
                permissions=stat.filemode(info.st_mode))


def listing(params):
    directory = os.path.realpath(absolute(params.get('path', '~')))
    hidden = params.get('hidden') is True
    limit = 10000
    rows = []
    skipped = 0
    with os.scandir(directory) as entries:
        for entry in entries:
            if not hidden and entry.name.startswith('.'):
                continue
            if len(rows) >= limit:
                raise ValueError('这个目录超过 10000 项，请进入更具体的子目录')
            try:
                rows.append(describe(entry))
            except (OSError, UnicodeError):
                skipped += 1
    rows.sort(key=lambda item: (not item['directory'], item['name'].lower(), item['name']))
    return dict(path=directory, parent=os.path.dirname(directory), home=os.path.expanduser('~'), entries=rows, skipped=skipped)


def upload(params):
    def interrupted(signum, frame):
        raise InterruptedError('上传连接中断')
    for label in ('SIGTERM', 'SIGHUP'):
        if hasattr(signal, label):
            signal.signal(getattr(signal, label), interrupted)
    directory = os.path.realpath(absolute(params['path']))
    name = filename(params['name'])
    size = params['size']
    if not isinstance(size, int) or isinstance(size, bool) or not 0 <= size <= MAX_BYTES:
        raise ValueError('文件大小超过限制（每个文件最大 20 GiB）')
    destination = os.path.join(directory, name)
    if os.path.lexists(destination):
        raise FileExistsError('同名文件已存在，请改名或选择其他目录；原文件未覆盖')
    fd, temporary = tempfile.mkstemp(prefix='.hpc-upload-', suffix='.part', dir=directory)
    digest = hashlib.sha256()
    try:
        with os.fdopen(fd, 'wb') as out:
            left = size
            while left:
                chunk = sys.stdin.buffer.read(min(left, 256 * 1024))
                if not chunk:
                    raise ValueError('上传中断，未保存不完整文件')
                out.write(chunk)
                digest.update(chunk)
                left -= len(chunk)
            if sys.stdin.buffer.read(1):
                raise ValueError('上传大小与声明不一致')
            out.flush()
            os.fsync(out.fileno())
        # Publishing a hard link is atomic and refuses an existing file/symlink,
        # including a same-name file created while this upload was in progress.
        os.link(temporary, destination)
        return dict(path=destination, size=size, sha256=digest.hexdigest())
    finally:
        os.unlink(temporary)


def download(params):
    source = absolute(params['path'])
    fd = os.open(source, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0))
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('只能下载普通文件；目录请先打包')
        if info.st_size > MAX_BYTES:
            raise ValueError('文件超过 20 GiB，请使用专用传输工具')
        reply(dict(ok=True, path=source, name=os.path.basename(source), size=info.st_size))
        left = info.st_size
        while left:
            chunk = stream.read(min(left, 256 * 1024))
            if not chunk:
                raise IOError('文件在下载期间被截短')
            sys.stdout.buffer.write(chunk)
            left -= len(chunk)
        sys.stdout.buffer.flush()


def main(action, params):
    try:
        if action == 'download':
            download(params)
            return
        if action == 'list':
            result = listing(params)
        elif action == 'stat':
            source = absolute(params['path'])
            info = os.stat(source)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('只能下载普通文件；目录请先打包')
            if info.st_size > MAX_BYTES:
                raise ValueError('文件超过 20 GiB，请使用专用传输工具')
            result = dict(path=source, name=os.path.basename(source), size=info.st_size)
        elif action == 'upload':
            result = upload(params)
        elif action == 'mkdir':
            target = os.path.join(os.path.realpath(absolute(params['path'])), filename(params['name']))
            os.mkdir(target, 0o755)
            result = dict(path=target)
        else:
            raise ValueError('不支持的文件操作')
        reply(dict(ok=True, result=result))
    except Exception as error:
        # Download errors after its first header must never become file bytes.
        if action == 'download':
            sys.stderr.write(str(error) + '\n')
        else:
            reply(dict(ok=False, error=str(error), code='EXISTS' if isinstance(error, FileExistsError) else 'FILE_ERROR'))
        sys.exit(1)


if __name__ == '__main__':
    main(sys.argv[1], json.loads(base64.b64decode(sys.argv[2]).decode('utf8')))
