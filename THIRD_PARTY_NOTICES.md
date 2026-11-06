# Third-party components

This source distribution installs dependencies with `npm ci` from the public npm registry. Dependency versions and integrity hashes are recorded in `package-lock.json`. Dependencies are not embedded in the ZIP; their original license files are installed under `node_modules`.

| Component | Version | License reported by package metadata |
| --- | --- | --- |
| @xterm/xterm | 6.0.0 | MIT |
| @xterm/headless | 6.0.0 | MIT |
| @xterm/addon-fit | 0.11.0 | MIT |
| @xterm/addon-serialize | 0.14.0 | MIT |
| node-pty | 1.1.0 | MIT |
| ssh2 | 1.17.0 | MIT |
| ws | 8.21.3 | MIT |

Transitive dependencies may carry additional licenses; consult their package metadata and license files after installation. Node.js, Windows OpenSSH, Python, tmux, and Claude Code are separately installed products and retain their own licensing and service terms. This dashboard is an independent tool and is not an official Claude Code or HPC vendor product. The dashboard source is licensed under the MIT License in LICENSE.
