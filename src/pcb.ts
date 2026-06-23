// KiCad PCB parser
// Extracted and cleaned from solderlib/src/pcb/parser.ts

import { parseSexpr, type SexprNode, getChildAtom, getChildNumber, getAllChildren, getChild } from "./sexpr";

export interface PcbPosition { x: number; y: number; angle?: number }

export interface PcbPad {
  number: string;
  type: string;
  shape: string;
  at: PcbPosition;
  size: { x: number; y: number };
  layers: string[];
  net?: number;
}

export interface PcbFootprint {
  libId: string;
  ref: string;
  value: string;
  at: PcbPosition;
  layer: string;
  pads: PcbPad[];
  uuid?: string;
}

export interface PcbTrack {
  start: { x: number; y: number };
  end: { x: number; y: number };
  width: number;
  layer: string;
  net?: number;
}

export interface PcbNet { code: number; name: string }

export interface PcbBoard {
  version: number;
  generator: string;
  paper?: string;
  nets: PcbNet[];
  footprints: PcbFootprint[];
  tracks: PcbTrack[];
}

function parseAt(node: SexprNode): PcbPosition {
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

export function parsePcb(text: string): PcbBoard {
  const tree = parseSexpr(text);
  if (!Array.isArray(tree) || tree[0] !== "kicad_pcb") {
    throw new Error("Invalid KiCad PCB file: expected (kicad_pcb ...) root");
  }

  const version = getChildNumber(tree, "version", 20240108);
  const generator = getChildAtom(tree, "generator", "");
  const paper = getChildAtom(tree, "paper", "");

  const nets: PcbNet[] = getAllChildren(tree, "net").map((n) => ({
    code: Number(n[1]) || 0,
    name: String(n[2] ?? ""),
  }));

  const footprints: PcbFootprint[] = [];
  for (const fp of getAllChildren(tree, "footprint")) {
    const libId = String(fp[1] ?? "");
    const ref = getChildAtom(fp, "fp_text reference", "") || (() => {
      for (const t of getAllChildren(fp, "fp_text")) {
        if (Array.isArray(t) && t[1] === "reference") return String(t[2] ?? "");
      }
      return "";
    })();
    const value = getChildAtom(fp, "fp_text value", "") || (() => {
      for (const t of getAllChildren(fp, "fp_text")) {
        if (Array.isArray(t) && t[1] === "value") return String(t[2] ?? "");
      }
      return "";
    })();
    const atNode = getChild(fp, "at");
    const at = atNode ? parseAt(atNode) : { x: 0, y: 0 };
    const layer = getChildAtom(fp, "layer", "F.Cu");
    const uuid = getChildAtom(fp, "uuid", "");

    const pads: PcbPad[] = getAllChildren(fp, "pad").map((p) => ({
      number: String(p[1] ?? ""),
      type: String(p[2] ?? ""),
      shape: String(p[3] ?? ""),
      at: parseAt(getChild(p, "at") ?? ["at", 0, 0]),
      size: parseXY(getChild(p, "size") ?? ["xy", 0, 0]),
      layers: getAllChildren(p, "layers").flatMap((l) => l.slice(1).map(String)),
      net: (() => {
        const n = getChild(p, "net");
        return n && Array.isArray(n) && n.length >= 2 ? Number(n[1]) : undefined;
      })(),
    }));

    footprints.push({ libId, ref, value, at, layer, pads, uuid: uuid || undefined });
  }

  const tracks: PcbTrack[] = getAllChildren(tree, "segment").map((s) => ({
    start: parseXY(getChild(s, "start") ?? ["xy", 0, 0]),
    end: parseXY(getChild(s, "end") ?? ["xy", 0, 0]),
    width: getChildNumber(s, "width", 0),
    layer: getChildAtom(s, "layer", ""),
    net: (() => {
      const n = getChild(s, "net");
      return n && Array.isArray(n) && n.length >= 2 ? Number(n[1]) : undefined;
    })(),
  }));

  return { version, generator, paper: paper || undefined, nets, footprints, tracks };
}
