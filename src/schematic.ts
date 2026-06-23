// KiCad schematic parser
// Extracted and cleaned from solderlib/src/sch/parser.ts + types.ts

import { parseSexpr, type SexprNode, getChildAtom, getChildNumber, getAllChildren, getChild } from "./sexpr";

export interface SchPosition { x: number; y: number; angle?: number }
export interface SchStroke { width: number; type: string; color?: string }
export interface SchEffects { font: { size: { x: number; y: number }; thickness?: number }; justify?: string; hide?: boolean }

export interface SchSymbol {
  libId: string;
  ref: string;
  value: string;
  footprint: string;
  at: SchPosition;
  properties: { key: string; value: string }[];
  uuid?: string;
}

export interface SchWire { start: { x: number; y: number }; end: { x: number; y: number } }
export interface SchJunction { at: { x: number; y: number } }
export interface SchLabel { text: string; at: SchPosition; type: "local" | "global" | "hierarchical" }
export interface SchText { text: string; at: SchPosition }
export interface SchRect { start: { x: number; y: number }; end: { x: number; y: number } }

export interface Schematic {
  version: number;
  generator: string;
  uuid?: string;
  paper?: string;
  symbols: SchSymbol[];
  wires: SchWire[];
  junctions: SchJunction[];
  labels: SchLabel[];
  texts: SchText[];
  rects: SchRect[];
}

function parseAt(node: SexprNode): SchPosition {
  if (!Array.isArray(node) || node[0] !== "at") return { x: 0, y: 0 };
  return {
    x: Number(node[1]) || 0,
    y: Number(node[2]) || 0,
    angle: node.length > 3 ? Number(node[3]) || 0 : undefined,
  };
}

function parseXY(node: SexprNode): { x: number; y: number } {
  if (!Array.isArray(node)) return { x: 0, y: 0 };
  return { x: Number(node[1]) || 0, y: Number(node[2]) || 0 };
}

export function parseSchematic(text: string): Schematic {
  const tree = parseSexpr(text);
  return parseSchematicFromTree(tree);
}

export function parseSchematicFromTree(tree: SexprNode): Schematic {
  if (!Array.isArray(tree) || tree[0] !== "kicad_sch") {
    throw new Error("Invalid KiCad schematic file: expected (kicad_sch ...) root");
  }

  const version = getChildNumber(tree, "version", 20231120);
  const generator = getChildAtom(tree, "generator", "");
  const uuid = getChildAtom(tree, "uuid", "");
  const paper = getChildAtom(tree, "paper", "");

  const symbols: SchSymbol[] = [];
  for (const sym of getAllChildren(tree, "symbol")) {
    const libId = getChildAtom(sym, "lib_id", "");
    const ref = (() => {
      for (const prop of getAllChildren(sym, "property")) {
        if (Array.isArray(prop) && prop.length >= 2 && String(prop[1]) === "Reference") {
          return String(prop[2] ?? "");
        }
      }
      return "";
    })();
    const value = (() => {
      for (const prop of getAllChildren(sym, "property")) {
        if (Array.isArray(prop) && prop.length >= 2 && String(prop[1]) === "Value") {
          return String(prop[2] ?? "");
        }
      }
      return "";
    })();
    const footprint = (() => {
      for (const prop of getAllChildren(sym, "property")) {
        if (Array.isArray(prop) && prop.length >= 2 && String(prop[1]) === "Footprint") {
          return String(prop[2] ?? "");
        }
      }
      return "";
    })();
    const atNode = getChild(sym, "at");
    const at = atNode ? parseAt(atNode) : { x: 0, y: 0 };
    const properties = getAllChildren(sym, "property").map((p) => ({
      key: String(p[1] ?? ""),
      value: String(p[2] ?? ""),
    }));
    const symUuid = getChildAtom(sym, "uuid", "");
    symbols.push({ libId, ref, value, footprint, at, properties, uuid: symUuid || undefined });
  }

  const wires: SchWire[] = getAllChildren(tree, "wire").map((w) => {
    const pts = getAllChildren(w, "pts");
    const start = pts.length > 0 ? parseXY(getChild(pts[0], "start") ?? ["xy", 0, 0]) : { x: 0, y: 0 };
    const end = pts.length > 0 ? parseXY(getChild(pts[0], "end") ?? ["xy", 0, 0]) : { x: 0, y: 0 };
    return { start, end };
  });

  const junctions: SchJunction[] = getAllChildren(tree, "junction").map((j) => ({
    at: parseAt(j),
  }));

  const labels: SchLabel[] = [];
  for (const l of getAllChildren(tree, "label")) {
    labels.push({ text: String(l[1] ?? ""), at: parseAt(getChild(l, "at") ?? ["at", 0, 0]), type: "local" });
  }
  for (const l of getAllChildren(tree, "global_label")) {
    labels.push({ text: String(l[1] ?? ""), at: parseAt(getChild(l, "at") ?? ["at", 0, 0]), type: "global" });
  }
  for (const l of getAllChildren(tree, "hierarchical_label")) {
    labels.push({ text: String(l[1] ?? ""), at: parseAt(getChild(l, "at") ?? ["at", 0, 0]), type: "hierarchical" });
  }

  const texts: SchText[] = getAllChildren(tree, "text").map((t) => ({
    text: String(t[1] ?? ""),
    at: parseAt(getChild(t, "at") ?? ["at", 0, 0]),
  }));

  const rects: SchRect[] = getAllChildren(tree, "rectangle").map((r) => ({
    start: parseXY(getChild(r, "start") ?? ["xy", 0, 0]),
    end: parseXY(getChild(r, "end") ?? ["xy", 0, 0]),
  }));

  return {
    version, generator, uuid: uuid || undefined, paper: paper || undefined,
    symbols, wires, junctions, labels, texts, rects,
  };
}
