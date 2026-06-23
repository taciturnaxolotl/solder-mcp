// KiCad netlist parser
// Extracted and cleaned from solderlib/src/netlist/parser.ts

import { parseSexpr, type SexprNode, getChildAtom, getAllChildren } from "./sexpr";

export interface NetlistNode {
  ref: string;
  pin: string;
  pinfunction?: string;
}

export interface NetlistNet {
  name: string;
  nodes: NetlistNode[];
}

export interface NetlistComponent {
  ref: string;
  value: string;
  footprint: string;
  lib: string;
  part: string;
}

export interface NetlistDocument {
  version: string;
  components: NetlistComponent[];
  nets: NetlistNet[];
}

function parseMeta(list: SexprNode): Record<string, string | number> {
  const meta: Record<string, string | number> = {};
  if (!Array.isArray(list)) return meta;
  for (const child of list) {
    if (!Array.isArray(child) || child.length < 2) continue;
    const key = String(child[0]);
    const val = child[1];
    if (typeof val === "string") {
      meta[key] = val;
    }
  }
  return meta;
}

export function parseNetlistSexpr(netlistContent: string): NetlistDocument {
  const root = parseSexpr(netlistContent);
  if (!Array.isArray(root) || root[0] !== "export") {
    throw new Error("Invalid KiCad netlist: expected (export ...) root");
  }

  const version = getChildAtom(root, "version", "");
  const components: NetlistComponent[] = [];
  const compNodes = getAllChildren(root, "components");
  for (const compList of compNodes) {
    for (const comp of getAllChildren(compList, "comp")) {
      const ref = getChildAtom(comp, "ref");
      const value = getChildAtom(comp, "value");
      const footprint = getChildAtom(comp, "footprint");
      const libsource = (() => {
        for (const child of comp) {
          if (Array.isArray(child) && child[0] === "libsource") return child;
        }
        return undefined;
      })();
      const lib = libsource ? getChildAtom(libsource, "lib", "") : "";
      const part = libsource ? getChildAtom(libsource, "part", "") : "";
      if (ref) components.push({ ref, value, footprint, lib, part });
    }
  }

  const nets: NetlistNet[] = [];
  const netNodes = getAllChildren(root, "nets");
  for (const netList of netNodes) {
    for (const net of getAllChildren(netList, "net")) {
      const name = getChildAtom(net, "code", "") || getChildAtom(net, "name", "");
      const nodes: NetlistNode[] = [];
      for (const node of getAllChildren(net, "node")) {
        const ref = getChildAtom(node, "ref");
        const pin = getChildAtom(node, "pin");
        if (ref && pin) {
          const n: NetlistNode = { ref, pin };
          const pf = getChildAtom(node, "pinfunction", "");
          if (pf) n.pinfunction = pf;
          nodes.push(n);
        }
      }
      if (name) nets.push({ name, nodes });
    }
  }

  return { version, components, nets };
}

export function parseJsonNetlist(content: string): NetlistDocument {
  const data = JSON.parse(content);
  if (!data.nets || !Array.isArray(data.nets)) {
    throw new Error("JSON netlist has no recognizable 'nets' field");
  }
  const nets: NetlistNet[] = data.nets.map((n: any, i: number) => {
    if (!n.name) throw new Error(`JSON netlist entry at index ${i} is missing 'name'`);
    if (!Array.isArray(n.nodes)) throw new Error(`JSON netlist entry '${n.name}' is missing 'nodes' array`);
    return {
      name: n.name,
      nodes: n.nodes.map((node: any, j: number) => {
        if (!node.ref) throw new Error(`JSON netlist node at index ${j} in net '${n.name}' is missing 'ref'`);
        if (!node.pin) throw new Error(`JSON netlist node at index ${j} in net '${n.name}' is missing 'pin'`);
        return { ref: node.ref, pin: node.pin, pinfunction: node.pinfunction };
      }),
    };
  });

  const components: NetlistComponent[] = (data.components ?? []).map((c: any) => ({
    ref: c.ref ?? "",
    value: c.value ?? "",
    footprint: c.footprint ?? "",
    lib: c.lib ?? "",
    part: c.part ?? "",
  }));

  return { version: data.version ?? "", components, nets };
}

export function parseNetlist(content: string): NetlistDocument {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    return parseJsonNetlist(trimmed);
  }
  return parseNetlistSexpr(trimmed);
}
