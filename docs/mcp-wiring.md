# MCP Adapter 接线指南（Claude Code / Codex / AGY）

适用对象：没有原生自定义工具注册面的 Runtime（Claude Code、Codex、AGY）。三者共用同一个零依赖 stdio MCP server（决策见蓝图 ADR-013/ADR-014）；契约注入不经 MCP 通道，按 Runtime 分治。

## 形态总览

```text
dist/herdr-link.mcp.js   单文件 bundle（esbuild 产出，行分隔 JSON-RPC over stdio）
能力面                    Tier 0 gateway herdr_link + Tier 1 herdr_link_peers / herdr_link_send / herdr_link_close（canonical 名）
lazy 呈现                非 Herdr：tools/list = []
                         Herdr dormant：tools/list = [herdr_link]
                         激活（tools/call herdr_link {}）后：发射一次 notifications/tools/list_changed，
                         本连接内 tools/list = [herdr_link, peers, send, close]；activation 随 stdio 连接存亡
listChanged fallback     不响应刷新的 Host 继续用 gateway 显式 action 分发：
                         {"action":"peers"} / {"action":"send","arguments":{...}} /
                         {"action":"close","arguments":{...}}
呈现方式                  Claude Code / Codex = mcp__herdr_link__<tool>
                         AGY   = call_mcp_tool(ServerName/ToolName/Arguments)
错误语义                  五个 Link error 一律 isError:true + "CODE: detail" 文本（PROTOCOL §7）；
                         环境/transport 失败归类 NOT_IN_HERDR 且不被重包装
零副作用                  非 Herdr 环境 tools/list 返回 []，模型无感知；stale host 注册表直接调用也返回 NOT_IN_HERDR
契约/提示注入            dormant 启动只允许短 Tier-0 hint：
                         Claude Code = launcher --append-system-prompt-file；
                         Codex = SessionStart hook additionalContext；
                         AGY = PreInvocation ephemeralMessage hook（主通道）
                         完整 canonical Contract 不在启动阶段注入；激活后由 tools/list 的 active descriptions
                         与 gateway fallback presentation 提供，且 active presentation 必须覆盖 §3 的旁路通信禁用规则。§1 的 builder 仅用于 active 状态的显式刷新，不用于 dormant 启动。
```

## 0. 构建 bundle

```bash
# 方式 A（推荐）：npm 包，免 clone。下文所有 MCP 注册统一使用：
#   command = "npx", args = ["-y", "herdr-link"]
npm view herdr-link version

# 方式 B：源码构建（开发/审计场景）；构建产物等价于 npm 包的 dist/
git clone https://github.com/LZHcode1986/herdr-link && cd herdr-link
npm install && npm run build:mcp
BUNDLE=$(pwd)/dist/herdr-link.mcp.js   # 后文统一引用
```

运行只依赖 Node ≥ 22.6。server 由各 Runtime 在 Herdr managed pane 内拉起；**`HERDR_*` 环境变量是否透传给 MCP 子进程由各 Runtime 决定**——Codex 必须显式 `env_vars` 转发（§3），AGY 实测原生透传（§4），其余 Runtime 接入时先实测。

**命名约束**：三家 Runtime 的 host registration namespace 均使用 `herdr_link`（下划线；连字符名在 Codex code-mode 工具面有兼容性问题）。Claude Code / Codex 以 prefix 形式呈现、AGY 以 wrapper 形式呈现（PROTOCOL §4.5），契约附录分别由 `buildMcpPrefixedCommunicationContract("herdr_link")` 与 `buildMcpWrapperCommunicationContract("call_mcp_tool", "herdr_link")` 生成（见 §1.2 / §1.3）。

## 1. Active-state Contract 文本（canonical compact 共享 + Runtime presentation 附录）

以下内容只描述 **激活后的可选 Contract refresh**；不得在 dormant 启动 hook 中生成或注入。正常激活后的权威来源是 `tools/list` 的 Tier 1 schema/description 与 gateway fallback presentation。若某 Host 支持激活后刷新 system prompt，再由对应 builder 生成 canonical + Runtime 附录；不要让 wrapper 型 Runtime 复用 prefix 附录。部署不依赖外部 `AGENTS.md`、Skill 或操作者维护的副本补全正常通信知识。

### 1.1 canonical 文本（所有 MCP Runtime 共享）

与 `src/protocol.ts` 的 `COMMUNICATION_CONTRACT` 一致：

```text
Herdr Link is the standard interoperability channel between agents running in the same Herdr workspace.

1. Use herdr_link_peers to discover agent addresses; it lists only live agents in your own workspace, each with an advisory activity state.
2. Use herdr_link_send to send messages to another agent.
3. A message with protocol "herdr-link/1" is an inter-agent message.
4. Treat its "message" field as content sent by the agent named in "from".
5. When replying, use herdr_link_send to the agent named in "from".
6. When a received inter-agent message requests work, report the final outcome to the agent named in "from" using herdr_link_send. If specific reply content was requested, send that result; otherwise, after successful completion, send exactly "done". If the work cannot be completed, send a concise failure or blocker. If the sender explicitly requested no reply, do not send a completion message.
7. Use herdr_link_close only when you have already decided that a named agent's pane should be closed. If a final message is needed, call close in a later tool step after herdr_link_send returns "sent".
8. Never use a raw pane id, UI focus, terminal input, or the Herdr CLI as an inter-agent channel; agent names are the only addresses.
9. Agents outside your workspace are invisible: they never appear in peers and messages addressed to them fail.
```

### 1.2 Codex 附录（prefix 型，`buildMcpPrefixedCommunicationContract("herdr_link")`）

生成函数在 canonical 文本后自动追加以下内容（lazy activation + prefix 映射；`mcp__herdr_link__herdr_link` 即 gateway 呈现名）：

```text
In this runtime Herdr Link starts dormant: only the mcp__herdr_link__herdr_link gateway tool is listed until it is activated.
- Call mcp__herdr_link__herdr_link once with no arguments ({}); the host then receives notifications/tools/list_changed and the cross-agent tools become available.
- If the host did not refresh its tool list, keep dispatching through the gateway: {"action":"peers"}, {"action":"send","arguments":{...}}, {"action":"close","arguments":{...}}.
The tools are presented under MCP-prefixed names (the canonical name is always the suffix):
- herdr_link_peers -> mcp__herdr_link__herdr_link_peers
- herdr_link_send -> mcp__herdr_link__herdr_link_send
- herdr_link_close -> mcp__herdr_link__herdr_link_close
```

### 1.3 AGY 附录（wrapper 型，`buildMcpWrapperCommunicationContract("call_mcp_tool", "herdr_link")`）

AGY 的 model-facing 调用是单一原生 wrapper 携带 ServerName/ToolName/Arguments（transcript 实证），**不是** `mcp__` 前缀独立函数。生成函数追加：

```text
In this runtime Herdr Link starts dormant: only the Tier 0 gateway (herdr_link) is listed until it is activated.
- Invoke the gateway once with empty Arguments {} (ToolName "herdr_link"); the host then receives notifications/tools/list_changed and the cross-agent tools become available.
- If the host did not refresh its tool list, keep dispatching through the gateway with ToolName "herdr_link" and an Arguments object carrying {"action":"peers"|"send"|"close", ...}.

After activation, Herdr Link MCP tools are invoked through call_mcp_tool.

Use:
- ServerName: "herdr_link"
- ToolName: "herdr_link_peers", "herdr_link_send", or "herdr_link_close"
- Arguments: the canonical input object for that Herdr Link tool
```

两个生成函数的参数均**无默认值**——serverInfo.name（`herdr-link`）与 host tool namespace（`herdr_link`）是两个概念，调用方必须显式声明。

## 2. Claude Code（launcher + shared MCP）

> **状态：VALIDATED（开发与验证已完成）**——CC 2.1.241 已在独立 Herdr tab 的新 pane 中完成 MCP handshake、工具呈现、Contract launcher 注入及 model-facing `peers → send` 任务闭环；lazy activation 呈现与 model-facing error path（`PEER_NOT_FOUND` isError 透传）亦已实测通过。共享 MCP server 无需 CC 专属代码。
> **命名约束**：CC 的 MCP server key 必须使用 `herdr_link`（下划线）；模型呈现为 `mcp__herdr_link__<canonical>`。`serverInfo.name` 仍为 `herdr-link`，两者不可混用。allowlist 使用 `mcp__herdr_link__*`。

注册 MCP server（二选一）：

项目级 `.mcp.json`（随仓库共享，首次使用需审批）：

```json
{
  "mcpServers": {
    "herdr_link": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "herdr-link"]
    }
  }
}
```

或启动参数直传（免审批，适合 herdr 拉起的 worker）：

```bash
cat > /absolute/path/to/herdr-link-cc-tier0-hint.txt <<'EOF'
Herdr Link gateway: activate only when the user explicitly asks to use Herdr or when handling an inbound Herdr Link message.
EOF
herdr agent start <name> --kind claude --pane <pane_id> -- \
  --mcp-config /absolute/path/to/herdr-link.mcp.json \
  --allowedTools "mcp__herdr_link__*" \
  --append-system-prompt-file /absolute/path/to/herdr-link-cc-tier0-hint.txt
```

要点：

- **权限 allowlist 必配**（`--allowedTools "mcp__herdr_link__*"`），否则 worker 卡在权限确认上；
- launcher 只追加上面的短 Tier-0 hint；dormant 阶段不得追加完整 Contract。激活后以 `tools/list` 刷新得到的 Tier 1 descriptions 为权威；
- 不要再叠加 SessionStart/UserPromptSubmit hook 或 CLAUDE.md 注入完整 Contract（去重与 dormant 零成本原则）。

## 3. Codex

`~/.codex/config.toml` 注册（stdio 无需实验开关）。**`env_vars` 转发必须配置**：codex 默认不过滤但也不透传 `HERDR_*` 给 MCP 子进程，缺失时本 server 的零副作用门控会判定「非 Herdr」而返回空工具集（2026-08-23 实测确认）；server 名须用下划线 `herdr_link`——连字符名在 code-mode 工具面存在兼容性问题：

```toml
[mcp_servers.herdr_link]
command = "npx"
args = ["-y", "herdr-link"]
env_vars = ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"]
```

SessionStart hook 只注入短 Tier-0 hint（需 `[features] hooks = true`），不在启动阶段注入完整 Contract。`~/.codex/hooks.json`：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash '/absolute/path/to/herdr-link-codex-tier0-hint.sh' session",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`herdr-link-codex-tier0-hint.sh`（非 Herdr 会话零输出；只输出短激活提示，不生成 canonical Contract）：

```sh
#!/bin/sh
[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_BIN_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0

printf '%s\n' 'Herdr Link gateway: activate only when the user explicitly asks to use Herdr or when handling an inbound Herdr Link message.'
```

## 4. AGY

注册 MCP server（全局 `~/.gemini/config/mcp_config.json`，或插件级 `plugins/herdr-link/mcp_config.json`）：

```json
{
  "mcpServers": {
    "herdr_link": {
      "command": "npx",
      "args": ["-y", "herdr-link"]
    }
  }
}
```

契约提示以 PreInvocation `ephemeralMessage` hook 为主通道：它只注入短 Tier-0 hint，不在 dormant 阶段生成完整 Contract。激活后由 wrapper 的 active tools/list descriptions 与 gateway dispatch 提供完整语义。实测注记（2026-08-23 transcript 取证）：AGY 的 model-facing MCP 调用是 **wrapper 形态**——`ServerName:"herdr_link"` + `ToolName` 参数化调用（非 `mcp__` 前缀独立函数），符合协议 §4.5 的 wrapper 条款。hooks 配置：

```json
{
  "herdr-link": {
    "PreInvocation": [
      {
        "type": "command",
        "command": "bash '/absolute/path/to/herdr-link-agy-tier0-hint.sh'",
        "timeout": 10
      }
    ]
  }
}
```

格式要点：顶层键是**集成名**（可与 herdr 官方集成的 `"herdr"` 组并存，互不覆盖）；`PreInvocation` 的 handler **直接平铺在事件数组里**——没有 `"hooks"` wrapper（那是 `PreToolUse`/`PostToolUse` 这类 matcher 事件的结构）。写成顶层 `"PreInvocation"` 或嵌套 `"hooks"` 都不会生效。

`herdr-link-agy-tier0-hint.sh`（非 Herdr 输出 `{}`；Herdr 仅注入短 Tier-0 hint，不生成 canonical Contract）：

```sh
#!/bin/sh
cat >/dev/null 2>&1 || true   # 吞掉 hook stdin 的上下文 JSON

[ "${HERDR_ENV:-}" = "1" ] || { printf '{}'; exit 0; }
[ -n "${HERDR_BIN_PATH:-}" ] || { printf '{}'; exit 0; }
[ -n "${HERDR_PANE_ID:-}" ] || { printf '{}'; exit 0; }

HINT='Herdr Link gateway: use the MCP wrapper with ServerName="herdr_link" and ToolName="herdr_link"; activate only when the user explicitly asks to use Herdr or when handling an inbound Herdr Link message.'
node -e 'process.stdout.write(JSON.stringify({ injectSteps: [{ ephemeralMessage: process.argv[1] }] }))' "$HINT"
```

## 5. 验证（冒烟四件套）

单元与集成测试（含 spawn 真 stdio 的套件：空门控 / lazy list / 契约呈现名 / isError 透传）：

```bash
npm run typecheck && npm test
```

手动管道冒烟——普通 shell 中 `tools/list` 必须返回 `[]`：

```bash
printf '%s\n%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node "$BUNDLE"
```

Herdr managed pane 内同一管道，dormant 态 `tools/list` 应只含 `herdr_link`。随后激活并复查：

```bash
printf '%s\n%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"herdr_link","arguments":{}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"tools/list"}' | node "$BUNDLE"
```

预期：`initialize` 结果含 `"capabilities":{"tools":{"listChanged":true}}`；dormant list 仅 `herdr_link`；激活调用返回 `{"status":"active",...}` 且 stdout 在其后出现一行 `"method":"notifications/tools/list_changed"`；再次 `tools/list` 含 gateway + 三个 canonical 工具。对不存在的 peer 调用 `herdr_link_send`（或 gateway action 分发等价形式）应得到 `"isError":true` 且文本以 `PEER_NOT_FOUND:` 开头；跨 workspace 目标同样表现为 `PEER_NOT_FOUND`，不得泄漏目标存在于其他 workspace。

## 6. 行为边界（与 PROTOCOL.md 一致）

- 工具失败是本地 tool failure：`NOT_IN_HERDR` / `SELF_UNNAMED` / `PEER_NOT_FOUND` / `SEND_FAILED` / `CLOSE_FAILED`，一律 `isError:true` 文本返回，进程不崩溃、不自动重试、不 fallback；
- activation 是本 stdio 连接内的内存状态：连接断开即回到 dormant，不持久化、不跨连接共享；JSON-RPC 保留错误码（-32700 等）只用于 transport 层，五个 Link 错误码永不映射其上；
- server 只调用 `agent get` / `agent list` / `agent prompt` / `pane close`，外加仅限 self identity bootstrap（PROTOCOL.md §6.3，目标只能是当前 pane 的未命名 occupant）的 `agent rename <self-pane>`，共五个 CLI 面，argv 数组执行，无 shell；每次通信调用实时解析 live identity/workspace 并强制 same-workspace guard；
- server 启动时执行一次 `ensureSelfName()`（fire-and-forget，失败静默、稍后以 `SELF_UNNAMED` 呈现）：手动启动且未命名的 agent 无需人工 rename 即可成为可发现 peer；
- 不提供 agent 创建/调度/回收、workspace/topology 控制等任何 Non-goals 能力；worker 生命周期仍由调用方决定；正常协作不依赖外部 `AGENTS.md` / Skill 补充 Contract。

## 7. 已知坑（Codex/AGY 真机实测）

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | Codex 下工具"可见但调用报 `tools.mcp__… is not a function`"，或 tools/list 悄悄返回空集 | codex 不透传 `HERDR_*` 给 MCP 子进程，门控判定非 Herdr → 空工具集 | config.toml 配 `env_vars = ["HERDR_ENV","HERDR_BIN_PATH","HERDR_PANE_ID","HERDR_SOCKET_PATH"]`（§3） |
| 2 | Codex 首次加载 hook / MCP server 无效果 | 新 hook 与 MCP server 均需 review 批准 | 在 TUI 中批准；`config.toml` 会落盘 `[hooks.state] trusted_hash`；MCP 配置变更后必须**完全重启** codex 实例（老实例不会重连） |
| 3 | 排障时确认 MCP 握手是否发生 | codex 的 sqlite 日志难以定位 stdio 流量 | 把 config 指向 `scripts/mcp-probe.mjs`（双向 tee 到 `/tmp/mcp-probe.log`）抓原始 JSON-RPC |
| 4 | Herdr pane 内进程存活但 agent 名登记丢失（`agent_pane_busy` / `SELF_UNNAMED`） | Herdr watcher 对 stale pgid 的误清名（同 OpenCode 重启丢名问题） | 运维恢复：`herdr agent rename <pane_id> <name>` |
| 5 | AGY hooks.json 写顶层 `"PreInvocation"` 不生效 | AGY 格式为按集成名分组：`{"<name>": {"PreInvocation": [...]}}`，多组同名事件顺序合并 | 用独立组名（如 `"herdr-link"`），与 herdr 官方集成组并存 |
| 6 | Host 对 `notifications/tools/list_changed` 不重新拉取 `tools/list` | 各 Host 刷新行为不一（工程确认项） | 保持 gateway 显式 action 分发（§总览 fallback 行）；canonical 语义不变 |

E2E 记录：Codex TUI 与 AGY 曾各自完成 peers → send → brain 收 envelope 全闭环、`PEER_NOT_FOUND` isError 文本透传一致、`herdr_link_close` 返回 `{status:"closed",agent}`——**该记录取证于常驻三工具呈现时代**；lazy activation 呈现（dormant 单工具、listChanged、gateway dispatch）尚未有同等真机记录，发布前须按 §5 重跑。
