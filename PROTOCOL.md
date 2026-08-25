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

发送与回复共用同一个 Envelope 和同一个工具；回复仅增加 `reply_to`，不存在独立的 reply 工具或消息类型。

### 2.3 字段定义

| 字段 | 必填 | 生成方 | 语义 |
|---|---:|---|---|
| `protocol` | 是 | Adapter | 固定为 `herdr-link/1`；模型不可提交 |
| `id` | 是 | Adapter | 消息唯一 ID，格式为 `hl_<timestamp>_<random>`；`timestamp` 与 `random` 均为非空小写字母数字串 |
| `from` | 是 | Adapter | 当前 Agent Name（从 Herdr identity 即时解析）；模型不可自行声明 |
| `to` | 是 | Model input → Adapter validation | 目标 Agent Name；必须匹配 `[a-z][a-z0-9_-]{0,31}` 且为当前 workspace 内的 live named peer |
| `reply_to` | 否 | Model input → Adapter validation | 被回复消息的合法 `herdr-link/1` `id` |
| `message` | 是 | Model | 非空业务 payload（至少包含一个非空白字符，可含 JSON/YAML）；Link 不解析其语义 |

### 2.4 不进入 Envelope 的字段

V1 不定义：`task_id`、`status`、`result`、`error`、`runtime`、`model`、`priority`、`timeout`、`workflow`、`stage`、`permission`、`evidence`、`receipt`、`workspace_id`、`pane_id`。

上层业务需要结构化 payload 时，将 JSON/YAML/文本放入 `message`；Herdr Link 不解释其中业务语义。**workspace scope 是本地 Adapter 的授权边界，永不进入跨 Agent Envelope。**

投递时 Adapter 可在 Envelope 外包裹一段 self-describing 的 inbound wrapper 文本（末行为逐字 Envelope），使处于 dormant 状态的接收方也能识别这是一条 Herdr Link 消息，并在需要回复时先激活 gateway、再调用 send。wrapper 只是 transport 外衣：不改变 Envelope 字段集合，不是协议实体，仅在真实投递时产生、不常驻 system prompt。

## 3. Agent Communication Contract（激活后呈现）

Herdr Link 的模型可见面分两个状态：

- **Dormant**（默认）：Adapter 已注册但未激活。模型侧只呈现极小的 Tier 0 gateway（§4.1）；**不注入任何 Communication Contract**，不呈现 Tier 1 工具的完整 schema/description。
- **Active**：Tier 0 gateway 被调用后（触发条件见 §6.2），Adapter 使本 runtime session 对模型呈现语义等价的 Active Contract，并使 peers/send/close 对模型可用；激活在本 runtime session 内保持，直到 session 结束。

Active 状态下，所有 Runtime Adapter 必须使本节规则的语义对 Agent 完整可见并暴露 §4 定义的能力。可通过 system-prompt injection、active tool schema/description、gateway presentation 或这些机制的组合实现；Active Contract 与工具 schema/description 共同构成完整且唯一的 Agent-facing 使用权威。符合规范的部署不得依赖外部 `AGENTS.md`、Skill、手工 prompt 或 Herdr CLI 指令补全正常通信知识。允许根据 Runtime 的呈现机制调整表现形式（例如 gateway dispatch 形态可将同名规则表达为对 `herdr_link` action 的说明），但以下规则不可改变：

```text
Herdr Link is the standard interoperability channel between agents running in the same Herdr workspace.

1. Use herdr_link_peers to discover agent addresses; it lists only live agents in your own workspace, each with an advisory activity state.
2. Use herdr_link_send to send messages to another agent.
3. A message with protocol "herdr-link/1" is an inter-agent message.
4. Treat its "message" field as content sent by the agent named in "from".
5. When replying, send to the received "from" agent and set reply_to to the received "id".
6. Use herdr_link_close only when you have already decided that a named agent's pane should be closed. If a final message is needed, call close in a later tool step after herdr_link_send returns "sent".
7. Never use a raw pane id, UI focus, terminal input, or the Herdr CLI as an inter-agent channel; agent names are the only addresses.
8. Agents outside your workspace are invisible: they never appear in peers and messages addressed to them fail.
```

`PROTOCOL.md` 是上述核心文本的唯一人工维护位置。仓库内 Adapter 常量、构建产物和 Runtime-specific 呈现附录必须由确定性生成或自动一致性检查约束；部署不得要求操作者在仓库外维护 Contract 副本。

## 4. Agent-facing API

### 4.1 Tier 0：`herdr_link` gateway

- 输入：`{}`（无参数）。
- 输出：`{ "status": "active", "capabilities": ["peers", "send", "close"] }`。
- 规范：
  1. gateway 是 dormant 状态下唯一的 Herdr Link discoverability surface；
  2. 幂等：重复调用仍返回 active；
  3. 激活后在本 runtime session 内保持 active（§6.2）；activation 只存在于内存，不持久化、不跨 session 恢复；
  4. gateway 本身不做 peer discovery、不发消息、不关 pane；
  5. 调用 gateway 不要求当前 Agent 已拥有 Agent Name。

### 4.2 Tier 1：`herdr_link_peers`

- 输入：无。
- 输出：

```json
{
  "self": { "name": "brain", "state": "working" },
  "peers": [
    { "name": "reviewer", "state": "idle" }
  ]
}
```

- 语义：
  - `self.name` 由 Adapter 从 Herdr live identity 即时解析，绝不硬编码；
  - `state` 直接映射 Herdr authoritative `AgentStatus`：`idle | working | blocked | done | unknown`；无法识别的取值归一化为 `unknown`；
  - `peers` 只包含当前 authoritative workspace 内有稳定 Agent Name 的 live Agent，排除 self；
  - 不返回 workspace_id / pane_id / tab_id / terminal ID；
  - `state` 仅供观察：不排序优先级、不解释业务含义、**不作为 send / close 的前置条件**。

### 4.3 Tier 1：`herdr_link_send`（含回复）

- 输入：`{ "to": string, "message": string, "reply_to": string (可选) }`；`to`、`message` 与 `reply_to` 必须满足 §2.3；
- 输出：`{ "status": "sent", "id": string, "to": string }`
- 语义：
  - 每次 send 都实时重新解析 self 与 target 的 live 记录并执行 same-workspace guard（§5），不缓存；
  - 不要求先调用 `peers`；不依赖目标 `state`；
  - `status=sent` 只表示 Herdr 接受消息投递；不表示对方完成任务；
  - 不等待 reply；不自动 poll；不维护 pending request 状态；不执行 retry policy；
  - 投递给 Herdr `agent prompt` 的内容是 §2 所述的 self-describing inbound wrapper，Envelope 本身逐字不变。

### 4.4 Tier 1：`herdr_link_close`

- 输入：`{ "agent": string }` —— 只接受 Agent Name，不接受 raw pane ID。
- 正常输出：`{ "status": "closed", "agent": string }`
- 规范：
  1. 如果调用方需要发送最终消息，必须先等待 `herdr_link_send` 返回 `status=sent`，再在后续工具步骤调用 `herdr_link_close`；
  2. 每次 close 都实时重新解析 self 与 target 的 live 记录并通过 same-workspace guard（§5），然后取 target 当前的 authoritative `pane_id`，再调用 `pane close <pane_id>`；不缓存 pane ID；
  3. 不依赖目标 `state`；不允许默认关闭 focused pane；不允许 `--current` / UI focus fallback；
  4. 不要求先 `release-agent`；V1 的资源关闭原语就是 Herdr `pane.close`；
  5. 如果关闭的是调用 Agent 自己的 pane，进程可能在工具响应完整返回前终止；调用方不得依赖 self-close 的返回值完成后续业务动作；
  6. Herdr 返回失败时直接失败，不猜测替代目标。

### 4.5 工具命名呈现

- Canonical 名固定为 Tier 0 `herdr_link` 与 Tier 1 `herdr_link_peers` / `herdr_link_send` / `herdr_link_close`；
- Runtime 可因宿主机制以不同形态呈现：
  - **true deferred tools**：四个工具均为独立注册工具，dormant 时仅 gateway 在模型可见集合中，激活后 Tier 1 进入可见集合（如 Pi 的动态工具 API）；
  - **prefix 型独立工具**（如 MCP 宿主的 `mcp__<namespace>__<tool>`）：呈现名的结尾必须是完整 canonical 名；
  - **wrapper 形式**（如 AGY 的 `ServerName`/`ToolName` 参数化调用）：`ToolName` 即 canonical 名；
  - **single-gateway dispatch**：模型面只有 `herdr_link` 一个工具，Tier 1 能力以 `action` 参数分发；此时 active presentation 必须把 §3 规则完整映射到 gateway action 上；
- 无论哪种形态，呈现层与 canonical 名之间必须有确定性映射；入参/出参 schema、错误语义与调用时序约束完全一致；
- Active presentation 必须同时声明该 Runtime 的实际呈现方式与 dormant/active 行为，使模型无需猜测即可正确激活和调用。

逻辑能力集合在所有形态下恒为：**activate / peers / send(+reply) / close**。

## 5. Peer 地址模型与通信域

- 唯一公开地址是 Herdr Agent Name（`[a-z][a-z0-9_-]{0,31}`）。
- **唯一性由 Herdr 强制**（实测：向已占用名字 rename 返回 `agent_name_taken`）。同一 Herdr daemon 内 Agent Name 跨 workspace 全局共享、全局解析，同一时刻不存在两个同名 live agent——按名字解析不会歧义。
- **Herdr Link 的通信域是当前 authoritative workspace。** 公开 peer 定义收窄为：*当前 Agent live 记录中 workspace 相同的 named live Agent*。因此 `Herdr 可寻址 ≠ Herdr Link peer`：Herdr 底层的跨 workspace 寻址能力不通过 Link 暴露。
- self 与 target 的当前 workspace 一律来自每次调用即时执行的 `agent get`（以 `HERDR_PANE_ID` 解析 self），fresh 读取、不缓存。环境变量 `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` 只是存在性信号：pane 被 move 跨 workspace 后进程仍保留 launch-time 旧值，**不得作为当前 workspace 的权威**。
- 跨 workspace 目标（以及非法名、不存在的名、workspace 未上报的目标）对模型统一表现为 `PEER_NOT_FOUND`；不得返回区分性的「存在于其他 workspace」信息，不泄漏其他 workspace topology。
- Agent Name 跟随 pane occupant；agent 退出/释放/替换时清除。peer 列表是瞬时的，每次调用即时生成，不缓存。
- 命名空间全局共享意味着多项目可能撞名：部署者应按项目前缀命名 Agent（如 `proofloop-brain`）。即便如此，Link 也只会在同一 workspace 内发现它们。
- `peers` 可寻址不等于支持 Link Contract：V1 不验证目标 Runtime 是否安装了 Herdr Link Adapter；部署者负责保证参与互通的各 Runtime 安装了对应 Adapter。

## 6. Adapter Contract

一个 Runtime 被视为支持 Herdr Link，必须由同一 Runtime Adapter 交付闭环满足四项逻辑能力：

1. **Activate**：提供 `herdr_link` gateway 等价能力（§4.1）；
2. **Expose Active Contract Semantics**：active 后让模型完整知道本协议第 3 节的规则；允许通过 system-prompt injection、active tool schema/description、gateway presentation 或组合实现；dormant 时必须**不**暴露 Tier 1 Contract 语义；
3. **Expose Peers / Send**：提供 `herdr_link_peers`、`herdr_link_send`（含 reply_to 回复）等价能力；
4. **Expose Close**：提供 `herdr_link_close` 等价能力。

“同一 Runtime Adapter”指一个可独立安装和验证的 Runtime-specific 交付单元；它可以由多个宿主接线点组成（例如 MCP tools + Runtime hook），但不得把外部 Agent 指令文件或操作者维护的 Contract 副本当作第五项依赖。

Adapter 可通过 Extension、Hook、Plugin、MCP Tool 或 Runtime 原生 tool system 实现；不强制实现语言。V1 不创建统一 Adapter Framework（无 BaseAdapter / registry / plugin loader / daemon）。工具命名呈现须符合 §4.5。已知的合规呈现形态：

- **true deferred tools**（如 Pi）：四工具全部注册，`session_start` 时把 Tier 1 移出 active 集合，gateway 以加性方式启用 Tier 1；close 保持顺序执行以保证 send 先完成；
- **single-gateway dispatch**（宿主无公开的动态启停 API 时，如 OpenCode）：模型面常驻且仅有一个极小 `herdr_link` dispatcher，空参调用幂等激活本 session，随后以 `action: peers|send|close` 分发到同一控制层；Active Contract semantics 仅在已激活 session 暴露；
- **shared MCP：listChanged 优先 + gateway fallback**（Claude Code / Codex / AGY 等）：dormant `tools/list` 只返回 gateway；声明 `tools.listChanged` capability，激活时发射一次 `notifications/tools/list_changed`；active `tools/list` 返回 gateway + Tier 1；不响应刷新的 Host 通过 gateway 显式 action 分发保持全功能。MCP activation 按 stdio 连接（即宿主为本 session 拉起的 server 进程）记忆，连接结束即回到 dormant。

### 6.1 环境门控（Environment Gate）

- 只有 `HERDR_ENV=1`、`HERDR_BIN_PATH` 与 `HERDR_PANE_ID` 均存在时 Adapter 才注册任何工具；否则保持完全 no-op——不注册工具、不注入 Contract（MCP 形态下 `tools/list` 返回空集）。
- `HERDR_BIN_PATH` 失效（binary 被更新/删除导致 spawn 失败）、CLI transport 失败或响应非法 JSON 属于 Herdr 环境不可用，归类为 `NOT_IN_HERDR`（§7），不得改判为操作级错误码。

### 6.2 Activation 与 Communication Readiness

- **Dormant 为默认态**。满足环境门控后，模型侧只看到 gateway；不注入 Contract、不呈现 Tier 1 完整 schema、不加载官方 Herdr Skill、不产生后台轮询/监听。
- **激活触发仅有两个**：用户显式要求使用 Herdr（explicit Herdr intent），或收到一条 self-describing 的 inbound `herdr-link/1` 投递（§2）。两者都表现为模型调用 gateway；inbound 触发不要求宿主具备 prompt 拦截能力——wrapper 文本本身引导模型调用 gateway。
- **Once-per-runtime-session**：激活后在当前 runtime session 内保持 active，不因后续用户消息不再提及 Herdr 而回退；新 runtime session 重新从 dormant 开始。activation 是内存中的 session 局部状态，不持久化、不写文件、不进 DB。
- **Communication readiness**：已激活的当前 pane occupant 还必须拥有合法、稳定的 live Agent Name，才能作为 Envelope 的 `from` 使用 `herdr_link_peers` / `herdr_link_send` / reply。
- 已激活但当前 occupant 未命名时，Herdr Link 先执行一次内部 self identity bootstrap（§6.3）：为已被 Herdr 识别但尚未命名的当前 occupant 自动生成并绑定一个 Link 前缀的临时 Agent Name 后再正常通信；occupant 尚未被 Herdr 检测或 bootstrap 最终失败时，通信调用返回 `SELF_UNNAMED`。除 §6.3 的碰撞重生外不自动 retry；不猜测名字、不缓存旧名字。
- 当前 occupant 已有合法 Agent Name 时绝不改名：用户指定名保持不变，仅在无合法名时生成新名。Link 不持久化 Agent Names；名字的生命周期与恢复仍由 Herdr 和部署/编排层负责，Link 只在每次通信调用时消费 live identity。显式 `herdr_link_close(agent)` 仍按目标 Agent Name 解析，不把调用方是否已命名作为额外条件。

### 6.3 Self Identity Bootstrap（Adapter 内部机制）

- 触发时机：Adapter 进入有效 Herdr 环境后执行一次 `ensureSelfName()`；`getSelfContext()` 在每条通信路径上兜底执行同一逻辑，覆盖初始化时尚未完成检测的时序窗口。初始探测对「尚未被 Herdr 检测」状态做小预算就绪重试（≤3 次、短间隔），避免启动竞态使被动 Agent 永远不可发现。
- 执行条件：仅当当前 pane occupant 已被 Herdr 识别（live）且没有合法 Agent Name 时，才对其执行一次 `agent rename <self-pane> <generated>`；已有合法名则原样保留，绝不改写。
- 生成名规则：Link 专属前缀 `hl-` + 随机十六进制后缀，整体满足 Agent Name 规则 `[a-z][a-z0-9_-]{0,31}`。
- 确认方式：rename 成功后必须重新读取 authoritative live record 确认命名生效；确认失败即收敛为 `SELF_UNNAMED`。
- 内部重试仅两类且均为小预算：① 初始探测的就绪重试（仅限未检测状态，≤3 次）；② CLI 返回 `agent_name_taken` 时的重生重试（≤3 次）。其余任何失败不做自动 retry。
- 并发去重：同一时刻至多一个 bootstrap 序列在执行（in-flight 合并），Adapter 启动自举与通信路径兜底不会并发 rename；守卫在结算后即清除，不缓存、不持久化任何名字。
- 边界：纯 Adapter 内部机制，不向模型暴露任何 rename/claim 工具，Communication Contract 不新增指令；错误文案不得包含 raw pane ID 或 CLI 诊断。

## 7. 错误模型

V1 定义最小错误语义，全部是本地 tool operation failure，不是跨 Agent message type（不建立 Error Envelope）。

| Code | Meaning |
|---|---|
| `NOT_IN_HERDR` | Herdr 环境不可用：环境变量缺失、`HERDR_BIN_PATH` 失效/被删除（spawn ENOENT）、CLI transport 失败、响应非法 JSON |
| `SELF_UNNAMED` | Herdr Link 已尝试建立当前 Agent 的稳定 Agent Name（§6.3）但失败——包括 occupant 尚未被 Herdr 检测、自动命名最终未成功两种情况 |
| `PEER_NOT_FOUND` | 目标不是当前 workspace 内的 live named peer——涵盖名字非法、目标不存在、目标属于其他 workspace、target workspace 未上报；四种情况对模型不可区分（scope privacy） |
| `SEND_FAILED` | self 与目标均已解析并通过 guard，但 Herdr 未接受 message prompt |
| `CLOSE_FAILED` | 目标已解析到 authoritative pane，但 Herdr `pane close` 失败 |

### Failure Policy

- 不自动 retry；不 fallback 到 terminal send/read；不 fallback 到 focused pane；不转换成 Workflow 状态；
- **错误分类透传**：底层已归类为 `NOT_IN_HERDR` 的环境/transport 失败，不得被外层操作逻辑重包装成 `SEND_FAILED` / `CLOSE_FAILED` 等操作级错误码；操作逻辑只对尚未分类的意外异常使用自身 fallback 码；
- Agent-facing tool error 只返回稳定 error code 与简化原因；不得暴露 raw pane/tab/workspace/terminal ID，也不得把 `agent rename` 或其他越界恢复动作提示给模型。底层诊断细节如需保留，只能进入 operator-facing 日志。

## 8. Command Safety

- Herdr CLI 必须通过 argv 数组执行（`execFile` 或等价无 shell 方式），禁止构造 shell command string。
- 调用面：`agent get <target>`、`agent list`、`agent prompt <target> <text>`、`pane close <pane_id>`。
- `agent prompt` 的投递文本是 §2 定义的 self-describing inbound wrapper；除此之外不构造任何额外协议负载。
- 不使用 `--wait`（V1 无订阅、无等待语义）。不调用：`agent.wait`、`agent.read`、`pane.read`、`events.subscribe`、`pane.send_text`、`pane.send_keys`、`agent start`、任何 workspace 控制命令。
- `agent rename` 仅限 §6.3 self identity bootstrap 使用：目标只能是当前 pane 中未命名的 live occupant；禁止将其暴露为模型工具、用于任何其他 pane/agent 目标，或在面向模型的文本中提示该动作。

## 9. Non-goals

V1 不提供：agent 创建/启动/配置/调度、通用 Agent Name 管理（分配策略/持久化/恢复——§6.3 的一次性 self identity bootstrap 除外，Link 自身不持久化任何名字）、自动回收策略、模型选择、workflow/task/stage 状态、业务结果 schema、evidence/receipt/review、持久消息队列、跨机器传输、权限审批系统、离线投递、可靠投递确认、全局权限、跨 session 持久化。

明确不属于 Herdr Link 的还有：

- **跨 workspace 的 peer discovery / send / close**：属于官方 Herdr Skill / CLI 的高级控制面；
- **官方 Herdr Skill 依赖**：正常 Agent-to-Agent 协作只依赖 Adapter 自包含交付的 Contract 与工具；Skill 仅是高级可选控制面，Link 不自动 fallback 到 Skill，也不教模型用 CLI 完成正常 Link 操作；
- workspace/tab/pane topology 创建、pane move 等控制面操作。

`herdr_link_close` 只是执行调用方已经作出的显式关闭决定，不拥有 lifecycle policy。
