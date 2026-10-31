/* Type patch selectors: names of declarations in a package, written the
 * same way for JSDoc in its JavaScript and for its declaration files.
 *
 *   selector := [ file ":" ] root segment*
 *   root     := identifier | "export=" | "default"
 *   segment  := "." name          member (interface, type alias, @typedef,
 *                                  class, namespace, object type)
 *             | "()"              return type
 *             | "(" name ")"      type of the named parameter
 *             | "[]"              element type of an array type
 *             | "[string]" | "[number]"   value type of an index signature
 *
 * Examples: `HelpContext.helpWidth`, `index.js:parse()`, `export=()`,
 * `fetchUser().email`, `Env[string]`. */

export type SelectorSegment =
  | { kind: "member"; name: string }
  | { kind: "return" }
  | { kind: "param"; name: string }
  | { kind: "element" }
  | { kind: "index"; key: "string" | "number" };

export interface Selector {
  /** Package-relative file the root must be declared in, or null. */
  file: string | null;
  /** A declared name, `export=` or `default`. */
  root: string;
  segments: readonly SelectorSegment[];
  /** The selector as written. */
  text: string;
}

const IDENT = /^[A-Za-z_$][\w$]*/;

/** The parsed selector, or a message saying what is wrong with it. */
export function parseSelector(text: string): Selector | { error: string } {
  let rest = text.trim();
  if (rest === "") return { error: "is empty" };
  let file: string | null = null;
  const colon = rest.indexOf(":");
  if (colon >= 0) {
    file = rest.slice(0, colon).replace(/^\.\//, "");
    rest = rest.slice(colon + 1);
    if (file === "" || file.startsWith("/") || file.split("/").includes(".."))
      return { error: "names a file outside the package" };
  }
  let root: string;
  if (rest.startsWith("export=")) {
    root = "export=";
    rest = rest.slice("export=".length);
  } else {
    const m = IDENT.exec(rest);
    if (m === null) return { error: "must start with a declared name, 'export=' or 'default'" };
    root = m[0];
    rest = rest.slice(root.length);
  }
  const segments: SelectorSegment[] = [];
  while (rest !== "") {
    if (rest.startsWith(".")) {
      const m = IDENT.exec(rest.slice(1));
      if (m === null) return { error: `has no member name after '.' at '${rest}'` };
      segments.push({ kind: "member", name: m[0] });
      rest = rest.slice(1 + m[0].length);
    } else if (rest.startsWith("()")) {
      segments.push({ kind: "return" });
      rest = rest.slice(2);
    } else if (rest.startsWith("(")) {
      const m = /^\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(rest);
      if (m === null) return { error: `has a malformed parameter at '${rest}'` };
      segments.push({ kind: "param", name: m[1]! });
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith("[]")) {
      segments.push({ kind: "element" });
      rest = rest.slice(2);
    } else if (rest.startsWith("[string]") || rest.startsWith("[number]")) {
      segments.push({ kind: "index", key: rest.startsWith("[string]") ? "string" : "number" });
      rest = rest.slice("[string]".length);
    } else {
      return { error: `has an unexpected '${rest}'` };
    }
  }
  return { file, root, segments, text: text.trim() };
}

/** A widening (`| undefined`) or a replacement type. */
export type TypePatchOp =
  | { kind: "widen"; arms: readonly string[] }
  | { kind: "replace"; text: string };

/** The operation a patch's type text stands for, or a message. */
export function parseTypeText(text: string): TypePatchOp | { error: string } {
  if (/[\r\n]/.test(text)) return { error: "must be one line" };
  const t = text.trim();
  if (t === "") return { error: "is empty" };
  if (t.startsWith("|")) {
    const arms = splitUnion(t.slice(1));
    if (arms.some((a) => a === "")) return { error: "has an empty union member" };
    return { kind: "widen", arms };
  }
  return { kind: "replace", text: t };
}

/** The top-level union members of a type text, trimmed. */
export function splitUnion(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") {
      // `=>` is not a closing bracket.
      if (!(ch === ">" && text[i - 1] === "=")) depth--;
    } else if (ch === "|" && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** Whitespace-insensitive text of a type for comparisons. */
export function normalizeType(text: string): string {
  return text.replace(/\s+/g, "");
}
