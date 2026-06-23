#!/usr/bin/env bun
// Solder MCP Server - KiCad/EDA tooling extracted from Solderable

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, readdir } from "fs/promises";
import { dirname, join, extname } from "path";
import { parseSexpr, stringifySexprPretty } from "./sexpr";
import { parseNetlist } from "./netlist";
import { parseSchematic } from "./schematic";
import { parsePcb } from "./pcb";
import { runRemoteAgent } from "./remote-agent";

const server = new McpServer({
  name: "solder-mcp",
  version: "0.2.0",
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function jsonResult(data: unknown) {
  return textResult(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Resources: let agents browse project structure without calling tools
// ---------------------------------------------------------------------------

server.resource(
  "kicad-file-info",
  new ResourceTemplate("file://{path}", { list: undefined }),
  { description: "Metadata and summary for any KiCad file", mimeType: "application/json" },
  async (uri, params) => {
    const filePath = (params.path as string).replace(/^\/+/, "/");
    const content = await readFile(filePath, "utf-8");
    const ext = filePath.split(".").pop();

    let summary: Record<string, unknown> = { path: filePath, type: ext };

    if (ext === "kicad_sch") {
      const sch = parseSchematic(content);
      const realSymbols = sch.symbols.filter((s) => s.ref && !s.ref.startsWith("#"));
      summary = {
        ...summary,
        version: sch.version,
        component_count: realSymbols.length,
        wire_count: sch.wires.length,
        label_count: sch.labels.length,
        components: realSymbols.map((s) => ({ ref: s.ref, value: s.value, footprint: s.footprint })),
      };
    } else if (ext === "kicad_pcb") {
      const pcb = parsePcb(content);
      summary = {
        ...summary,
        version: pcb.version,
        footprint_count: pcb.footprints.length,
        track_count: pcb.tracks.length,
        net_count: pcb.nets.length,
      };
    } else if (ext === "net") {
      const nl = parseNetlist(content);
      summary = {
        ...summary,
        component_count: nl.components.length,
        net_count: nl.nets.length,
      };
    } else {
      // Generic S-expression: just show root node and child count
      const tree = parseSexpr(content);
      if (Array.isArray(tree)) {
        summary = { ...summary, root: String(tree[0]), children: tree.length - 1 };
      }
    }

    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(summary, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Tools: focused, concise, annotated
// ---------------------------------------------------------------------------

server.tool(
  "kicad_overview",
  "Get a summary of a KiCad file. By default returns concise counts and metadata. Pass detail=true for the full parsed structure (all properties, coordinates, raw data). Use the summary FIRST, then detail=true only when you need specific fields not in the summary.",
  {
    path: z.string().describe("Path to any KiCad file (.kicad_sch, .kicad_pcb, .net, .kicad_pro, etc.)"),
    detail: z.boolean().optional().describe("Return full parsed structure instead of summary (default: false)"),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path, detail }) => {
    const content = await readFile(path, "utf-8");
    const ext = path.split(".").pop();

    if (ext === "kicad_sch") {
      const sch = parseSchematic(content);
      if (detail) return jsonResult(sch);
      const realSymbols = sch.symbols.filter((s) => s.ref && !s.ref.startsWith("#"));
      return jsonResult({
        type: "schematic",
        version: sch.version,
        components: realSymbols.length,
        wires: sch.wires.length,
        junctions: sch.junctions.length,
        labels: sch.labels.length,
        unique_footprints: [...new Set(realSymbols.map((s) => s.footprint).filter(Boolean))].length,
      });
    }

    if (ext === "kicad_pcb") {
      const pcb = parsePcb(content);
      if (detail) return jsonResult(pcb);
      const layers = new Set([...pcb.tracks.map((t) => t.layer), ...pcb.footprints.map((f) => f.layer)]);
      return jsonResult({
        type: "pcb",
        version: pcb.version,
        footprints: pcb.footprints.length,
        tracks: pcb.tracks.length,
        nets: pcb.nets.length,
        layers: [...layers].sort(),
      });
    }

    if (ext === "net") {
      const nl = parseNetlist(content);
      if (detail) return jsonResult(nl);
      return jsonResult({
        type: "netlist",
        components: nl.components.length,
        nets: nl.nets.length,
        power_nets: nl.nets.filter((n) => /^(VCC|VDD|GND|VIN|VOUT|\+|-)/i.test(n.name)).map((n) => n.name),
      });
    }

    // Generic S-expression
    const tree = parseSexpr(content);
    if (detail) return jsonResult(tree);
    if (Array.isArray(tree)) {
      return jsonResult({ type: "sexpr", root: String(tree[0]), top_level_children: tree.length - 1 });
    }
    return jsonResult({ type: "atom", value: String(tree) });
  },
);

server.tool(
  "kicad_components",
  "List components in a schematic or PCB with ref, value, and footprint. Pass detail=true to include all properties, positions, and pad info.",
  {
    path: z.string().describe("Path to .kicad_sch or .kicad_pcb file"),
    filter: z.string().optional().describe("Optional regex to filter by ref, value, or footprint (e.g., 'R[0-9]+', 'capacitor')"),
    detail: z.boolean().optional().describe("Include all properties, positions, pads (default: false)"),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path, filter, detail }) => {
    const content = await readFile(path, "utf-8");
    const ext = path.split(".").pop();

    if (ext === "kicad_sch") {
      const sch = parseSchematic(content);
      let symbols = sch.symbols.filter((s) => s.ref && !s.ref.startsWith("#"));
      if (filter) {
        const re = new RegExp(filter, "i");
        symbols = symbols.filter((s) => re.test(s.ref) || re.test(s.value) || re.test(s.footprint));
      }
      symbols.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
      if (detail) return jsonResult({ count: symbols.length, components: symbols });
      return jsonResult({
        count: symbols.length,
        components: symbols.map((s) => ({ ref: s.ref, value: s.value, footprint: s.footprint })),
      });
    }

    if (ext === "kicad_pcb") {
      const pcb = parsePcb(content);
      let fps = pcb.footprints;
      if (filter) {
        const re = new RegExp(filter, "i");
        fps = fps.filter((fp) => re.test(fp.ref) || re.test(fp.value) || re.test(fp.libId));
      }
      fps.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
      if (detail) return jsonResult({ count: fps.length, components: fps });
      return jsonResult({
        count: fps.length,
        components: fps.map((fp) => ({ ref: fp.ref, value: fp.value, footprint: fp.libId })),
      });
    }

    return errorResult(`Unsupported file type: .${ext}. Use .kicad_sch or .kicad_pcb.`);
  },
);

server.tool(
  "kicad_nets",
  "Inspect nets in a netlist or schematic. Can list all nets, show connections for a specific net, or find which net a component pin belongs to.",
  {
    path: z.string().describe("Path to .net or .kicad_sch file"),
    net_name: z.string().optional().describe("Show connections for this specific net"),
    component_ref: z.string().optional().describe("Show all nets connected to this component"),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path, net_name, component_ref }) => {
    const content = await readFile(path, "utf-8");
    const ext = path.split(".").pop();

    let nets: { name: string; nodes: { ref: string; pin: string }[] }[] = [];

    if (ext === "net") {
      const nl = parseNetlist(content);
      nets = nl.nets.map((n) => ({ name: n.name, nodes: n.nodes.map((nd) => ({ ref: nd.ref, pin: nd.pin })) }));
    } else if (ext === "kicad_sch") {
      // Extract net info from schematic labels and wires
      const sch = parseSchematic(content);
      const labelNets = sch.labels.map((l) => ({ name: l.text, nodes: [] as { ref: string; pin: string }[] }));
      return jsonResult({
        note: "Schematic net extraction shows labels only. For full connectivity, export a netlist first with kicad_export_netlist.",
        labels: labelNets.map((l) => l.name),
        global_labels: sch.labels.filter((l) => l.type === "global").map((l) => l.text),
        hierarchical_labels: sch.labels.filter((l) => l.type === "hierarchical").map((l) => l.text),
      });
    } else {
      return errorResult(`Unsupported file type: .${ext}. Use .net or .kicad_sch.`);
    }

    if (net_name) {
      const net = nets.find((n) => n.name === net_name);
      if (!net) return errorResult(`Net '${net_name}' not found. Available: ${nets.slice(0, 20).map((n) => n.name).join(", ")}${nets.length > 20 ? ` (+${nets.length - 20} more)` : ""}`);
      return jsonResult({ net: net.name, connections: net.nodes });
    }

    if (component_ref) {
      const connected = nets.filter((n) => n.nodes.some((nd) => nd.ref === component_ref));
      return jsonResult({
        component: component_ref,
        nets: connected.map((n) => ({
          name: n.name,
          pins: n.nodes.filter((nd) => nd.ref === component_ref).map((nd) => nd.pin),
        })),
      });
    }

    // Summary: just names and connection counts
    return jsonResult({
      total_nets: nets.length,
      nets: nets.map((n) => ({ name: n.name, connections: n.nodes.length })),
    });
  },
);

server.tool(
  "kicad_compare_netlists",
  "Compare two netlists and report only differences. Returns a concise diff summary, not full netlists.",
  {
    path_a: z.string().describe("Path to first netlist"),
    path_b: z.string().describe("Path to second netlist"),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path_a, path_b }) => {
    const [a, b] = await Promise.all([
      readFile(path_a, "utf-8").then(parseNetlist),
      readFile(path_b, "utf-8").then(parseNetlist),
    ]);

    const netsA = new Map(a.nets.map((n) => [n.name, new Set(n.nodes.map((nd) => `${nd.ref}:${nd.pin}`))]));
    const netsB = new Map(b.nets.map((n) => [n.name, new Set(n.nodes.map((nd) => `${nd.ref}:${nd.pin}`))]));

    const onlyInA = [...netsA.keys()].filter((k) => !netsB.has(k));
    const onlyInB = [...netsB.keys()].filter((k) => !netsA.has(k));
    const mismatched: { name: string; diff: string }[] = [];

    for (const [name, nodesA] of netsA) {
      const nodesB = netsB.get(name);
      if (!nodesB) continue;
      if (nodesA.size !== nodesB.size || ![...nodesA].every((n) => nodesB.has(n))) {
        const added = [...nodesB].filter((n) => !nodesA.has(n));
        const removed = [...nodesA].filter((n) => !nodesB.has(n));
        const parts: string[] = [];
        if (added.length) parts.push(`+${added.join(", +")}`);
        if (removed.length) parts.push(`-${removed.join(", -")}`);
        mismatched.push({ name, diff: parts.join("; ") });
      }
    }

    const equivalent = onlyInA.length === 0 && onlyInB.length === 0 && mismatched.length === 0;
    return jsonResult({
      equivalent,
      ...(equivalent ? {} : {
        summary: `${onlyInA.length} nets only in A, ${onlyInB.length} only in B, ${mismatched.length} mismatched`,
        ...(onlyInA.length ? { only_in_a: onlyInA } : {}),
        ...(onlyInB.length ? { only_in_b: onlyInB } : {}),
        ...(mismatched.length ? { mismatched } : {}),
      }),
    });
  },
);

server.tool(
  "kicad_format_file",
  "Pretty-print a KiCad S-expression file with proper indentation. Returns the formatted text.",
  { path: z.string().describe("Path to any KiCad S-expression file") },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path }) => {
    const content = await readFile(path, "utf-8");
    const tree = parseSexpr(content);
    return textResult(stringifySexprPretty(tree));
  },
);

server.tool(
  "kicad_export_netlist",
  "Export a netlist from a KiCad schematic using kicad-cli. Requires Bun runtime and kicad-cli installed.",
  {
    schematic_path: z.string().describe("Path to .kicad_sch file"),
    output_path: z.string().optional().describe("Output path (default: same name with .net extension)"),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ schematic_path, output_path }) => {
    if (typeof Bun === "undefined") {
      return errorResult("kicad_export_netlist requires the Bun runtime.");
    }
    const outPath = output_path ?? schematic_path.replace(/\.kicad_sch$/, ".net");
    const cliPath = process.env.KICAD_CLI_PATH ?? "kicad-cli";

    try {
      const proc = Bun.spawn([cliPath, "sch", "export", "netlist", "--output", outPath, schematic_path], {
        stdout: "pipe", stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return errorResult(`kicad-cli failed (exit ${exitCode}): ${stderr}`);
      }
      return textResult(`Netlist exported to ${outPath}`);
    } catch (err) {
      return errorResult(`Failed to run kicad-cli: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "skidl_compile",
  "Compile a SKiDL Python circuit file to a KiCad netlist. Requires Bun runtime and PATH_TO_SKIDL_RUNTIME env var.",
  {
    script_path: z.string().describe("Path to circuit.py or other SKiDL script"),
    output_path: z.string().optional().describe("Output netlist path (default: same name with .net extension)"),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ script_path, output_path }) => {
    if (typeof Bun === "undefined") {
      return errorResult("skidl_compile requires the Bun runtime.");
    }
    const skidlBase = process.env.PATH_TO_SKIDL_RUNTIME;
    if (!skidlBase) {
      return errorResult("PATH_TO_SKIDL_RUNTIME environment variable not set.");
    }

    const pythonPath = join(skidlBase, "bin", "python3");
    const outPath = output_path ?? script_path.replace(/\.py$/, ".net");

    try {
      const proc = Bun.spawn([pythonPath, script_path], {
        cwd: dirname(script_path),
        env: { ...process.env, PYTHONPATH: skidlBase },
        stdout: "pipe", stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return errorResult(`SKiDL compilation failed (exit ${exitCode}):\n${stderr}`);
      }
      return textResult(`Compiled successfully. Netlist: ${outPath}`);
    } catch (err) {
      return errorResult(`SKiDL compile failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
);

server.tool(
  "kicad_search",
  "Search across KiCad files in a project directory. Finds components, nets, labels, and raw text matches. Returns concise matches with file paths and context.",
  {
    directory: z.string().describe("Project directory to search"),
    query: z.string().describe("Search term: component ref (R1), value (10k), footprint (0402), net name (GND), or any text"),
    type: z.enum(["components", "nets", "text", "all"]).optional().describe("Limit search scope (default: all)"),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ directory, query, type }) => {
    const scope = type ?? "all";
    const kicadExts = new Set([".kicad_sch", ".kicad_pcb", ".net", ".kicad_pro", ".kicad_sym"]);
    const results: { file: string; type: string; matches: unknown[] }[] = [];

    // Recursively find KiCad files
    async function findFiles(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...await findFiles(fullPath));
        } else if (kicadExts.has(extname(entry.name))) {
          files.push(fullPath);
        }
      }
      return files;
    }

    let files: string[];
    try {
      files = await findFiles(directory);
    } catch (err) {
      return errorResult(`Cannot read directory: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (files.length === 0) {
      return errorResult(`No KiCad files found in ${directory}`);
    }

    const queryLower = query.toLowerCase();

    for (const filePath of files) {
      const content = await readFile(filePath, "utf-8");
      const ext = extname(filePath);
      const relPath = filePath.startsWith(directory) ? filePath.slice(directory.length).replace(/^[/\\]+/, "") : filePath;
      const fileMatches: unknown[] = [];

      // Component search
      if ((scope === "all" || scope === "components") && (ext === ".kicad_sch" || ext === ".kicad_pcb")) {
        try {
          if (ext === ".kicad_sch") {
            const sch = parseSchematic(content);
            for (const sym of sch.symbols) {
              if (!sym.ref || sym.ref.startsWith("#")) continue;
              const haystack = `${sym.ref} ${sym.value} ${sym.footprint} ${sym.libId}`.toLowerCase();
              if (haystack.includes(queryLower)) {
                fileMatches.push({ ref: sym.ref, value: sym.value, footprint: sym.footprint, position: sym.at });
              }
            }
          } else {
            const pcb = parsePcb(content);
            for (const fp of pcb.footprints) {
              const haystack = `${fp.ref} ${fp.value} ${fp.libId}`.toLowerCase();
              if (haystack.includes(queryLower)) {
                fileMatches.push({ ref: fp.ref, value: fp.value, footprint: fp.libId, layer: fp.layer, position: fp.at });
              }
            }
          }
        } catch { /* skip unparseable files */ }
      }

      // Net search
      if ((scope === "all" || scope === "nets") && ext === ".net") {
        try {
          const nl = parseNetlist(content);
          for (const net of nl.nets) {
            if (net.name.toLowerCase().includes(queryLower)) {
              fileMatches.push({ net: net.name, connections: net.nodes.length, nodes: net.nodes.slice(0, 10) });
            } else {
              // Check if query matches a component ref within this net
              const matchingNodes = net.nodes.filter((n) => n.ref.toLowerCase().includes(queryLower));
              if (matchingNodes.length > 0) {
                fileMatches.push({ net: net.name, matched_component: query, pins: matchingNodes.map((n) => n.pin) });
              }
            }
          }
        } catch { /* skip */ }
      }

      // Raw text search
      if ((scope === "all" || scope === "text") && fileMatches.length === 0) {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            fileMatches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
            if (fileMatches.length >= 20) break; // cap raw text matches
          }
        }
      }

      if (fileMatches.length > 0) {
        results.push({ file: relPath, type: ext.replace(".", ""), matches: fileMatches });
      }
    }

    if (results.length === 0) {
      return jsonResult({ query, matches: 0, message: `No matches for "${query}" in ${files.length} KiCad files` });
    }

    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
    return jsonResult({ query, total_matches: totalMatches, files_searched: files.length, results });
  },
);

server.tool(
  "solder_remote_agent",
  "Run a task on the Solderable remote agent. Access to GPT-5.5, Claude Opus 4.8, Claude Fable 5, fine-tuned Gemini layout model, LCSC component search, SKiDL help, pinout lookup, and sub-agent dispatch. Requires SOLDERSLACK_REMOTE_TUI_API_KEY.",
  {
    prompt: z.string().describe("Task or question for the remote agent"),
    model: z.string().optional().describe("Model override (gpt-5.5-xhigh, opus-4.8-high, fable-5-medium)"),
    project_id: z.string().optional().describe("Project ID for context"),
    timeout_ms: z.number().optional().describe("Timeout in ms (default: 300000)"),
  },
  { readOnlyHint: false, openWorldHint: true },
  async ({ prompt, model, project_id, timeout_ms }) => {
    const result = await runRemoteAgent({ prompt, model, projectId: project_id, timeoutMs: timeout_ms });

    if (!result.success) {
      return errorResult(`Remote agent failed: ${result.error}`);
    }

    const parts: string[] = [];

    // Only show phases if there are meaningful ones (not just boilerplate)
    const meaningfulPhases = result.phases.filter((p) => p.summary || p.status === "failed");
    if (meaningfulPhases.length > 0) {
      parts.push("## Phases");
      for (const phase of meaningfulPhases) {
        const icon = phase.status === "finished" ? "✓" : phase.status === "failed" ? "✗" : "⟳";
        parts.push(`- ${icon} **${phase.label}**: ${phase.summary ?? phase.status}${phase.error ? ` (${phase.error})` : ""}`);
      }
      parts.push("");
    }

    // Show tool calls concisely
    if (result.toolCalls.length > 0) {
      parts.push("## Tools Used");
      for (const tc of result.toolCalls) {
        const inputStr = JSON.stringify(tc.input);
        const outputPreview = tc.output ? tc.output.slice(0, 500) : "(no output)";
        parts.push(`**${tc.name}**: ${inputStr.length > 200 ? inputStr.slice(0, 200) + "..." : inputStr}`);
        parts.push(`→ ${outputPreview}`);
        parts.push("");
      }
    }

    parts.push(result.finalMessage);
    return textResult(parts.join("\n"));
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("solder-mcp v0.2.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
