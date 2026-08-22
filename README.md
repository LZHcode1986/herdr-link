# Herdr Link

**Herdr Link 是运行在 Herdr 会话中的跨 Agent 互操作层**：每种 Agent Runtime 通过自己的 Adapter 自动获得统一的通信契约，并使用相同的 peer discovery、message send/reply 与 pane close 语义。

- **协议**：`herdr-link/1`（唯一规范见 [`PROTOCOL.md`](./PROTOCOL.md)）
- **Runtime Adapter**：Pi（Extension API）、OpenCode（Plugin，单文件 bundle）
- **设计文档**：保存在本机开发环境的 `.docs/` 目录，不作为发布物。

Herdr Link 不负责决定 Agent 应该做什么，也不负责 Agent 的创建、模型选择、调度、复用策略或工作流状态。它只提供跨 Agent 协作所需的最小公共能力。

## V1 能力

| 能力 | 说明 |
|---|---|
| Protocol Awareness | Agent 不依赖 Skill，自动知道 Herdr Link 通信规范（契约注入 system prompt） |
| Identity & Peer Discovery | `herdr_link_peers` 返回当前 Agent Name 与可通信的 peer 列表 |
| Message Send / Receive | `herdr_link_send` 投递 `herdr-link/1` envelope；目标 Agent 由契约识别 |
| Reply Correlation | 回复通过 `reply_to` 与原消息关联 |
| Pane Close | `herdr_link_close` 按 Agent Name 显式关闭目标 pane（仅能力，不判断时机） |

### 最小互通示例

```text
Agent A → herdr_link_send → Agent B
Agent B → herdr_link_send(reply_to=...) → Agent A
herdr_link_close("worker-a")
```

## 安装（Pi Adapter）

推荐使用 Pi package 安装到全局扩展目录（所有项目可用）：

```bash
pi install git:github.com/LZHcode1986/herdr-link
```

仅当前项目安装：

```bash
pi install -l git:github.com/LZHcode1986/herdr-link
```

### Development/manual installation

以下方式仅供开发或手动安装场景。将 `src/pi.ts` 作为 Pi Extension 加载；多文件扩展须使用子目录 + `index.ts` 入口：

```bash
# 方式一：复制到全局扩展目录（开发/手动场景）
mkdir -p ~/.pi/agent/extensions/herdr-link
cp src/pi.ts ~/.pi/agent/extensions/herdr-link/index.ts
cp src/herdr.ts src/protocol.ts ~/.pi/agent/extensions/herdr-link/

# 方式二：启动时显式加载（临时验证）
pi --extension /path/to/herdr-link/src/pi.ts
```

安装或加载后，Agent 的 system prompt 自动包含 Communication Contract，并获得三个工具：`herdr_link_peers`、`herdr_link_send`、`herdr_link_close`。

## 安装（OpenCode Adapter）

OpenCode 自动扫描 `~/.config/opencode/plugins/`（Bun 运行时支持 TS，扫描目录中**每个文件**都会当作 plugin 加载）。因此必须使用**单文件 bundle**（含三个模块），不能平铺多个源文件：

```bash
# 构建单文件 bundle（依赖 esbuild，仅开发机需要）
npm install && npm run build:opencode

# 部署：拷贝 bundle 到 opencode 插件目录
cp dist/herdr-link.opencode.js ~/.config/opencode/plugins/herdr-link.js
```

部署或重启 opencode 后，agent 获得相同三个工具与 Communication Contract 注入（`experimental.chat.system.transform`）。

### 身份自愈（OpenCode 专属）

Herdr 对 opencode pane 的 agent 登记会在 pane 内进程组变化时整体重置并丢失名字（重启 opencode 后必现）。插件会自动把当前 pane 的期望名持久化在 `~/.local/state/herdr-link/opencode-agent-names.json` 并在三个时机自动恢复：plugin 启动校验、工具调用遇到 `SELF_UNNAMED` 时先恢复再重试一次、每 30 秒兜底检查。若原名已被其他 agent 占用，则回退为 `<name>-2` 等后缀并更新记录。因此用 `herdr agent rename <pane> <name>` 改名一次即可长期生效；清名到自愈之间的短暂窗口内发来的消息仍可能投递失败。

## 环境要求

运行环境必须由 Herdr managed pane 提供：

| 变量 | 用途 |
|---|---|
| `HERDR_ENV=1` | 确认处于 Herdr 环境 |
| `HERDR_BIN_PATH` | 当前 Herdr binary 路径（CLI wrapper 执行） |
| `HERDR_PANE_ID` | caller pane，用于解析 self identity |

非 Herdr managed pane 中，各 Runtime Adapter 均不注册任何工具、不注入 Communication Contract（no-op）；运行期间的 Herdr 操作失败才通过 Link error 返回（`NOT_IN_HERDR` / `SELF_UNNAMED` / `PEER_NOT_FOUND` / `SEND_FAILED` / `CLOSE_FAILED`）。

## 开发

发布仓库仅包含扩展源码及发布所需的 `package.json`、`PROTOCOL.md`、`README.md` 与 `.gitignore`。完整开发环境（含 `test/`、`tsconfig.json` 等）保留在本机，不作为发布物。依赖安装、类型检查和单元测试等命令仅适用于本机开发副本，不是发布仓库的使用步骤。

### 发布仓库结构

```text
PROTOCOL.md          协议唯一规范（Envelope、Contract、工具语义、错误模型）
README.md            使用说明与安装指引
package.json         扩展包元数据
.gitignore           发布仓库忽略规则
src/protocol.ts      协议核心：类型、buildEnvelope、错误、COMMUNICATION_CONTRACT
src/herdr.ts         Herdr CLI 控制层：identity、peers、send、close
src/pi.ts            Pi Runtime Adapter：契约注入 + 三个工具注册
src/opencode.ts      OpenCode Runtime Adapter：契约注入 + 三个工具注册
dist/herdr-link.opencode.js  OpenCode 单文件 bundle（esbuild 构建产物）
```

分层原则：`protocol.ts` 零 Herdr IO；`herdr.ts` 只做 Herdr 控制面调用（`execFile` argv 数组，无 shell）；`pi.ts` 只做 Extension 接线，无长期状态。

## 错误模型

| Code | Meaning |
|---|---|
| `NOT_IN_HERDR` | 当前 Runtime 不在 Herdr 环境 |
| `SELF_UNNAMED` | 当前 Agent 没有稳定 Agent Name |
| `PEER_NOT_FOUND` | 目标 Agent Name 不存在或不是 live peer |
| `SEND_FAILED` | Herdr 未接受 message prompt |
| `CLOSE_FAILED` | 无法解析目标或 Herdr pane close 失败 |

错误是本地 tool failure，不是跨 Agent 消息类型；不自动重试、不 fallback、不维护 pending 状态。

## Non-goals（V1）

不提供：agent 创建/调度/回收、模型选择、workflow/task/stage 状态、业务结果 schema、evidence/receipt/review、持久消息队列、跨机器传输、权限审批、离线投递、可靠投递确认、跨 session 持久化。上层业务需要结构化 payload 时放入 `message` 字段，Link 不解释其语义。