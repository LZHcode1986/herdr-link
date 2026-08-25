# Herdr Link

[![npm version](https://img.shields.io/npm/v/herdr-link.svg)](https://www.npmjs.com/package/herdr-link)
[![CI](https://github.com/LZHcode1986/herdr-link/actions/workflows/ci.yml/badge.svg)](https://github.com/LZHcode1986/herdr-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/herdr-link.svg)](./package.json)

[English](./README.md) | **简体中文**

Herdr Link 是运行在 Herdr 会话中的跨 Agent 按需互操作层。同一 workspace 内的 Agent 可以互相发现、交换协议化消息、关闭已完成的 pane——只通过 **3 个工具**，**零学习成本**。

提供 Pi（原生扩展）、OpenCode（插件 bundle）以及任意支持 MCP 的 Runtime 如 Claude Code / Codex / AGY（共享 stdio MCP server）的 Adapter。线上格式为 `herdr-link/1` 协议，唯一规范见 [`PROTOCOL.md`](./PROTOCOL.md)。

## 为什么选择 Herdr Link？

让 Agent 学会跨 Agent 通信的常规方式是给它官方 Herdr Skill。这可行，但有一笔随每个 Agent、每个会话不断重复支付的成本：

- Agent 必须先**阅读 Skill 文档并思考如何驱动 CLI**，然后才谈得上真正通信；
- 这些推理过程**每次使用都在消耗 token 并增加延迟**；
- 使用知识靠模型**反复自行推导**，而不是直接交给它。

Herdr Link 把这一步彻底去掉。Adapter 直接给模型 3 个自描述工具，并自动注入一份紧凑的通信契约：

| | 官方 Herdr Skill 路线 | 使用 Herdr Link |
|---|---|---|
| Agent 需要学什么 | Skill 文档 + CLI 用法 | 无需学习——直接调用工具 |
| 第一条消息之前 | 用法推理（token + 延迟） | 一次工具调用 |
| 空闲期上下文开销 | 加载时携带 Skill 内容 | 仅一个极小的 dormant gateway |
| 对端寻址 | 每次临时推导 | `herdr_link_peers` 直接返回 live named agents |

一句话总结：

- **更少消耗。** 无需阅读、无需推导。dormant 态下模型只看到一个极小的 `herdr_link` gateway——无契约、无 schema；激活后也只注入一段简短契约，而不是一本手册。
- **更快通讯。** 发现对端、发送协议化消息、关闭 pane 都是一次直接的工具调用——中间没有任何多步 CLI 编排。
- **无感接入（零推理）。** 用户显式提出 Herdr 需求、或收到 inbound `herdr-link/1` 消息时自动激活；回复通过 `reply_to` 关联，Agent 不需要自己发明簿记机制。

## 工作方式

每种 Runtime 都呈现同样的惰性两级能力面：

```text
Agent A → herdr_link {}                    # 激活（幂等）
Agent A → herdr_link_send(to="B", ...)     # status "sent"
Agent B → （收到 inbound wrapper）herdr_link {}   # 自动激活触发
Agent B → herdr_link_send(to="A", reply_to=<received id>, ...)
任意一方 → herdr_link_close(agent="worker-a")   # 最终 send 返回 sent 之后的工具步骤
```

- **Dormant 层**：只有 `herdr_link` gateway 可见；空参 `{}` 调用一次性激活当前 session（幂等、纯内存态）。
- **Active 层**：`herdr_link_peers`、`herdr_link_send`、`herdr_link_close`，外加紧凑 Communication Contract。每次调用都经 Herdr 实时解析身份/workspace 并执行同 workspace guard。

Herdr Link 不决定 Agent 应该做什么，也不负责 Agent 的创建、调度、模型选择或回收——它只是消息层。

## 安装

### Pi（原生扩展）

```bash
pi install git:github.com/LZHcode1986/herdr-link          # 全局
pi install -l git:github.com/LZHcode1986/herdr-link       # 仅当前项目
```

手动/开发加载：

```bash
mkdir -p ~/.pi/agent/extensions/herdr-link
cp src/pi.ts ~/.pi/agent/extensions/herdr-link/index.ts
cp src/herdr.ts src/protocol.ts ~/.pi/agent/extensions/herdr-link/
# 或：pi --extension /path/to/herdr-link/src/pi.ts
```

安装后 Adapter 注册 `herdr_link` gateway 与三个 Tier 1 工具；每个 session 开始时 Tier 1 处于 inactive，模型调用 `herdr_link {}` 后启用并注入契约。

### OpenCode（单文件插件）

OpenCode 把插件目录里**每个文件**都当作 plugin 加载，因此必须部署预构建的单文件 bundle——绝不能平铺源文件：

```bash
npm install -g herdr-link    # 或源码构建：npm run build:opencode
cp "$(npm root -g)/herdr-link/dist/herdr-link.opencode.js" \
   ~/.config/opencode/plugins/herdr-link.js
```

OpenCode 没有按 session 启停工具的 API，因此 Adapter 采用**single-gateway dispatcher** 呈现：`{}` 激活，之后 `{"action":"peers"|"send"|"close", ...}` 分发到同一控制层。契约只注入已激活 session 的 system prompt（按 `sessionID` 记忆的内存态；server 重启回到 dormant）。

### Claude Code / Codex / AGY（共享 stdio MCP server）

没有原生自定义工具注册面的 Runtime 共用同一个零依赖 stdio MCP server，以本包的 `bin` 发布：

```bash
npx -y herdr-link           # 在 stdio 上启动 MCP server
```

注册 namespace 必须用 `herdr_link`（下划线）。各 host 呈现形态不同：Claude Code / Codex 以前缀函数（`mcp__herdr_link__<tool>`）呈现，AGY 经原生 `call_mcp_tool` wrapper 调用——入参、出参与错误语义完全一致。各 host 的注册配置与 Tier-0 hint 接线（launcher 参数 / SessionStart hook / PreInvocation hook）见 [`docs/mcp-wiring.md`](./docs/mcp-wiring.md)。

MCP 同样是惰性呈现：非 Herdr 环境 `tools/list` 返回空集；Herdr managed pane 内 dormant 时只列出 gateway；激活后发射一次 `notifications/tools/list_changed`（不响应刷新的 host 可继续通过 gateway action 分发保持全功能）。

## 环境要求

运行进程必须由 Herdr 在 managed pane 中启动：

| 变量 | 用途 |
|---|---|
| `HERDR_ENV=1` | 确认处于 Herdr 环境 |
| `HERDR_BIN_PATH` | 当前 Herdr binary 路径；失效时返回 `NOT_IN_HERDR` |
| `HERDR_PANE_ID` | caller pane，用于实时解析 self identity 与权威 workspace |

- 非 Herdr managed pane 中所有 Adapter 均为完全 no-op：Pi/OpenCode 不注册任何工具，MCP 返回空工具集；
- Herdr 环境 dormant 态下，模型侧只有 `herdr_link` gateway 可见；
- **Self identity bootstrap**（PROTOCOL.md §6.3）：用户手动启动、已被 Herdr 识别但尚无合法 Agent Name 的 agent，会被自动赋一个生成的 `hl-*` 名字（Adapter 启动时执行一次 `ensureSelfName()`，通信路径内另有 fallback）。已有名字绝不改写、不持久化；bootstrap 失败时 Link 以 `SELF_UNNAMED` 报错；
- 运行期失败通过 Link error 返回（`NOT_IN_HERDR` / `SELF_UNNAMED` / `PEER_NOT_FOUND` / `SEND_FAILED` / `CLOSE_FAILED`）。

## 错误模型

| Code | 含义 |
|---|---|
| `NOT_IN_HERDR` | Herdr 环境不可用（变量缺失、binary 失效/被删除、transport 失败、非法 JSON） |
| `SELF_UNNAMED` | Herdr Link 已尝试建立稳定 Agent Name（self identity bootstrap，PROTOCOL.md §6.3）但失败——occupant 尚未被 Herdr 检测或自动命名未成功 |
| `PEER_NOT_FOUND` | 目标不是当前 workspace 内的 live named peer（不存在/非法名/其他 workspace——对模型不可区分） |
| `SEND_FAILED` | guard 通过后 Herdr 未接受 message prompt |
| `CLOSE_FAILED` | 目标已解析到 pane，但 Herdr pane close 失败 |

错误是本地 tool failure，不是跨 Agent 消息类型；不自动重试、不 fallback、不维护 pending 状态。

## 开发

仓库包含完整的可审计与可扩展组件（`test/`、`tsconfig.json`、构建脚本）。npm 发布包由 `package.json` 的 `files` allowlist 控制。

```bash
npm install
npm run typecheck
npm test                    # node --experimental-strip-types --test test/*.test.ts
npm run build:opencode      # dist/herdr-link.opencode.js
npm run build:mcp           # dist/herdr-link.mcp.js
```

目录结构：

```text
PROTOCOL.md                  协议唯一规范（Envelope、两级能力面、Contract、工具语义、错误模型）
src/protocol.ts              协议核心：类型、envelope/wrapper 构建、错误、COMMUNICATION_CONTRACT
src/herdr.ts                 Herdr CLI 控制层：live identity/workspace 解析、same-workspace guard
src/pi.ts                    Pi Runtime Adapter：gateway + deferred Tier 1（setActiveTools），激活后注入契约
src/opencode.ts              OpenCode Runtime Adapter：single-gateway dispatcher + 按 sessionID 契约注入
src/mcp.ts                   共享 stdio MCP server：JSON-RPC、惰性工具列表、gateway dispatch
docs/mcp-wiring.md           Claude Code / Codex / AGY 注册与 Tier-0 hint 接线指南
dist/*.js                    预构建 bundle（opencode 插件、MCP server bin）
scripts/mcp-probe.mjs        stdio 握手排障探针
```

分层原则：`protocol.ts` 零 Herdr IO；`herdr.ts` 只做 Herdr 控制面调用（`execFile` argv 数组，无 shell）；`pi.ts` / `opencode.ts` / `mcp.ts` 各自只做 Runtime 接线。activation 是各 Adapter 内存中的 session 局部状态：不持久化、不跨 session 恢复。

## Non-goals（V1）

不提供：agent 创建/调度/回收、模型选择、workflow/task/stage 状态、业务结果 schema、evidence/receipt/review、持久消息队列、跨机器传输、权限审批、离线投递、可靠投递确认、跨 session 持久化、**跨 workspace 的 discovery/send/close**（属官方 Herdr Skill / CLI 控制面）、workspace/topology 管理面操作。业务 payload 放入 `message` 字段，Link 不解释其语义。

## 许可证

[MIT](./LICENSE)
