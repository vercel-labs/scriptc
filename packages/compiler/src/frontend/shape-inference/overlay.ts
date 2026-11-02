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
 * The package's own JSDoc is a declaration (maintainer decision
 * 2026-10-25): it stays as written, and the overlay adds a type only where
 * the package's JSDoc declares none (a documented parameter, return or
 * binding keeps its documented type, as in the default build).
 *
 * Every edit is inline: no line breaks are added or removed, so positions
 * keep their lines. */
import * as ts from "../ts7/adapter.js";
import type { Atom } from "./domain.js";
import { isPackageJsFile, type Op, type ShapeAnalysis } from "./analyze.js";
import type { SiteVerdict } from "./report.js";
import { jsInferenceEnabled } from "../js-inference.js";

export interface ShapeOverlay {
  /** Rewritten text per package file. */
  readonly files: Map<string, string>;
  /** Annotations written, for the build report. */
  readonly annotations: number;
  /** Branches the analysis proved unreachable, replaced by checks. */
  readonly deadBranches: number;
  /** The files with annotations or dead-branch checks. */
  readonly typed: ReadonlySet<string>;
}

interface Edit {
  readonly pos: number;
  readonly text: string;
  /** Replaces pos..end instead of inserting at pos. */
  readonly end?: number;
  /** The annotation (or dead branch) the edit belongs to. */
  readonly id?: number;
}

/** The overlay before annotation exclusions apply: per file, its text,
 * edits and appended typedefs. It depends only on the analysis, so a build
 * that drops refused annotations renders it again instead of analyzing
 * again (renderShapeOverlay). */
export interface ShapeOverlayPlan {
  readonly parts: Map<string, OverlayPart>;
}

interface OverlayPart {
  readonly text: string;
  readonly edits: Edit[];
  readonly suffix: string;
}

/** Spans of a served package file that a project type patch edited (the
 * type-patches layer's `typePatchedSpans`, in served-text offsets). */
export type ProtectedSpans = (fileName: string) => readonly { start: number; end: number }[];

let protectedSpansOf: ProtectedSpans = () => [];

/** Installs the source of patched spans: the overlay neither annotates nor
 * rewrites a declaration a project type patch edited, since the patch is
 * the project's own declaration of its type. */
export function setShapeOverlayProtectedSpans(spans: ProtectedSpans | null): void {
  protectedSpansOf = spans ?? (() => []);
}

/** Whether a file has patched spans (static-objects.ts leaves it as served,
 * so the spans keep their offsets). */
export function hasShapeOverlayProtectedSpans(fileName: string): boolean {
  return protectedSpansOf(fileName).length > 0;
}

/** Whether the declaration whose first token starts at `pos` overlaps a
 * patched span: its leading comments and its header (up to its body). */
export function declarationPatched(
  sf: ts.SourceFile,
  pos: number,
  spans: readonly { start: number; end: number }[],
): boolean {
  if (spans.length === 0) return false;
  let node: ts.Node = sf;
  for (;;) {
    let next: ts.Node | undefined;
    ts.forEachChild(node, (c) => {
      if (next === undefined && c.pos <= pos && c.end > pos) next = c;
      return undefined;
    });
    if (next === undefined || ts.tokenStartOfNode(next) > pos) break;
    node = next;
    if (ts.tokenStartOfNode(node) === pos) break;
  }
  if (node === sf) return false;
  const body = (node as { body?: ts.Node }).body;
  const end = body !== undefined ? ts.tokenStartOfNode(body) : node.end;
  return spans.some((span) => span.start < end && span.end > node.pos);
}

/** Marks the overlay's own comments (an unknown JSDoc tag, ignored). */
export const OVERLAY_MARK = "@scriptcShape";
const MARK = OVERLAY_MARK;

/** Above 1, values of several record key sets type as one merged record
 * with optional fields (SCRIPTC_SHAPE_RECORD_ARMS; experimental). */
const MAX_RECORD_ARMS = Number(process.env.SCRIPTC_SHAPE_RECORD_ARMS ?? 1);

/** The most class or record arms an inferred union may have. */
const MAX_ARMS = 6;

/** Operations whose receivers' class instances keep the dynamic representation. */
const REFLECTIVE_OPS: ReadonlySet<Op["kind"]> = new Set<Op["kind"]>([
  "computedWrite",
  "delete",
  "defineProperty",
  "setPrototypeOf",
  "proxy",
]);

function list<T extends ts.Node>(arr: { readonly nodes: readonly T[] } | undefined): readonly T[] {
  return arr?.nodes ?? [];
}

let debugIndex = 0;

/** Annotations a build dropped because their lowering was refused: per
 * file, the annotation ids (positions in the overlay's input text); a file
 * in `files` gets no overlay at all. */
export interface OverlayExclusions {
  readonly annotations: ReadonlyMap<string, ReadonlySet<number>>;
  readonly files: ReadonlySet<string>;
}

export const NO_EXCLUSIONS: OverlayExclusions = { annotations: new Map(), files: new Set() };

/** The ids of the overlay annotations in a comment or trivia text. */
export function overlayAnnotationIds(text: string): number[] {
  const ids: number[] = [];
  for (const m of text.matchAll(/@scriptcShape #(\d+)/g)) ids.push(Number(m[1]));
  return ids;
}

export function planShapeOverlay(
  analysis: ShapeAnalysis,
  verdicts: readonly SiteVerdict[],
  packageFiles: readonly ts.SourceFile[],
  exclusions: OverlayExclusions = NO_EXCLUSIONS,
  held: ReadonlySet<Atom> = new Set(),
): ShapeOverlayPlan {
  // Debugging: SCRIPTC_DEBUG_SHAPE_FIELD=name prints that field's values per atom.
  const debugField = process.env["SCRIPTC_DEBUG_SHAPE_FIELD"];
  if (debugField !== undefined)
    for (const [atom, fields] of analysis.fields) {
      const id = fields.get(debugField);
      if (id !== undefined)
        process.stderr.write(
          `[shape-field] ${atom.kind}:${atom.label}.${debugField} = ${[...analysis.nodes[id]!.atoms].map((a) => `${a.kind}:${a.label}`).join(" | ")}\n`,
        );
    }
  const pSites = new Map<Atom, SiteVerdict>();
  const siteVerdicts = new Set<Atom>(verdicts.map((v) => v.site.atom));
  // Class instances that a computed write, `delete`, a property
  // definition, a prototype change or a proxy reaches keep the dynamic
  // representation in the program's own files: the typed lowering of a
  // class instance does not support those operations.
  const reflectedInstances = new Set<Atom>();
  for (const o of analysis.ops) {
    if (!REFLECTIVE_OPS.has(o.kind)) continue;
    for (const a of analysis.nodes[o.recv]!.atoms)
      if (a.kind === "instance" && a.node !== undefined && !isPackageJsFile(a.node.getSourceFile()))
        reflectedInstances.add(a);
  }
  const dynHeld = dynHeldSites(analysis, verdicts, held);
  // Objects and arrays that reach a position of the program's own files the
  // overlay leaves untyped (a binding, parameter, result, field or element
  // whose values print as no type, or one the program's JSDoc types): the
  // lowering holds them in the dynamic representation there, so typing their
  // literal sites would make that position hold a copy.
  const untyped = new Set<Atom>();
  // A literal of the program's own files that stores a parameter its
  // JSDoc types reads the parameter at that type, which the values passed
  // need not match: the literal stays dynamic.
  if (jsInferenceEnabled())
    for (const v of verdicts) {
      const node = v.site.node;
      if (!isPackageJsFile(node.getSourceFile()) && storesDocumentedParameter(node))
        untyped.add(v.site.atom);
    }
  // Functions and classes that reach such a position are called through the
  // dynamic representation: their parameters and results stay untyped, so
  // the values passed in keep their identity.
  const dynCalled = new Set<ts.Node>();
  for (const a of held)
    if ((a.kind === "function" || a.kind === "class") && a.node !== undefined)
      dynCalled.add(a.node);
  // Records and arrays print only for sites whose objects never escape: a
  // native record that reached untyped code would be seen as a copy.
  const siteKeys = new Map<Atom, { keys: string[]; optional: Set<string> }>();
  for (const v of verdicts) {
    if (v.verdict !== "P-local" || dynHeld.has(v.site.atom)) continue;
    if (v.site.kind === "array") {
      pSites.set(v.site.atom, v);
      continue;
    }
    const keys = keysOfSite(analysis, v);
    if (keys === null) continue;
    siteKeys.set(v.site.atom, keys);
    pSites.set(v.site.atom, v);
  }
  const parts = new Map<string, OverlayPart>();
  const overlaid = new Set<ts.SourceFile>(packageFiles);
  const exportedClasses = new Map<ts.SourceFile, Set<string>>();
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
  // Classes whose instances meet as the receivers of one member read, by
  // member name: their same-named methods need one signature.
  const cooccurring = new Map<string, Set<ts.Node>[]>();
  for (const op of analysis.ops) {
    if (op.kind !== "read" || op.name === null) continue;
    const classes = new Set<ts.Node>();
    for (const a of analysis.nodes[op.recv]!.atoms)
      if (a.kind === "instance" && a.node !== undefined) classes.add(a.node);
    if (classes.size < 2) continue;
    let l = cooccurring.get(op.name);
    if (l === undefined) cooccurring.set(op.name, (l = []));
    l.push(classes);
  }
  for (const sf of packageFiles) {
    if (exclusions.files.has(sf.fileName)) continue;
    // One of the program's own files (inference for the program's
    // JavaScript), not a package's.
    const programFile = jsInferenceEnabled() && !isPackageJsFile(sf);
    const typedefs = new Map<string, string>();
    const typedefText: string[] = [];
    const edits: Edit[] = [];
    // One annotation: a JSDoc comment at `pos` carrying MARK and the
    // annotation's id (its position), so a refused lowering can name it and
    // the next load drop it. `close`: the text that closes a type cast.
    const patchedSpans = protectedSpansOf(sf.fileName);
    // The checker reads a declaration's last JSDoc comment only, so an
    // annotation placed after the program's own comment repeats that
    // comment's text.
    const ownDocBefore = (pos: number): string => {
      if (isPackageJsFile(sf)) return "";
      let end = pos;
      while (end > 0 && /\s/.test(sf.text[end - 1]!)) end--;
      if (end < 5 || sf.text.slice(end - 2, end) !== "*/") return "";
      const start = sf.text.lastIndexOf("/*", end - 3);
      if (start < 0 || sf.text[start + 2] !== "*") return "";
      const comment = sf.text.slice(start, end);
      if (comment.includes(MARK)) return "";
      return comment
        .slice(3, -2)
        .replace(/^\s*\*/gm, " ")
        .replace(/\s+/g, " ")
        .trim();
    };
    const annotate = (pos: number, tags: string, close?: number): void => {
      // A declaration a project type patch edited keeps the patch alone.
      if (declarationPatched(sf, pos, patchedSpans)) return;
      const own = close === undefined ? ownDocBefore(pos) : "";
      edits.push({
        pos,
        id: pos,
        text: `/** ${own === "" ? "" : `${own} `}${tags} ${MARK} #${pos} */ ${close !== undefined ? "(" : ""}`,
      });
      if (close !== undefined) edits.push({ pos: close, id: pos, text: ")" });
    };

    const className = (decl: ts.Node): string | null => {
      const own = (decl as ts.ClassLikeDeclaration).name;
      // A top-level class of another overlaid file: named through the type
      // alias the overlay exports from that file.
      if (decl.getSourceFile() !== sf) {
        const other = decl.getSourceFile();
        if (
          process.env["SCRIPTC_SHAPE_CROSS_FILE"] === "0" ||
          own === undefined ||
          !ts.isClassDeclaration(decl) ||
          decl.parent !== other ||
          !overlaid.has(other) ||
          exclusions.files.has(other.fileName)
        )
          return null;
        const alias = `__shape_class_${own.text}`;
        let names = exportedClasses.get(other);
        if (names === undefined) exportedClasses.set(other, (names = new Set()));
        names.add(own.text);
        return `import(${JSON.stringify(other.fileName)}).${alias}`;
      }
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
    const holdUntyped = (atoms: Iterable<Atom>): void => {
      if (!programFile) return;
      for (const a of atoms)
        if (
          a.kind === "object" ||
          a.kind === "array" ||
          a.kind === "function" ||
          a.kind === "class"
        )
          untyped.add(a);
    };
    // In the program's own files a type with an `any` inside stays unwritten:
    // the lowering stores an `any` field or element at the checker's type of
    // the value it receives, which would type an object held untyped.
    const typeOf = (atoms: ReadonlySet<Atom>, inner: boolean, depth: number): string | null => {
      let t = typeOfValues(atoms, inner, depth);
      if (programFile && !inner && t !== null && containsAny(t)) t = null;
      if (t === null || t === "any") holdUntyped(atoms);
      return t;
    };
    // Typedefs with an `any` inside, directly or through another typedef.
    const anyTypedefs = new Set<string>();
    const containsAny = (t: string): boolean =>
      /\bany\b/.test(t) || [...t.matchAll(/__shape_\d+/g)].some((m) => anyTypedefs.has(m[0]));
    const typeOfValues = (
      atoms: ReadonlySet<Atom>,
      inner: boolean,
      depth: number,
    ): string | null => {
      if (atoms.size === 0) return inner ? "any" : null;
      const arms = new Set<string>();
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
            t = a.node !== undefined && !reflectedInstances.has(a) ? className(a.node) : null;
            break;
          case "object": {
            const v = pSites.get(a);
            if (v === undefined || depth >= 4 || !siteKeys.has(a)) return inner ? "any" : null;
            recordSites.push(a);
            continue;
          }
          case "array": {
            if (analysis.escaped.has(a) || (siteVerdicts.has(a) && !pSites.has(a)))
              return inner ? "any" : null;
            // Only arrays the program writes as literals: a builtin's array
            // (a match result, `new Array(n)`) may have holes, and the
            // checker already types it from the library.
            if (
              a.node === undefined ||
              !ts.isArrayLiteralExpression(a.node) ||
              a.node.elements.nodes.some((e) => e.kind === ts.SyntaxKind.OmittedExpression)
            )
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
      // Arms, not atoms: per-site allocations of one record shape are one
      // typedef.
      if (arms.size > MAX_ARMS) return inner ? "any" : null;
      // Arithmetic on unknown values may answer a number or a bigint: the
      // lowering has no useful mixed representation, so those stay untyped.
      if (arms.has("number") && arms.has("bigint")) return inner ? "any" : null;
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
      if (parts.some(containsAny)) anyTypedefs.add(name);
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
      if (parts.some(containsAny)) anyTypedefs.add(name);
      typedefText.push(`/** @typedef {{${parts.join(", ")}}} ${name} ${MARK} */`);
      return name;
    };

    // Functions called with `new` yield their instance, whatever they return.
    // The set holds nodes only: compiled natively, a Set of `ts.Node |
    // undefined` keeps that union in a box, and so every `ts.Node |
    // undefined` value of the compiler, such as each optional child a syntax
    // node returns.
    const constructed = new Set<ts.Node>();
    for (const a of analysis.fnOfInstance.values()) if (a.node) constructed.add(a.node);
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
          annotate(ts.tokenStartOfNode(self), `@type {${t}}`, self.end);
        }
        ts.forEachChild(node, (c) => {
          scan(c);
          return undefined;
        });
      };
      if (method.body !== undefined) for (const st of method.body.statements.nodes) scan(st);
    };

    // Same-named instance methods of the file's classes form a family when
    // a call can reach several of them: a call on a union of those classes
    // needs one signature, so each member's parameters and result join the
    // whole family's values. Two members join when their classes' instances
    // meet as the receivers of one read of the method, or when one class
    // extends the other (an override keeps its base's signature). Members
    // no union reaches keep their own values: ZodString's `_addCheck`
    // returns a ZodString, not every schema class's `_addCheck` result.
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
    const familyParent = new Map<ts.MethodDeclaration, ts.MethodDeclaration>();
    const familyFind = (m: ts.MethodDeclaration): ts.MethodDeclaration => {
      let r = m;
      for (let p = familyParent.get(r); p !== undefined && p !== r; p = familyParent.get(r)) r = p;
      return r;
    };
    const familyUnion = (a: ts.MethodDeclaration, b: ts.MethodDeclaration): void => {
      const ra = familyFind(a);
      const rb = familyFind(b);
      if (ra !== rb) familyParent.set(rb, ra);
    };
    const classNameOf = (c: ts.Node): string | null => {
      const named = c as { name?: ts.Node };
      if (named.name !== undefined && ts.isIdentifier(named.name)) return named.name.text;
      const p = c.parent;
      return p !== undefined && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)
        ? p.name.text
        : null;
    };
    const baseNameOf = (c: ts.Node): string | null => {
      const clauses = (c as { heritageClauses?: { nodes: readonly ts.HeritageClause[] } })
        .heritageClauses;
      for (const h of list(clauses)) {
        if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        const t = list(h.types)[0];
        if (t !== undefined && ts.isIdentifier(t.expression)) return t.expression.text;
      }
      return null;
    };
    for (const [name, members] of families) {
      if (members.length < 2) continue;
      // The member a class's instances run: its own, or its nearest base's
      // (by name, within the file).
      const byClass = new Map<ts.Node, ts.MethodDeclaration>();
      for (const m of members) if (m.parent !== undefined) byClass.set(m.parent, m);
      const classesByName = new Map<string, ts.Node>();
      const collect = (node: ts.Node): void => {
        if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
          const n = classNameOf(node);
          if (n !== null && !classesByName.has(n)) classesByName.set(n, node);
        }
        ts.forEachChild(node, (c) => {
          collect(c);
          return undefined;
        });
      };
      const memberOf = (c: ts.Node): ts.MethodDeclaration | undefined => {
        let cur: ts.Node | undefined = c;
        for (let depth = 0; cur !== undefined && depth < 16; depth++) {
          const own = byClass.get(cur);
          if (own !== undefined) return own;
          const base = baseNameOf(cur);
          if (base === null) return undefined;
          if (classesByName.size === 0) collect(sf);
          cur = classesByName.get(base);
        }
        return undefined;
      };
      // Overrides join their base's member.
      for (const m of members) {
        const base = m.parent === undefined ? null : baseNameOf(m.parent);
        if (base === null) continue;
        if (classesByName.size === 0) collect(sf);
        const baseClass = classesByName.get(base);
        const inherited = baseClass === undefined ? undefined : memberOf(baseClass);
        if (inherited !== undefined) familyUnion(inherited, m);
      }
      for (const classes of cooccurring.get(name) ?? []) {
        let first: ts.MethodDeclaration | undefined;
        for (const c of classes) {
          if (c.getSourceFile() !== sf) continue;
          const m = memberOf(c);
          if (m === undefined) continue;
          if (first === undefined) first = m;
          else familyUnion(first, m);
        }
      }
    }
    // Members the program runs (they have analysis contexts); members it
    // never reaches would only widen the family's types.
    const reached = new Set<ts.Node>();
    for (const info of analysis.functions.values())
      if (info.node.getSourceFile() === sf) reached.add(info.node);
    const familyOf = (fn: ts.FunctionLikeDeclaration): readonly ts.MethodDeclaration[] => {
      if (!ts.isMethodDeclaration(fn) || !ts.isIdentifier(fn.name))
        return [fn as ts.MethodDeclaration];
      const root = familyFind(fn as ts.MethodDeclaration);
      const members = (families.get(fn.name.text) ?? [fn]).filter(
        (m) => reached.has(m) && familyFind(m) === root,
      );
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

    // A constructor parameter the constructor stores in a field (`this.value
    // = value`) types the field: the checker types a JavaScript field from
    // its constructor assignments alone. When other writes give the field
    // more values than the parameter's, the parameter stays untyped in the
    // program's own files, so the field keeps the dynamic representation.
    const storedIntoWiderField = (
      fn: ts.FunctionLikeDeclaration,
      param: string,
      t: string,
    ): boolean => {
      if (!ts.isConstructorDeclaration(fn) || fn.body === undefined || isPackageJsFile(sf))
        return false;
      const cls = fn.parent;
      if (cls === undefined) return false;
      return list(fn.body.statements).some((st) => {
        if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression)) return false;
        const b = st.expression;
        return (
          b.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(b.left) &&
          b.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(b.left.name) &&
          ts.isIdentifier(b.right) &&
          b.right.text === param &&
          fieldType(cls, b.left.name.text) !== t
        );
      });
    };

    const paramTags = (fn: ts.FunctionLikeDeclaration): string | null => {
      const tags: string[] = [];
      // The package's JSDoc declares types: the overlay adds none where it
      // has one, and none at all for a signature it types as a whole.
      const doc = packageDocOf(fn);
      if (doc.whole) return null;
      if (
        programFile &&
        (dynCalled.has(fn) ||
          (ts.isConstructorDeclaration(fn) && fn.parent !== undefined && dynCalled.has(fn.parent)))
      ) {
        list(fn.parameters).forEach((_, index) => holdUntyped(paramValues(fn, index)));
        const ret = returnValues(fn);
        if (ret !== undefined) holdUntyped(ret);
        return null;
      }
      let opaqueResult = false;
      if (!ts.isConstructorDeclaration(fn) && !constructed.has(fn) && !doc.returns) {
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
        // The checker types an unannotated method's result from its own
        // body, which an override in the program's own files may not match
        // (`method(value = 1)` overridden by one returning a string): a
        // family whose results print as no type returns `any`.
        else if (familyOf(fn).length > 1 && !isPackageJsFile(sf)) tags.push("@returns {any}");
        else
          opaqueResult =
            ret !== undefined &&
            [...ret].some((a) => a.kind === "object" || a.kind === "array" || a.kind === "top");
      }
      const typedParams = tags.length;
      list(fn.parameters).forEach((p, index) => {
        if (
          !ts.isIdentifier(p.name) ||
          p.dotDotDotToken !== undefined ||
          p.initializer !== undefined ||
          p.questionToken !== undefined
        ) {
          if (p.dotDotDotToken === undefined) holdUntyped(paramValues(fn, index));
          return;
        }
        const values = paramValues(fn, index);
        const t = typeOf(values, false, 0);
        // A `typeof p === "…"` test the proven values never pass would
        // narrow the typed parameter to never inside the branch, which the
        // lowering refuses: such a parameter stays untyped.
        if (
          t === null ||
          typeofTestsOutside(fn, p.name.text, values) ||
          doc.params.has(p.name.text) ||
          storedIntoWiderField(fn, p.name.text, t)
        ) {
          holdUntyped(values);
          return;
        }
        tags.push(`@param {${t}} ${p.name.text}`);
      });
      // With typed parameters the checker infers the result from them: an
      // object or array the analysis does not type (a `__proto__` literal,
      // a prototype change) would become a record the lowering checks, so
      // in the program's own files the result stays `any`.
      if (opaqueResult && tags.length > typedParams && !isPackageJsFile(sf))
        tags.push("@returns {any}");
      return tags.length > 0 ? tags.join(" ") : null;
    };

    // Getters of one name in several classes of the program's own file: an
    // override can return what the base's body does not (`get value()`
    // returning a string over one returning a number), and the checker
    // types a read from the getter it resolves, so they return `any`.
    const getterClasses = new Map<string, number>();
    if (!isPackageJsFile(sf)) {
      const countGetters = (node: ts.Node): void => {
        if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name))
          getterClasses.set(node.name.text, (getterClasses.get(node.name.text) ?? 0) + 1);
        ts.forEachChild(node, (c) => {
          countGetters(c);
          return undefined;
        });
      };
      countGetters(sf);
    }

    const visit = (node: ts.Node): void => {
      if (ts.isMethodDeclaration(node)) receiverCasts(node);
      if (
        ts.isGetAccessorDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        (getterClasses.get(node.name.text) ?? 0) > 1 &&
        node.type === undefined
      )
        annotate(ts.tokenStartOfNode(node), "@returns {any}");
      if (
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        // Functions stored as object members (`run: function (…) {…}`).
        (process.env["SCRIPTC_SHAPE_MEMBER_FUNCTIONS"] !== "0" &&
          ts.isFunctionExpression(node) &&
          node.parent !== undefined &&
          ts.isPropertyAssignment(node.parent) &&
          node.parent.initializer === node)
      ) {
        if (node.body !== undefined) {
          const tags = paramTags(node);
          if (tags !== null) annotate(ts.tokenStartOfNode(node), tags);
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
            if (t !== null && !packageDocOf(st).type)
              annotate(ts.tokenStartOfNode(st), `@type {${t}}`);
          }
        }
      }
      // Locals, and in the program's own files module-level bindings too: in
      // a package, a module-level binding is initialized once (and a
      // record-typed module constant can turn a return type into a union of
      // overlapping records, which the lowering width-coerces). A module-level
      // object literal of the program is typed as well: the lowering keeps
      // such a binding dynamic for its identity unless the overlay types it.
      // Every declarator of a statement is typed: a consumer of a literal in
      // `const a = {…}, b = {…}` would otherwise see a record while the
      // lowering kept that binding dynamic, a copy of it.
      const moduleLevel = node.parent === sf;
      if (
        ts.isVariableStatement(node) &&
        (!moduleLevel || programFile || process.env["SCRIPTC_SHAPE_OVERLAY_MODULE_VARS"] === "1")
      ) {
        const declarations = node.declarationList.declarations.nodes;
        for (const d of declarations) {
          const init = d.initializer;
          if (
            !ts.isIdentifier(d.name) ||
            init === undefined ||
            (literalInitializer(init) &&
              !(moduleLevel && programFile && ts.isObjectLiteralExpression(init)))
          )
            continue;
          // A statement-level `@type` applies to the first declarator only,
          // as the checker reads it: the later ones have their own trivia.
          const documented = d === declarations[0] ? packageDocOf(node).type : declTypeDoc(d, sf);
          const t = typeOf(analysis.declValues(d), false, 0);
          if (process.env["SCRIPTC_DEBUG_SHAPE_OVERLAY_WHY"] === d.name.text)
            process.stderr.write(
              `[shape-overlay-why] ${d.name.text}@${sf.getLineAndCharacterOfPosition(ts.tokenStartOfNode(d)).line + 1}: ${t} <- ${[...analysis.declValues(d)].map((a) => `${a.kind}:${a.label}`).join(" | ")}\n`,
            );
          if (t !== null && !documented) {
            // The statement's first declarator takes the statement-level tag
            // (the only position the checker reads it from); a later one
            // takes a tag in its own leading trivia.
            const first = d === declarations[0];
            annotate(ts.tokenStartOfNode(first ? node : d), `@type {${t}}`);
            typedDecls.add(d);
          }
        }
      }
      // A binding of the program's own files the overlay does not type takes
      // the checker's type from its initializer, or its JSDoc's: values it
      // holds other than its own initializer's literal stay dynamic.
      if (
        programFile &&
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        !typedDecls.has(node)
      ) {
        const own = node.initializer;
        holdUntyped([...analysis.declValues(node)].filter((a) => a.node !== own));
      }
      ts.forEachChild(node, (c) => {
        visit(c);
        return undefined;
      });
    };
    const typedDecls = new Set<ts.VariableDeclaration>();

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
      // In the program's own files, code that sees an instance before the
      // constructor stores the field reads undefined from it.
      if (atoms.size > 0 && !isPackageJsFile(sf) && !analysis.fieldSurelyPresent(cls, name))
        atoms.add(analysis.prim("undefined"));
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
          id: lo,
          text: `{ /** ${MARK} #${lo} */ ${vars}throw new Error(${JSON.stringify(message)}); }`,
        });
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
    if (edits.length === 0 && typedefText.length === 0) continue;
    parts.set(sf.fileName, { text: sf.text, edits, suffix: typedefText.join("") });
  }
  // Holding more objects can leave more positions untyped: plan again until
  // the held set stops growing.
  const grown = [...untyped].filter((a) => !held.has(a) && !dynHeld.has(a));
  if (grown.length > 0)
    return planShapeOverlay(
      analysis,
      verdicts,
      packageFiles,
      exclusions,
      new Set([...held, ...grown]),
    );
  // Type aliases other files name these files' classes through.
  for (const [other, names] of exportedClasses) {
    const aliases = [...names]
      .sort()
      .map((n) => `/** @typedef {${n}} __shape_class_${n} ${MARK} */`)
      .join("");
    const part = parts.get(other.fileName);
    if (part !== undefined)
      parts.set(other.fileName, { ...part, suffix: `${part.suffix}\n${aliases}` });
    else
      parts.set(other.fileName, {
        text: other.text,
        edits: [],
        suffix: `\n${aliases}`,
      });
  }
  return { parts };
}

/** The plan moved onto texts that structural rewrites changed: each
 * annotation and dead-branch edit maps through the rewrite's edits, and an
 * annotation whose position the rewrite replaced is left out (with its
 * closing parenthesis). `rewritten` gives a rewritten file's text and its
 * position map. */
export function planOnRewrittenTexts(
  plan: ShapeOverlayPlan,
  rewritten: ReadonlyMap<string, { text: string; map: (pos: number) => number | null }>,
): ShapeOverlayPlan {
  const parts = new Map<string, OverlayPart>();
  for (const [file, part] of plan.parts) {
    const r = rewritten.get(file);
    if (r === undefined) {
      parts.set(file, part);
      continue;
    }
    const lost = new Set<number>();
    const moved: Edit[] = [];
    for (const e of part.edits) {
      const pos = r.map(e.pos);
      const end = e.end === undefined ? undefined : r.map(e.end);
      if (pos === null || end === null || (end !== undefined && end < pos)) {
        if (e.id !== undefined) lost.add(e.id);
        continue;
      }
      if (e.end !== undefined && end !== undefined && end - pos !== e.end - e.pos) {
        // A rewrite inside a replaced dead branch.
        if (e.id !== undefined) lost.add(e.id);
        continue;
      }
      moved.push(end === undefined ? { ...e, pos } : { ...e, pos, end });
    }
    const edits = moved.filter((e) => e.id === undefined || !lost.has(e.id));
    parts.set(file, { text: r.text, edits, suffix: part.suffix });
  }
  return { parts };
}

/** The overlay's files with the annotations a build dropped left out. */
export function renderShapeOverlay(
  plan: ShapeOverlayPlan,
  exclusions: OverlayExclusions = NO_EXCLUSIONS,
): ShapeOverlay {
  const files = new Map<string, string>();
  const typed = new Set<string>();
  let annotations = 0;
  let deadBranches = 0;
  for (const [file, part] of plan.parts) {
    const dropped = exclusions.annotations.get(file);
    const edits = part.edits.filter((e) => e.id === undefined || dropped?.has(e.id) !== true);
    for (const e of edits) {
      if (e.id === undefined || e.text === ")") continue;
      if (e.end !== undefined) deadBranches++;
      else annotations++;
    }
    if (edits.length === 0 && part.suffix === "") continue;
    const text = applyEdits(part.text, edits) + part.suffix;
    files.set(file, text);
    if (edits.some((e) => e.id !== undefined)) typed.add(file);
  }
  return { files, typed, annotations, deadBranches };
}

/** Literal sites whose objects some holder keeps in the lowering's dynamic
 * representation: a module-level binding of a package's JavaScript file (the
 * overlay does not type those, and the lowering keeps their objects
 * dynamic), the objects of `extra` (positions of the program's own files the
 * overlay leaves untyped), and, transitively, the fields and elements of
 * those objects and of every object or array that is not P-local. A typed
 * position that receives such an object converts it to a native record,
 * which is a copy: identity comparisons and writes through either reference
 * would diverge. */
function dynHeldSites(
  analysis: ShapeAnalysis,
  verdicts: readonly SiteVerdict[],
  extra: ReadonlySet<Atom>,
): Set<Atom> {
  const held = new Set<Atom>();
  const work: Atom[] = [];
  const add = (a: Atom): void => {
    if ((a.kind === "object" || a.kind === "array") && !held.has(a)) {
      held.add(a);
      work.push(a);
    }
  };
  for (const a of extra) add(a);
  // The overlay types the module-level bindings of the program's own files.
  const programFiles = jsInferenceEnabled();
  for (const sf of analysis.files) {
    if (!/\.[cm]?jsx?$/.test(sf.fileName)) continue;
    if (programFiles && !isPackageJsFile(sf)) continue;
    for (const st of sf.statements.nodes) {
      if (!ts.isVariableStatement(st)) continue;
      for (const d of st.declarationList.declarations.nodes)
        for (const a of analysis.declValues(d)) add(a);
    }
  }
  const pLocal = new Set<Atom>();
  for (const v of verdicts) if (v.verdict === "P-local") pLocal.add(v.site.atom);
  for (const a of analysis.atoms.atoms)
    if ((a.kind === "object" || a.kind === "array") && !pLocal.has(a)) work.push(a);
  const seen = new Set<Atom>();
  while (work.length > 0) {
    const a = work.pop()!;
    if (seen.has(a)) continue;
    seen.add(a);
    for (const id of analysis.fields.get(a)?.values() ?? [])
      for (const x of analysis.nodes[id]!.atoms) add(x);
    const el = analysis.elements.get(a);
    if (el !== undefined) for (const x of analysis.nodes[el]!.atoms) add(x);
  }
  return held;
}

/** Whether an object or array literal stores a parameter, read by name,
 * that its function's JSDoc types. */
function storesDocumentedParameter(literal: ts.Node): boolean {
  const values: ts.Node[] = [];
  if (ts.isObjectLiteralExpression(literal)) {
    for (const p of literal.properties.nodes) {
      if (ts.isPropertyAssignment(p)) values.push(p.initializer);
      else if (ts.isShorthandPropertyAssignment(p)) values.push(p.name);
    }
  } else if (ts.isArrayLiteralExpression(literal)) values.push(...literal.elements.nodes);
  for (let value of values) {
    while (ts.isParenthesizedExpression(value)) value = value.expression;
    if (!ts.isIdentifier(value)) continue;
    const name = value.text;
    for (let n: ts.Node | undefined = literal.parent; n !== undefined; n = n.parent) {
      if (!ts.isFunctionLike(n)) continue;
      const declares = list((n as ts.FunctionLikeDeclaration).parameters).some(
        (p) => ts.isIdentifier(p.name) && p.name.text === name,
      );
      if (!declares) continue;
      if (packageDocOf(n).params.has(name)) return true;
      break;
    }
  }
  return false;
}

interface PackageDoc {
  /** Documented parameter names. */
  readonly params: ReadonlySet<string>;
  readonly returns: boolean;
  readonly type: boolean;
  /** A tag that types the whole declaration (`@type`, `@template`,
   * `@this`, `@overload`, `@callback`). */
  readonly whole: boolean;
}

/** The type tags of the package's own JSDoc for a declaration: in its
 * leading trivia and in that of the statement or property holding it
 * (`/** … *\/ const f = function (…) {}`, `exports.f = function …`). */
function packageDocOf(node: ts.Node): PackageDoc {
  let text = "";
  for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
    const sf = n.getSourceFile();
    for (const m of sf.text.slice(n.pos, ts.tokenStartOfNode(n)).matchAll(/\/\*\*[\s\S]*?\*\//g))
      if (!m[0].includes(MARK)) text += m[0];
    const p: ts.Node | undefined = n.parent;
    if (
      p === undefined ||
      !(
        ts.isVariableDeclaration(p) ||
        ts.isVariableDeclarationList(p) ||
        ts.isVariableStatement(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isParenthesizedExpression(p) ||
        ts.isExpressionStatement(p) ||
        ts.isExportAssignment(p) ||
        (ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.right === n)
      )
    )
      break;
  }
  const params = new Set<string>();
  for (const m of text.matchAll(/@(?:param|arg|argument)\b/g)) {
    let i = m.index + m[0].length;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === "{") {
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}" && --depth === 0) {
          i++;
          break;
        }
      }
    }
    const name = /^\s*\[?\s*([A-Za-z_$][\w$]*)/.exec(text.slice(i));
    if (name !== null) params.add(name[1]!);
  }
  return {
    params,
    returns: /@returns?\b/.test(text),
    type: /@type\b/.test(text),
    whole: /@(?:type|template|this|overload|callback)\b/.test(text),
  };
}

/** Whether the declaration's own leading trivia holds a `@type` JSDoc that
 * is not the overlay's. A statement-level tag belongs to the statement's
 * first declarator only, so later declarators of a list are asked about
 * their trivia alone. */
function declTypeDoc(decl: ts.VariableDeclaration, sf: ts.SourceFile): boolean {
  const text = sf.text.slice(decl.pos, ts.tokenStartOfNode(decl));
  for (const m of text.matchAll(/\/\*\*[\s\S]*?\*\//g))
    if (!m[0].includes(MARK) && /@type\b/.test(m[0])) return true;
  return false;
}

/** A comment range's JSDoc type tags made plain text (the range is
 * trivia, so it holds no literal). The overlay's own comments carry MARK
 * and are kept. Lengths are unchanged. */
export function neutralizeCommentTags(text: string): string {
  return text.replace(/\/\*\*[\s\S]*?\*\//g, (comment) => {
    if (comment.includes(MARK)) return comment;
    return comment.replace(
      /@(param|type|typedef|returns?|template|this|callback|property|prop|arg|argument|enum|implements|extends|augments|satisfies|overload|import)\b/g,
      "-$1",
    );
  });
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

/** The `typeof` results the values can have. */
function typeofResults(values: ReadonlySet<Atom>): Set<string> {
  const out = new Set<string>();
  for (const a of values) {
    if (a.kind === "prim")
      out.add(a.label === "null" ? "object" : a.label === "symbol" ? "symbol" : a.label);
    else if (a.kind === "function" || a.kind === "class") out.add("function");
    else out.add("object");
  }
  return out;
}

/** Whether the function's body compares `typeof name` with a result the
 * values never have. */
function typeofTestsOutside(
  fn: ts.FunctionLikeDeclaration,
  name: string,
  values: ReadonlySet<Atom>,
): boolean {
  const results = typeofResults(values);
  let outside = false;
  const visit = (n: ts.Node): void => {
    if (outside) return;
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        n.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
    ) {
      for (const [op, lit] of [
        [n.left, n.right],
        [n.right, n.left],
      ] as const)
        if (
          ts.isTypeOfExpression(op) &&
          ts.isIdentifier(op.expression) &&
          op.expression.text === name &&
          ts.isStringLiteral(lit) &&
          !results.has(lit.text)
        )
          outside = true;
    }
    ts.forEachChild(n, (c) => {
      visit(c);
      return undefined;
    });
  };
  if (fn.body !== undefined) visit(fn.body);
  return outside;
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
