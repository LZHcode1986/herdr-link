# MCP Adapter 接线指南（Claude Code / Codex / AGY）

适用对象：没有原生自定义工具注册面的 Runtime（Claude Code、Codex、AGY）。三者共用同一个零依赖 stdio MCP server（决策见蓝图 ADR-013/ADR-014）；契约注入不经 MCP 通道，按 Runtime 分治。

## 形态总览

```text
dist/herdr-link.mcp.js   单文件 bundle（esbuild 产出，行分隔 JSON-RPC over stdio）
工具面                    herdr_link_peers / herdr_link_send / herdr_link_close（canonical 名）
呈现名                    mcp__herdr-link__<tool>（宿主前缀，结尾必须是完整 canonical 名，PROTOCOL §4.4）
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

运行只依赖 Node ≥ 22。server 由各 Runtime 在 Herdr managed pane 内拉起，自动继承 `HERDR_ENV` / `HERDR_BIN_PATH` / `HERDR_PANE_ID`。

**命名约束**：下文所有配置中 server 名必须叫 `herdr-link`——呈现名 `mcp__herdr-link__<tool>` 与注入的契约文本一一对应。若改名，必须同步改契约附录（由 `src/mcp.ts` 的 `buildMcpCommunicationContract(serverName)` 生成）。

## 1. 契约注入文本（三个 Runtime 通用）

以下文本即 `buildMcpCommunicationContract()` 的输出（canonical Contract + §4.4 呈现名附录），按各 Runtime 的注入通道原样投递：

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

In this runtime these tools are presented under MCP-prefixed names:
- herdr_link_peers -> mcp__herdr-link__herdr_link_peers
- herdr_link_send -> mcp__herdr-link__herdr_link_send
- herdr_link_close -> mcp__herdr-link__herdr_link_close
```

注意：每个 Runtime **只走一条**契约通道，避免重复注入（launcher 与 hook 并存会双份）。

## 2. Claude Code

注册 MCP server（二选一）：

项目级 `.mcp.json`（随仓库共享，首次使用需审批）：

```json
{
  "mcpServers": {
    "herdr-link": {
      "command": "node",
      "args": ["/absolute/path/to/herdr-link/dist/herdr-link.mcp.js"]
    }
  }
}
```

或启动参数直传（免审批，适合 herdr 拉起的 worker）：

```bash
herdr agent start <name> --kind claude --pane <pane_id> -- \
  --mcp-config /absolute/path/to/herdr-link.mcp.json \
  --allowedTools "mcp__herdr-link__*" \
  --append-system-prompt "<第 1 节契约文本>"
```

要点：

- **权限 allowlist 必配**（`--allowedTools "mcp__herdr-link__*"`），否则 worker 卡在权限确认上；
- 契约经 `--append-system-prompt` 进入系统提示，跨 compaction 存活；不要用会整体替换默认提示的 `--system-prompt`；
- 不要再叠加 SessionStart/UserPromptSubmit hook 或 CLAUDE.md 注入同一契约（去重原则）。

## 3. Codex

`~/.codex/config.toml` 注册（stdio 无需实验开关）：

```toml
[mcp_servers.herdr-link]
command = "node"
args = ["/absolute/path/to/herdr-link/dist/herdr-link.mcp.js"]
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
<第 1 节契约文本>
CONTRACT
```

## 4. AGY

注册 MCP server（全局 `~/.gemini/config/mcp_config.json`，或插件级 `plugins/herdr-link/mcp_config.json`）：

```json
{
  "mcpServers": {
    "herdr-link": {
      "command": "node",
      "args": ["/absolute/path/to/herdr-link/dist/herdr-link.mcp.js"]
    }
  }
}
```

契约注入以 PreInvocation `ephemeralMessage` hook 为主通道（动态门禁；静态 Rules 无法条件化，只能作辅助，否则非 Herdr 会话也会被注入）。hooks 配置：

```json
{
  "PreInvocation": [
    {
      "hooks": [
        {
          "type": "command",
          "command": "bash '/absolute/path/to/herdr-link-agy-contract.sh'",
          "timeout": 10
        }
      ]
    }
  ]
}
```

`herdr-link-agy-contract.sh`（非 Herdr 输出 `{}`，零字符注入）：

```sh
#!/bin/sh
cat >/dev/null 2>&1 || true   # 吞掉 hook stdin 的上下文 JSON

[ "${HERDR_ENV:-}" = "1" ] || { printf '{}'; exit 0; }
[ -n "${HERDR_BIN_PATH:-}" ] || { printf '{}'; exit 0; }
[ -n "${HERDR_PANE_ID:-}" ] || { printf '{}'; exit 0; }

CONTRACT=$(cat <<'EOF'
<第 1 节契约文本>
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
