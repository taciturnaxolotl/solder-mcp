// S-expression parser for KiCad files
// Extracted and cleaned from solderlib/src/sexpr/index.ts

export type SexprNode = string | SexprNode[];

export function tokenizeSexpr(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (ch === "(" || ch === ")") {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let str = "";
      while (j < input.length) {
        const c = input.charAt(j);
        if (c === '"') break;
        if (c === "\\" && j + 1 < input.length) {
          const next = input.charAt(j + 1);
          if (next === "\\") { str += "\\"; j += 2; continue; }
          if (next === '"') { str += '"'; j += 2; continue; }
          if (next === "n") { str += "\n"; j += 2; continue; }
          if (next === "r") { str += "\r"; j += 2; continue; }
          if (next === "t") { str += "\t"; j += 2; continue; }
          str += "\\" + next;
          j += 2;
          continue;
        }
        str += c;
        j += 1;
      }
      if (j >= input.length) {
        throw new Error(`Unterminated quoted string starting at position ${i}`);
      }
      tokens.push('"' + str + '"');
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) { i += 1; continue; }
    let j = i;
    let atom = "";
    while (j < input.length) {
      const c = input.charAt(j);
      if (c === "(" || c === ")" || /\s/.test(c)) break;
      atom += c;
      j += 1;
    }
    tokens.push(atom);
    i = j;
  }
  return tokens;
}

export function parseTokens(tokens: string[], idx = 0): [SexprNode, number] {
  if (idx >= tokens.length) throw new Error("Unexpected end of tokens");
  if (tokens[idx] === "(") {
    const list: SexprNode[] = [];
    let i = idx + 1;
    while (i < tokens.length && tokens[i] !== ")") {
      const [child, next] = parseTokens(tokens, i);
      list.push(child);
      i = next;
    }
    if (i >= tokens.length) throw new Error("Unmatched opening parenthesis");
    return [list, i + 1];
  }
  if (tokens[idx] === ")") throw new Error("Unexpected closing parenthesis");
  const raw = tokens[idx];
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return [raw.slice(1, -1), idx + 1];
  }
  return [raw, idx + 1];
}

export function parseSexpr(text: string): SexprNode {
  const tokens = tokenizeSexpr(text);
  const [result] = parseTokens(tokens);
  return result;
}

export function stringifySexpr(node: SexprNode): string {
  if (typeof node === "string") {
    if (/[\s()"\\]/.test(node) || node.length === 0) {
      return '"' + node.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    }
    return node;
  }
  return "(" + node.map(stringifySexpr).join(" ") + ")";
}

export function stringifySexprPretty(
  node: SexprNode,
  indent = 0,
  indentStr = "\t",
  alwaysQuoteStrings = false,
): string {
  if (typeof node === "string") {
    if (alwaysQuoteStrings || /[\s()"\\]/.test(node) || node.length === 0) {
      return '"' + node.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
    }
    return node;
  }
  if (node.length === 0) return "()";
  const head = node[0];
  const isSimple = node.length <= 4 && node.every((n) => typeof n === "string" && !/[\s()"\\]/.test(n));
  if (isSimple) {
    return "(" + node.map((n) => stringifySexprPretty(n, 0, indentStr, alwaysQuoteStrings)).join(" ") + ")";
  }
  const pad = indentStr.repeat(indent);
  const childPad = indentStr.repeat(indent + 1);
  let out = "(" + stringifySexprPretty(head, 0, indentStr, alwaysQuoteStrings);
  for (let i = 1; i < node.length; i++) {
    const child = node[i];
    if (Array.isArray(child)) {
      out += "\n" + childPad + stringifySexprPretty(child, indent + 1, indentStr, alwaysQuoteStrings);
    } else {
      out += " " + stringifySexprPretty(child, 0, indentStr, alwaysQuoteStrings);
    }
  }
  out += ")";
  return out;
}

// Navigation helpers
export function findAllByHead(node: SexprNode, head: string): SexprNode[][] {
  if (!Array.isArray(node)) return [];
  const results: SexprNode[][] = [];
  for (const child of node) {
    if (Array.isArray(child) && child.length > 0 && child[0] === head) {
      results.push(child);
    }
  }
  return results;
}

export function getChild(list: SexprNode, name: string): SexprNode | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const child of list) {
    if (Array.isArray(child) && child.length > 0 && child[0] === name) return child;
  }
  return undefined;
}

export function getChildAtom(list: SexprNode, name: string, defaultValue = ""): string {
  const child = getChild(list, name);
  if (!child || !Array.isArray(child) || child.length < 2) return defaultValue;
  return String(child[1]);
}

export function getChildNumber(list: SexprNode, name: string, defaultValue = 0): number {
  const val = getChildAtom(list, name, "");
  if (val === "") return defaultValue;
  const num = Number(val);
  return Number.isFinite(num) ? num : defaultValue;
}

export function getAllChildren(list: SexprNode, name: string): SexprNode[][] {
  return findAllByHead(list, name);
}

export function getPropertyValue(list: SexprNode, propertyName: string): string | undefined {
  const props = getAllChildren(list, "property");
  for (const prop of props) {
    if (Array.isArray(prop) && prop.length >= 2 && String(prop[1]) === propertyName) {
      return prop.length >= 3 ? String(prop[2]) : undefined;
    }
  }
  return undefined;
}
