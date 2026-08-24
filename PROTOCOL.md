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
  "id": "hl_mep7abc_4f8k2n",
  "from": "brain",
  "to": "reviewer",
  "message": "请检查这个设计。"
}
```

### 2.2 回复

```json
{
  "protocol": "herdr-link/1",
  "id": "hl_mep7def_9q3r5s",
  "from": "reviewer",
  "to": "brain",
  "reply_to": "hl_mep7abc_4f8k2n",
  "message": "检查完成。"
}
```

### 2.3 字段定义

| 字段 | 必填 | 生成方 | 语义 |
|---|---:|---|---|
| `protocol` | 是 | Adapter | 固定为 `herdr-link/1`；模型不可提交 |
| `id` | 是 | Adapter | 消息唯一 ID，格式为 `hl_<timestamp>_<random>`；`timestamp` 与 `random` 均为非空小写字母数字串 |
| `from` | 是 | Adapter | 当前 Agent Name（从 Herdr identity 即时解析）；模型不可自行声明 |
| `to` | 是 | Model input → Adapter validation | 目标 Agent Name；必须匹配 `[a-z][a-z0-9_-]{0,31}` 且为 live peer |
| `reply_to` | 否 | Model input → Adapter validation | 被回复消息的合法 `herdr-link/1` `id` |
| `message` | 是 | Model | 非空业务 payload（至少包含一个非空白字符，可含 JSON/YAML）；Link 不解析其语义 |

### 2.4 不进入 Envelope 的字段

V1 不定义：`task_id`、`status`、`result`、`error`、`runtime`、`model`、`priority`、`timeout`、`workflow`、`stage`、`permission`、`evidence`、`receipt`。

上层业务需要结构化 payload 时，将 JSON/YAML/文本放入 `message`；Herdr Link 不解释其中业务语义。

## 3. Agent Communication Contract

所有 Runtime Adapter 必须自动向 Agent 注入语义等价的 Contract，并自动暴露 §4 定义的工具 schema。Contract 与工具 schema/description 共同构成完整且唯一的 Agent-facing 使用权威；符合规范的部署不得依赖外部 `AGENTS.md`、Skill、手工 prompt 或 Herdr CLI 指令补全正常通信知识。允许根据 Runtime 的 system prompt / hook 与工具呈现机制调整表现形式，但以下规则不可改变：

```text
Herdr Link is the standard interoperability channel between agents
running in the same Herdr session.

1. Use herdr_link_peers to discover agent addresses.
2. Use herdr_link_send to send messages to another agent.
3. A message with protocol "herdr-link/1" is an inter-agent message.
4. Treat its "message" field as content sent by the agent named in "from".
5. When replying, send to the received "from" agent and set reply_to to the received "id".
6. Use herdr_link_close only when you have already decided that a named agent's pane should be closed. If a final message is needed, call close in a later tool step after herdr_link_send returns "sent".
7. Never use a raw pane id or UI focus as an inter-agent address.
8. Do not use Herdr CLI, terminal input, pane reads, waits, or Skills for normal inter-agent messaging.
9. Herdr Link communicates with existing named agents and executes explicit close requests; agent creation, configuration, scheduling, identity ownership, and lifecycle policy remain outside it.
```

`PROTOCOL.md` 是上述核心文本的唯一人工维护位置。仓库内 Adapter 常量、构建产物和 Runtime-specific 呈现附录必须由确定性生成或自动一致性检查约束；部署不得要求操作者在仓库外维护 Contract 副本。

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

- 输入：`{ "to": string, "message": string, "reply_to": string (可选) }`；`to`、`message` 与 `reply_to` 必须满足 §2.3；
- 输出：`{ "status": "sent", "id": string, "to": string }`
- 语义：
  - `status=sent` 只表示 Herdr 接受消息投递；不表示对方完成任务；
  - 不等待 reply；不自动 poll；不维护 pending request 状态；不执行 retry policy。

### 4.3 `herdr_link_close`

- 输入：`{ "agent": string }` —— 只接受 Agent Name，不接受 raw pane ID。
- 正常输出：`{ "status": "closed", "agent": string }`
- 规范：
  1. 如果调用方需要发送最终消息，必须先等待 `herdr_link_send` 返回 `status=sent`，再在后续工具步骤调用 `herdr_link_close`；
  2. Adapter 调用 Herdr `agent get <name>` 取得当前 authoritative `pane_id`；
  3. 再调用 `pane close <pane_id>`；
  4. 不允许默认关闭 focused pane；不允许 `--current` / UI focus fallback；不缓存 pane ID；
  5. 不要求先 `release-agent`；V1 的资源关闭原语就是 Herdr `pane.close`；
  6. 如果关闭的是调用 Agent 自己的 pane，进程可能在工具响应完整返回前终止；调用方不得依赖 self-close 的返回值完成后续业务动作；
  7. Herdr 返回失败时直接失败，不猜测替代目标。

### 4.4 工具命名呈现（Tool Name Presentation）

- 工具的 canonical 名固定为 `herdr_link_peers` / `herdr_link_send` / `herdr_link_close`；
- Runtime 可因宿主机制以不同形态呈现工具：带前缀的独立工具（如 MCP 宿主的 `mcp__<server>__<tool>`，呈现名的结尾必须是完整 canonical 名），或 wrapper 形式（如 AGY 的 `ServerName`/`ToolName` 参数化调用，`ToolName` 即 canonical 名）；无论哪种形态，呈现层与 canonical 名之间必须有确定性映射；
- 注入的 Communication Contract 必须同时声明该 Runtime 的实际呈现方式（前缀型写明完整呈现名；wrapper 型写明 server/tool 参数取值），使模型无需猜测即可正确调用；
- 无论呈现形态如何，入参/出参 schema、错误语义与调用时序约束完全一致。

## 5. Peer 地址模型

- 唯一公开地址是 Herdr Agent Name（`[a-z][a-z0-9_-]{0,31}`，live 全局唯一）。
- **唯一性由 Herdr 强制**（实测：向已占用名字 rename 返回 `agent_name_taken`）。同一 Herdr daemon 内跨 workspace 共享命名空间，同一时刻不存在两个同名 live agent——`send`/`close` 按名字解析不会歧义。
- Agent Name 跟随 pane occupant；agent 退出/释放/替换时清除。peer 列表是瞬时的，每次调用 `herdr_link_peers` 即时生成，不缓存。
- 命名空间是全局共享的（谁先占名谁用），跨项目会撞名：部署者应按项目前缀命名 Agent（如 `proofloop-brain`），避免多项目同名冲突。

`peers` 指所有拥有合法 Agent Name 的 live Herdr agent，即 Herdr Link transport 可寻址的 agent。V1 不验证目标 runtime 是否安装了 Herdr Link Adapter——可寻址（addressable）不等于支持 Link Contract（contract-supporting）。V1 部署者负责保证参与互通的各 Runtime 安装了对应 Adapter。
## 6. Adapter Contract

一个 Runtime 被视为支持 Herdr Link，必须由同一 Runtime Adapter 交付闭环满足四项：

1. **Inject Contract**：让模型自动知道本协议第 3 节的规则；
2. **Expose Peers**：提供 `herdr_link_peers` 等价能力；
3. **Expose Send**：提供 `herdr_link_send` 等价能力；
4. **Expose Close**：提供 `herdr_link_close` 等价能力。

“同一 Runtime Adapter”指一个可独立安装和验证的 Runtime-specific 交付单元；它可以由多个宿主接线点组成（例如 MCP tools + Runtime hook），但不得把外部 Agent 指令文件或操作者维护的 Contract 副本当作第五项依赖。

Adapter 可通过 Extension、Hook、Plugin、MCP Tool 或 Runtime 原生 tool system 实现；不强制实现语言。V1 不创建统一 Adapter Framework（无 BaseAdapter / registry / plugin loader / daemon）。工具命名呈现须符合 §4.4。

### 6.1 Activation 与 Communication Readiness

- **Adapter activation**：只有 `HERDR_ENV=1`、`HERDR_BIN_PATH` 与 `HERDR_PANE_ID` 均存在时，Adapter 才注册工具并注入 Contract；否则保持 no-op。
- **Communication readiness**：已激活的当前 pane occupant 还必须拥有合法、稳定的 live Agent Name，才能作为 Envelope 的 `from` 使用 `herdr_link_peers` / `herdr_link_send` / reply。
- Adapter 已激活但当前 occupant 未命名时，通信调用返回 `SELF_UNNAMED`；不猜测名字、不缓存旧名字、不执行 `agent rename`、不自动 retry。
- Agent Name 的分配、持久性与恢复由 Herdr 和部署/编排层负责；Herdr Link 只在每次通信调用时消费 live identity。显式 `herdr_link_close(agent)` 仍按目标 Agent Name 解析，不把调用方是否已命名作为额外条件。

## 7. 错误模型

V1 定义最小错误语义，全部是本地 tool operation failure，不是跨 Agent message type（不建立 Error Envelope）。

| Code | Meaning |
|---|---|
| `NOT_IN_HERDR` | 当前 Runtime 不在可激活的 Herdr 环境（`HERDR_ENV != 1` 或必要的 Herdr context 缺失） |
| `SELF_UNNAMED` | Adapter 已激活，但当前 live pane occupant 没有合法、稳定的 Agent Name |
| `PEER_NOT_FOUND` | 输入的 Agent Name 非法，或目标不是当前 live named peer；包括 `send` / `close` 的目标解析失败 |
| `SEND_FAILED` | self 与目标均已解析，但 Herdr 未接受 message prompt |
| `CLOSE_FAILED` | 目标已解析到 authoritative pane，但 Herdr `pane close` 失败 |

### Failure Policy

- 不自动 retry；不 fallback 到 terminal send/read；不 fallback 到 focused pane；不转换成 Workflow 状态；
- Agent-facing tool error 只返回稳定 error code 与简化原因；不得暴露 raw pane/tab/workspace/terminal ID，也不得把 `agent rename` 或其他越界恢复动作提示给模型。底层诊断细节如需保留，只能进入 operator-facing 日志。

## 8. Command Safety

- Herdr CLI 必须通过 argv 数组执行（`execFile` 或等价无 shell 方式），禁止构造 shell command string。
- 调用面：`agent get <target>`、`agent list`、`agent prompt <target> <text>`、`pane close <pane_id>`。
- 不使用 `--wait`（V1 无订阅、无等待语义）。不调用：`agent.wait`、`agent.read`、`pane.read`、`events.subscribe`、`pane.send_text`、`pane.send_keys`、`agent start`、`agent rename`。

## 9. Non-goals

V1 不提供：agent 创建/启动/配置/调度、Agent Name 分配/持久化/恢复、自动回收策略、模型选择、workflow/task/stage 状态、业务结果 schema、evidence/receipt/review、持久消息队列、跨机器传输、权限审批系统、离线投递、可靠投递确认、全局权限、跨 session 持久化。`herdr_link_close` 只是执行调用方已经作出的显式关闭决定，不拥有 lifecycle policy。
