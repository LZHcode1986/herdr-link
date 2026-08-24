# Herdr Link

**Herdr Link 是运行在 Herdr 会话中的跨 Agent 按需互操作层**：平时只保留一个极小的 `herdr_link` gateway（dormant）；当用户显式要求使用 Herdr、或 Agent 收到 self-describing 的 `herdr-link/1` 消息时，才激活本 runtime session 内的 peers / send / close 能力。每种 Agent Runtime 通过自己的 Adapter 自动获得统一的通信契约与相同的 peer discovery、message send/reply 与 pane close 语义，且只在当前 workspace 内通信。

- **协议**：`herdr-link/1`（唯一规范见 [`PROTOCOL.md`](./PROTOCOL.md)）
- **Runtime Adapter**：Pi（Extension API，true deferred tools）、OpenCode（Plugin，single-gateway 呈现，单文件 bundle）、共享 stdio MCP server（Claude Code / Codex / AGY；listChanged 优先 + gateway fallback，接线与验证见 [docs/mcp-wiring.md](./docs/mcp-wiring.md)）
- **设计文档**：保存在本机开发环境的 `.docs/` 目录，不作为发布物。

Herdr Link 不负责决定 Agent 应该做什么，也不负责 Agent 的创建、模型选择、调度、复用策略或工作流状态。官方 Herdr Skill 不是正常使用的依赖——它仅是跨 workspace、topology 管理等高级操作的可选控制面。

## V1 能力

| 能力 | 说明 |
|---|---|
| 按需激活 | dormant 时模型只看到极小的 `herdr_link` gateway，无 Contract、无 Tier 1 schema；显式 Herdr intent 或 inbound Link 消息激活，once-per-runtime-session，内存态不持久化 |
| Scoped Peer Discovery | `herdr_link_peers` 返回 `{self:{name,state}, peers:[{name,state}]}`；只含当前 workspace 的 live named Agent；state 映射 Herdr authoritative 状态（`idle/working/blocked/done/unknown`），仅供观察 |
| Message Send / Receive | `herdr_link_send` 投递 `herdr-link/1` envelope（附 self-describing wrapper）；目标 Agent 由契约识别 envelope |
| Reply Correlation | 回复复用同一个 send 工具，通过 `reply_to` 与原消息关联；无独立 reply 工具 |
| Pane Close | `herdr_link_close` 按 Agent Name 显式关闭目标 pane；send-first、close 必须在后续工具步骤；仅能力，不判断时机 |
| Same-workspace Guard | peers/send/close 每次调用实时解析 live 记录并校验同 workspace；workspace 权威来自 `agent get`，不用可能过期的 `HERDR_WORKSPACE_ID` |

### 最小互通示例

```text
Agent A → herdr_link {}                    # 激活（幂等）
Agent A → herdr_link_send(to="B", ...)     # status "sent"
Agent B → （收到 inbound wrapper）herdr_link {} 激活后
Agent B → herdr_link_send(to="A", reply_to=<received id>, ...)
任意一方 → herdr_link_close(agent="worker-a")   # 在最终 send 返回 sent 之后的工具步骤
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

安装或加载后，Adapter 注册 `herdr_link` gateway 与三个 Tier 1 工具，但每个 session 开始时 Tier 1 处于 inactive（dormant 只呈现 gateway、不注入契约）；模型调用 `herdr_link {}` 后经 Pi 动态工具 API 启用 Tier 1 并注入 compact Communication Contract。

## 安装（OpenCode Adapter）

OpenCode 自动扫描 `~/.config/opencode/plugins/`（Bun 运行时支持 TS，扫描目录中**每个文件**都会当作 plugin 加载）。因此必须使用**单文件 bundle**，不能平铺多个源文件：

```bash
# 构建单文件 bundle（依赖 esbuild，仅开发机需要）
npm install && npm run build:opencode

# 部署：拷贝 bundle 到 opencode 插件目录
cp dist/herdr-link.opencode.js ~/.config/opencode/plugins/herdr-link.js
```

OpenCode 无公开的按 session 启停工具 API，因此采用 **single-gateway 呈现**：模型面只有一个 `herdr_link` dispatcher 工具——空参调用 `{}` 幂等激活当前 session，随后以 `{"action":"peers"|"send"|"close", ...}` 分发到同一控制层；compact Contract 仅注入已激活 session 的 system prompt（按 `sessionID` 记忆的内存态，server 重启回到 dormant）。

## 安装（共享 MCP Server：Claude Code / Codex / AGY）

三个无原生自定义工具注册面的 Runtime 共用同一个零依赖 stdio MCP server：

```bash
npm run build:mcp   # 产出 dist/herdr-link.mcp.js
```

MCP 注册配置与各 Runtime 的契约注入通道（Claude Code = launcher 参数/文件、Codex = SessionStart hook、AGY = PreInvocation hook）见 [docs/mcp-wiring.md](./docs/mcp-wiring.md)。host 注册 namespace 为 `herdr_link`（`serverInfo.name` 为 `herdr-link`，两者不同）：Claude Code / Codex 以 `mcp__herdr_link__<tool>` 前缀函数呈现；AGY 经原生 `call_mcp_tool` wrapper 以 `ServerName="herdr_link"` + canonical `ToolName` 调用（协议 §4.5；Codex 须按 docs 指引显式 `env_vars` 转发 `HERDR_*`），入参/出参与错误语义同其余 Adapter 完全一致。

MCP 呈现为 lazy activation：非 Herdr 环境 `tools/list` 返回空集；Herdr 环境 dormant 时只列出 `herdr_link` gateway；gateway 调用 `{}` 后 server 发射一次 `notifications/tools/list_changed` 并在本连接内保持 active（Tier 1 进入 `tools/list`）；不响应刷新的 Host 可继续以 gateway action 分发保持全功能。

## 环境要求

运行环境必须由 Herdr managed pane 提供：

| 变量 | 用途 |
|---|---|
| `HERDR_ENV=1` | 确认处于 Herdr 环境 |
| `HERDR_BIN_PATH` | 当前 Herdr binary 路径（CLI wrapper 执行）；失效时返回 `NOT_IN_HERDR` |
| `HERDR_PANE_ID` | caller pane，用于实时解析 self identity 与 authoritative workspace |

- 非 Herdr managed pane 中，各 Runtime Adapter 均为完全 no-op：Pi/OpenCode 不注册任何工具，MCP `tools/list` 返回空集；
- Herdr 环境 dormant 态下，模型侧只有 `herdr_link` gateway 可见；
- 运行期间的 Herdr 操作失败通过 Link error 返回（`NOT_IN_HERDR` / `SELF_UNNAMED` / `PEER_NOT_FOUND` / `SEND_FAILED` / `CLOSE_FAILED`）。

## 开发

仓库包含完整的可复核开发组件（`test/`、`tsconfig.json`）；npm 发布包由 `package.json` 的 `files` allowlist 控制，当前 `package.json` 仍标记为 `private`、尚未进入 npm 发布。依赖安装、类型检查和单元测试命令均可在仓库副本中复现。

### 仓库结构

```text
PROTOCOL.md          协议唯一规范（Envelope、两级能力面、Contract、工具语义、错误模型）
README.md            使用说明与安装指引
package.json         扩展包元数据
.gitignore           发布仓库忽略规则
src/protocol.ts      协议核心：类型、buildEnvelope/inbound wrapper、错误、COMMUNICATION_CONTRACT
src/herdr.ts         Herdr CLI 控制层：live identity/workspace 解析、same-workspace guard、peers、send、close
src/pi.ts            Pi Runtime Adapter：gateway + deferred Tier 1（setActiveTools）+ 仅激活后注入契约
src/opencode.ts      OpenCode Runtime Adapter：single-gateway 呈现 + 按 sessionID 的契约注入
src/mcp.ts           共享 stdio MCP server（Claude Code / Codex / AGY）：JSON-RPC + lazy tool list + gateway dispatch
docs/mcp-wiring.md   MCP Adapter 三家 Runtime 的注册与契约注入接线指南
dist/herdr-link.opencode.js  OpenCode 单文件 bundle（esbuild 构建产物）
dist/herdr-link.mcp.js       共享 MCP server 单文件 bundle（esbuild 构建产物）
test/                 可复核的协议、Herdr、MCP、Pi、OpenCode 测试套件
tsconfig.json         类型检查与 TypeScript test 配置
```

分层原则：`protocol.ts` 零 Herdr IO；`herdr.ts` 只做 Herdr 控制面调用（`execFile` argv 数组，无 shell）；`pi.ts` / `opencode.ts` / `mcp.ts` 各自只做 Runtime 接线（工具注册、激活状态、契约注入、JSON-RPC 编解码）。activation 是各 Adapter 内存中的 session 局部状态：不持久化、不写文件、不跨 session 恢复。

## 错误模型

| Code | Meaning |
|---|---|
| `NOT_IN_HERDR` | Herdr 环境不可用（变量缺失、binary 失效/被删除、transport 失败、非法 JSON） |
| `SELF_UNNAMED` | 当前 Agent 没有稳定 Agent Name |
| `PEER_NOT_FOUND` | 目标不是当前 workspace 内的 live named peer（不存在/非法名/其他 workspace 对模型不可区分） |
| `SEND_FAILED` | guard 通过后 Herdr 未接受 message prompt |
| `CLOSE_FAILED` | 目标已解析到 pane，但 Herdr pane close 失败 |

错误是本地 tool failure，不是跨 Agent 消息类型；不自动重试、不 fallback、不维护 pending 状态。环境/transport 类失败归类为 `NOT_IN_HERDR`，不会被重包装成操作级错误码。

## Non-goals（V1）

不提供：agent 创建/调度/回收、模型选择、workflow/task/stage 状态、业务结果 schema、evidence/receipt/review、持久消息队列、跨机器传输、权限审批、离线投递、可靠投递确认、跨 session 持久化、**跨 workspace 的 discovery/send/close**（属官方 Herdr Skill / CLI 高级控制面）、workspace/topology 控制面操作。上层业务需要结构化 payload 时放入 `message` 字段，Link 不解释其语义。
