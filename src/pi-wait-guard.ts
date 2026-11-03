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

const WAIT_COMMAND = /\bherdr\s+agent\s+wait\b/;
const WAIT_FLAG = /(^|\s)--wait(\s|$)/;
const PROMPT_COMMAND = /herdr\s+agent\s+prompt/;

/**
 * Return the part of `command` that Bash would actually execute, with quoted
 * strings, heredoc bodies, here-string data, and comments blanked out.
 *
 * The guard only needs to decide whether the model asked for a blocking wait,
 * so data that merely mentions the command (a commit message, docs text, an
 * echoed string) must not trip it. Blanking keeps newlines, so line-anchored
 * patterns still behave.
 *
 * Deliberate trade-off: text inside quotes counts as data, so a wait hidden in
 * `bash -c "…"` is not detected. That form is off-pattern for the models this
 * guard targets, while the false positive it prevents (a commit message or a
 * doc line that merely mentions the command) used to terminate the turn.
 */
export function executableText(command: string): string {
  let out = "";
  let index = 0;

  const blank = (char: string): string => (char === "\n" ? "\n" : " ");

  while (index < command.length) {
    const char = command[index] ?? "";

    // Comment: `#` at a word boundary runs to the end of the line.
    if (char === "#" && (index === 0 || /\s/.test(command[index - 1] ?? ""))) {
      while (index < command.length && command[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }

    // Backslash escapes the next character: it cannot be a command word.
    if (char === "\\") {
      out += blank(command[index + 1] ?? "");
      index += command[index + 1] === "\n" ? 1 : 2;
      continue;
    }

    if (char === "'") {
      out += " ";
      index += 1;
      while (index < command.length && command[index] !== "'") {
        out += blank(command[index] ?? "");
        index += 1;
      }
      out += " ";
      index += 1;
      continue;
    }

    if (char === '"') {
      out += " ";
      index += 1;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === "\\") {
          out += blank(command[index + 1] ?? "");
          index += 2;
          continue;
        }
        out += blank(command[index] ?? "");
        index += 1;
      }
      out += " ";
      index += 1;
      continue;
    }

    // Here-string: the text after `<<<` is data, never a command.
    if (char === "<" && command.startsWith("<<<", index)) {
      while (index < command.length && command[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }

    // Heredoc: keep the header, blank the body up to the delimiter line.
    if (char === "<" && command.startsWith("<<", index)) {
      let head = index + 2;
      let stripTabs = false;
      if (command[head] === "-") {
        stripTabs = true;
        head += 1;
      }
      while (head < command.length && /[ \t]/.test(command[head] ?? "")) head += 1;

      let delimiter = "";
      const quote = command[head];
      if (quote === "'" || quote === '"') {
        head += 1;
        while (head < command.length && command[head] !== quote) {
          delimiter += command[head] ?? "";
          head += 1;
        }
        head += 1;
      } else {
        while (head < command.length && !/[\s;|&<>()]/.test(command[head] ?? "")) {
          delimiter += command[head] ?? "";
          head += 1;
        }
      }

      // Copy the header (up to the newline) unchanged and blank the body.
      while (index < head && index < command.length) {
        out += command[index] ?? "";
        index += 1;
      }
      while (index < command.length && command[index] !== "\n") {
        out += command[index] ?? "";
        index += 1;
      }
      if (index < command.length) {
        out += "\n";
        index += 1;
      }

      if (delimiter) {
        while (index < command.length) {
          const lineEnd = command.indexOf("\n", index);
          const end = lineEnd === -1 ? command.length : lineEnd;
          const line = command.slice(index, end);
          const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
          if (candidate.trimEnd() === delimiter) {
            out += line;
            index = end;
            if (index < command.length) {
              out += "\n";
              index += 1;
            }
            break;
          }
          for (const bodyChar of line) out += blank(bodyChar);
          if (index < command.length) out += "\n";
          index = lineEnd === -1 ? command.length : lineEnd + 1;
        }
      }
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
}

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
    const command = executableText(event.input.command);

    if (WAIT_COMMAND.test(command)) {
      return {
        block: true,
        reason: "Wait disabled by Herdr Link. End this turn; resume on the inbound Link message.",
        terminate: true,
      };
    }

    // Match the command as a plain substring and `--wait` as a standalone
    // token, preserving the old guard's behavior without relying on \b.
    if (PROMPT_COMMAND.test(command) && WAIT_FLAG.test(command)) {
      return { block: true, reason: "Use herdr_link_send for agent messages." };
    }

    return undefined;
  });
}
