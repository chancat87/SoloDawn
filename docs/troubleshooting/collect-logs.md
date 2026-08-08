# 收集诊断日志

排查工作流类问题（例如「工作区里只有 `.git`、没有项目文件」）时，请按本文收集三份材料。
三份都给最有用；只给其中一份也比没有强。

---

## 一、后端运行日志（最重要）

SoloDawn 的后端把日志写到**标准输出，不落文件**。所以必须在**启动时**就把它接住 ——
事后再去找是找不到的。

### 提高日志级别再启动

默认只有 `info`。排查问题请开 `debug`：

**Windows PowerShell**

```powershell
$env:RUST_LOG="debug"; .\solodawn.exe *> solodawn.log
```

**macOS / Linux**

```bash
RUST_LOG=debug ./solodawn 2>&1 | tee solodawn.log
```

**从源码跑（开发模式）**

```bash
RUST_LOG=debug pnpm run dev 2>&1 | tee solodawn.log
```

然后**复现一次问题**，结束后把 `solodawn.log` 发过来。

> 日志过滤规则是 `warn,server=<级别>,services=<级别>,db=<级别>,executors=<级别>,...`。
> 如果 `debug` 还不够，可以用 `RUST_LOG=trace`，但输出量会大很多。

---

## 二、终端输出记录（判断 Agent 到底做了什么）

每个终端的完整输出会**持久化到数据库**，事后仍可导出 —— 这是判断
「AI 到底有没有写文件、写到哪儿去了」最直接的证据。

### 方式 A：界面导出

进入出问题的工作流 → 打开对应终端 → 「查看历史记录」，把内容复制出来。

### 方式 B：接口导出（推荐，内容完整）

服务运行时执行，把 `<终端ID>` 换成实际 ID（在浏览器地址栏或界面上能看到）：

```bash
curl "http://127.0.0.1:23456/api/terminals/<终端ID>/logs?limit=5000" -o terminal-log.json
```

> 端口默认 `23456`。若设置过 `BACKEND_PORT` 或 `PORT` 环境变量，则以它为准；
> 启动日志里那行 `No PORT environment variable set, using default port 23456`
> 或实际监听地址可以确认。

---

## 三、数据库文件（可选，问题复杂时再给）

数据库里有工作流、任务、终端的完整状态，能还原「界面显示成功但磁盘为空」这类
状态不一致问题。

文件名固定是 **`db.sqlite`**，位置按平台：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\solodawn\solodawn\data\db.sqlite` |
| macOS | `~/Library/Application Support/ai.solodawn.solodawn/db.sqlite` |
| Linux | `~/.local/share/solodawn/db.sqlite` |

从源码以开发模式运行时，则在仓库根目录的 **`dev_assets/db.sqlite`**。

如果设置过 `SOLODAWN_ASSET_DIR` 环境变量，则以该目录为准。

> ⚠️ 数据库是 WAL 模式，复制时请把 `db.sqlite`、`db.sqlite-wal`、`db.sqlite-shm`
> 三个文件**一起**打包，否则可能读不到最新数据。
>
> ⚠️ 数据库里可能含有你配置的 API Key 等凭据。发送前请确认接收方可信，
> 或先在设置里删除模型配置再导出。

---

## 四、工作区现场（针对「只有 .git」类问题）

在出问题的工作目录里执行，把输出一并发来：

```bash
ls -la && echo "--- git status ---" && git status && echo "--- git log ---" && git log --oneline -5 && echo "--- worktree ---" && git worktree list && echo "--- HEAD ---" && git rev-parse --abbrev-ref HEAD
```

这能一次性区分几种完全不同的原因：仓库是空的（从未提交）、文件被提交了但工作区被清空、
处于 detached HEAD、还是根本就是另一个目录被当成了工作区。

---

## 附：一并说明这些信息

- 用的是哪个 CLI（Claude Code / Codex / OpenCode / 其他）及其版本；
- 工作流类型（自定义工作流 / AI 规划工作流）；
- 出问题的工作目录**完整路径**；
- 界面显示的状态 与 磁盘实际情况的差异。
