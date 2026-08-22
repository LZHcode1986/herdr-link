# Herdr Link Protocol — `herdr-link/1`

> 本文件是 Herdr Link 协议的唯一规范文本（canonical spec）。所有 Runtime Adapter 必须实现本文件定义的语义；任何修改必须先修改本文件。
> 设计决策记录保存在本机开发环境，不随协议发布。

## 1. Protocol Identifier

```text
herdr-link/1
```

版本号放在 Envelope 的 `protocol` 字段中，不另建 negotiation service。

## 2. Message Envelope

### 2.1 发送

```json
{
  "protocol": "herdr-link/1",
  "id": "hl_01K...",
  "from": "brain",
  "to": "reviewer",
  "message": "请检查这个设计。"
}
```

### 2.2 回复

```json
{
  "protocol": "herdr-link/1",
  "id": "hl_01K...",
  "from": "reviewer",
  "to": "brain",
  "reply_to": "hl_01J...",
  "message": "检查完成。"
}
```

### 2.3 字段定义

| 字段 | 必填 | 生成方 | 语义 |
|---|---:|---|---|
| `protocol` | 是 | Adapter | 固定为 `herdr-link/1`；模型不可提交 |
| `id` | 是 | Adapter | 消息唯一 ID，格式 `hl_` 前缀 + timestamp + random |
| `from` | 是 | Adapter | 当前 Agent Name（从 Herdr identity 解析）；模型不可自行声明 |
| `to` | 是 | Model input → Adapter validation | 目标 Agent Name；必须匹配 `[a-z][a-z0-9_-]{0,31}` 且为 live peer |
| `reply_to` | 否 | Model input | 被回复消息的 `id` |
| `message` | 是 | Model | 业务 payload（任意文本，可含 JSON/YAML）；Link 不解析其语义 |

### 2.4 不进入 Envelope 的字段

V1 不定义：`task_id`、`status`、`result`、`error`、`runtime`、`model`、`priority`、`timeout`、`workflow`、`stage`、`permission`、`evidence`、`receipt`。

上层业务需要结构化 payload 时，将 JSON/YAML/文本放入 `message`；Herdr Link 不解释其中业务语义。

## 3. Agent Communication Contract

所有 Runtime Adapter 必须向 Agent 注入语义等价的 Contract。允许根据 Runtime 的 system prompt / hook 格式调整表现形式，但以下规则不可改变：

```text
Herdr Link is the standard interoperability channel between agents
running in the same Herdr session.

1. Use herdr_link_peers to discover agent addresses.
2. Use herdr_link_send to send messages to another agent.
3. A message with protocol "herdr-link/1" is an inter-agent message.
4. Treat its "message" field as content sent by the agent named in "from".
5. When replying, send to the received "from" agent and set reply_to to the received "id".
6. Use herdr_link_close only when you have already decided that a named agent's pane should be closed.
7. Never use a raw pane id or UI focus as an inter-agent address.
8. Do not use Herdr CLI, terminal input, pane reads, waits, or Skills for normal inter-agent messaging.
9. Herdr Link does not choose, create, configure, schedule, or recycle agents.
```

各 Adapter 从本文件生成或复制对应 prompt 内容时必须保持语义一致。

## 4. Agent-facing API

### 4.1 `herdr_link_peers`

- 输入：无。
- 输出：`{ "self": string, "peers": string[] }`
- 语义：
  - `self` 是 Adapter 从 Herdr 解析出的当前 Agent Name；
  - `peers` 只包含有稳定 Agent Name 的 live Agent，排除 self；
  - 不暴露 pane/tab/workspace/terminal ID；
  - 不承担 worker selection 或 availability ranking。

### 4.2 `herdr_link_send`

- 输入：`{ "to": string, "message": string, "reply_to": string (可选) }`
- 输出：`{ "status": "sent", "id": string, "to": string }`
- 语义：
  - `status=sent` 只表示 Herdr 接受消息投递；不表示对方完成任务；
  - 不等待 reply；不自动 poll；不维护 pending request 状态；不执行 retry policy。

### 4.3 `herdr_link_close`

- 输入：`{ "agent": string }` —— 只接受 Agent Name，不接受 raw pane ID。
- 正常输出：`{ "status": "closed", "agent": string }`
- 规范：
  1. Adapter 先调用 Herdr `agent get <name>` 取得当前 authoritative `pane_id`；
  2. 再调用 `pane close <pane_id>`；
  3. 不允许默认关闭 focused pane；不允许 `--current` / UI focus fallback；不缓存 pane ID；
  4. 不要求先 `release-agent`；V1 的资源关闭原语就是 Herdr `pane.close`；
  5. 如果关闭的是调用 Agent 自己的 pane，进程可能在工具响应完整返回前终止；调用方不得依赖 self-close 的返回值完成后续业务动作；
  6. Herdr 返回失败时直接失败，不猜测替代目标。

## 5. Peer 地址模型

- 唯一公开地址是 Herdr Agent Name（`[a-z][a-z0-9_-]{0,31}`，live 唯一）。
- Agent Name 跟随 pane occupant；agent 退出/释放/替换时清除。peer 列表是瞬时的，每次调用 `herdr_link_peers` 即时生成，不缓存。

`peers` 指所有拥有合法 Agent Name 的 live Herdr agent，即 Herdr Link transport 可寻址的 agent。V1 不验证目标 runtime 是否安装了 Herdr Link Adapter——可寻址（addressable）不等于支持 Link Contract（contract-supporting）。V1 部署者负责保证参与互通的各 Runtime 安装了对应 Adapter。
## 6. Adapter Contract

一个 Runtime 被视为支持 Herdr Link，只需满足四项：

1. **Inject Contract**：让模型自动知道本协议第 3 节的规则；
2. **Expose Peers**：提供 `herdr_link_peers` 等价能力；
3. **Expose Send**：提供 `herdr_link_send` 等价能力；
4. **Expose Close**：提供 `herdr_link_close` 等价能力。

Adapter 可通过 Extension、Hook、Plugin、MCP Tool 或 Runtime 原生 tool system 实现；不强制实现语言。V1 不创建统一 Adapter Framework（无 BaseAdapter / registry / plugin loader / daemon）。

## 7. 错误模型

V1 定义最小错误语义，全部是本地 tool operation failure，不是跨 Agent message type（不建立 Error Envelope）。

| Code | Meaning |
|---|---|
| `NOT_IN_HERDR` | 当前 Runtime 不在 Herdr 环境（`HERDR_ENV != 1` 或 `HERDR_BIN_PATH` 缺失） |
| `SELF_UNNAMED` | 当前 Agent 没有稳定 Agent Name |
| `PEER_NOT_FOUND` | 目标 Agent Name 不存在或不是 live peer |
| `SEND_FAILED` | Herdr 未接受 message prompt |
| `CLOSE_FAILED` | 无法解析目标或 Herdr pane close 失败 |

### Failure Policy

- 不自动 retry；不 fallback 到 terminal send/read；不 fallback 到 focused pane；不转换成 Workflow 状态；
- 将简化后的 Herdr 原因作为 tool error detail 返回。

## 8. Command Safety

- Herdr CLI 必须通过 argv 数组执行（`execFile` 或等价无 shell 方式），禁止构造 shell command string。
- 调用面：`agent get <target>`、`agent list`、`agent prompt <target> <text>`、`pane close <pane_id>`。
- 不使用 `--wait`（V1 无订阅、无等待语义）。不调用：`agent.wait`、`agent.read`、`pane.read`、`events.subscribe`、`pane.send_text`、`pane.send_keys`、`agent start`、`agent rename`。

## 9. Non-goals

V1 不提供：agent 创建/调度/回收、模型选择、workflow/task/stage 状态、业务结果 schema、evidence/receipt/review、持久消息队列、跨机器传输、权限审批系统、离线投递、可靠投递确认、全局权限、跨 session 持久化。