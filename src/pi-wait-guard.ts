/**
 * Minimal Pi wait guard.
 *
 * Herdr Link's communication tools live in the shared MCP server; this
 * extension keeps only the old blocking-wait safety rule. It never registers
 * tools, changes the active tool set, injects prompt text, or manages MCP.
 *
 * The guard is active in any Herdr-managed pane, independent of whether the
 * Link MCP session is dormant or active. Link's own send path uses execFile,
 * not the model Bash tool, so this hook never blocks Link calls.
 */
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  if (
    process.env.HERDR_ENV !== "1" ||
    !process.env.HERDR_BIN_PATH ||
    !process.env.HERDR_PANE_ID
  ) {
    return;
  }

  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;

    if (/\bherdr\s+agent\s+wait\b/.test(command)) {
      return {
        block: true,
        reason: "Wait disabled by Herdr Link. End this turn; resume on the inbound Link message.",
        terminate: true,
      };
    }

    // Match the command as a plain substring and `--wait` as a standalone
    // token, preserving the old guard's behavior without relying on \b.
    if (/herdr\s+agent\s+prompt/.test(command) && /(^|\s)--wait(\s|$)/.test(command)) {
      return { block: true, reason: "Use herdr_link_send for agent messages." };
    }

    return undefined;
  });
}
