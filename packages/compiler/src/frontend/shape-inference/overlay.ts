/* Shape inference: the typed overlay (results/design-shape-inference,
 * maintainer decision 2026-10-23). The analysis's proven facts become JSDoc
 * types in a rewritten copy of each package JavaScript file, and the
 * lowering treats the rewritten file like a checked JavaScript file, so the
 * static tier compiles the package's hot code from those types.
 *
 * Only proven facts are written: a position whose value set contains ⊤
 * (anything from islands, JSON.parse, the network or the file system,
 * reflection, globals, `process`, caught exceptions, or code the analysis
 * cannot see) stays untyped. A check the lowering inserts where a value
 * meets an inferred type therefore fails only when the analysis is wrong;
 * such checks carry the inferred-fact failure message.
 *
 * The package's own JSDoc is a hint, not a declaration: its tags are
 * neutralized in the rewritten file, so only the analysis's types remain.
 *
 * Every edit is inline: no line breaks are added or removed, so positions
 * keep their lines. */
import * as ts from "../ts7/adapter.js";
import type { Atom } from "./domain.js";
import type { ShapeAnalysis } from "./analyze.js";
import type { SiteVerdict } from "./report.js";

export interface ShapeOverlay {
  /** Rewritten text per package file. */
  readonly files: Map<string, string>;
  /** Annotations written, for the build report. */
  readonly annotations: number;
  /** Branches the analysis proved unreachable, replaced by checks. */
  readonly deadBranches: number;
}

interface Edit {
  readonly pos: number;
  readonly text: string;
  /** Replaces pos..end instead of inserting at pos. */
  readonly end?: number;
}

/** Marks the overlay's own comments (an unknown JSDoc tag, ignored). */
export const OVERLAY_MARK = "@scriptcShape";
const MARK = OVERLAY_MARK;

/** Above 1, values of several record key sets type as one merged record
 * with optional fields (SCRIPTC_SHAPE_RECORD_ARMS; experimental). */
const MAX_RECORD_ARMS = Number(process.env.SCRIPTC_SHAPE_RECORD_ARMS ?? 1);

/** The most class or record arms an inferred union may have. */
const MAX_ARMS = 6;

function list<T extends ts.Node>(arr: { readonly nodes: readonly T[] } | undefined): readonly T[] {
  return arr?.nodes ?? [];
}

let debugIndex = 0;

export function planShapeOverlay(
  analysis: ShapeAnalysis,
  verdicts: readonly SiteVerdict[],
  packageFiles: readonly ts.SourceFile[],
): ShapeOverlay {
  const pSites = new Map<Atom, SiteVerdict>();
  const siteVerdicts = new Set<Atom>(verdicts.map((v) => v.site.atom));
  // Records and arrays print only for sites whose objects never escape: a
  // native record that reached untyped code would be seen as a copy.
  const siteKeys = new Map<Atom, { keys: string[]; optional: Set<string> }>();
  for (const v of verdicts) {
    if (v.verdict !== "P-local") continue;
    if (v.site.kind === "array") {
      pSites.set(v.site.atom, v);
      continue;
    }
    const keys = keysOfSite(analysis, v);
    if (keys === null) continue;
    siteKeys.set(v.site.atom, keys);
    pSites.set(v.site.atom, v);
  }
  const files = new Map<string, string>();
  let annotations = 0;
  let deadBranches = 0;
  debugIndex = 0;
  // `if` branches no condition value allowed, per file: the overlay
  // replaces each with a throwing check, so the checker and the lowering
  // see the code the analysis saw.
  const deadByFile = new Map<ts.SourceFile, ts.Statement[]>();
  if (process.env["SCRIPTC_SHAPE_DEAD_BRANCHES"] !== "0")
    for (const s of analysis.branchIfs) {
      for (const branch of [s.thenStatement, s.elseStatement]) {
        if (branch === undefined || analysis.walkedBranches.has(branch)) continue;
        const sf = s.getSourceFile();
        let list = deadByFile.get(sf);
        if (list === undefined) deadByFile.set(sf, (list = []));
        list.push(branch);
      }
    }
  for (const sf of packageFiles) {
    const typedefs = new Map<string, string>();
    const typedefText: string[] = [];
    const edits: Edit[] = [];

    const className = (decl: ts.Node): string | null => {
      if (decl.getSourceFile() !== sf) return null;
      const own = (decl as ts.ClassLikeDeclaration).name;
      if (own !== undefined && ts.isClassDeclaration(decl) && decl.parent === sf) return own.text;
      const p = decl.parent;
      if (
        p !== undefined &&
        ts.isVariableDeclaration(p) &&
        ts.isIdentifier(p.name) &&
        p.parent?.parent?.parent === sf
      )
        return p.name.text;
      return null;
    };

    // `inner`: inside a record field, where ⊤ and unprintable values are `any`.
    const typeOf = (atoms: ReadonlySet<Atom>, inner: boolean, depth: number): string | null => {
      if (atoms.size === 0) return inner ? "any" : null;
      const arms = new Set<string>();
      let objects = 0;
      // Every array arm becomes one Array<…> of the joined element values.
      const elements = new Set<Atom>();
      let hasArray = false;
      const promised = new Set<Atom>();
      let hasPromise = false;
      const recordSites: Atom[] = [];
      for (const a of atoms) {
        let t: string | null = null;
        switch (a.kind) {
          case "prim":
            t =
              a.label === "null" ||
              a.label === "undefined" ||
              a.label === "string" ||
              a.label === "number" ||
              a.label === "boolean" ||
              a.label === "bigint"
                ? a.label
                : null;
            break;
          case "instance":
            t = a.node !== undefined ? className(a.node) : null;
            objects++;
            break;
          case "object": {
            objects++;
            const v = pSites.get(a);
            if (v === undefined || depth >= 4 || !siteKeys.has(a)) return inner ? "any" : null;
            recordSites.push(a);
            continue;
          }
          case "array": {
            objects++;
            if (analysis.escaped.has(a) || (siteVerdicts.has(a) && !pSites.has(a)))
              return inner ? "any" : null;
            const el = analysis.elements.get(a);
            if (el !== undefined) for (const x of analysis.nodes[el]!.atoms) elements.add(x);
            hasArray = true;
            continue;
          }
          case "promise": {
            // One promise arm: the values it resolves to, joined.
            const value = analysis.fields.get(a)?.get("value");
            if (value !== undefined) for (const x of analysis.nodes[value]!.atoms) promised.add(x);
            hasPromise = true;
            continue;
          }
          default:
            t = null;
        }
        if (t === null) return inner ? "any" : null;
        arms.add(t);
      }
      // Records of one key set print as their typedef; records of several
      // key sets merge into one record whose fields missing from some sites
      // are optional (unions of overlapping records would need the lowering
      // to pick an arm per value).
      if (recordSites.length > 0) {
        const keySets = new Set(recordSites.map(keySetOf));
        if (keySets.size === 1) arms.add(recordType(recordSites[0]!, depth));
        else if (MAX_RECORD_ARMS > 1) arms.add(mergedRecordType(recordSites, depth));
        else return inner ? "any" : null;
      }
      if (hasArray) {
        const inside = depth < 4 ? typeOf(elements, true, depth + 1) : "any";
        arms.add(`Array<${inside ?? "any"}>`);
      }
      // A promise beside other values cannot cross into untyped code
      // (maybe-promise unions stay typed-only), so it stays untyped here.
      if (hasPromise) return inner ? "any" : null;
      if (objects > MAX_ARMS) return inner ? "any" : null;
      if (arms.has("any")) return inner ? "any" : null;
      return [...arms].join(" | ");
    };

    // One typedef per key set: sites with the same keys intern to the same
    // structural record, so their field types are joined.
    const keySetOf = (site: Atom): string => {
      const k = siteKeys.get(site)!;
      return k.keys
        .map((key) => (k.optional.has(key) ? `${key}?` : key))
        .sort()
        .join(",");
    };
    const sitesByKeys = new Map<string, Atom[]>();
    for (const site of pSites.keys()) {
      if (pSites.get(site)!.site.kind !== "object") continue;
      const k = keySetOf(site);
      let l = sitesByKeys.get(k);
      if (l === undefined) sitesByKeys.set(k, (l = []));
      l.push(site);
    }
    const recordType = (site: Atom, depth: number): string => {
      const keySet = keySetOf(site);
      const existing = typedefs.get(keySet);
      if (existing !== undefined) return existing;
      const name = `__shape_${typedefs.size}`;
      typedefs.set(keySet, name);
      const { keys, optional } = siteKeys.get(site)!;
      const parts = keys.map((k) => {
        const atoms = new Set<Atom>();
        for (const other of sitesByKeys.get(keySet) ?? [site]) {
          const id = analysis.fields.get(other)?.get(k);
          if (id !== undefined) for (const a of analysis.nodes[id]!.atoms) atoms.add(a);
        }
        const t = typeOf(atoms, true, depth + 1);
        return `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${optional.has(k) ? "?" : ""}: ${t ?? "any"}`;
      });
      typedefText.push(`/** @typedef {{${parts.join(", ")}}} ${name} ${MARK} */`);
      return name;
    };

    const mergedRecordType = (sites: readonly Atom[], depth: number): string => {
      const all = new Set<Atom>();
      for (const site of sites)
        for (const other of sitesByKeys.get(keySetOf(site)) ?? [site]) all.add(other);
      const keys: string[] = [];
      const optional = new Set<string>();
      for (const site of all) {
        const k = siteKeys.get(site)!;
        for (const key of k.keys) {
          if (!keys.includes(key)) keys.push(key);
          if (k.optional.has(key)) optional.add(key);
        }
      }
      for (const site of all) {
        const own = siteKeys.get(site)!.keys;
        for (const key of keys) if (!own.includes(key)) optional.add(key);
      }
      const keySet = `merged:${keys
        .map((k) => (optional.has(k) ? `${k}?` : k))
        .sort()
        .join(",")}`;
      const existing = typedefs.get(keySet);
      if (existing !== undefined) return existing;
      const name = `__shape_${typedefs.size}`;
      typedefs.set(keySet, name);
      const parts = keys.map((k) => {
        const atoms = new Set<Atom>();
        for (const site of all) {
          const id = analysis.fields.get(site)?.get(k);
          if (id !== undefined) for (const a of analysis.nodes[id]!.atoms) atoms.add(a);
        }
        const t = typeOf(atoms, true, depth + 1);
        return `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${optional.has(k) ? "?" : ""}: ${t ?? "any"}`;
      });
      typedefText.push(`/** @typedef {{${parts.join(", ")}}} ${name} ${MARK} */`);
      return name;
    };

    // Functions called with `new` yield their instance, whatever they return.
    const constructed = new Set<ts.Node | undefined>(
      [...analysis.fnOfInstance.values()].map((a) => a.node),
    );
    // Return values merged over every analysis context of each function.
    const returns = new Map<ts.Node, Set<Atom>>();
    for (const info of analysis.functions.values()) {
      if (info.node.getSourceFile() !== sf || info.isAsync || info.isGenerator) continue;
      let set = returns.get(info.node);
      if (set === undefined) returns.set(info.node, (set = new Set()));
      for (const a of analysis.nodes[info.ret]!.atoms) set.add(a);
    }

    // Receivers each method runs on, merged over its analysis contexts.
    const thisAtoms = new Map<ts.Node, Set<Atom>>();
    for (const info of analysis.functions.values()) {
      if (info.node.getSourceFile() !== sf || !ts.isMethodDeclaration(info.node)) continue;
      let set = thisAtoms.get(info.node);
      if (set === undefined) thisAtoms.set(info.node, (set = new Set()));
      for (const a of analysis.nodes[info.thisNode]!.atoms) set.add(a);
    }
    const declaresMember = (cls: ts.Node, name: string): boolean =>
      analysis.classChain(cls).some((c) =>
        (c as ts.ClassLikeDeclaration).members.nodes.some((m) => {
          const n = (m as { name?: ts.Node }).name;
          return (
            n !== undefined && (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) && n.text === name
          );
        }),
      );
    // `this.m(…)` in an inherited method whose class does not declare `m`
    // (zod's ZodType._parseSync calls the subclasses' _parse): the receiver
    // is cast to the classes the method runs on, so the call dispatches over
    // them instead of through an untyped call.
    const receiverCasts = (method: ts.MethodDeclaration): void => {
      const cls = method.parent;
      const receivers = thisAtoms.get(method);
      if (cls === undefined || receivers === undefined || receivers.size === 0) return;
      if (![...receivers].every((a) => a.kind === "instance")) return;
      const t = typeOf(receivers, false, 0);
      if (t === null) return;
      const scan = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return;
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(node.expression.name) &&
          !declaresMember(cls, node.expression.name.text)
        ) {
          const self = node.expression.expression;
          edits.push({ pos: ts.tokenStartOfNode(self), text: `/** @type {${t}} ${MARK} */ (` });
          edits.push({ pos: self.end, text: ")" });
          annotations++;
        }
        ts.forEachChild(node, (c) => {
          scan(c);
          return undefined;
        });
      };
      if (method.body !== undefined) for (const st of method.body.statements.nodes) scan(st);
    };

    // Same-named instance methods of the file's classes form a family: a
    // call on a union of those classes needs one signature, so each member's
    // parameters and result join the whole family's values.
    const families = new Map<string, ts.MethodDeclaration[]>();
    const familyVisit = (node: ts.Node): void => {
      if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        !list((node as { modifiers?: { nodes: readonly ts.Node[] } }).modifiers).some(
          (m) => m.kind === ts.SyntaxKind.StaticKeyword,
        )
      ) {
        let l = families.get(node.name.text);
        if (l === undefined) families.set(node.name.text, (l = []));
        l.push(node);
      }
      ts.forEachChild(node, (c) => {
        familyVisit(c);
        return undefined;
      });
    };
    familyVisit(sf);
    // Members the program runs (they have analysis contexts); members it
    // never reaches would only widen the family's types.
    const reached = new Set<ts.Node>();
    for (const info of analysis.functions.values())
      if (info.node.getSourceFile() === sf) reached.add(info.node);
    const familyOf = (fn: ts.FunctionLikeDeclaration): readonly ts.MethodDeclaration[] => {
      if (!ts.isMethodDeclaration(fn) || !ts.isIdentifier(fn.name))
        return [fn as ts.MethodDeclaration];
      const members = (families.get(fn.name.text) ?? [fn]).filter((m) => reached.has(m));
      return members.length > 0 ? members : [fn];
    };
    const paramValues = (fn: ts.FunctionLikeDeclaration, index: number): Set<Atom> => {
      const out = new Set<Atom>();
      for (const member of familyOf(fn)) {
        const p = list(member.parameters)[index];
        if (p === undefined) continue;
        for (const a of analysis.declValues(p)) out.add(a);
      }
      return out;
    };
    const returnValues = (fn: ts.FunctionLikeDeclaration): Set<Atom> | undefined => {
      let out: Set<Atom> | undefined;
      for (const member of familyOf(fn)) {
        const r = returns.get(member);
        if (r === undefined) continue;
        out ??= new Set();
        for (const a of r) out.add(a);
      }
      return out;
    };

    const paramTags = (fn: ts.FunctionLikeDeclaration): string | null => {
      const tags: string[] = [];
      if (!ts.isConstructorDeclaration(fn) && !constructed.has(fn)) {
        const ret = returnValues(fn);
        const t = ret !== undefined && ret.size > 0 ? typeOf(ret, false, 0) : null;
        const why = process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY_WHY"];
        if (
          why !== undefined &&
          t === null &&
          ret !== undefined &&
          ts.isMethodDeclaration(fn) &&
          ts.isIdentifier(fn.name) &&
          fn.name.text === why
        )
          process.stderr.write(
            `[shape-overlay-why] ${fn.name.text}: ${[...ret].map((a) => `${a.kind}:${a.label}${analysis.escaped.has(a) ? "(escaped)" : ""}`).join(" | ")}\n`,
          );
        if (t !== null) tags.push(`@returns {${t}}`);
      }
      list(fn.parameters).forEach((p, index) => {
        if (
          !ts.isIdentifier(p.name) ||
          p.dotDotDotToken !== undefined ||
          p.initializer !== undefined ||
          p.questionToken !== undefined
        )
          return;
        const t = typeOf(paramValues(fn, index), false, 0);
        if (t !== null) tags.push(`@param {${t}} ${p.name.text}`);
      });
      return tags.length > 0 ? `${tags.join(" ")} ${MARK}` : null;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) receiverCasts(node);
      if (
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isFunctionDeclaration(node)
      ) {
        if (node.body !== undefined) {
          const tags = paramTags(node);
          if (tags !== null) {
            edits.push({ pos: ts.tokenStartOfNode(node), text: `/** ${tags} */ ` });
            annotations++;
          }
        }
        // `this.f = …` fields of a constructor's top-level statements.
        if (ts.isConstructorDeclaration(node) && node.body !== undefined) {
          const cls = node.parent;
          const seen = new Set<string>();
          for (const st of list(node.body.statements)) {
            if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) continue;
            const b = st.expression;
            if (
              b.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
              !ts.isPropertyAccessExpression(b.left)
            )
              continue;
            if (
              b.left.expression.kind !== ts.SyntaxKind.ThisKeyword ||
              !ts.isIdentifier(b.left.name)
            )
              continue;
            const name = b.left.name.text;
            if (seen.has(name)) continue;
            seen.add(name);
            const t = cls !== undefined ? fieldType(cls, name) : null;
            if (t !== null) {
              edits.push({ pos: ts.tokenStartOfNode(st), text: `/** @type {${t}} ${MARK} */ ` });
              annotations++;
            }
          }
        }
      }
      // Locals only: module-level bindings are initialized once (and a
      // record-typed module constant can turn a return type into a union of
      // overlapping records, which the lowering width-coerces).
      if (
        ts.isVariableStatement(node) &&
        (node.parent !== sf || process.env["SCRIPTC_SHAPE_OVERLAY_MODULE_VARS"] === "1") &&
        node.declarationList.declarations.nodes.length === 1
      ) {
        const d = node.declarationList.declarations.nodes[0]!;
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init !== undefined && !literalInitializer(init)) {
          const t = typeOf(analysis.declValues(d), false, 0);
          if (t !== null) {
            edits.push({ pos: ts.tokenStartOfNode(node), text: `/** @type {${t}} ${MARK} */ ` });
            annotations++;
          }
        }
      }
      ts.forEachChild(node, (c) => {
        visit(c);
        return undefined;
      });
    };

    const fieldType = (cls: ts.Node, name: string): string | null => {
      const atoms = new Set<Atom>();
      for (const a of analysis.atoms.atoms) {
        if (
          a.kind !== "instance" ||
          a.node === undefined ||
          !analysis.classChain(a.node).includes(cls)
        )
          continue;
        const id = analysis.fields.get(a)?.get(name);
        if (id !== undefined) for (const x of analysis.nodes[id]!.atoms) atoms.add(x);
      }
      return typeOf(atoms, false, 0);
    };

    visit(sf);
    // Dead branches: outermost first; edits inside a replaced range drop.
    const dead = (deadByFile.get(sf) ?? []).sort((a, b) => a.pos - b.pos);
    const ranges: [number, number][] = [];
    const removed = new Set<ts.Node>();
    for (const branch of dead) {
      const start = ts.tokenStartOfNode(branch);
      if (ranges.some(([lo, hi]) => start >= lo && start < hi)) continue;
      if (hoistedNames(branch, removed) === null) continue;
      removed.add(branch);
      ranges.push([start, branch.end]);
    }
    // A var that only removed branches declare stays declared in each.
    const hoisted = new Map<number, readonly string[]>();
    for (const branch of removed)
      hoisted.set(ts.tokenStartOfNode(branch), hoistedNames(branch, removed)!);
    if (ranges.length > 0) {
      const kept = edits.filter((e) => !ranges.some(([lo, hi]) => e.pos > lo && e.pos < hi));
      edits.length = 0;
      edits.push(...kept);
      const pkg = packageNameOf(sf.fileName);
      const rel = sf.fileName.split("/node_modules/").pop() ?? sf.fileName;
      for (const [lo, hi] of ranges) {
        const line = sf.getLineAndCharacterOfPosition(lo).line + 1;
        const message =
          `scriptc internal error: shape inference proved the branch at ${rel}:${line} unreachable, but it ran. ` +
          `This is a bug in scriptc's shape analysis, not in the program. Rebuild with --no-shape-overlay, ` +
          `or set "scriptc": {"packages": {"${pkg}": {"shapes": false}}} in package.json.`;
        // The branch's own var names stay declared in its scope, undefined.
        const names = hoisted.get(lo)!;
        const vars = names.length > 0 ? `var ${names.join(", ")}; ` : "";
        edits.push({
          pos: lo,
          end: hi,
          text: `{ ${vars}throw new Error(${JSON.stringify(message)}); }`,
        });
        deadBranches++;
      }
    }
    // Debugging: SCRIPTC_SHAPE_OVERLAY_ONLY=a-b keeps the annotations
    // numbered a..b (program order across files), to bisect a miscompile.
    const only = process.env["SCRIPTC_SHAPE_OVERLAY_ONLY"];
    if (only !== undefined) {
      const [lo, hi] = only.split("-").map(Number) as [number, number];
      edits.sort((a, b) => a.pos - b.pos);
      const kept = edits.filter(() => {
        const n = debugIndex++;
        return n >= lo && n <= hi;
      });
      edits.length = 0;
      edits.push(...kept);
    }
    if (edits.length === 0) continue;
    files.set(sf.fileName, applyEdits(neutralizeDocTags(sf), edits) + typedefText.join(""));
  }
  return { files, annotations, deadBranches };
}

function packageNameOf(fileName: string): string {
  const parts = (fileName.split("/node_modules/").pop() ?? "").split("/");
  return parts[0]!.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]!;
}

function literalInitializer(e: ts.Expression): boolean {
  return (
    ts.isObjectLiteralExpression(e) ||
    (ts.isArrayLiteralExpression(e) && e.elements.nodes.length > 0) ||
    ts.isStringLiteral(e) ||
    ts.isNumericLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isArrowFunction(e) ||
    ts.isFunctionExpression(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword
  );
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.pos - b.pos);
  let out = "";
  let at = 0;
  for (const e of sorted) {
    out += text.slice(at, e.pos) + e.text;
    at = e.end ?? e.pos;
  }
  return out + text.slice(at);
}

/** The file's text with the JSDoc type tags of its comments made plain
 * text: package JSDoc is a hint, not a declaration. String, template and
 * regular expression literals and JSX text are copied unchanged, so
 * comment-like text in them keeps its runtime value. Lengths are unchanged,
 * so edit positions in the source text stay valid. */
export function neutralizeDocTags(sf: ts.SourceFile): string {
  const text = sf.text;
  // Literal token ranges, in source order.
  const literals: [number, number][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      literals.push([node.pos, node.end]);
      return;
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    ) {
      literals.push([ts.tokenStartOfNode(node), node.end]);
      return;
    }
    ts.forEachChild(node, (c) => {
      visit(c);
      return undefined;
    });
  };
  visit(sf);
  literals.sort((a, b) => a[0] - b[0]);
  let out = "";
  let copied = 0;
  let next = 0;
  let pos = 0;
  // Outside literals, `//` and `/*` only start comments.
  while (pos < text.length) {
    while (next < literals.length && literals[next]![1] <= pos) next++;
    const literal = literals[next];
    if (literal !== undefined && literal[0] <= pos) {
      pos = literal[1];
      continue;
    }
    if (text.charCodeAt(pos) !== 47) {
      pos++;
      continue;
    }
    const second = text.charCodeAt(pos + 1);
    if (second === 47) {
      while (pos < text.length && !lineBreak(text.charCodeAt(pos))) pos++;
      continue;
    }
    if (second !== 42) {
      pos++;
      continue;
    }
    const close = text.indexOf("*/", pos + 2);
    const end = close < 0 ? text.length : close + 2;
    const comment = text.slice(pos, end);
    if (comment.startsWith("/**") && !comment.includes(MARK)) {
      out += text.slice(copied, pos) + neutralizeComment(comment);
      copied = end;
    }
    pos = end;
  }
  return out + text.slice(copied);
}

function lineBreak(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function neutralizeComment(comment: string): string {
  return comment.replace(
    /@(param|type|typedef|returns?|template|this|callback|property|prop|arg|argument|enum|implements|extends|augments|satisfies|overload|import)\b/g,
    "-$1",
  );
}

/** The `var` names a dead branch declares that its function (or file)
 * declares nowhere else outside the `removed` branches: replacing the
 * branch must keep them bound, as undefined. Null when the branch declares
 * a function in a block, whose binding outside the block depends on the
 * file's strictness; such a branch is kept. */
function hoistedNames(branch: ts.Node, removed: ReadonlySet<ts.Node>): readonly string[] | null {
  let scope: ts.Node | undefined = branch.parent;
  while (scope !== undefined && !ts.isSourceFile(scope) && !functionScope(scope))
    scope = scope.parent;
  if (scope === undefined) return null;
  const own = new Set<string>();
  let blockFunction = false;
  ts.walkPreorder(branch, (n) => {
    if (n !== branch && ts.isFunctionDeclaration(n)) {
      blockFunction = true;
      return "skip";
    }
    if (n !== branch && (functionScope(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)))
      return "skip";
    if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.BlockScoped) === 0)
      for (const d of n.declarations.nodes) addBindingNames(d.name, own);
    return undefined;
  });
  if (blockFunction) return null;
  if (own.size === 0) return [];
  // Names the scope binds outside the branch: parameters, a function
  // expression's name, other var declarations and function declarations.
  const elsewhere = new Set<string>();
  if (!ts.isSourceFile(scope)) {
    for (const p of list(
      (scope as { parameters?: { readonly nodes: readonly ts.ParameterDeclaration[] } }).parameters,
    ))
      addBindingNames(p.name, elsewhere);
    const name = (scope as { name?: ts.Node }).name;
    if (name !== undefined && ts.isIdentifier(name)) elsewhere.add(name.text);
  }
  const body = ts.isSourceFile(scope) ? scope : (scope as { body?: ts.Node }).body;
  if (body !== undefined)
    ts.walkPreorder(body, (n) => {
      if (n === branch || removed.has(n)) return "skip";
      if (n !== body && ts.isFunctionDeclaration(n) && n.name !== undefined)
        elsewhere.add(n.name.text);
      if (n !== body && (functionScope(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)))
        return "skip";
      if (ts.isVariableDeclarationList(n) && (n.flags & ts.NodeFlags.BlockScoped) === 0)
        for (const d of n.declarations.nodes) addBindingNames(d.name, elsewhere);
      return undefined;
    });
  return [...own].filter((name) => !elsewhere.has(name));
}

function functionScope(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isClassStaticBlockDeclaration(n)
  );
}

function addBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements.nodes)
    if (!ts.isOmittedExpression(element) && element.name !== undefined)
      addBindingNames(element.name, out);
}

/** A record site's keys: its static keys, or for a literal with spreads its
 * own keys plus every key a spread source contributes (optional unless
 * every value of that source has it). Null when a computed key or an
 * untracked spread source makes the key set unknown. */
function keysOfSite(
  analysis: ShapeAnalysis,
  v: SiteVerdict,
): { keys: string[]; optional: Set<string> } | null {
  const site = v.site;
  if (site.keys !== null) return { keys: site.keys, optional: new Set() };
  if (site.hasComputedKey) return null;
  const fields = analysis.fields.get(site.atom);
  const any = fields?.get("*");
  if (any !== undefined && analysis.nodes[any]!.atoms.size > 0) return null;
  const required = new Set(site.ownKeys);
  for (const spread of site.spreads) {
    const sets: Set<string>[] = [];
    for (const a of analysis.nodes[spread]!.atoms) {
      if (a.kind === "prim" && (a.label === "undefined" || a.label === "null")) continue;
      if (a.kind !== "object") return null;
      const own = new Set<string>();
      for (const k of analysis.fields.get(a)?.keys() ?? []) if (k !== "*") own.add(k);
      sets.push(own);
    }
    const first = sets[0];
    if (first === undefined) continue;
    for (const k of first) if (sets.every((set) => set.has(k))) required.add(k);
  }
  const all = [...site.ownKeys];
  for (const k of fields?.keys() ?? []) if (k !== "*" && !all.includes(k)) all.push(k);
  return { keys: all, optional: new Set(all.filter((k) => !required.has(k))) };
}
