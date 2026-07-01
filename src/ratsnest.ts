#!/usr/bin/env bun
// Ratsnest viewer - renders KiCad schematic with ratsnest overlay in browser
// Usage: bun run ratsnest.ts <schematic.kicad_sch> [netlist.net]

import { readFile } from "fs/promises";
import { basename, dirname } from "path";
import { parseSexpr, type SexprNode, getChild, getChildAtom, getAllChildren } from "./sexpr";
import { parseNetlist, type NetlistDocument } from "./netlist";

interface PinDef {
  number: string;
  name: string;
  x: number; // relative to symbol origin
  y: number;
  angle: number; // pin orientation
}

interface LibSymbol {
  libId: string;
  pins: Map<string, PinDef>;
}

interface SymbolInstance {
  libId: string;
  ref: string;
  value: string;
  x: number;
  y: number;
  angle: number;
  uuid: string;
}

interface PinLocation {
  ref: string;
  pin: string;
  x: number;
  y: number;
}

interface Net {
  name: string;
  pins: PinLocation[];
}

function deg2rad(d: number): number {
  return (d * Math.PI) / 180;
}

function rotate(x: number, y: number, angleDeg: number): [number, number] {
  const r = deg2rad(angleDeg);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

function parseLibSymbols(tree: SexprNode): Map<string, LibSymbol> {
  const lib = new Map<string, LibSymbol>();
  const libSymNode = getChild(tree, "lib_symbols");
  if (!libSymNode || !Array.isArray(libSymNode)) return lib;

  for (const sym of getAllChildren(libSymNode, "symbol")) {
    const libId = String(sym[1] ?? "");
    if (!libId) continue;

    const pins = new Map<string, PinDef>();
    // Pins can be nested in unit sub-symbols
    const allPins = findAllPins(sym);
    for (const p of allPins) {
      const atNode = getChild(p, "at");
      const pinNum = getChildAtom(p, "number", "");
      const pinName = getChildAtom(p, "name", "");
      if (!pinNum || !atNode) continue;
      pins.set(pinNum, {
        number: pinNum,
        name: pinName,
        x: Number(atNode[1]) || 0,
        y: Number(atNode[2]) || 0,
        angle: Number(atNode[3]) || 0,
      });
    }
    lib.set(libId, { libId, pins });
  }
  return lib;
}

function findAllPins(node: SexprNode): SexprNode[][] {
  const pins: SexprNode[][] = [];
  if (!Array.isArray(node)) return pins;
  for (const child of node) {
    if (Array.isArray(child) && child.length > 0 && child[0] === "pin") {
      pins.push(child);
    } else if (Array.isArray(child)) {
      pins.push(...findAllPins(child));
    }
  }
  return pins;
}

function parseSymbolInstances(tree: SexprNode): SymbolInstance[] {
  const instances: SymbolInstance[] = [];
  if (!Array.isArray(tree)) return instances;

  for (const sym of getAllChildren(tree, "symbol")) {
    const libId = getChildAtom(sym, "lib_id", "");
    if (!libId) continue;

    const atNode = getChild(sym, "at");
    if (!atNode) continue;

    // Find Reference property
    let ref = "";
    let value = "";
    for (const prop of getAllChildren(sym, "property")) {
      const propName = String(prop[1] ?? "");
      const propVal = String(prop[2] ?? "");
      if (propName === "Reference") ref = propVal;
      if (propName === "Value") value = propVal;
    }

    // Also check instances for the actual reference (handles power symbols etc)
    const instancesNode = getChild(sym, "instances");
    if (instancesNode) {
      for (const proj of getAllChildren(instancesNode, "project")) {
        for (const path of getAllChildren(proj, "path")) {
          const refNode = getChild(path, "reference");
          if (refNode) ref = String(refNode[1] ?? ref);
        }
      }
    }

    if (!ref) continue;

    instances.push({
      libId,
      ref,
      value,
      x: Number(atNode[1]) || 0,
      y: Number(atNode[2]) || 0,
      angle: Number(atNode[3]) || 0,
      uuid: getChildAtom(sym, "uuid", ""),
    });
  }
  return instances;
}

function computePinPositions(
  instances: SymbolInstance[],
  libSymbols: Map<string, LibSymbol>,
): Map<string, Map<string, PinLocation>> {
  // Returns: ref -> pin -> location
  const result = new Map<string, Map<string, PinLocation>>();

  for (const inst of instances) {
    const libSym = libSymbols.get(inst.libId);
    if (!libSym) continue;

    const pinMap = new Map<string, PinLocation>();
    for (const [pinNum, pinDef] of libSym.pins) {
      // Rotate pin position by symbol angle, then translate to symbol position
      const [rx, ry] = rotate(pinDef.x, pinDef.y, inst.angle);
      pinMap.set(pinNum, {
        ref: inst.ref,
        pin: pinNum,
        x: inst.x + rx,
        y: inst.y - ry, // KiCad Y is up, SVG Y is down
      });
    }
    result.set(inst.ref, pinMap);
  }

  return result;
}

function buildNets(
  netlist: NetlistDocument,
  pinPositions: Map<string, Map<string, PinLocation>>,
): Net[] {
  const nets: Net[] = [];
  for (const net of netlist.nets) {
    const pins: PinLocation[] = [];
    for (const node of net.nodes) {
      const refPins = pinPositions.get(node.ref);
      if (!refPins) continue;
      const loc = refPins.get(node.pin);
      if (!loc) continue;
      pins.push(loc);
    }
    if (pins.length > 0) {
      nets.push({ name: net.name, pins });
    }
  }
  return nets;
}

function computeBounds(instances: SymbolInstance[], nets: Net[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const inst of instances) {
    minX = Math.min(minX, inst.x);
    minY = Math.min(minY, inst.y);
    maxX = Math.max(maxX, inst.x);
    maxY = Math.max(maxY, inst.y);
  }
  for (const net of nets) {
    for (const pin of net.pins) {
      minX = Math.min(minX, pin.x);
      minY = Math.min(minY, pin.y);
      maxX = Math.max(maxX, pin.x);
      maxY = Math.max(maxY, pin.y);
    }
  }
  const pad = 20;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function generateSVG(
  instances: SymbolInstance[],
  nets: Net[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): string {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const scale = 4; // mm to px scale factor

  const svgW = width * scale;
  const svgH = height * scale;

  const tx = (x: number) => (x - bounds.minX) * scale;
  const ty = (y: number) => (y - bounds.minY) * scale;

  // Group nets by color
  const netColors = new Map<string, string>();
  const palette = [
    "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
    "#1abc9c", "#e67e22", "#e91e63", "#00bcd4", "#8bc34a",
    "#ff5722", "#607d8b", "#795548", "#cddc39", "#009688",
  ];
  let colorIdx = 0;
  for (const net of nets) {
    netColors.set(net.name, palette[colorIdx % palette.length]);
    colorIdx++;
  }

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="background:#1a1a2e;font-family:monospace">\n`;

  // Draw ratsnest lines first (behind components)
  for (const net of nets) {
    const color = netColors.get(net.name)!;
    if (net.pins.length < 2) continue;

    // Draw lines between all pins in the net (full mesh for clarity)
    for (let i = 0; i < net.pins.length; i++) {
      for (let j = i + 1; j < net.pins.length; j++) {
        svg += `  <line x1="${tx(net.pins[i].x)}" y1="${ty(net.pins[i].y)}" x2="${tx(net.pins[j].x)}" y2="${ty(net.pins[j].y)}" stroke="${color}" stroke-width="0.8" opacity="0.5"/>\n`;
      }
    }
  }

  // Draw component markers
  for (const inst of instances) {
    const cx = tx(inst.x);
    const cy = ty(inst.y);
    // Skip power symbols (they're usually GND/VCC labels)
    const isPower = inst.libId.startsWith("power:");
    const r = isPower ? 3 : 6;

    svg += `  <circle cx="${cx}" cy="${cy}" r="${r}" fill="${isPower ? "#555" : "#16213e"}" stroke="${isPower ? "#666" : "#0f3460"}" stroke-width="1.5"/>\n`;
    svg += `  <text x="${cx}" y="${cy - 10}" fill="#eee" font-size="9" text-anchor="middle">${inst.ref}</text>\n`;
    if (!isPower && inst.value && inst.value !== inst.ref) {
      svg += `  <text x="${cx}" y="${cy + 16}" fill="#888" font-size="7" text-anchor="middle">${inst.value.slice(0, 20)}</text>\n`;
    }
  }

  // Draw pin dots
  for (const net of nets) {
    const color = netColors.get(net.name)!;
    for (const pin of net.pins) {
      svg += `  <circle cx="${tx(pin.x)}" cy="${ty(pin.y)}" r="2" fill="${color}"/>\n`;
    }
  }

  svg += `</svg>`;
  return svg;
}

function generateHTML(svg: string, nets: Net[], instances: SymbolInstance[]): string {
  const netList = nets
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => `<div class="net-item" data-net="${n.name}"><span class="net-color" style="background:${getNetColor(n.name)}"></span><span class="net-name">${n.name}</span><span class="net-count">${n.pins.length} pins</span></div>`)
    .join("\n");

  const componentList = instances
    .filter((i) => !i.libId.startsWith("power:"))
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }))
    .map((i) => `<div class="comp-item"><span class="comp-ref">${i.ref}</span><span class="comp-val">${i.value}</span></div>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ratsnest Viewer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0f0f1e; color: #eee; font-family: -apple-system, system-ui, monospace; display: flex; height: 100vh; overflow: hidden; }
  #sidebar { width: 280px; background: #16213e; border-right: 1px solid #0f3460; overflow-y: auto; flex-shrink: 0; }
  #sidebar h2 { padding: 12px 16px; font-size: 13px; color: #888; border-bottom: 1px solid #0f3460; position: sticky; top: 0; background: #16213e; z-index: 1; }
  .net-item { display: flex; align-items: center; padding: 6px 16px; cursor: pointer; gap: 8px; }
  .net-item:hover { background: #1a1a3e; }
  .net-item.active { background: #0f3460; }
  .net-color { width: 12px; height: 12px; border-radius: 2px; flex-shrink: 0; }
  .net-name { flex: 1; font-size: 12px; }
  .net-count { font-size: 10px; color: #666; }
  .comp-item { display: flex; padding: 4px 16px; gap: 12px; font-size: 11px; }
  .comp-ref { color: #3498db; width: 40px; flex-shrink: 0; }
  .comp-val { color: #888; }
  #viewer { flex: 1; overflow: auto; display: flex; align-items: center; justify-content: center; padding: 20px; }
  #viewer svg { max-width: 100%; max-height: 100%; }
  .net-item.active .net-color { box-shadow: 0 0 8px currentColor; }
</style>
</head>
<body>
<div id="sidebar">
  <h2>Nets (${nets.length})</h2>
  <div id="net-list">${netList}</div>
  <h2>Components (${instances.filter(i => !i.libId.startsWith("power:")).length})</h2>
  <div id="comp-list">${componentList}</div>
</div>
<div id="viewer">${svg}</div>
<script>
  const netItems = document.querySelectorAll('.net-item');
  const svg = document.querySelector('#viewer svg');
  const lines = svg.querySelectorAll('line');
  const pinDots = svg.querySelectorAll('circle');
  const texts = svg.querySelectorAll('text');

  // Store original opacity
  lines.forEach(l => l.dataset.origOpacity = l.getAttribute('opacity'));

  netItems.forEach(item => {
    item.addEventListener('mouseenter', () => {
      const netName = item.dataset.net;
      const color = item.querySelector('.net-color').style.background;
      item.classList.add('active');

      // Highlight matching lines and dim others
      lines.forEach(l => {
        if (l.getAttribute('stroke') === getComputedStyle(item.querySelector('.net-color')).backgroundColor) {
          l.setAttribute('opacity', '1');
          l.setAttribute('stroke-width', '1.5');
        } else {
          l.setAttribute('opacity', '0.08');
        }
      });

      // Highlight matching pin dots
      pinDots.forEach(d => {
        if (d.getAttribute('fill') === getComputedStyle(item.querySelector('.net-color')).backgroundColor) {
          d.setAttribute('r', '4');
        } else {
          d.setAttribute('opacity', '0.2');
        }
      });
    });

    item.addEventListener('mouseleave', () => {
      item.classList.remove('active');
      lines.forEach(l => {
        l.setAttribute('opacity', l.dataset.origOpacity);
        l.setAttribute('stroke-width', '0.8');
      });
      pinDots.forEach(d => {
        d.setAttribute('r', '2');
        d.removeAttribute('opacity');
      });
    });
  });
</script>
</body>
</html>`;
}

function getNetColor(name: string): string {
  const palette = [
    "#e74c3c", "#3498db", "#2ecc71", "#f39c12", "#9b59b6",
    "#1abc9c", "#e67e22", "#e91e63", "#00bcd4", "#8bc34a",
    "#ff5722", "#607d8b", "#795548", "#cddc39", "#009688",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

async function main() {
  const schPath = process.argv[2];
  const netPath = process.argv[3];

  if (!schPath) {
    console.error("Usage: bun run ratsnest.ts <schematic.kicad_sch> [netlist.net]");
    process.exit(1);
  }

  // Default netlist path: same dir, circuit.net
  const netPathResolved = netPath ?? schPath.replace(/\.kicad_sch$/, ".net");

  console.log(`Loading schematic: ${schPath}`);
  const schContent = await readFile(schPath, "utf-8");
  const tree = parseSexpr(schContent);

  console.log(`Loading netlist: ${netPathResolved}`);
  const netContent = await readFile(netPathResolved, "utf-8");
  const netlist = parseNetlist(netContent);

  const libSymbols = parseLibSymbols(tree);
  const instances = parseSymbolInstances(tree);
  console.log(`Found ${instances.length} symbol instances, ${libSymbols.size} lib symbols, ${netlist.nets.length} nets`);

  const pinPositions = computePinPositions(instances, libSymbols);
  const nets = buildNets(netlist, pinPositions);
  const bounds = computeBounds(instances, nets);

  const svg = generateSVG(instances, nets, bounds);
  const html = generateHTML(svg, nets, instances);

  const outPath = join(dirname(schPath), "ratsnest.html");
  await Bun.write(outPath, html);
  console.log(`\nWrote ${outPath}`);
  console.log(`Opening in browser...`);

  // Open in default browser
  const proc = Bun.spawn(["open", outPath]);
  await proc.exited;
}

import { join } from "path";
main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
