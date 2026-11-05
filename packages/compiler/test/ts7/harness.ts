import { createProgram } from "../../src/frontend/ts7/program-adapter.js";
/* Shared two-world harness for the TS7 adapter suite: builds the SAME
 * fixture programs through typescript@5.9.3 (the "typescript5" island
 * alias — allowed here precisely because this suite's job is comparing
 * the worlds) and through the adapter, with scriptc's exact forced
 * options and shipped ambient declarations, then walks both ASTs in
 * lockstep.
 *
 * The 5.9.3 import in this file is the ONLY sanctioned checker-world use
 * of the old package outside the parser/transpile islands: it is the
 * PINNED ORACLE the adapter is measured against — these suites are the
 * tsgo-upgrade canary lane (the playbook lives in order-parity.test.ts's
 * header), so the island pin doubles as the recorded reference the next
 * tsgo bump is triaged against. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts5 from "typescript5";
import { ambientDtsPath, fallbackDtsPath } from "../../src/frontend/program.js";
import { fallbackModulesNamedIn } from "../../src/frontend/dts-paths.js";
import * as ad from "../../src/frontend/ts7/adapter.js";

export { ad, ts5 };

/* scriptc's BASE + FORCED options (program.ts's COMPILER_OPTIONS), spelled
 * once per world with each world's own enum objects. */
export function options5(): ts5.CompilerOptions {
  return {
    strict: true,
    target: ts5.ScriptTarget.ESNext,
    module: ts5.ModuleKind.ESNext,
    moduleResolution: ts5.ModuleResolutionKind.Bundler,
    lib: ["lib.es2023.d.ts"],
    types: [],
    allowImportingTsExtensions: true,
    allowJs: true,
    checkJs: true,
    resolveJsonModule: true,
    noEmit: true,
  };
}

export function options7(): ad.Ts7CompilerOptions {
  return {
    strict: true,
    target: ad.ScriptTarget.ESNext as number,
    module: ad.ModuleKind.ESNext as number,
    moduleResolution: ad.ModuleResolutionKind.Bundler as number,
    lib: ["lib.es2023.d.ts"],
    types: [],
    allowImportingTsExtensions: true,
    allowJs: true,
    checkJs: true,
    resolveJsonModule: true,
    noEmit: true,
  };
}

export interface TwoWorlds {
  dir: string;
  files: string[];
  p5: ts5.Program;
  c5: ts5.TypeChecker;
  p7: ad.Ts7Program;
  c7: ad.CheckerFacade;
  dispose(): void;
}

/** Writes the fixture sources to a temp dir and builds both programs over
 * identical roots: the fixtures plus scriptc's shipped ambient core and the
 * node fallback declarations (the no-tsconfig program shape loadProgram
 * builds). */
export function buildTwoWorlds(sources: Record<string, string>, host?: ad.Ts7Host): TwoWorlds {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-ts7-"));
  const files: string[] = [];
  for (const [name, text] of Object.entries(sources)) {
    const path = join(dir, name);
    writeFileSync(path, text);
    files.push(path);
  }
  const modules = Object.values(sources).flatMap((text) => fallbackModulesNamedIn(text));
  const roots = [...files, ambientDtsPath(), fallbackDtsPath(), ...new Set(modules)];
  const p5 = ts5.createProgram(roots, options5());
  const p7 = createProgram(roots, options7(), host);
  return {
    dir,
    files,
    p5,
    c5: p5.getTypeChecker(),
    p7,
    c7: p7.getTypeChecker(),
    dispose: () => p7.dispose(),
  };
}

/** Both worlds' full walks of one file, in forEachChild order. The walks are
 * asserted elsewhere to be position-identical; this returns the raw lists. */
export function walkBoth(w: TwoWorlds, file: string): { n5: ts5.Node[]; n7: ad.Node[] } {
  const sf5 = w.p5.getSourceFile(file);
  const sf7 = w.p7.getSourceFile(file);
  if (!sf5 || !sf7) throw new Error(`fixture missing from a world: ${file}`);
  const n5: ts5.Node[] = [];
  const n7: ad.Node[] = [];
  const v5 = (n: ts5.Node): void => {
    n5.push(n);
    ts5.forEachChild(n, v5);
  };
  v5(sf5);
  const v7 = (n: ad.Node): void => {
    n7.push(n);
    n.forEachChild(v7);
  };
  v7(sf7);
  return { n5, n7 };
}

/** The 7-world kind name for comparison purposes: 5.9.3 spells the EOF
 * token EndOfFileToken, 7 spells it EndOfFile (survey rename). */
export function kindName5(kind: ts5.SyntaxKind): string {
  const name = ts5.SyntaxKind[kind] ?? String(kind);
  return name === "EndOfFileToken" ? "EndOfFile" : name;
}

export function kindName7(kind: number): string {
  return ((ad.SyntaxKind as Record<number, string | number>)[kind] as string) ?? String(kind);
}

/** The one STRUCTURAL divergence the survey suite pinned: an elision in an
 * ARRAY BINDING PATTERN (`const [a, , b] = ...`) is an OmittedExpression
 * node in 5.9.3 but a (nameless) BindingElement in 7. Expression-position
 * elisions (`[1, , 2]`) kept OmittedExpression in both worlds. Guard and
 * flag comparisons except these positions. */
export function isBindingPatternElision(n5: ts5.Node): boolean {
  return (
    ts5.isOmittedExpression(n5) && n5.parent !== undefined && ts5.isArrayBindingPattern(n5.parent)
  );
}

/* ---- canonical type text ----
 *
 * FINDING (pinned by the parity suite): tsgo renders the same type with a
 * different ORDER of unordered constituents than 5.9.3 — union arms
 * ("utf8" | "utf-8" vs "utf-8" | "utf8", T | PromiseLike<T> vs the
 * reverse) and spread-merged object members ({ q; p? } vs { p?; q }). The
 * SET of constituents always agreed in the battery; only the arrangement
 * moved. canonTypeText sorts every unordered list (top-level union arms,
 * intersection arms, object-type members) at every nesting depth, so the
 * comparison is order-insensitive without forgiving real differences. */

const OPENERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
const CLOSERS = new Set(Object.values(OPENERS));

/** Splits `s` on `sep` at bracket depth 0, honoring quotes and skipping the
 * ">" of "=>" arrows. */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < s.length && s[i] !== quote) i += s[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "=" && s[i + 1] === ">") {
      i++; // the arrow's ">" is not a closer
      continue;
    }
    if (ch in OPENERS) depth++;
    else if (CLOSERS.has(ch)) depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      parts.push(s.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function canonLevel(s: string, insideBraces: boolean): string {
  // Canonicalize every bracketed region's interior first (recursively).
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const from = i;
      i++;
      while (i < s.length && s[i] !== quote) i += s[i] === "\\" ? 2 : 1;
      out += s.slice(from, i + 1);
      continue;
    }
    if (ch === "=" && s[i + 1] === ">") {
      out += "=>";
      i++;
      continue;
    }
    if (ch in OPENERS) {
      // find the matching closer at this level
      let depth = 1;
      let j = i + 1;
      while (j < s.length && depth > 0) {
        const cj = s[j]!;
        if (cj === '"' || cj === "'" || cj === "`") {
          const q = cj;
          j++;
          while (j < s.length && s[j] !== q) j += s[j] === "\\" ? 2 : 1;
        } else if (cj === "=" && s[j + 1] === ">") {
          j++;
        } else if (cj in OPENERS) depth++;
        else if (CLOSERS.has(cj)) depth--;
        j++;
      }
      out += ch + canonLevel(s.slice(i + 1, j - 1), ch === "{") + s[j - 1];
      i = j - 1;
      continue;
    }
    out += ch;
  }
  // Object-type members are unordered: sort "; "-separated members.
  if (insideBraces) {
    out = splitTopLevel(out, ";")
      .map((m) => m.trim())
      .filter((m) => m !== "")
      .sort()
      .join("; ");
  }
  // Union and intersection arms are unordered. The textual wrinkle: a label
  // ("encoding: "), arrow ("() => "), or return-position prefix glues onto
  // the FIRST arm ("encoding: A | B" — the union is A | B, not
  // "encoding: A" | B), so before sorting, peel the first arm's prefix (its
  // last top-level ": " or "=> ") when no other arm carries one.
  out = sortArms(sortArms(out, " | "), " & ");
  return out;
}

function lastTopLevelPrefixEnd(s: string): number {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < s.length && s[i] !== quote) i += s[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "=" && s[i + 1] === ">") {
      if (depth === 0 && s[i + 2] === " ") last = i + 3;
      i++;
      continue;
    }
    if (ch in OPENERS) depth++;
    else if (CLOSERS.has(ch)) depth--;
    else if (depth === 0 && ch === ":" && s[i + 1] === " ") last = i + 2;
  }
  return last;
}

function sortArms(text: string, sep: string): string {
  const parts = splitTopLevel(text, sep).map((a) => a.trim());
  if (parts.length < 2) return text;
  let prefix = "";
  const cut = lastTopLevelPrefixEnd(parts[0]!);
  const othersUnprefixed = parts.slice(1).every((p) => lastTopLevelPrefixEnd(p) < 0);
  if (cut >= 0 && othersUnprefixed) {
    prefix = parts[0]!.slice(0, cut);
    parts[0] = parts[0]!.slice(cut);
  }
  return prefix + parts.sort().join(sep);
}

/** Order-insensitive canonical form of a typeToString rendering. */
export function canonTypeText(s: string): string {
  return canonLevel(s, false);
}
