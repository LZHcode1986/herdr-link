# Herdr Link

**Herdr Link 是运行在 Herdr 会话中的跨 Agent 互操作层**：每种 Agent Runtime 通过自己的 Adapter 自动获得统一的通信契约，并使用相同的 peer discovery、message send/reply 与 pane close 语义。

- **协议**：`herdr-link/1`（唯一规范见 [`PROTOCOL.md`](./PROTOCOL.md)）
- **首个 Runtime Adapter**：Pi（Extension API）
- **设计文档**：[技术架构蓝图](.docs/Herdr_Link_Technical_Architecture_Blueprint.md)

Herdr Link 不负责决定 Agent 应该做什么，也不负责 Agent 的创建、模型选择、调度、复用策略或工作流状态。它只提供跨 Agent 协作所需的最小公共能力。

## V1 能力

| 能力 | 说明 |
|---|---|
| Protocol Awareness | Agent 不依赖 Skill，自动知道 Herdr Link 通信规范（契约注入 system prompt） |
| Identity & Peer Discovery | `herdr_link_peers` 返回当前 Agent Name 与可通信的 peer 列表 |
| Message Send / Receive | `herdr_link_send` 投递 `herdr-link/1` envelope；目标 Agent 由契约识别 |
| Reply Correlation | 回复通过 `reply_to` 与原消息关联 |
| Pane Close | `herdr_link_close` 按 Agent Name 显式关闭目标 pane（仅能力，不判断时机） |

## 安装（Pi Adapter）

将 `src/pi.ts` 作为 Pi Extension 加载，推荐安装到全局扩展目录：

```bash
# 方式一：全局目录（每个 Pi Agent 自动加载；多文件扩展须用子目录 + index.ts 入口）
mkdir -p ~/.pi/agent/extensions/herdr-link
cp src/pi.ts ~/.pi/agent/extensions/herdr-link/index.ts
cp src/herdr.ts src/protocol.ts ~/.pi/agent/extensions/herdr-link/

# 方式二：启动时显式加载（临时验证用）
pi --extension /path/to/herdr-link/src/pi.ts
```

加载后，Agent 的 system prompt 自动包含 Communication Contract，并获得三个工具：`herdr_link_peers`、`herdr_link_send`、`herdr_link_close`。

## 环境要求

运行环境必须由 Herdr managed pane 提供：

| 变量 | 用途 |
|---|---|
| `HERDR_ENV=1` | 确认处于 Herdr 环境 |
| `HERDR_BIN_PATH` | 当前 Herdr binary 路径（CLI wrapper 执行） |
| `HERDR_PANE_ID` | caller pane，用于解析 self identity |

缺失时工具返回明确错误（`NOT_IN_HERDR` / `SELF_UNNAMED`），不猜测 UI focus。

## 开发

### 派发独立 Worker（标准操作）

```bash
# 1. 创建独立 tab（新 pane，独立屏幕）
herdr tab create --workspace wH --cwd <工程> --label <名字> --no-focus

# 2. 启动 pi worker —— 注意：--kind pi 会自动加上 "pi"，-- 后只写参数，不要再写 "pi"
herdr agent start <name> --kind pi --pane <pane_id> --timeout 60000 -- --model openai-codex/gpt-5.6-luna --thinking max

# 3. 用 herdr_link_send 派发任务（envelope）；任务里只描述目标，不教回传方式
# 4. 收到 reply_to 关联原任务 ID 的回传即完成，随后 pane close 回收
```

**陷阱**：`--` 后多写 `pi` 会执行 `pi pi --model ...`，第二个 `pi` 被当作 prompt 发给 worker，产生多余消息并触发澄清请求。

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # node --test（单元测试，mock CLI，不触碰真实 Herdr）
```

### 仓库结构

```text
PROTOCOL.md          协议唯一规范（Envelope、Contract、工具语义、错误模型）
src/protocol.ts      协议核心：类型、buildEnvelope、错误、COMMUNICATION_CONTRACT
src/herdr.ts         Herdr CLI 控制层：identity、peers、send、close
src/pi.ts            Pi Runtime Adapter：契约注入 + 三个工具注册
test/                node:test 单元测试
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