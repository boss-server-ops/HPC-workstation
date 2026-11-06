// Rebuild a clean share package from this explicit source-file allowlist.
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = path.dirname(fileURLToPath(import.meta.url));
export const releaseFiles = [
  'file-manager.mjs', 'remote-files.py', 'local-proxy.mjs',
  'public/files.html', 'public/files.js', 'public/files.css',
  'test/file-manager.test.mjs', 'test/local-proxy.test.mjs',
  'README.md', 'LICENSE', '使用指南.md', '使用指南.html', 'THIRD_PARTY_NOTICES.md',
  'Install.cmd', 'Install.ps1', 'Start.cmd', 'Run-Board.vbs', 'Start-Board.ps1',
  'Stop.cmd', 'Stop-Board.ps1', 'Uninstall.cmd', 'config.example.json',
  'package.json', 'package-lock.json', 'package-release.mjs', '.gitignore',
  'server.mjs', 'supervisor.mjs', 'configuration.mjs', 'connection.mjs', 'launch.mjs',
  'web-terminal.mjs', 'protection.mjs', 'recovery.mjs',
  'remote-index.py', 'remote-guard.py', 'remote-start.py',
  'public/index.html', 'public/app.js', 'public/web-terminal.js', 'public/style.css', 'public/setup.css', 'public/terminal.css', 'public/favicon.svg',
  'test/clipboard.test.mjs', 'test/configuration.test.mjs', 'test/protection.test.mjs',
  'test/recovery.test.mjs', 'test/setup.test.mjs', 'test/supervisor.test.mjs', 'test/writer.test.mjs',
  'test/test_index.py', 'test/test_guard.py', 'test/test_start.py',
];
if (process.platform !== 'win32') throw Error('Build this Windows release using Node.js on Windows.');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
assert.match(version, /^\d+\.\d+\.\d+$/);
const name = `HPC-Claude-Board-Windows-${version}`;
const output = path.join(root, 'dist');
await mkdir(output, {recursive:true});
const stage = await mkdtemp(path.join(os.tmpdir(), 'hpc-board-package-'));
try {
  const folder = path.join(stage, name);
  const sums = [];
  for (const file of releaseFiles) {
    assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
    const target = path.join(folder, file);
    await mkdir(path.dirname(target), {recursive:true});
    await copyFile(path.join(root, file), target);
    sums.push(createHash('sha256').update(await readFile(target)).digest('hex') + '  ' + file);
  }
  await writeFile(path.join(folder, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
  const script = path.join(stage, 'compress.ps1');
  await writeFile(script, "param([string]$Source,[string]$Destination)\n$ErrorActionPreference='Stop'\nCompress-Archive -LiteralPath $Source -DestinationPath $Destination -Force\n");
  const zip = path.join(output, name + '.zip');
  const result = spawnSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Source',folder,'-Destination',zip], {windowsHide:true,encoding:'utf8'});
  if (result.status !== 0) throw Error(result.stderr || result.error?.message || 'ZIP creation failed');
  const digest = createHash('sha256').update(await readFile(zip)).digest('hex');
  await writeFile(zip + '.sha256', digest + '  ' + path.basename(zip) + '\n');
  console.log(JSON.stringify({zip,files:releaseFiles.length+1,sha256:digest}));
} finally {
  // Only remove this freshly created staging directory inside the system temp directory.
  assert.equal(await realpath(path.dirname(stage)), await realpath(os.tmpdir()));
  assert.ok(path.basename(stage).startsWith('hpc-board-package-'));
  await rm(stage,{recursive:true,force:true});
}
