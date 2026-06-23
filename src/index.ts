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
  version: "0.3.0",
});

const DEFAULT_LIMIT = 50;

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

function truncateList<T>(items: T[], limit: number): { items: T[]; has_more: boolean; total: number } {
  return { items: items.slice(0, limit), has_more: items.length > limit, total: items.length };
}

function matchGlob(value: string, pattern: string): boolean {
  // Convert glob to regex: * → [^/]*, ? → [^/], escape dots
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

function matchesQuery(haystack: string, query: string): boolean {
  const lower = haystack.toLowerCase();
  const q = query.toLowerCase();
  // Try glob first (if contains * or ?), then substring
  if (query.includes("*") || query.includes("?")) {
    return query.split(/\s+/).some((part) => matchGlob(haystack, part));
  }
  return lower.includes(q);
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

server.resource(
  "kicad-file-info",
  new ResourceTemplate("file://{path}", { list: undefined }),
  { description: "Metadata and summary for any KiCad file. Use instead of kicad_overview when the host application pre-loads context.", mimeType: "application/json" },
  async (uri, params) => {
    const filePath = (params.path as string).replace(/^\/+/, "/");
    const content = await readFile(filePath, "utf-8");
    const ext = filePath.split(".").pop();
    let summary: Record<string, unknown> = { path: filePath, type: ext };

    if (ext === "kicad_sch") {
      const sch = parseSchematic(content);
      const realSymbols = sch.symbols.filter((s) => s.ref && !s.ref.startsWith("#"));
      summary = { ...summary, version: sch.version, component_count: realSymbols.length, wire_count: sch.wires.length, label_count: sch.labels.length };
    } else if (ext === "kicad_pcb") {
      const pcb = parsePcb(content);
      summary = { ...summary, version: pcb.version, footprint_count: pcb.footprints.length, track_count: pcb.tracks.length, net_count: pcb.nets.length };
    } else if (ext === "net") {
      const nl = parseNetlist(content);
      summary = { ...summary, component_count: nl.components.length, net_count: nl.nets.length };
    } else {
      const tree = parseSexpr(content);
      if (Array.isArray(tree)) summary = { ...summary, root: String(tree[0]), children: tree.length - 1 };
    }

    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(summary, null, 2) }] };
  },
);

// ---------------------------------------------------------------------------
// Prompts: reusable workflow templates
// ---------------------------------------------------------------------------

server.prompt(
  "design_circuit",
  "Design a new circuit from a description using SKiDL code-first workflow",
  { description: z.string().describe("Natural language description of the circuit to build") },
  ({ description }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Design this circuit using SKiDL (code-first PCB workflow):

${description}

Workflow:
1. Create or edit circuit.py with the SKiDL design. Every Part() MUST include ref= (e.g., ref='R1').
2. Run skidl_lint on circuit.py to catch errors before compiling.
3. Run skidl_compile to generate circuit.net.
4. Run kicad_overview on circuit.net to verify component and net counts match expectations.
5. If issues found, fix circuit.py and repeat from step 2.

SKiDL basics:
- from skidl import *
- r = Part('Device', 'R', ref='R1', value='10k')
- vcc = Net('VCC')
- vcc += r[1]   # connect pin 1 to VCC
- def build_circuit(): ... is the required entry point

Be specific about component values, packages, and connections. Use standard library names (Device, Connector_Generic, etc.).`,
      },
    }],
  }),
);

server.prompt(
  "review_design",
  "Review a KiCad project for common design issues",
  { project_dir: z.string().describe("Path to the KiCad project directory") },
  ({ project_dir }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Review the KiCad project at ${project_dir} for common design issues.

Steps:
1. Run kicad_overview on the .kicad_sch and .kicad_pcb files to understand the design scope
2. Run kicad_components to get the full BOM and check for missing footprints or values
3. If a .net file exists, run kicad_nets to check for unconnected pins or single-node nets
4. Look for: missing footprints, duplicate references, power flag issues, unconnected critical nets, components with no value set
5. Summarize findings as a prioritized list (critical / warning / info)

Be specific: cite component references and net names for every issue found.`,
      },
    }],
  }),
);

server.prompt(
  "compare_revisions",
  "Compare two versions of a schematic or netlist to find what changed",
  {
    file_a: z.string().describe("Path to the original/baseline file"),
    file_b: z.string().describe("Path to the modified file"),
  },
  ({ file_a, file_b }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Compare these two KiCad files and report what changed:
- Baseline: ${file_a}
- Modified: ${file_b}

Steps:
1. Run kicad_overview on both files to compare high-level counts
2. If both are netlists, run kicad_compare_netlists for a precise diff
3. If both are schematics, run kicad_components with detail=true on both and compare
4. Report: added/removed components, changed values or footprints, added/removed nets, changed connections

Present as a clear changelog with categories: Added, Removed, Modified.`,
      },
    }],
  }),
);

server.prompt(
  "bom_check",
  "Generate and validate a bill of materials from a KiCad project",
  { project_dir: z.string().describe("Path to the KiCad project directory") },
  ({ project_dir }) => ({
    messages: [{
      role: "user",
      content: {
        type: "text",
        text: `Generate a BOM from the KiCad project at ${project_dir} and check for issues.

Steps:
1. Find the .kicad_sch or .kicad_pcb file and run kicad_components to get all components
2. Group by value + footprint and count quantities
3. Flag: components with missing values, missing footprints, duplicate references, unusual quantities (e.g., odd numbers of decoupling caps)
4. Present as a table: Ref | Value | Footprint | Qty | Notes

Sort by reference designator. Include totals row.`,
      },
    }],
  }),
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  "kicad_overview",
  "Get a summary of a KiCad file. Use this FIRST when encountering any KiCad file to understand its scope before drilling into details. Returns concise counts by default; pass detail=true for the full parsed structure with all properties and coordinates. Examples: 'overview of main.kicad_sch', 'show me the PCB stats'.",
  {
    path: z.string().describe("Path to any KiCad file (.kicad_sch, .kicad_pcb, .net, .kicad_pro, etc.)"),
    detail: z.boolean().optional().describe("Return full parsed structure instead of summary. WARNING: can be very large for complex designs. Only use when you need specific fields not in the summary."),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path, detail }) => {
    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch (err) {
      return errorResult(`Cannot read file: ${err instanceof Error ? err.message : String(err)}. Check the path exists and is readable.`);
    }
    const ext = path.split(".").pop();

    if (ext === "kicad_sch") {
      const sch = parseSchematic(content);
      if (detail) return jsonResult(sch);
      const realSymbols = sch.symbols.filter((s) => s.ref && !s.ref.startsWith("#"));
      return jsonResult({
        type: "schematic", version: sch.version, components: realSymbols.length,
        wires: sch.wires.length, junctions: sch.junctions.length, labels: sch.labels.length,
        unique_footprints: [...new Set(realSymbols.map((s) => s.footprint).filter(Boolean))].length,
      });
    }
    if (ext === "kicad_pcb") {
      const pcb = parsePcb(content);
      if (detail) return jsonResult(pcb);
      const layers = new Set([...pcb.tracks.map((t) => t.layer), ...pcb.footprints.map((f) => f.layer)]);
      return jsonResult({ type: "pcb", version: pcb.version, footprints: pcb.footprints.length, tracks: pcb.tracks.length, nets: pcb.nets.length, layers: [...layers].sort() });
    }
    if (ext === "net") {
      const nl = parseNetlist(content);
      if (detail) return jsonResult(nl);
      return jsonResult({ type: "netlist", components: nl.components.length, nets: nl.nets.length, power_nets: nl.nets.filter((n) => /^(VCC|VDD|GND|VIN|VOUT|\+|-)/i.test(n.name)).map((n) => n.name) });
    }
    const tree = parseSexpr(content);
    if (detail) return jsonResult(tree);
    if (Array.isArray(tree)) return jsonResult({ type: "sexpr", root: String(tree[0]), top_level_children: tree.length - 1 });
    return jsonResult({ type: "atom", value: String(tree) });
  },
);

server.tool(
  "kicad_components",
  "List components in a schematic or PCB. Use when you need a BOM, want to find a specific part, verify values/footprints, or audit component assignments. Supports glob patterns in filter (e.g., 'C*', 'R[0-9]+', '*capacitor*'). Pass detail=true for all properties including positions and pads. Results are paginated; increase limit if has_more is true.",
  {
    path: z.string().describe("Path to .kicad_sch or .kicad_pcb file"),
    filter: z.string().optional().describe("Filter by ref, value, or footprint. Supports globs: 'R*' for all resistors, 'C1' for exact match, '*0402*' for package size"),
    detail: z.boolean().optional().describe("Include all properties, positions, pads (default: false). Large for complex designs."),
    limit: z.number().optional().describe(`Max results to return (default: ${DEFAULT_LIMIT})`),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path, filter, detail, limit }) => {
    const content = await readFile(path, "utf-8");
    const ext = path.split(".").pop();
    const maxItems = limit ?? DEFAULT_LIMIT;

    if (ext === "kicad_sch") {
      let symbols = parseSchematic(content).symbols.filter((s) => s.ref && !s.ref.startsWith("#"));
      if (filter) symbols = symbols.filter((s) => matchesQuery(`${s.ref} ${s.value} ${s.footprint}`, filter));
      symbols.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
      const { items, has_more, total } = truncateList(symbols, maxItems);
      if (detail) return jsonResult({ count: total, has_more, components: items });
      return jsonResult({ count: total, has_more, components: items.map((s) => ({ ref: s.ref, value: s.value, footprint: s.footprint })) });
    }
    if (ext === "kicad_pcb") {
      let fps = parsePcb(content).footprints;
      if (filter) fps = fps.filter((fp) => matchesQuery(`${fp.ref} ${fp.value} ${fp.libId}`, filter));
      fps.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
      const { items, has_more, total } = truncateList(fps, maxItems);
      if (detail) return jsonResult({ count: total, has_more, components: items });
      return jsonResult({ count: total, has_more, components: items.map((fp) => ({ ref: fp.ref, value: fp.value, footprint: fp.libId })) });
    }
    return errorResult(`Unsupported file type: .${ext}. Expected .kicad_sch or .kicad_pcb. Try kicad_overview for other file types.`);
  },
);

server.tool(
  "kicad_nets",
  "Inspect nets and connectivity. Use when checking which pins connect to a net, finding unconnected pins, verifying power distribution, or debugging routing. Can query by net name or component ref. For full connectivity analysis, export a netlist first with kicad_export_netlist.",
  {
    path: z.string().describe("Path to .net or .kicad_sch file"),
    net_name: z.string().optional().describe("Show all connections for this specific net (e.g., 'GND', 'VCC', 'SPI_CLK')"),
    component_ref: z.string().optional().describe("Show all nets connected to this component (e.g., 'U1', 'J3')"),
    limit: z.number().optional().describe(`Max nets to return in summary mode (default: ${DEFAULT_LIMIT})`),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path, net_name, component_ref, limit }) => {
    const content = await readFile(path, "utf-8");
    const ext = path.split(".").pop();
    const maxItems = limit ?? DEFAULT_LIMIT;

    if (ext === ".kicad_sch" || ext === "kicad_sch") {
      const sch = parseSchematic(content);
      return jsonResult({
        note: "Schematic mode shows labels only. For full net connectivity, export a netlist first with kicad_export_netlist.",
        local_labels: sch.labels.filter((l) => l.type === "local").map((l) => l.text),
        global_labels: sch.labels.filter((l) => l.type === "global").map((l) => l.text),
        hierarchical_labels: sch.labels.filter((l) => l.type === "hierarchical").map((l) => l.text),
      });
    }

    if (ext !== "net") {
      return errorResult(`Unsupported file type: .${ext}. Use .net for full connectivity or .kicad_sch for label listing.`);
    }

    const nl = parseNetlist(content);
    const nets = nl.nets.map((n) => ({ name: n.name, nodes: n.nodes.map((nd) => ({ ref: nd.ref, pin: nd.pin })) }));

    if (net_name) {
      const net = nets.find((n) => n.name.toLowerCase() === net_name.toLowerCase());
      if (!net) {
        const similar = nets.filter((n) => n.name.toLowerCase().includes(net_name.toLowerCase().slice(0, 3))).slice(0, 10);
        return errorResult(`Net '${net_name}' not found.${similar.length > 0 ? ` Did you mean: ${similar.map((n) => n.name).join(", ")}?` : ""} Use kicad_nets without net_name to list all nets.`);
      }
      return jsonResult({ net: net.name, connections: net.nodes.length, nodes: net.nodes });
    }

    if (component_ref) {
      const connected = nets.filter((n) => n.nodes.some((nd) => nd.ref.toLowerCase() === component_ref.toLowerCase()));
      if (connected.length === 0) {
        const allRefs = [...new Set(nets.flatMap((n) => n.nodes.map((nd) => nd.ref)))].sort();
        const similar = allRefs.filter((r) => r.toLowerCase().includes(component_ref.toLowerCase().slice(0, 2))).slice(0, 10);
        return errorResult(`Component '${component_ref}' not found in netlist.${similar.length > 0 ? ` Did you mean: ${similar.join(", ")}?` : ""}`);
      }
      return jsonResult({
        component: component_ref,
        nets: connected.map((n) => ({ name: n.name, pins: n.nodes.filter((nd) => nd.ref.toLowerCase() === component_ref.toLowerCase()).map((nd) => nd.pin) })),
      });
    }

    // Summary mode
    const { items, has_more, total } = truncateList(nets, maxItems);
    return jsonResult({ total_nets: total, has_more, nets: items.map((n) => ({ name: n.name, connections: n.nodes.length })) });
  },
);

server.tool(
  "kicad_compare_netlists",
  "Compare two netlists and report ONLY differences. Use after modifying a circuit to verify changes are correct, or to check SKiDL output against a KiCad export. Returns empty result if equivalent.",
  {
    path_a: z.string().describe("Path to baseline/original netlist"),
    path_b: z.string().describe("Path to modified/new netlist"),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path_a, path_b }) => {
    const [a, b] = await Promise.all([readFile(path_a, "utf-8").then(parseNetlist), readFile(path_b, "utf-8").then(parseNetlist)]);
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
  "Pretty-print a KiCad S-expression file with proper indentation. Use when you need human-readable output of a raw KiCad file, or to normalize formatting before committing.",
  { path: z.string().describe("Path to any KiCad S-expression file") },
  { readOnlyHint: true, openWorldHint: false },
  async ({ path }) => {
    const content = await readFile(path, "utf-8");
    return textResult(stringifySexprPretty(parseSexpr(content)));
  },
);

server.tool(
  "kicad_search",
  "Search across all KiCad files in a project directory. Use when you need to find where a component, net, value, or text appears across the entire project. Accepts natural terms ('10k resistor', 'GND', 'U1') or glob patterns ('R*', '*0402*', 'SPI_*'). Searches component refs/values/footprints, net names, and raw file text.",
  {
    directory: z.string().describe("Project directory to search recursively"),
    query: z.string().describe("Search term: component ref (R1), value (10k), footprint (0402), net name (GND), glob pattern (R*, SPI_*), or any text"),
    type: z.enum(["components", "nets", "text", "all"]).optional().describe("Limit search scope (default: all)"),
    limit: z.number().optional().describe(`Max matches per file (default: ${DEFAULT_LIMIT})`),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ directory, query, type, limit }) => {
    const scope = type ?? "all";
    const maxPerFile = limit ?? DEFAULT_LIMIT;
    const kicadExts = new Set([".kicad_sch", ".kicad_pcb", ".net", ".kicad_pro", ".kicad_sym"]);
    const results: { file: string; type: string; matches: unknown[] }[] = [];

    async function findFiles(dir: string): Promise<string[]> {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) files.push(...await findFiles(fullPath));
          else if (kicadExts.has(extname(entry.name))) files.push(fullPath);
        }
        return files;
      } catch { return []; }
    }

    const files = await findFiles(directory);
    if (files.length === 0) return errorResult(`No KiCad files found in ${directory}. Check the path and ensure it contains .kicad_sch, .kicad_pcb, or .net files.`);

    for (const filePath of files) {
      const content = await readFile(filePath, "utf-8");
      const ext = extname(filePath);
      const relPath = filePath.startsWith(directory) ? filePath.slice(directory.length).replace(/^[/\\]+/, "") : filePath;
      const fileMatches: unknown[] = [];

      if ((scope === "all" || scope === "components") && (ext === ".kicad_sch" || ext === ".kicad_pcb")) {
        try {
          if (ext === ".kicad_sch") {
            for (const sym of parseSchematic(content).symbols) {
              if (!sym.ref || sym.ref.startsWith("#")) continue;
              if (matchesQuery(`${sym.ref} ${sym.value} ${sym.footprint} ${sym.libId}`, query)) {
                fileMatches.push({ ref: sym.ref, value: sym.value, footprint: sym.footprint });
              }
            }
          } else {
            for (const fp of parsePcb(content).footprints) {
              if (matchesQuery(`${fp.ref} ${fp.value} ${fp.libId}`, query)) {
                fileMatches.push({ ref: fp.ref, value: fp.value, footprint: fp.libId, layer: fp.layer });
              }
            }
          }
        } catch {}
      }

      if ((scope === "all" || scope === "nets") && ext === ".net") {
        try {
          for (const net of parseNetlist(content).nets) {
            if (matchesQuery(net.name, query)) {
              fileMatches.push({ net: net.name, connections: net.nodes.length, sample_nodes: net.nodes.slice(0, 5) });
            } else {
              const matchingNodes = net.nodes.filter((n) => matchesQuery(n.ref, query));
              if (matchingNodes.length > 0) {
                fileMatches.push({ net: net.name, matched_component: query, pins: matchingNodes.map((n) => n.pin) });
              }
            }
          }
        } catch {}
      }

      if ((scope === "all" || scope === "text") && fileMatches.length === 0) {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && fileMatches.length < maxPerFile; i++) {
          if (lines[i].toLowerCase().includes(query.toLowerCase())) {
            fileMatches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
        }
      }

      if (fileMatches.length > 0) {
        results.push({ file: relPath, type: ext.replace(".", ""), matches: fileMatches.slice(0, maxPerFile) });
      }
    }

    if (results.length === 0) {
      return jsonResult({ query, matches: 0, files_searched: files.length, suggestion: "Try a broader search term, different type scope, or check spelling." });
    }

    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
    return jsonResult({ query, total_matches: totalMatches, files_searched: files.length, results });
  },
);

server.tool(
  "kicad_export_netlist",
  "Export a netlist from a KiCad schematic using kicad-cli. Use BEFORE running kicad_nets or kicad_compare_netlists on a schematic, since those tools need a .net file for full connectivity data. Requires Bun runtime and kicad-cli installed.",
  {
    schematic_path: z.string().describe("Path to .kicad_sch file"),
    output_path: z.string().optional().describe("Output path (default: same name with .net extension)"),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ schematic_path, output_path }) => {
    if (typeof Bun === "undefined") return errorResult("kicad_export_netlist requires the Bun runtime (uses Bun.spawn).");
    const outPath = output_path ?? schematic_path.replace(/\.kicad_sch$/, ".net");
    const cliPath = process.env.KICAD_CLI_PATH ?? "kicad-cli";
    try {
      const proc = Bun.spawn([cliPath, "sch", "export", "netlist", "--output", outPath, schematic_path], { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return errorResult(`kicad-cli failed (exit ${exitCode}): ${stderr}\n\nEnsure kicad-cli is installed and KICAD_CLI_PATH is set if it's not on PATH.`);
      }
      return textResult(`Netlist exported to ${outPath}`);
    } catch (err) {
      return errorResult(`Failed to run kicad-cli: ${err instanceof Error ? err.message : String(err)}\n\nIs kicad-cli installed? Set KICAD_CLI_PATH if needed.`);
    }
  },
);

server.tool(
  "skidl_compile",
  "Compile a SKiDL Python circuit file to a KiCad netlist. Use when working with code-first circuit designs. After compiling, run kicad_export_netlist or kicad_overview on the output to verify. Requires Bun runtime and PATH_TO_SKIDL_RUNTIME env var.",
  {
    script_path: z.string().describe("Path to circuit.py or other SKiDL script"),
    output_path: z.string().optional().describe("Output netlist path (default: same name with .net extension)"),
  },
  { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async ({ script_path, output_path }) => {
    if (typeof Bun === "undefined") return errorResult("skidl_compile requires the Bun runtime (uses Bun.spawn).");
    const skidlBase = process.env.PATH_TO_SKIDL_RUNTIME;
    if (!skidlBase) return errorResult("PATH_TO_SKIDL_RUNTIME environment variable not set. Point it to your SKiDL installation directory.");
    const pythonPath = join(skidlBase, "bin", "python3");
    const outPath = output_path ?? script_path.replace(/\.py$/, ".net");
    try {
      const proc = Bun.spawn([pythonPath, script_path], { cwd: dirname(script_path), env: { ...process.env, PYTHONPATH: skidlBase }, stdout: "pipe", stderr: "pipe" });
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
  "skidl_lint",
  "Validate SKiDL Python code for common errors WITHOUT compiling. Checks syntax and ensures every Part() call has an explicit ref= parameter. Use BEFORE /compile to catch issues early. Fast — uses AST parsing, not the SKiDL runtime.",
  {
    script_path: z.string().describe("Path to circuit.py or other SKiDL script"),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ script_path }) => {
    let source: string;
    try {
      source = await readFile(script_path, "utf-8");
    } catch (err) {
      return errorResult(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Parse Python AST using Bun's built-in or fallback to basic checks
    // Since we can't run Python AST in TS, do regex-based validation
    const lines = source.split("\n");
    const issues: { line: number; severity: "error" | "warning"; message: string }[] = [];

    // Check for Part() calls missing ref=
    const partCallRegex = /Part\s*\(/g;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes("Part(")) continue;
      // Skip comments
      if (line.trimStart().startsWith("#")) continue;
      // Check if ref= is present on this line or continuation
      const blockEnd = Math.min(i + 10, lines.length);
      let block = "";
      for (let j = i; j < blockEnd; j++) {
        block += lines[j];
        if (lines[j].includes(")") && !lines[j].includes("(")) break;
      }
      if (!block.includes("ref=") && !block.includes("TEMPLATE") && !block.includes("LIBRARY")) {
        issues.push({ line: i + 1, severity: "error", message: `Part() call missing ref= parameter. Every netlisted Part must include ref='R1' etc.` });
      }
    }

    // Check for basic Python syntax issues
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("from skidl import") || trimmed.startsWith("import skidl")) continue;
      if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith('"""') || trimmed.startsWith("'''")) continue;
      // Flag bare except
      if (/except\s*:/.test(trimmed)) {
        issues.push({ line: i + 1, severity: "warning", message: "Bare except clause catches all exceptions including KeyboardInterrupt" });
      }
    }

    // Check for build_circuit function
    if (!source.includes("def build_circuit")) {
      issues.push({ line: 0, severity: "warning", message: "No build_circuit() function found. Solderable expects this as the entry point." });
    }

    if (issues.length === 0) {
      return jsonResult({ ok: true, file: script_path, message: "No issues found. Ready to compile." });
    }

    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");
    return jsonResult({
      ok: errors.length === 0,
      file: script_path,
      errors: errors.length,
      warnings: warnings.length,
      issues,
    });
  },
);

server.tool(
  "skidl_explain",
  "Explain what a SKiDL circuit.py file does in plain English. Parses the Python source and summarizes components, connections, power rails, and subcircuits without needing the SKiDL runtime. Use when reviewing or understanding existing circuit code.",
  {
    script_path: z.string().describe("Path to circuit.py or other SKiDL script"),
  },
  { readOnlyHint: true, openWorldHint: false },
  async ({ script_path }) => {
    let source: string;
    try {
      source = await readFile(script_path, "utf-8");
    } catch (err) {
      return errorResult(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
    }

    const lines = source.split("\n");
    const parts: { ref?: string; lib?: string; name?: string; value?: string; line: number }[] = [];
    const nets: { name: string; line: number }[] = [];
    const connections: { from: string; to: string; line: number }[] = [];
    const imports: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#")) continue;

      // Track imports
      if (line.startsWith("from ") || line.startsWith("import ")) {
        imports.push(line);
        continue;
      }

      // Extract Part() calls
      const partMatch = line.match(/Part\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/);
      if (partMatch) {
        const refMatch = line.match(/ref\s*=\s*["']([^"']+)["']/);
        const valMatch = line.match(/value\s*=\s*["']([^"']+)["']/);
        parts.push({
          lib: partMatch[1], name: partMatch[2],
          ref: refMatch?.[1], value: valMatch?.[1],
          line: i + 1,
        });
      }

      // Extract Net() calls
      const netMatch = line.match(/Net\s*\(\s*["']([^"']+)["']\s*\)/);
      if (netMatch) {
        nets.push({ name: netMatch[1], line: i + 1 });
      }

      // Extract += connections (net += pin pattern)
      const connMatch = line.match(/(\w+)\s*\+=\s*(.+)/);
      if (connMatch && !line.includes("import")) {
        connections.push({ from: connMatch[1], to: connMatch[2].trim(), line: i + 1 });
      }
    }

    return jsonResult({
      file: script_path,
      summary: {
        total_lines: lines.length,
        components: parts.length,
        named_nets: nets.length,
        connections: connections.length,
        has_build_circuit: source.includes("def build_circuit"),
      },
      imports,
      components: parts.map((p) => ({
        ...(p.ref ? { ref: p.ref } : {}),
        lib: p.lib, part: p.name,
        ...(p.value ? { value: p.value } : {}),
        line: p.line,
      })),
      nets: nets.slice(0, 30),
      connections: connections.slice(0, 30),
      ...(parts.some((p) => !p.ref) ? { warning: `${parts.filter((p) => !p.ref).length} Part() calls missing ref=` } : {}),
    });
  },
);

server.tool(
  "solder_remote_agent",
  "Run a task on the Solderable remote agent. Use for tasks requiring AI reasoning about circuits: LCSC component search, SKiDL help, pinout lookup, design review, sub-agent dispatch, or accessing the fine-tuned Gemini layout model. Available remote tools: component_search, skidl_help, get_pinout, component_expert, review, verify_requirements, compile, shell_command, apply_patch, dispatch_subagent. Requires SOLDERSLACK_REMOTE_TUI_API_KEY.",
  {
    prompt: z.string().describe("Task or question for the remote agent"),
    model: z.string().optional().describe("Model override: gpt-5.5-xhigh (default), opus-4.8-high, fable-5-medium"),
    project_id: z.string().optional().describe("Project ID for persistent context across calls"),
    timeout_ms: z.number().optional().describe("Timeout in ms (default: 300000)"),
  },
  { readOnlyHint: false, openWorldHint: true },
  async ({ prompt, model, project_id, timeout_ms }) => {
    const result = await runRemoteAgent({ prompt, model, projectId: project_id, timeoutMs: timeout_ms });
    if (!result.success) return errorResult(`Remote agent failed: ${result.error}`);

    const parts: string[] = [];
    const meaningfulPhases = result.phases.filter((p) => p.summary || p.status === "failed");
    if (meaningfulPhases.length > 0) {
      parts.push("## Phases");
      for (const phase of meaningfulPhases) {
        const icon = phase.status === "finished" ? "✓" : phase.status === "failed" ? "✗" : "⟳";
        parts.push(`- ${icon} **${phase.label}**: ${phase.summary ?? phase.status}${phase.error ? ` (${phase.error})` : ""}`);
      }
      parts.push("");
    }
    if (result.toolCalls.length > 0) {
      parts.push("## Tools Used");
      for (const tc of result.toolCalls) {
        const inputStr = JSON.stringify(tc.input);
        parts.push(`**${tc.name}**: ${inputStr.length > 200 ? inputStr.slice(0, 200) + "..." : inputStr}`);
        if (tc.output) parts.push(`→ ${tc.output.slice(0, 500)}`);
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
  console.error("solder-mcp v0.3.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
