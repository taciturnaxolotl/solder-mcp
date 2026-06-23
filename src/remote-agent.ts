// Remote Solderable agent bridge
// Connects to the Solderable remote TUI server via WebSocket and runs agent tasks

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

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
  phases: { id: string; label: string; status: "running" | "finished" | "failed"; summary?: string; error?: string }[];
  finalMessage: string;
  error?: string;
}

async function loadApiKey(): Promise<string | undefined> {
  // Check env first
  if (process.env.SOLDERSLACK_REMOTE_TUI_API_KEY?.trim()) {
    return process.env.SOLDERSLACK_REMOTE_TUI_API_KEY.trim();
  }
  // Then check stored config
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
      phases: [],
      finalMessage: "",
      error: "No Solderable API key found. Set SOLDERSLACK_REMOTE_TUI_API_KEY or run `solder /auth`.",
    };
  }

  const url = options.url ?? DEFAULT_URL;
  const timeoutMs = options.timeoutMs ?? 300_000; // 5 min default

  return new Promise<AgentResult>((resolve) => {
    const events: AgentEvent[] = [];
    const assistantMessages: string[] = [];
    const phases: Map<string, { id: string; label: string; status: "running" | "finished" | "failed"; summary?: string; error?: string }> = new Map();
    let sessionId: string | undefined;
    let connected = false;
    let conversationOpened = false;
    let done = false;

    const finish = (result: AgentResult) => {
      if (done) return;
      done = true;
      try { ws.close(1000, "agent run complete"); } catch {}
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({
        success: false,
        sessionId,
        events,
        assistantMessages,
        phases: [...phases.values()],
        finalMessage: assistantMessages.at(-1) ?? "",
        error: `Agent run timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, [SUBPROTOCOL], {
        headers: { Authorization: `Bearer ${apiKey}` },
      } as any);
    } catch (err) {
      clearTimeout(timeout);
      finish({
        success: false,
        events: [],
        assistantMessages: [],
        phases: [],
        finalMessage: "",
        error: `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    ws.onopen = () => {
      connected = true;
    };

    ws.onmessage = (event) => {
      if (done) return;
      let msg: any;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }

      events.push(msg);

      switch (msg.type) {
        case "hello":
          sessionId = msg.sessionId;
          // Open conversation
          ws.send(JSON.stringify({
            type: "conversation.open",
            ...(options.projectId ? { projectId: options.projectId } : {}),
          }));
          break;

        case "conversation.opened":
          conversationOpened = true;
          sessionId = msg.serverRunId ?? sessionId;
          // Submit the prompt
          ws.send(JSON.stringify({
            type: "chat.submit",
            text: options.prompt,
            ...(options.projectId ? { projectId: options.projectId } : {}),
            ...(options.model ? { model: options.model } : {}),
            noAsk: true,
          }));
          break;

        case "heartbeat":
          ws.send(JSON.stringify({ type: "heartbeat_ack", heartbeatId: msg.heartbeatId }));
          break;

        case "assistant_message":
          if (msg.text) assistantMessages.push(msg.text);
          break;

        case "phase_begin":
          phases.set(msg.phaseId, { id: msg.phaseId, label: msg.label ?? msg.phaseId, status: "running" });
          break;

        case "phase_update":
          if (phases.has(msg.phaseId)) {
            phases.get(msg.phaseId)!.summary = msg.detail;
          }
          break;

        case "phase_finish":
          if (phases.has(msg.phaseId)) {
            const p = phases.get(msg.phaseId)!;
            p.status = "finished";
            p.summary = msg.summary ?? p.summary;
          }
          break;

        case "phase_fail":
          if (phases.has(msg.phaseId)) {
            const p = phases.get(msg.phaseId)!;
            p.status = "failed";
            p.error = msg.error;
          }
          break;

        case "run_state":
          // When the agent finishes (busy=false) and we have messages, we're done
          if (msg.busy === false && conversationOpened && assistantMessages.length > 0) {
            clearTimeout(timeout);
            finish({
              success: true,
              sessionId,
              events,
              assistantMessages,
              phases: [...phases.values()],
              finalMessage: assistantMessages.at(-1) ?? "",
            });
          }
          break;

        case "error":
          if (msg.code === "unauthorized" || msg.code === "forbidden") {
            clearTimeout(timeout);
            finish({
              success: false,
              sessionId,
              events,
              assistantMessages,
              phases: [...phases.values()],
              finalMessage: "",
              error: `Authentication failed: ${msg.message ?? msg.code}`,
            });
          }
          break;
      }
    };

    ws.onerror = (err) => {
      clearTimeout(timeout);
      finish({
        success: false,
        sessionId,
        events,
        assistantMessages,
        phases: [...phases.values()],
        finalMessage: assistantMessages.at(-1) ?? "",
        error: `WebSocket error: ${(err as any).message ?? String(err)}`,
      });
    };

    ws.onclose = (event) => {
      clearTimeout(timeout);
      if (!done) {
        finish({
          success: assistantMessages.length > 0,
          sessionId,
          events,
          assistantMessages,
          phases: [...phases.values()],
          finalMessage: assistantMessages.at(-1) ?? "",
          error: connected ? undefined : `WebSocket closed before connecting: ${event.reason || `code ${event.code}`}`,
        });
      }
    };
  });
}
