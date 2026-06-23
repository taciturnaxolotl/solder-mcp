#!/usr/bin/env bun
// Solder MCP Server - KiCad/EDA tooling extracted from Solderable
// Exposes solderlib parsers and KiCad CLI tools via Model Context Protocol

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { parseSexpr, stringifySexprPretty } from "./sexpr";
import { parseNetlist } from "./netlist";
import { parseSchematic } from "./schematic";
import { parsePcb } from "./pcb";
import { runRemoteAgent } from "./remote-agent";

const server = new McpServer({
  name: "solder-mcp",
  version: "0.1.0",
});

// --- Tool: parse_kicad_schematic ---
server.tool(
  "parse_kicad_schematic",
  "Parse a KiCad schematic file (.kicad_sch) into structured JSON with symbols, wires, labels, and connectivity info",
  { path: z.string().describe("Path to .kicad_sch file") },
  async ({ path }) => {
    const content = await readFile(path, "utf-8");
    const sch = parseSchematic(content);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(sch, null, 2) }],
    };
  },
);

// --- Tool: parse_kicad_pcb ---
server.tool(
  "parse_kicad_pcb",
  "Parse a KiCad PCB file (.kicad_pcb) into structured JSON with footprints, tracks, nets, and board info",
  { path: z.string().describe("Path to .kicad_pcb file") },
  async ({ path }) => {
    const content = await readFile(path, "utf-8");
    const pcb = parsePcb(content);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(pcb, null, 2) }],
    };
  },
);

// --- Tool: parse_netlist ---
server.tool(
  "parse_netlist",
  "Parse a KiCad netlist file (.net or JSON) into structured data with components and nets",
  { path: z.string().describe("Path to netlist file (.net or .json)") },
  async ({ path }) => {
    const content = await readFile(path, "utf-8");
    const netlist = parseNetlist(content);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(netlist, null, 2) }],
    };
  },
);

// --- Tool: parse_sexpr ---
server.tool(
  "parse_sexpr",
  "Parse any KiCad S-expression file into a tree structure. Useful for .kicad_sym, .kicad_pro, fp-lib-table, sym-lib-table, etc.",
  { path: z.string().describe("Path to any KiCad S-expression file") },
  async ({ path }) => {
    const content = await readFile(path, "utf-8");
    const tree = parseSexpr(content);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(tree, null, 2) }],
    };
  },
);

// --- Tool: format_sexpr ---
server.tool(
  "format_sexpr",
  "Pretty-print a KiCad S-expression file with proper indentation",
  { path: z.string().describe("Path to S-expression file to format") },
  async ({ path }) => {
    const content = await readFile(path, "utf-8");
    const tree = parseSexpr(content);
    const formatted = stringifySexprPretty(tree);
    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  },
);

// --- Tool: analyze_netlist_equivalence ---
server.tool(
  "analyze_netlist_equivalence",
  "Compare two netlists (e.g., SKiDL output vs KiCad schematic export) and report differences in nets and connections",
  {
    path_a: z.string().describe("Path to first netlist"),
    path_b: z.string().describe("Path to second netlist"),
  },
  async ({ path_a, path_b }) => {
    const [a, b] = await Promise.all([
      readFile(path_a, "utf-8").then(parseNetlist),
      readFile(path_b, "utf-8").then(parseNetlist),
    ]);

    const netsA = new Map(a.nets.map((n) => [n.name, new Set(n.nodes.map((nd) => `${nd.ref}:${nd.pin}`))]));
    const netsB = new Map(b.nets.map((n) => [n.name, new Set(n.nodes.map((nd) => `${nd.ref}:${nd.pin}`))]));

    const onlyInA = [...netsA.keys()].filter((k) => !netsB.has(k));
    const onlyInB = [...netsB.keys()].filter((k) => !netsA.has(k));
    const mismatched: string[] = [];
    for (const [name, nodesA] of netsA) {
      const nodesB = netsB.get(name);
      if (!nodesB) continue;
      if (nodesA.size !== nodesB.size || ![...nodesA].every((n) => nodesB.has(n))) {
        mismatched.push(name);
      }
    }

    const result = {
      summary: {
        nets_in_a: netsA.size,
        nets_in_b: netsB.size,
        only_in_a: onlyInA.length,
        only_in_b: onlyInB.length,
        mismatched_nets: mismatched.length,
        equivalent: onlyInA.length === 0 && onlyInB.length === 0 && mismatched.length === 0,
      },
      only_in_a: onlyInA,
      only_in_b: onlyInB,
      mismatched_nets: mismatched.map((name) => ({
        name,
        a_nodes: [...(netsA.get(name) ?? [])],
        b_nodes: [...(netsB.get(name) ?? [])],
      })),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- Tool: extract_schematic_components ---
server.tool(
  "extract_schematic_components",
  "Extract a summary of all components in a KiCad schematic: references, values, footprints, and positions",
  { path: z.string().describe("Path to .kicad_sch file") },
  async ({ path }) => {
    const content = await readFile(path, "utf-8");
    const sch = parseSchematic(content);
    const components = sch.symbols
      .filter((s) => s.ref && !s.ref.startsWith("#"))
      .map((s) => ({
        ref: s.ref,
        value: s.value,
        footprint: s.footprint,
        lib_id: s.libId,
        position: s.at,
      }))
      .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ count: components.length, components }, null, 2) }],
    };
  },
);

// --- Tool: extract_pcb_summary ---
server.tool(
  "extract_pcb_summary",
  "Get a high-level summary of a KiCad PCB: footprint count, track count, net count, layers used",
  { path: z.string().describe("Path to .kicad_pcb file") },
  async ({ path }) => {
    const content = await readFile(path, "utf-8");
    const pcb = parsePcb(content);
    const layers = new Set<string>();
    for (const t of pcb.tracks) layers.add(t.layer);
    for (const fp of pcb.footprints) layers.add(fp.layer);

    const summary = {
      version: pcb.version,
      generator: pcb.generator,
      paper: pcb.paper,
      footprint_count: pcb.footprints.length,
      track_count: pcb.tracks.length,
      net_count: pcb.nets.length,
      layers_used: [...layers].sort(),
      footprints: pcb.footprints.map((fp) => ({
        ref: fp.ref,
        value: fp.value,
        footprint: fp.libId,
        layer: fp.layer,
        pad_count: fp.pads.length,
        position: fp.at,
      })),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
    };
  },
);

// --- Tool: kicad_cli_export_netlist ---
server.tool(
  "kicad_cli_export_netlist",
  "Export a netlist from a KiCad schematic using kicad-cli. Requires kicad-cli to be installed.",
  {
    schematic_path: z.string().describe("Path to .kicad_sch file"),
    output_path: z.string().optional().describe("Output path for netlist (default: same dir as schematic with .net extension)"),
  },
  async ({ schematic_path, output_path }) => {
    if (typeof Bun === "undefined") {
      return {
        content: [{ type: "text" as const, text: "kicad_cli_export_netlist requires the Bun runtime (uses Bun.spawn)." }],
        isError: true,
      };
    }
    const outPath = output_path ?? schematic_path.replace(/\.kicad_sch$/, ".net");
    const cliPath = process.env.KICAD_CLI_PATH ?? "kicad-cli";

    try {
      const proc = Bun.spawn([cliPath, "sch", "export", "netlist", "--output", outPath, schematic_path], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `kicad-cli failed (exit ${exitCode}): ${stderr}` }],
          isError: true,
        };
      }

      const netlistContent = await readFile(outPath, "utf-8");
      return {
        content: [{ type: "text" as const, text: `Netlist exported to ${outPath}\n\n${netlistContent}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to run kicad-cli: ${err instanceof Error ? err.message : String(err)}. Is kicad-cli installed?` }],
        isError: true,
      };
    }
  },
);

// --- Tool: compile_skidl ---
server.tool(
  "compile_skidl",
  "Compile a SKiDL Python circuit file to a KiCad netlist. Requires SKiDL runtime to be configured.",
  {
    script_path: z.string().describe("Path to circuit.py or other SKiDL script"),
    output_path: z.string().optional().describe("Output netlist path (default: circuit.net in same directory)"),
  },
  async ({ script_path, output_path }) => {
    if (typeof Bun === "undefined") {
      return {
        content: [{ type: "text" as const, text: "compile_skidl requires the Bun runtime (uses Bun.spawn)." }],
        isError: true,
      };
    }
    const skidlBase = process.env.PATH_TO_SKIDL_RUNTIME;
    if (!skidlBase) {
      return {
        content: [{ type: "text" as const, text: "PATH_TO_SKIDL_RUNTIME environment variable not set. Configure SKiDL runtime path." }],
        isError: true,
      };
    }

    const pythonPath = join(skidlBase, "bin", "python3");
    const outPath = output_path ?? script_path.replace(/\.py$/, ".net");

    try {
      const proc = Bun.spawn([pythonPath, script_path], {
        cwd: dirname(script_path),
        env: { ...process.env, PYTHONPATH: skidlBase },
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `SKiDL compilation failed (exit ${exitCode}):\n${stderr}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `SKiDL compiled successfully.\nStdout: ${stdout}\nNetlist: ${outPath}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to compile SKiDL: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Tool: remote_agent_run ---
server.tool(
  "remote_agent_run",
  "Run a task on the Solderable remote agent server. Gives access to GPT-5.5, Claude Opus 4.8, Claude Fable 5, and a fine-tuned Gemini schematic layout model. Requires a Solderable API key (set SOLDERSLACK_REMOTE_TUI_API_KEY or run `solder /auth`).",
  {
    prompt: z.string().describe("The task or question to send to the remote agent"),
    model: z.string().optional().describe("Model to use (e.g., gpt-5.5-xhigh, opus-4.8-high, fable-5-medium)"),
    project_id: z.string().optional().describe("Project ID for context"),
    timeout_ms: z.number().optional().describe("Timeout in milliseconds (default: 300000)"),
  },
  async ({ prompt, model, project_id, timeout_ms }) => {
    const result = await runRemoteAgent({
      prompt,
      model,
      projectId: project_id,
      timeoutMs: timeout_ms,
    });

    if (!result.success) {
      return {
        content: [{ type: "text" as const, text: `Remote agent failed: ${result.error}` }],
        isError: true,
      };
    }

    const parts: string[] = [];
    if (result.phases.length > 0) {
      parts.push("## Phases");
      for (const phase of result.phases) {
        const icon = phase.status === "finished" ? "✓" : phase.status === "failed" ? "✗" : "⟳";
        parts.push(`- ${icon} **${phase.label}**: ${phase.summary ?? phase.status}${phase.error ? ` (${phase.error})` : ""}`);
      }
      parts.push("");
    }

    if (result.toolCalls.length > 0) {
      parts.push("## Tools Used");
      for (const tc of result.toolCalls) {
        parts.push(`### ${tc.name}`);
        parts.push(`**Input:** \`${JSON.stringify(tc.input).slice(0, 300)}\``);
        if (tc.output) {
          parts.push(`**Output:** ${tc.output.slice(0, 1000)}`);
        }
        parts.push("");
      }
    }

    parts.push("## Response");
    parts.push(result.finalMessage);

    return {
      content: [{ type: "text" as const, text: parts.join("\n") }],
    };
  },
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("solder-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
