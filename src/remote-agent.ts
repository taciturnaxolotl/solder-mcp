// Remote Solderable agent bridge
// Connects to the Solderable remote TUI server via WebSocket and runs agent tasks

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import WebSocket from "ws";

const DEFAULT_URL = "wss://sch.up.railway.app/remote-tui";
const SUBPROTOCOL = "solderslack.remote-tui.v2";

export interface AgentRunOptions {
  prompt: string;
  apiKey?: string;
  url?: string;
  projectId?: string;
  model?: string;
  timeoutMs?: number;
}

interface ToolCallRecord {
  name: string;
  input: unknown;
  output?: string;
}

interface PhaseRecord {
  id: string;
  label: string;
  status: "running" | "finished" | "failed";
  summary?: string;
  error?: string;
}

export interface AgentResult {
  success: boolean;
  sessionId?: string;
  events: unknown[];
  assistantMessages: string[];
  toolCalls: ToolCallRecord[];
  phases: PhaseRecord[];
  finalMessage: string;
  error?: string;
}

// Harness event sub-types from the Solderable protocol
interface HarnessGenerationComplete {
  type: "generation.complete";
  text?: string;
  reasoning?: string;
  hasToolCalls?: boolean;
}

interface HarnessToolCallBegin {
  type: "tool_call.begin";
  toolName: string;
  args?: unknown;
  input?: unknown;
}

interface HarnessToolCallComplete {
  type: "tool_call.complete";
  toolName: string;
  result?: unknown;
  output?: unknown;
}

type HarnessEvent =
  | HarnessGenerationComplete
  | HarnessToolCallBegin
  | HarnessToolCallComplete
  | { type: string; [key: string]: unknown };

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
      // skip unreadable configs
    }
  }
  return undefined;
}

function extractInnerEvent(msg: Record<string, unknown>): Record<string, unknown> {
  if (msg.type === "ui.event" && msg.event && typeof msg.event === "object") {
    return msg.event as Record<string, unknown>;
  }
  return msg;
}

function handleHandshake(
  inner: Record<string, unknown>,
  ws: WebSocket,
  state: { sessionId: string | undefined },
  options: AgentRunOptions,
  projectId: string,
): "handled" | "not_handled" {
  if (inner.type === "hello") {
    state.sessionId = (inner.sessionId as string) ?? state.sessionId;
    ws.send(JSON.stringify({
      type: "conversation.open",
      conversationId: state.sessionId,
      projectId,
      history: [],
      historyRevision: 0,
      ...(options.model ? { model: options.model } : {}),
    }));
    return "handled";
  }

  if (inner.type === "conversation.opened") {
    state.sessionId = (inner.serverRunId as string) ?? state.sessionId;
    ws.send(JSON.stringify({
      type: "chat.submit",
      text: options.prompt,
      projectId,
      ...(options.model ? { model: options.model } : {}),
      noAsk: true,
    }));
    return "handled";
  }

  return "not_handled";
}

function handleHeartbeat(
  inner: Record<string, unknown>,
  msg: Record<string, unknown>,
  ws: WebSocket,
): boolean {
  if (inner.type !== "heartbeat") return false;
  const heartbeatId = (inner.heartbeatId ?? msg.heartbeatId) as string;
  ws.send(JSON.stringify({ type: "heartbeat_ack", heartbeatId }));
  return true;
}

function handleAssistantMessage(
  inner: Record<string, unknown>,
  assistantMessages: string[],
): boolean {
  if (inner.type !== "assistant_message") return false;
  if (inner.text) assistantMessages.push(inner.text as string);
  return true;
}

function handlePhaseEvent(
  inner: Record<string, unknown>,
  phases: Map<string, PhaseRecord>,
): boolean {
  switch (inner.type) {
    case "phase_begin": {
      const phaseId = inner.phaseId as string;
      phases.set(phaseId, { id: phaseId, label: (inner.label as string) ?? phaseId, status: "running" });
      return true;
    }
    case "phase_update": {
      const phase = phases.get(inner.phaseId as string);
      if (phase) phase.summary = inner.detail as string;
      return true;
    }
    case "phase_finish": {
      const phase = phases.get(inner.phaseId as string);
      if (phase) {
        phase.status = "finished";
        phase.summary = (inner.summary as string) ?? phase.summary;
      }
      return true;
    }
    case "phase_fail": {
      const phase = phases.get(inner.phaseId as string);
      if (phase) {
        phase.status = "failed";
        phase.error = inner.error as string;
      }
      return true;
    }
    default:
      return false;
  }
}

function handleHarnessEvent(
  inner: Record<string, unknown>,
  assistantMessages: string[],
  toolCalls: ToolCallRecord[],
  currentToolCall: { ref: ToolCallRecord | null },
): boolean {
  if (inner.type !== "harness") return false;
  const event = inner.event as HarnessEvent | undefined;
  if (!event) return false;

  if (event.type === "generation.complete") {
    const e = event as HarnessGenerationComplete;
    if (e.text) assistantMessages.push(e.text);
  } else if (event.type === "tool_call.begin") {
    const e = event as HarnessToolCallBegin;
    currentToolCall.ref = { name: e.toolName, input: e.args ?? e.input };
  } else if (event.type === "tool_call.complete") {
    const e = event as HarnessToolCallComplete;
    const rawOutput = e.result ?? e.output;
    const output = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
    if (currentToolCall.ref && currentToolCall.ref.name === e.toolName) {
      currentToolCall.ref.output = output;
      toolCalls.push(currentToolCall.ref);
      currentToolCall.ref = null;
    } else {
      toolCalls.push({ name: e.toolName, input: e.args ?? e.input, output });
    }
  }

  return true;
}

export async function runRemoteAgent(options: AgentRunOptions): Promise<AgentResult> {
  const apiKey = options.apiKey ?? await loadApiKey();
  if (!apiKey) {
    return emptyResult("No Solderable API key found. Set SOLDERSLACK_REMOTE_TUI_API_KEY or run `solder /auth`.");
  }

  const baseUrl = options.url ?? DEFAULT_URL;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const projectId = options.projectId ?? "mcp-session";

  const wsUrl = new URL(baseUrl);
  wsUrl.searchParams.set("project", projectId);

  return new Promise<AgentResult>((resolve) => {
    const events: unknown[] = [];
    const assistantMessages: string[] = [];
    const toolCalls: ToolCallRecord[] = [];
    const phases = new Map<string, PhaseRecord>();
    const currentToolCall = { ref: null as ToolCallRecord | null };
    const state = { sessionId: undefined as string | undefined };
    let connected = false;
    let conversationOpened = false;
    let done = false;

    const buildResult = (overrides: { success: boolean; error?: string }): AgentResult => ({
      success: overrides.success,
      sessionId: state.sessionId,
      events,
      assistantMessages,
      toolCalls,
      phases: [...phases.values()],
      finalMessage: assistantMessages.at(-1) ?? "",
      error: overrides.error,
    });

    const finish = (result: AgentResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutTimer);
      try { ws.close(1000, "agent run complete"); } catch {}
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      finish(buildResult({
        success: assistantMessages.length > 0,
        error: assistantMessages.length > 0 ? undefined : `Agent run timed out after ${timeoutMs}ms`,
      }));
    }, timeoutMs);

    const ws = new WebSocket(wsUrl.toString(), [SUBPROTOCOL], {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    ws.on("open", () => { connected = true; });

    ws.on("message", (raw) => {
      if (done) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      events.push(msg);
      const inner = extractInnerEvent(msg);

      // Protocol handshake
      if (handleHandshake(inner, ws, state, options, projectId) === "handled") {
        if (inner.type === "conversation.opened") conversationOpened = true;
        return;
      }

      // Keepalive
      if (handleHeartbeat(inner, msg, ws)) return;

      // Direct assistant messages
      if (handleAssistantMessage(inner, assistantMessages)) return;

      // Phase tracking
      if (handlePhaseEvent(inner, phases)) return;

      // Harness events (generation, tool calls)
      if (handleHarnessEvent(inner, assistantMessages, toolCalls, currentToolCall)) return;

      // Run state: agent finished
      if (inner.type === "run_state" && inner.busy === false && conversationOpened && assistantMessages.length > 0) {
        finish(buildResult({ success: true }));
        return;
      }

      // Errors
      if (inner.type === "error") {
        const code = inner.code as string;
        if (code === "unauthorized" || code === "forbidden") {
          finish(buildResult({ success: false, error: `Authentication failed: ${(inner.message as string) ?? code}` }));
        } else if (inner.fatal) {
          finish(buildResult({
            success: assistantMessages.length > 0,
            error: `Server error: ${(inner.message as string) ?? code}`,
          }));
        }
      }
    });

    ws.on("error", (err) => {
      finish(buildResult({ success: false, error: `WebSocket error: ${err.message}` }));
    });

    ws.on("close", (code) => {
      if (!done) {
        finish(buildResult({
          success: assistantMessages.length > 0,
          error: connected ? undefined : `WebSocket closed before connecting: code ${code}`,
        }));
      }
    });
  });
}

function emptyResult(error: string): AgentResult {
  return {
    success: false,
    events: [],
    assistantMessages: [],
    toolCalls: [],
    phases: [],
    finalMessage: "",
    error,
  };
}
