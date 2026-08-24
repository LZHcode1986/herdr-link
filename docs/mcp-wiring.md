# MCP Adapter 接线指南（Claude Code / Codex / AGY）

适用对象：没有原生自定义工具注册面的 Runtime（Claude Code、Codex、AGY）。三者共用同一个零依赖 stdio MCP server（决策见蓝图 ADR-013/ADR-014）；契约注入不经 MCP 通道，按 Runtime 分治。

## 形态总览

```text
dist/herdr-link.mcp.js   单文件 bundle（esbuild 产出，行分隔 JSON-RPC over stdio）
工具面                    herdr_link_peers / herdr_link_send / herdr_link_close（canonical 名）
呈现方式                  Codex = mcp__herdr_link__<tool>
                         AGY   = call_mcp_tool(ServerName/ToolName/Arguments)
错误语义                  五个 Link error 一律 isError:true + "CODE: detail" 文本（PROTOCOL §7）
零副作用                  非 Herdr 环境 tools/list 返回 []，模型无感知
契约注入                  Claude Code = launcher --append-system-prompt；
                         Codex = SessionStart hook additionalContext；
                         AGY = PreInvocation ephemeralMessage hook（主通道）
```

## 0. 构建 bundle

```bash
git clone https://github.com/LZHcode1986/herdr-link && cd herdr-link
npm install && npm run build:mcp
BUNDLE=$(pwd)/dist/herdr-link.mcp.js   # 后文统一引用
```

运行只依赖 Node ≥ 22。server 由各 Runtime 在 Herdr managed pane 内拉起；**`HERDR_*` 环境变量是否透传给 MCP 子进程由各 Runtime 决定**——Codex 必须显式 `env_vars` 转发（§3），AGY 实测原生透传（§4），其余 Runtime 接入时先实测。

**命名约束**：Codex / AGY 的 host registration namespace 均使用 `herdr_link`（下划线；连字符名在 codex code-mode 工具面有兼容性问题）。Codex 以 prefix 形式呈现、AGY 以 wrapper 形式呈现，契约附录分别由 `buildMcpPrefixedCommunicationContract()` 与 `buildMcpWrapperCommunicationContract()` 生成（见 §1.2 / §1.3）。

## 1. 契约注入文本（canonical 共享 + 按 Runtime 追加呈现附录）

契约 = **canonical 9 条（三家共享）** + **Runtime Presentation Appendix**（按该 Runtime 的实际呈现形态追加，PROTOCOL §4.4）。不要让 wrapper 型 Runtime 复用 prefix 附录，反之亦然。

### 1.1 canonical 文本（所有 MCP Runtime 共享）

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

### 1.2 Codex 附录（prefix 型，`buildMcpPrefixedCommunicationContract("herdr_link")`）

```text
In this runtime these tools are presented under MCP-prefixed names:
- herdr_link_peers -> mcp__herdr_link__herdr_link_peers
- herdr_link_send -> mcp__herdr_link__herdr_link_send
- herdr_link_close -> mcp__herdr_link__herdr_link_close
```

### 1.3 AGY 附录（wrapper 型，`buildMcpWrapperCommunicationContract("call_mcp_tool", "herdr_link")`）

AGY 的 model-facing 调用是单一原生 wrapper 携带 ServerName/ToolName/Arguments（transcript 实证：`call_3798736 → call_mcp_tool → {"Arguments":{},"ServerName":"herdr_link","ToolName":"herdr_link_peers"}`），**不是** `mcp__` 前缀独立函数：

```text
In this runtime Herdr Link MCP tools are invoked through call_mcp_tool.

Use:
- ServerName: "herdr_link"
- ToolName: "herdr_link_peers", "herdr_link_send", or "herdr_link_close"
- Arguments: the canonical input object for that Herdr Link tool
```

两个生成函数的参数均**无默认值**——serverInfo.name（`herdr-link`）与 host tool namespace（`herdr_link`）是两个概念，调用方必须显式声明。
注意：每个 Runtime **只走一条**契约通道，避免重复注入（launcher 与 hook 并存会双份）。
## 2. Claude Code（launcher + shared MCP）
> **状态：VALIDATED（2026-08-24）**——CC 2.1.241 已在独立 Herdr tab（`cc-mcp-review`）的新 pane 中以默认 Gemini 3.7 Flash 完成 MCP handshake、工具呈现、Contract launcher 注入及 model-facing `peers → send(reply_to)` 10 秒任务闭环。共享 MCP server（`src/mcp.ts` / `dist/herdr-link.mcp.js`）无需 CC 专属代码。
> **命名约束**：CC 的 MCP server key 必须使用 `herdr_link`（下划线）；模型呈现为 `mcp__herdr_link__<canonical>`。`serverInfo.name` 仍为 `herdr-link`，两者不可混用。allowlist 使用 `mcp__herdr_link__*`。

注册 MCP server（二选一）：

项目级 `.mcp.json`（随仓库共享，首次使用需审批）：

```json
{
  "mcpServers": {
    "herdr_link": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/herdr-link/dist/herdr-link.mcp.js"]
    }
  }
}
```

或启动参数直传（免审批，适合 herdr 拉起的 worker）：

```bash
node --input-type=module -e 'import { buildMcpPrefixedCommunicationContract } from "/absolute/path/to/herdr-link/dist/herdr-link.mcp.js"; process.stdout.write(buildMcpPrefixedCommunicationContract("herdr_link"))' > /absolute/path/to/herdr-link-cc-contract.txt
herdr agent start <name> --kind claude --pane <pane_id> -- \
  --mcp-config /absolute/path/to/herdr-link.mcp.json \
  --allowedTools "mcp__herdr_link__*" \
  --append-system-prompt-file /absolute/path/to/herdr-link-cc-contract.txt
```

要点：

- **权限 allowlist 必配**（`--allowedTools "mcp__herdr_link__*"`），否则 worker 卡在权限确认上；
- 契约经 `--append-system-prompt` 或 `--append-system-prompt-file` 进入系统提示，跨 compaction 存活；不要用会整体替换默认提示的 `--system-prompt`；
- 不要再叠加 SessionStart/UserPromptSubmit hook 或 CLAUDE.md 注入同一契约（去重原则）。

## 3. Codex

`~/.codex/config.toml` 注册（stdio 无需实验开关）。**`env_vars` 转发必须配置**：codex 默认不过滤但也不透传 `HERDR_*` 给 MCP 子进程，缺失时本 server 的零副作用门控会判定「非 Herdr」而返回空工具集（2026-08-23 实测确认）；server 名须用下划线 `herdr_link`——连字符名在 code-mode 工具面存在兼容性问题：

```toml
[mcp_servers.herdr_link]
command = "node"
args = ["/absolute/path/to/herdr-link/dist/herdr-link.mcp.js"]
env_vars = ["HERDR_ENV", "HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"]
```
契约注入走 SessionStart hook（需 `[features] hooks = true`）。`~/.codex/hooks.json`：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash '/absolute/path/to/herdr-link-codex-contract.sh' session",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

`herdr-link-codex-contract.sh`（与 herdr 官方 `herdr-agent-state.sh` 相同的门控模式，非 Herdr 会话零输出）：

```sh
#!/bin/sh
[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_BIN_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0

cat <<'CONTRACT'
<第 1.1 节 canonical 文本>

<第 1.2 节 Codex prefix 附录>
CONTRACT
```

## 4. AGY

注册 MCP server（全局 `~/.gemini/config/mcp_config.json`，或插件级 `plugins/herdr-link/mcp_config.json`）：

```json
{
  "mcpServers": {
    "herdr_link": {
      "command": "node",
      "args": ["/absolute/path/to/herdr-link/dist/herdr-link.mcp.js"]
    }
  }
}
```

契约注入以 PreInvocation `ephemeralMessage` hook 为主通道（动态门禁；静态 Rules 无法条件化，只能作辅助，否则非 Herdr 会话也会被注入）。实测注记（2026-08-23 transcript 取证）：AGY 的 model-facing MCP 调用是 **wrapper 形态**——`ServerName:"herdr_link"` + `ToolName:"herdr_link_send"` 参数化调用（非 `mcp__` 前缀独立函数），符合协议 §4.4 的 wrapper 条款；PreInvocation 注入的契约文本已在会话 trajectory 中取证确认。hooks 配置：

```json
{
  "herdr-link": {
    "PreInvocation": [
      {
        "type": "command",
        "command": "bash '/absolute/path/to/herdr-link-agy-contract.sh'",
        "timeout": 10
      }
    ]
  }
}
```

格式要点：顶层键是**集成名**（可与 herdr 官方集成的 `"herdr"` 组并存，互不覆盖）；`PreInvocation` 的 handler **直接平铺在事件数组里**——没有 `"hooks"` wrapper（那是 `PreToolUse`/`PostToolUse` 这类 matcher 事件的结构）。写成顶层 `"PreInvocation"` 或嵌套 `"hooks"` 都不会生效。

`herdr-link-agy-contract.sh`（非 Herdr 输出 `{}`，零字符注入）：

```sh
#!/bin/sh
cat >/dev/null 2>&1 || true   # 吞掉 hook stdin 的上下文 JSON

[ "${HERDR_ENV:-}" = "1" ] || { printf '{}'; exit 0; }
[ -n "${HERDR_BIN_PATH:-}" ] || { printf '{}'; exit 0; }
[ -n "${HERDR_PANE_ID:-}" ] || { printf '{}'; exit 0; }

CONTRACT=$(cat <<'EOF'
<第 1.1 节 canonical 文本>

<第 1.3 节 AGY wrapper 附录>
EOF
)

node -e 'process.stdout.write(JSON.stringify({ injectSteps: [{ ephemeralMessage: process.argv[1] }] }))' "$CONTRACT"
```

## 5. 验证（冒烟三件套）

单元与集成测试（含 spawn 真 stdio 的三件套：空门控 / 契约呈现名 / isError 透传）：

```bash
npm run typecheck && npm test
```

手动管道冒烟——普通 shell 中 `tools/list` 必须返回 `[]`：

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | node "$BUNDLE"
```

Herdr managed pane 内同一命令应列出三个 canonical 名工具；对不存在的 peer 调用 `herdr_link_send` 应得到 `"isError":true` 且文本以 `PEER_NOT_FOUND:` 开头。

## 6. 行为边界（与 PROTOCOL.md 一致）

- 工具失败是本地 tool failure：`NOT_IN_HERDR` / `SELF_UNNAMED` / `PEER_NOT_FOUND` / `SEND_FAILED` / `CLOSE_FAILED`，一律 `isError:true` 文本返回，进程不崩溃、不自动重试、不 fallback；
- server 只调用 `agent get` / `agent list` / `agent prompt` / `pane close` 四个 CLI 面，argv 数组执行，无 shell；
- 不提供 agent 创建/调度/回收等任何 Non-goals 能力；worker 生命周期仍由调用方决定。

## 7. 已知坑（2026-08-23 Codex/AGY 真机实测）

| # | 现象 | 根因 | 处理 |
|---|---|---|---|
| 1 | Codex 下工具"可见但调用报 `tools.mcp__… is not a function`"，或 tools/list 悄悄返回空集 | codex 不透传 `HERDR_*` 给 MCP 子进程，门控判定非 Herdr → 空工具集 | config.toml 配 `env_vars = ["HERDR_ENV","HERDR_BIN_PATH","HERDR_PANE_ID","HERDR_SOCKET_PATH"]`（§3） |
| 2 | Codex 首次加载 hook / MCP server 无效果 | 新 hook 与 MCP server 均需 review 批准 | 在 TUI 中批准；`config.toml` 会落盘 `[hooks.state] trusted_hash`；MCP 配置变更后必须**完全重启** codex 实例（老实例不会重连） |
| 3 | 排障时确认 MCP 握手是否发生 | codex 的 sqlite 日志难以定位 stdio 流量 | 把 config 指向 `scripts/mcp-probe.mjs`（双向 tee 到 `/tmp/mcp-probe.log`）抓原始 JSON-RPC |
| 4 | Herdr pane 内进程存活但 agent 名登记丢失（`agent_pane_busy` / `SELF_UNNAMED`） | Herdr watcher 对 stale pgid 的误清名（同 OpenCode 重启丢名问题） | 运维恢复：`herdr agent rename <pane_id> <name>` |
| 5 | AGY hooks.json 写顶层 `"PreInvocation"` 不生效 | AGY 格式为按集成名分组：`{"<name>": {"PreInvocation": [...]}}`，多组同名事件顺序合并 | 用独立组名（如 `"herdr-link"`），与 herdr 官方集成组并存 |

E2E 记录（本机 wH workspace）：Codex TUI 与 AGY 各自完成 peers → send(reply_to 关联) → brain 收 envelope 全闭环；错误路径 `PEER_NOT_FOUND` isError 文本透传实测一致；`herdr_link_close` 实测返回 `{status:"closed",agent}`。
