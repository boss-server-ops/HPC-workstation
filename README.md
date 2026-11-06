# HPC Workstation

在浏览器里管理 Linux HPC 上的 **Claude Code 会话和文件**。每个项目一张卡片，接着上次的对话继续；关闭网页后，会话留在服务器的 tmux 中。

**Windows 10/11 本地运行，Linux 服务器端执行。** 这是源码安装版，不是免安装 EXE，也不是公共多用户网站。第一次启动没有预置服务器或账号，每位使用者配置自己的 SSH 和 Claude。

## 功能

- 项目看板、常用项目、会话历史、新建对话、继续上次。
- 浏览器内终端、滚动查看输出、复制粘贴、查找并接回旧会话。
- 校内直连、校外 SSH 跳板机、本地校园 SOCKS5 三种连接方式。
- tmux 保留后台会话；核验节点身份、PID 和启动时间，防止看板重复拉起同一会话。
- 独立文件管理页：目录浏览、拖放上传、多文件队列、取消上传、下载、新建文件夹、复制路径。
- 本地后台自动启动、健康检查和异常重启；干净源码 ZIP 打包。

## 快速开始

### 1. 准备环境

| 位置 | 需要什么 |
| --- | --- |
| Windows 电脑 | [Node.js 22 或更新的 LTS](https://nodejs.org/)（64 位，含 npm）、Windows OpenSSH 客户端 |
| Linux 服务器 | Python 3.6+、bash、tmux、已安装并登录的 Claude Code |
| 连接 | 可通过 SSH 密钥或 SSH agent 非交互登录，已核对服务器主机指纹 |

请在集群允许交互任务的节点上使用。看板不会安装 Claude、提供订阅或代替学校 VPN；服务器访问模型 API 的网络需另行配置。

### 2. 下载并安装

在本仓库选择 **Code → Download ZIP** 并完整解压，双击 `Install.cmd`；或运行：

```powershell
git clone https://github.com/boss-server-ops/HPC-workstation.git
cd HPC-workstation
.\Install.cmd
```

安装器执行锁定版本的 `npm ci`，验证本机终端组件，创建桌面和 Windows 登录启动快捷方式，然后打开看板。默认地址：**http://127.0.0.1:43127/**。之后使用桌面快捷方式或 `Start.cmd`。

如果已有其他看板占用默认端口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -Port 43227 -StatusPort 43228
```

不想自动启动时添加 `-NoAutoStart`。首次安装需访问 npm registry；node-pty 若无法使用预编译组件，需安装匹配平台的编译工具或改用支持的 Node LTS。Windows x64 是主要目标，ARM64 未完成真机验证。

### 3. 配置自己的 SSH

在 `%USERPROFILE%\.ssh\config` 添加别名，替换以下示例值：

```sshconfig
Host my-hpc
    HostName 192.0.2.10
    User researcher
    Port 22
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
```

`192.0.2.10` 是文档示例地址，不能直接连接。向管理员确认主机指纹后，先登录一次，再检查无交互登录：

```powershell
ssh -o HostKeyAlias=192.0.2.10 my-hpc
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o HostKeyAlias=192.0.2.10 my-hpc "echo SSH_OK"
```

HPC 登录使用私钥或已解锁的 agent；网页跳板机密码框不用于 HPC 密码或私钥口令。不要上传私钥到仓库。

### 4. 网页设置

打开「**配置我的服务器**」，参考 [config.example.json](config.example.json)：

```json
{
  "host": "my-hpc",
  "nodeAddress": "192.0.2.10",
  "hostKeyAlias": "",
  "connectionMode": "direct",
  "proxyPort": 1080,
  "jump": { "host": "", "port": 22, "username": "", "fingerprint": "" },
  "nodes": [],
  "claude": { "command": "claude", "configDir": ".claude" }
}
```

依次点击 **保存配置 → 验证并登记节点 → 读取我的项目**。

- `host`：本机 SSH 别名，提供登录用户名和密钥。
- `nodeAddress`：固定节点的 IP 或域名，避免负载均衡入口把 tmux 分配到另一台机器。
- `claude.configDir`：Claude 资料目录，相对远端家目录或使用绝对路径。
- `claude.command`：默认 `claude`，也可用自己在 `.bashrc` 定义的函数名，不填参数。
- `nodes`：初次留空，验证后由看板登记节点身份。

## 选择连接方式

| 模式 | 用途 | 配置 |
| --- | --- | --- |
| `direct` | 校内网络或已连接的系统 VPN | 固定 HPC 节点与 SSH 别名 |
| `jump` | 经 SSH 跳板机进入 HPC | `jump.host`、`username`、`port` 和已核对的 SHA256 主机指纹 |
| `proxy` | 校园客户端提供本地 SOCKS5 | `proxyPort` 填 SOCKS5 端口，`nodeAddress` 使用 IPv4 |

校园 SOCKS 示例：先连接校园客户端，再将 `connectionMode` 设为 `proxy`、`proxyPort` 设为该客户端的端口（如 1080）。这只改变看板的 SSH 连接，不修改电脑全局网络，也不自动把服务器的模型 API 请求转发到电脑。

跳板机需允许转发到 HPC 的 22 端口。网页跳板登录使用密码，断线后重新登录；密码不写入配置。HPC 端口目前固定为 22。首次主机指纹登记、多节点配置和跳板示例见 **[完整使用指南](使用指南.md)**，也可双击 `使用指南.html` 离线查看。

## 文件上传和下载

侧栏进入「**文件管理**」，先打开目标目录，再将文件拖到上传区域或文件列表即可上传，也可点击「上传文件」。

- 支持多文件依次上传、进度、取消；显示「HPC 已保存」才算完成。
- 单文件最多 20 GiB；同名文件拒绝覆盖。文件夹请先压缩。
- 下载通过浏览器保存；可复制当前目录或多个选中文件的远端绝对路径。
- 上传过程中保持页面和网络在线；文件操作使用你的 SSH 账号权限。

## 会话保留和恢复

关闭网页、看板或本机电脑通常只断开查看连接，服务器上的 tmux/Claude 会继续运行。服务器重启、进程被清理或资源限制仍可能终止任务；恢复历史不等于恢复内存中的任务。

「继续上次」优先接回原进程。若会话本身卡住，使用终端里的重启/恢复功能，先查看将结束的进程再确认；只点击重连不会重启 Claude。重复实例会触发只读保护，请用「找回旧会话」核实。不要删除占用记录来强行绕过保护。

每个安装使用一个 Claude 资料目录。多个节点应共享同一 Linux 家目录和历史目录。普通 SSH 终端手工启动的重复实例仍可能造成冲突；保护机制不能强制约束所有外部程序。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 重启电脑后网页打不开 | 运行 `Start.cmd`；检查 `data/server-error.log`、`data/supervisor.log` |
| `Permission denied (publickey)` | 确认 SSH 用户名、私钥、agent，先让上述 BatchMode 测试成功 |
| Host key verification failed | 向管理员核对节点指纹，使用相同 HostKeyAlias 登记；不要关闭校验 |
| 校园 SOCKS 未开启 | 重新连接校园客户端，确认端口是 SOCKS5 而不是 HTTP |
| Claude 报 API error / retry | SSH 能连不代表模型 API 可达；检查服务器内 Claude 的登录、代理和目标服务 |
| 终端只读 | 检查其他浏览器是否占用输入，或是否存在重复 Claude 进程 |
| 上传同名文件失败 | 默认防覆盖，请改名或选择其他目录 |
| 端口被占用 | 使用两个空闲端口重新运行安装器；不会自动关闭其他安装 |

## 更新、停止和卸载

先 `Stop.cmd`，然后 `git pull` 或覆盖新版源码，再运行 `Install.cmd`（自定义端口仍需传入原参数）。保留自己的 `data/`。不要同时运行两个使用同一端口的安装。

`Stop.cmd` 只停止本目录的本地看板。`Uninstall.cmd` 还会移除快捷方式，保留数据及远端会话。首次连接会在远端私有目录 `~/.local/state/hpc-claude-board/runtime-v3/` 部署辅助脚本。

## 隐私与发布

仓库仅包含源码、合成测试和示例配置，不含发布者的 SSH 配置、私钥、密码、API Key、节点身份、项目列表、会话历史或运行日志。安装后生成的 `data/` 属于使用者本人，已被 Git 忽略。

再次分享时，运行 `npm run package` 生成白名单 ZIP 和 SHA256 校验文件，不要压缩使用中的整个目录。服务只监听 `127.0.0.1`，写接口校验来源与令牌；不要自行暴露成公网公共服务。

本版发布 Windows 浏览器工作台；个人定制的 Android APK、多账号 A/B 切换、特定服务器代理与京东云分流配置不随包发布。

## 开发和验证

```powershell
npm ci
# 测试需 Python 3.9+；可用 HPC_TEST_PYTHON 指定本机解释器
npm test
python -m unittest discover -s test -p "test_*.py"
npm run package
```

测试使用临时目录与模拟 SSH，不需要真实服务器凭据，不会操作你的运行会话。Windows GitHub Actions 使用 Node 22/24 执行测试。

核心文件：`server.mjs`（本地 API）、`configuration.mjs`（独立配置）、`connection.mjs` / `local-proxy.mjs`（SSH 通道）、`protection.mjs` / `remote-guard.py`（会话保护）、`file-manager.mjs` / `remote-files.py`（文件传输）。

本项目是独立工具，非 Anthropic 或学校官方产品。源码采用 [MIT License](LICENSE)，第三方依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
