/* Speculative JSON shapes from zod schemas (the decl-boundary projection's
 * `S.parse(JSON.parse(text))` sites).
 *
 * When user code parses JSON text straight into a zod 3 schema that is
 * statically visible (a const built from `z.object`, `z.array`, `z.string`,
 * `z.number`, `z.boolean`, `z.enum`, `z.literal`, `.int()`, `.optional()`
 * and `.nullable()`), the projection replaces the call with a generated
 * helper:
 *
 *     __scriptc_zjson_0(S, text)
 *
 * The helper first reads the text as the schema's JSON shape through the
 * checked `JSON.parse(text) as T` route (the one-pass schema parser, with
 * the checked-dynamic conversion behind it). On any input that route
 * rejects (a syntax error, a wrong type, a missing member) it catches the
 * error and runs the original `S.parse(JSON.parse(text))`, so every failure,
 * and every value zod would read differently, is zod's own. On success it
 * applies the checks the shape cannot express (integers, enum members,
 * literals) and builds the output zod would build: a fresh object per
 * `z.object` with the schema's keys in schema order (unknown keys
 * stripped, absent optional keys omitted) and a fresh array per `z.array`.
 * A failed check also falls back to zod. Nothing throws because of the data
 * unless zod throws.
 *
 * The rewrite is sound only while nothing can change what zod does for the
 * schema: the schema consts are referenced only as `.parse` receivers,
 * inside other recognized schemas, or in type queries, and no source
 * outside zod writes the zod members the fast path bypasses. */

import * as ts from "./ts7/adapter.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Schema =
  | { readonly k: "string" }
  | { readonly k: "number"; readonly int: boolean }
  | { readonly k: "boolean" }
  | { readonly k: "enum"; readonly values: readonly string[] }
  | { readonly k: "literal"; readonly value: string | number | boolean }
  | { readonly k: "array"; readonly el: Schema }
  | { readonly k: "object"; readonly fields: readonly Field[] }
  | { readonly k: "nullable"; readonly inner: Schema }
  | { readonly k: "optional"; readonly inner: Schema };

interface Field {
  readonly name: string;
  readonly schema: Schema;
}

export interface ZodJsonEdit {
  start: number;
  end: number;
  text: string;
}

export interface ZodJsonSite {
  readonly edits: ZodJsonEdit[];
  readonly helper: string;
}

/** Keys an `in` test or a member read finds on Object.prototype: zod reads
 * them through the prototype, the shape would not. */
const PROTOTYPE_KEYS = new Set([
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/** zod members the fast path stands in for; a write to any of them outside
 * zod could change what zod does. */
const BYPASSED_MEMBERS: ReadonlySet<string> = new Set([
  "parse",
  "safeParse",
  "_parse",
  "_parseSync",
  "_def",
  "shape",
  "_cached",
  "_getCached",
  "_getType",
  "_getOrReturnCtx",
  "_processInputParams",
]);

export class ZodJsonPlanner {
  private readonly checker: ts.TypeChecker;
  private schemaSymbols = new Set<ts.Symbol>();
  private guardOk: boolean | null = null;
  private references: Map<ts.Symbol, ts.Identifier[]> | null = null;
  private zodVersionOk = new Map<string, boolean>();
  private count = 0;

  constructor(
    private readonly declProgram: ts.Program,
    private readonly jsProgram: ts.Program,
    private readonly userFiles: readonly string[],
  ) {
    this.checker = declProgram.getTypeChecker();
  }

  /** The rewrite of a `S.parse(JSON.parse(text))` call (declaration-world
   * node) whose declared type projects to `alias`, or null. */
  plan(
    call: ts.Node,
    alias: string,
    newlinesIn: (start: number, end: number) => string,
  ): ZodJsonSite | null {
    if (process.env["SCRIPTC_ZOD_JSON"] === "0") return this.decline(1);
    if (!ts.isCallExpression(call) || call.arguments.nodes.length !== 1) return this.decline(2);
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.name))
      return this.decline(3);
    if (callee.name.text !== "parse" || !ts.isIdentifier(callee.expression)) return this.decline(4);
    const inner = call.arguments.nodes[0]!;
    if (!ts.isCallExpression(inner) || inner.arguments.nodes.length !== 1) return this.decline(5);
    if (!this.isGlobalJsonParse(inner.expression)) return this.decline(6);
    const text = inner.arguments.nodes[0]!;
    if (ts.isSpreadElement(text) || !this.isString(text)) return this.decline(7);
    if (!this.isZodMethod(callee.name)) return this.decline(8);
    const receiver = callee.expression;
    const sym = this.symbolOf(receiver);
    if (sym === undefined || !this.moduleLevelConst(sym, receiver)) return this.decline(9);
    this.schemaSymbols = new Set();
    const schema = this.schemaOf(receiver, new Set());
    if (schema === null || (schema.k !== "object" && schema.k !== "array")) return this.decline(10);
    if (!this.guards()) return this.decline(11);
    for (const s of this.schemaSymbols) if (!this.referencedOnlyAsSchema(s)) return null;
    const n = this.count++;
    const prefix = `__scriptc_zjson_${n}`;
    const helper = new HelperWriter(prefix, alias).write(schema, receiver.text);
    const start = ts.tokenStartOfNode(call);
    const textStart = ts.tokenStartOfNode(text);
    return {
      edits: [
        {
          start,
          end: textStart,
          text: `${prefix}(${receiver.text}, ${newlinesIn(start, textStart)}`,
        },
        { start: text.end, end: call.end, text: `)${newlinesIn(text.end, call.end)}` },
      ],
      helper,
    };
  }

  private decline(step: number): null {
    if (process.env["SCRIPTC_DEBUG_ZOD_JSON"] !== undefined)
      process.stderr.write(`[zod-json] declined at check ${step}\n`);
    return null;
  }

  private symbolOf(node: ts.Node): ts.Symbol | undefined {
    let s: ts.Symbol | undefined;
    try {
      s = this.checker.getSymbolAtLocation(node);
      if (s !== undefined && s.flags & ts.SymbolFlags.Alias) s = this.checker.getAliasedSymbol(s);
    } catch {
      return undefined;
    }
    return s;
  }

  private isString(node: ts.Node): boolean {
    try {
      const t = this.checker.getTypeAtLocation(node);
      return (t.flags & ts.TypeFlags.String) !== 0;
    } catch {
      return false;
    }
  }

  private isGlobalJsonParse(e: ts.Expression): boolean {
    if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.expression)) return false;
    if (e.expression.text !== "JSON" || !ts.isIdentifier(e.name) || e.name.text !== "parse")
      return false;
    // The global JSON: declared only in declaration files (the standard
    // library, and ambient augmentations such as @types/node's).
    const s = this.symbolOf(e.expression);
    return (
      s !== undefined &&
      s.declarations.length > 0 &&
      s.declarations.every((d) => ts.getSourceFileOfNode(d).isDeclarationFile)
    );
  }

  /** Whether a member name resolves to a declaration in zod 3's package. */
  private isZodMethod(name: ts.Node): boolean {
    const s = this.symbolOf(name);
    return (
      s !== undefined && s.declarations.length > 0 && s.declarations.every((d) => this.inZod3(d))
    );
  }

  private inZod3(node: ts.Node): boolean {
    const file = ts.getSourceFileOfNode(node).fileName.split("\\").join("/");
    const at = file.lastIndexOf("/node_modules/zod/");
    if (at < 0) return false;
    const root = file.slice(0, at + "/node_modules/zod".length);
    let ok = this.zodVersionOk.get(root);
    if (ok === undefined) {
      ok = false;
      try {
        const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        ok = pkg.name === "zod" && typeof pkg.version === "string" && pkg.version.startsWith("3.");
      } catch {
        ok = false;
      }
      // zod 3.25 also ships v4 under `zod/v4`: only the v3 entry qualifies.
      if (ok && /\/node_modules\/zod\/(?:dist\/[^/]+\/)?v4(?:\/|$)/.test(file)) ok = false;
      this.zodVersionOk.set(root, ok);
    }
    return ok && !/\/node_modules\/zod\/(?:dist\/[^/]+\/)?v4(?:\/|\.)/.test(file);
  }

  /** `z` (a namespace or named import of zod 3's `z`). */
  private isZodNamespace(e: ts.Expression): boolean {
    if (!ts.isIdentifier(e)) return false;
    const s = this.symbolOf(e);
    return (
      s !== undefined && s.declarations.length > 0 && s.declarations.every((d) => this.inZod3(d))
    );
  }

  private moduleLevelConst(sym: ts.Symbol, use: ts.Node): ts.VariableDeclaration | null {
    if (sym.declarations.length !== 1) return null;
    const d = sym.declarations[0]!;
    if (!ts.isVariableDeclaration(d) || d.initializer === undefined || !ts.isIdentifier(d.name))
      return null;
    const list = d.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return null;
    const stmt = list.parent;
    if (stmt === undefined || !ts.isVariableStatement(stmt) || !ts.isSourceFile(stmt.parent))
      return null;
    // The helper names the const from the end of the call's file.
    if (ts.getSourceFileOfNode(d) !== ts.getSourceFileOfNode(use)) return null;
    if (!this.userFiles.includes(ts.getSourceFileOfNode(d).fileName)) return null;
    return d;
  }

  private schemaOf(e: ts.Expression, visiting: Set<ts.Symbol>): Schema | null {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isIdentifier(e)) {
      const s = this.symbolOf(e);
      if (s === undefined || visiting.has(s) || s.declarations.length !== 1) return null;
      const d = s.declarations[0]!;
      if (!ts.isVariableDeclaration(d) || d.initializer === undefined || d.type !== undefined)
        return null;
      const list = d.parent;
      if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0)
        return null;
      if (!this.userFiles.includes(ts.getSourceFileOfNode(d).fileName)) return null;
      visiting.add(s);
      this.schemaSymbols.add(s);
      const r = this.schemaOf(d.initializer, visiting);
      visiting.delete(s);
      return r;
    }
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return null;
    const callee = e.expression;
    if (!ts.isIdentifier(callee.name)) return null;
    const name = callee.name.text;
    const args = e.arguments.nodes;
    if (args.some((a) => ts.isSpreadElement(a))) return null;
    if (this.isZodNamespace(callee.expression)) {
      switch (name) {
        case "string":
        case "boolean":
          return args.length === 0 ? { k: name } : null;
        case "number":
          return args.length === 0 ? { k: "number", int: false } : null;
        case "array": {
          if (args.length !== 1) return null;
          const el = this.schemaOf(args[0]!, visiting);
          return el === null || el.k === "optional" ? null : { k: "array", el };
        }
        case "enum": {
          if (args.length !== 1 || !ts.isArrayLiteralExpression(args[0]!)) return null;
          const values: string[] = [];
          for (const v of args[0].elements.nodes) {
            if (!ts.isStringLiteral(v)) return null;
            values.push(v.text);
          }
          return values.length > 0 ? { k: "enum", values } : null;
        }
        case "literal": {
          if (args.length !== 1) return null;
          const v = args[0]!;
          if (ts.isStringLiteral(v)) return { k: "literal", value: v.text };
          if (ts.isNumericLiteral(v)) return { k: "literal", value: Number(v.text) };
          if (v.kind === ts.SyntaxKind.TrueKeyword) return { k: "literal", value: true };
          if (v.kind === ts.SyntaxKind.FalseKeyword) return { k: "literal", value: false };
          return null;
        }
        case "object": {
          if (args.length !== 1 || !ts.isObjectLiteralExpression(args[0]!)) return null;
          const fields: Field[] = [];
          for (const p of args[0].properties.nodes) {
            let key: string;
            let value: ts.Expression;
            if (ts.isPropertyAssignment(p)) {
              if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) key = p.name.text;
              else return null;
              value = p.initializer;
            } else if (ts.isShorthandPropertyAssignment(p) && ts.isIdentifier(p.name)) {
              key = p.name.text;
              value = p.name;
            } else return null;
            // Integer-like keys enumerate first in JavaScript; prototype keys
            // read through the prototype in zod.
            if (PROTOTYPE_KEYS.has(key) || /^(0|[1-9]\d*)$/.test(key)) return null;
            if (fields.some((f) => f.name === key)) return null;
            const schema = this.schemaOf(value, visiting);
            if (schema === null) return null;
            fields.push({ name: key, schema });
          }
          return fields.length > 0 ? { k: "object", fields } : null;
        }
        default:
          return null;
      }
    }
    // A method of a recognized schema.
    if (!this.isZodMethod(callee.name)) return null;
    const base = this.schemaOf(callee.expression, visiting);
    if (base === null) return null;
    switch (name) {
      case "int":
        return args.length === 0 && base.k === "number" ? { k: "number", int: true } : null;
      case "optional":
        return args.length === 0 && base.k !== "optional" ? { k: "optional", inner: base } : null;
      case "nullable":
        return args.length === 0 && base.k !== "optional" && base.k !== "nullable"
          ? { k: "nullable", inner: base }
          : null;
      case "array":
        return args.length === 0 && base.k !== "optional" ? { k: "array", el: base } : null;
      default:
        return null;
    }
  }

  /** Program-wide: no source outside zod writes the members the fast path
   * bypasses. User files are checked syntactically; package JavaScript is
   * scanned for prototype writes of those names. */
  private guards(): boolean {
    if (this.guardOk !== null) return this.guardOk;
    let ok = true;
    for (const sf of this.jsProgram.getSourceFiles()) {
      if (!ok) break;
      if (sf.isDeclarationFile) continue;
      const file = sf.fileName.split("\\").join("/");
      if (file.includes("/node_modules/zod/")) continue;
      if (file.includes("/node_modules/")) {
        const text = sf.text;
        const write =
          /\.prototype\s*(?:\.\s*(\w+)|\[\s*["'](\w+)["']\s*\])\s*=(?!=)|defineProperty\(\s*\w+\.prototype\s*,\s*["'](\w+)["']/g;
        for (let m = write.exec(text); m !== null; m = write.exec(text)) {
          const name = m[1] ?? m[2] ?? m[3] ?? "";
          if (BYPASSED_MEMBERS.has(name)) {
            ok = false;
            break;
          }
        }
        if (/\bZod\w*\.prototype\s*[.[]\s*\w*\s*=(?!=)/.test(text)) ok = false;
        continue;
      }
      const visit = (n: ts.Node): void => {
        if (!ok) return;
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
        ) {
          const target = n.left;
          const member = ts.isPropertyAccessExpression(target)
            ? ts.isIdentifier(target.name)
              ? target.name.text
              : ""
            : ts.isElementAccessExpression(target)
              ? ts.isStringLiteral(target.argumentExpression)
                ? target.argumentExpression.text
                : "*"
              : "";
          if (member === "*" || BYPASSED_MEMBERS.has(member)) ok = false;
        }
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          ts.isIdentifier(n.expression.name) &&
          /^(defineProperty|defineProperties|setPrototypeOf|assign)$/.test(
            n.expression.name.text,
          ) &&
          ts.isIdentifier(n.expression.expression) &&
          /^(Object|Reflect)$/.test(n.expression.expression.text)
        ) {
          // Only writes to zod values matter; an argument typed by zod
          // declarations is one.
          for (const a of n.arguments.nodes) if (this.typedByZod(a)) ok = false;
        }
        ts.forEachChild(n, visit);
      };
      if (this.userFiles.includes(sf.fileName)) {
        const declSf = this.declProgram.getSourceFile(sf.fileName);
        if (declSf !== undefined) visit(declSf);
      }
    }
    this.guardOk = ok;
    return ok;
  }

  private typedByZod(node: ts.Node): boolean {
    try {
      const t = this.checker.getTypeAtLocation(node);
      const s = t.getSymbol();
      return s !== undefined && s.declarations.some((d) => this.inZod3(d));
    } catch {
      return true;
    }
  }

  /** Every reference to a schema const is a `.parse` receiver, part of a
   * recognized schema initializer, or a type query. */
  private referencedOnlyAsSchema(sym: ts.Symbol): boolean {
    const refs = this.referenceMap().get(sym) ?? [];
    for (const id of refs) {
      const p = id.parent;
      if (p === undefined) return false;
      if (ts.isVariableDeclaration(p) && p.name === id) continue;
      if (ts.isTypeQueryNode(p)) continue;
      if (ts.isPropertyAccessExpression(p) && p.expression === id) {
        if (!ts.isIdentifier(p.name) || p.name.text !== "parse") return false;
        const call = p.parent;
        if (call === undefined || !ts.isCallExpression(call) || call.expression !== p) return false;
        continue;
      }
      // Inside another schema const's initializer (validated by schemaOf
      // when that schema is used; otherwise the const is itself a schema
      // whose own references are checked when it is).
      if (this.insideSchemaInitializer(id)) continue;
      return false;
    }
    return true;
  }

  private insideSchemaInitializer(id: ts.Node): boolean {
    for (let n: ts.Node | undefined = id.parent; n !== undefined; n = n.parent) {
      if (ts.isVariableDeclaration(n)) {
        const s = this.symbolOf(n.name);
        return s !== undefined && this.schemaSymbols.has(s);
      }
      if (ts.isStatement(n) || ts.isFunctionLike(n)) return false;
    }
    return false;
  }

  private referenceMap(): Map<ts.Symbol, ts.Identifier[]> {
    if (this.references !== null) return this.references;
    const map = new Map<ts.Symbol, ts.Identifier[]>();
    for (const file of this.userFiles) {
      const sf = this.declProgram.getSourceFile(file);
      if (sf === undefined) continue;
      const visit = (n: ts.Node): void => {
        if (ts.isIdentifier(n)) {
          const s = this.symbolOf(n);
          if (s !== undefined) {
            let l = map.get(s);
            if (l === undefined) map.set(s, (l = []));
            l.push(n);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    this.references = map;
    return map;
  }
}

/** Writes one site's helper: the input shape type, a builder per object and
 * array schema, and the entry function. */
class HelperWriter {
  private readonly parts: string[] = [];
  private fns = 0;

  constructor(
    private readonly prefix: string,
    private readonly alias: string,
  ) {}

  write(schema: Schema, schemaName: string): string {
    const entry = this.builder(schema, this.alias);
    const input = inputType(schema);
    this.parts.push(
      `function ${this.prefix}(s: typeof ${schemaName}, text: string): ${this.alias} {` +
        ` let v: ${input} | undefined;` +
        ` try { v = JSON.parse(text) as ${input}; } catch { v = undefined; }` +
        ` if (v !== undefined) { const out = ${entry}(v); if (out !== undefined) return out; }` +
        ` return s.parse(JSON.parse(text)) as ${this.alias}; }`,
    );
    return `\n${this.parts.join("\n")}\n`;
  }

  /** A builder function for an object or array schema: its name. */
  private builder(schema: Schema, out: string): string {
    const name = `${this.prefix}_${this.fns++}`;
    const body: string[] = [];
    if (schema.k === "array") {
      const elOut = `${out}[number]`;
      body.push(`const out: ${out} = [];`, `for (const x of v) {`);
      body.push(...this.checks(schema.el, "x"));
      const value = this.value(schema.el, "x", elOut, body);
      body.push(`out.push(${value}); }`, `return out;`);
    } else if (schema.k === "object") {
      const members: string[] = [];
      for (const f of schema.fields) {
        const read = `v[${JSON.stringify(f.name)}]`;
        const key = JSON.stringify(f.name);
        const fieldOut = `${out}[${key}]`;
        if (f.schema.k === "optional") {
          const inner = f.schema.inner;
          const innerOut = `Exclude<${fieldOut}, undefined>`;
          const checks = this.checks(inner, read);
          if (checks.length > 0) body.push(`if (${read} !== undefined) { ${checks.join(" ")} }`);
          const tmp = `f${members.length}`;
          const value = this.valueOptional(inner, read, innerOut, body, tmp);
          members.push(`...(${read} !== undefined ? { ${key}: ${value} } : {})`);
        } else {
          body.push(...this.checks(f.schema, read));
          members.push(`${key}: ${this.value(f.schema, read, fieldOut, body)}`);
        }
      }
      body.push(`return { ${members.join(", ")} };`);
    } else {
      throw new Error("zod-json: builder of a leaf");
    }
    this.parts.push(
      `function ${name}(v: ${inputType(schema)}): ${out} | undefined { ${body.join(" ")} }`,
    );
    return name;
  }

  /** Statements that return undefined when `read` fails a leaf check. */
  private checks(schema: Schema, read: string): string[] {
    switch (schema.k) {
      case "number":
        return schema.int ? [`if (!Number.isInteger(${read})) return undefined;`] : [];
      case "enum":
        return [
          `if (!(${schema.values.map((v) => `${read} === ${JSON.stringify(v)}`).join(" || ")})) return undefined;`,
        ];
      case "literal":
        return [`if (${read} !== ${JSON.stringify(schema.value)}) return undefined;`];
      case "nullable": {
        const inner = this.checks(schema.inner, read);
        return inner.length > 0 ? [`if (${read} !== null) { ${inner.join(" ")} }`] : [];
      }
      default:
        return [];
    }
  }

  /** The output expression for a checked `read`; composite schemas build
   * through their builder, whose failure returns undefined first. */
  private value(schema: Schema, read: string, out: string, body: string[]): string {
    switch (schema.k) {
      case "array":
      case "object": {
        const fn = this.builder(schema, out);
        const tmp = `b${body.length}`;
        body.push(`const ${tmp} = ${fn}(${read}); if (${tmp} === undefined) return undefined;`);
        return tmp;
      }
      case "nullable": {
        if (schema.inner.k === "array" || schema.inner.k === "object") {
          const fn = this.builder(schema.inner, `Exclude<${out}, null>`);
          const tmp = `b${body.length}`;
          body.push(
            `const ${tmp} = ${read} === null ? null : ${fn}(${read}); if (${tmp} === undefined) return undefined;`,
          );
          return tmp;
        }
        return `${read} as ${out}`;
      }
      default:
        return `${read} as ${out}`;
    }
  }

  private valueOptional(
    schema: Schema,
    read: string,
    out: string,
    body: string[],
    tmp: string,
  ): string {
    if (
      schema.k === "array" ||
      schema.k === "object" ||
      (schema.k === "nullable" && (schema.inner.k === "array" || schema.inner.k === "object"))
    ) {
      const inner = schema.k === "nullable" ? schema.inner : schema;
      const fn = this.builder(inner, schema.k === "nullable" ? `Exclude<${out}, null>` : out);
      const call =
        schema.k === "nullable" ? `(${read} === null ? null : ${fn}(${read}))` : `${fn}(${read})`;
      body.push(
        `const ${tmp} = ${read} === undefined ? undefined : ${call}; if (${read} !== undefined && ${tmp} === undefined) return undefined;`,
      );
      return `${tmp} as ${out}`;
    }
    return `${read} as ${out}`;
  }
}

function inputType(schema: Schema): string {
  switch (schema.k) {
    case "string":
    case "enum":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "literal":
      return typeof schema.value;
    case "array":
      return `Array<${inputType(schema.el)}>`;
    case "nullable":
      return `(${inputType(schema.inner)} | null)`;
    case "optional":
      return inputType(schema.inner);
    case "object":
      return `{ ${schema.fields
        .map((f) =>
          f.schema.k === "optional"
            ? `${JSON.stringify(f.name)}?: ${inputType(f.schema.inner)}`
            : `${JSON.stringify(f.name)}: ${inputType(f.schema)}`,
        )
        .join("; ")} }`;
  }
}
