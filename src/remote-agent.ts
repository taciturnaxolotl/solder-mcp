// Remote Solderable agent bridge
// Connects to the Solderable remote TUI server via WebSocket and runs agent tasks

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import WebSocket from "ws";

const DEFAULT_URL = "wss://sch.up.railway.app/remote-tui";
const SUBPROTOCOL = "solderslack.remote-tui.v2";

interface AgentRunOptions {
  prompt: string;
  apiKey?: string;
  url?: string;
  projectId?: string;
  model?: string;
  timeoutMs?: number;
}

interface AgentEvent {
  type: string;
  text?: string;
  label?: string;
  detail?: string;
  summary?: string;
  error?: string;
  phaseId?: string;
  busy?: boolean;
  [key: string]: unknown;
}

interface AgentResult {
  success: boolean;
  sessionId?: string;
  events: AgentEvent[];
  assistantMessages: string[];
  toolCalls: { name: string; input: unknown; output?: string }[];
  phases: { id: string; label: string; status: "running" | "finished" | "failed"; summary?: string; error?: string }[];
  finalMessage: string;
  error?: string;
}

async function loadApiKey(): Promise<string | undefined> {
  if (process.env.SOLDERSLACK_REMOTE_TUI_API_KEY?.trim()) {
    return process.env.SOLDERSLACK_REMOTE_TUI_API_KEY.trim();
  }
  const configPaths = [
    join(homedir(), ".config", "solderslack", "remote-tui.json"),
    join(homedir(), ".solder", "remote-tui.json"),
  ];
  for (const p of configPaths) {
    try {
      const data = JSON.parse(await readFile(p, "utf-8"));
      if (typeof data.apiKey === "string" && data.apiKey.trim()) {
        return data.apiKey.trim();
      }
    } catch {
      // skip
    }
  }
  return undefined;
}

export async function runRemoteAgent(options: AgentRunOptions): Promise<AgentResult> {
  const apiKey = options.apiKey ?? await loadApiKey();
  if (!apiKey) {
    return {
      success: false,
      events: [],
      assistantMessages: [],
      toolCalls: [],
      phases: [],
      finalMessage: "",
      error: "No Solderable API key found. Set SOLDERSLACK_REMOTE_TUI_API_KEY or run `solder /auth`.",
    };
  }

  const baseUrl = options.url ?? DEFAULT_URL;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const projectId = options.projectId ?? "mcp-session";

  // Build URL with required project param
  const wsUrl = new URL(baseUrl);
  wsUrl.searchParams.set("project", projectId);

  return new Promise<AgentResult>((resolve) => {
    const events: AgentEvent[] = [];
    const assistantMessages: string[] = [];
    const toolCalls: { name: string; input: unknown; output?: string }[] = [];
    const phases = new Map<string, { id: string; label: string; status: "running" | "finished" | "failed"; summary?: string; error?: string }>();
    let currentToolCall: { name: string; input: unknown } | null = null;    let sessionId: string | undefined;
    let connected = false;
    let conversationOpened = false;
    let done = false;

    const finish = (result: AgentResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      try { ws.close(1000, "agent run complete"); } catch {}
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({
        success: assistantMessages.length > 0,
        sessionId,
        events,
        assistantMessages,
        toolCalls,
        phases: [...phases.values()],
        toolCalls,
        finalMessage: assistantMessages.at(-1) ?? "",
        error: assistantMessages.length > 0 ? undefined : `Agent run timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    const ws = new WebSocket(wsUrl.toString(), [SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    ws.on("open", () => {
      connected = true;
    });

    ws.on("message", (raw) => {
      if (done) return;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      events.push(msg);

      // Unwrap ui.event envelope
      const inner = msg.type === "ui.event" && msg.event ? msg.event : msg;

      switch (inner.type) {
        case "hello":
          sessionId = inner.sessionId ?? msg.sessionId;
          ws.send(JSON.stringify({
            type: "conversation.open",
            conversationId: sessionId,
            projectId,
            history: [],
            historyRevision: 0,
            ...(options.model ? { model: options.model } : {}),
          }));
          break;

        case "conversation.opened":
          conversationOpened = true;
          sessionId = inner.serverRunId ?? sessionId;
          ws.send(JSON.stringify({
            type: "chat.submit",
            text: options.prompt,
            projectId,
            ...(options.model ? { model: options.model } : {}),
            noAsk: true,
          }));
          break;

        case "heartbeat":
          ws.send(JSON.stringify({ type: "heartbeat_ack", heartbeatId: inner.heartbeatId ?? msg.heartbeatId }));
          break;

        case "assistant_message":
          if (inner.text) assistantMessages.push(inner.text);
          break;

        case "phase_begin":
          phases.set(inner.phaseId, { id: inner.phaseId, label: inner.label ?? inner.phaseId, status: "running" });
          break;

        case "phase_update":
          if (phases.has(inner.phaseId)) {
            phases.get(inner.phaseId)!.summary = inner.detail;
          }
          break;

        case "phase_finish":
          if (phases.has(inner.phaseId)) {
            const p = phases.get(inner.phaseId)!;
            p.status = "finished";
            p.summary = inner.summary ?? p.summary;
          }
          break;

        case "phase_fail":
          if (phases.has(inner.phaseId)) {
            const p = phases.get(inner.phaseId)!;
            p.status = "failed";
            p.error = inner.error;
          }
          break;

        case "run_state":
          if (inner.busy === false && conversationOpened && assistantMessages.length > 0) {
            finish({
              success: true,
              sessionId,
              events,
              assistantMessages,
              phases: [...phases.values()],
        toolCalls,
              finalMessage: assistantMessages.at(-1) ?? "",
            });
          }
          break;

        case "error":
          if (inner.code === "unauthorized" || inner.code === "forbidden") {
            finish({
              success: false,
              sessionId,
              events,
              assistantMessages,
              phases: [...phases.values()],
        toolCalls,
              finalMessage: "",
              error: `Authentication failed: ${inner.message ?? inner.code}`,
            });
          } else if (inner.fatal) {
            finish({
              success: assistantMessages.length > 0,
              sessionId,
              events,
              assistantMessages,
              phases: [...phases.values()],
        toolCalls,
              finalMessage: assistantMessages.at(-1) ?? "",
              error: `Server error: ${inner.message ?? inner.code}`,
            });
          }
          break;

        // Also extract text and tool calls from harness events
        case "harness":
          if (inner.event?.type === "generation.complete" && inner.event.text) {
            assistantMessages.push(inner.event.text);
          } else if (inner.event?.type === "tool_call.begin") {
            currentToolCall = { name: inner.event.toolName, input: inner.event.args ?? inner.event.input };
          } else if (inner.event?.type === "tool_call.complete") {
            const result = inner.event.result ?? inner.event.output;
            if (currentToolCall && currentToolCall.name === inner.event.toolName) {
              currentToolCall.output = typeof result === "string" ? result : JSON.stringify(result);
              toolCalls.push(currentToolCall);
              currentToolCall = null;
            } else {
              toolCalls.push({
                name: inner.event.toolName,
                input: inner.event.args ?? inner.event.input,
                output: typeof result === "string" ? result : JSON.stringify(result),
              });
            }
          }
          break;
      }
    });

    ws.on("error", (err) => {
      finish({
        success: false,
        sessionId,
        events,
        assistantMessages,
        phases: [...phases.values()],
        toolCalls,
        finalMessage: assistantMessages.at(-1) ?? "",
        error: `WebSocket error: ${err.message}`,
      });
    });

    ws.on("close", (code, reason) => {
      if (!done) {
        finish({
          success: assistantMessages.length > 0,
          sessionId,
          events,
          assistantMessages,
          phases: [...phases.values()],
        toolCalls,
          finalMessage: assistantMessages.at(-1) ?? "",
          error: connected ? undefined : `WebSocket closed before connecting: code ${code}`,
        });
      }
    });
  });
}
