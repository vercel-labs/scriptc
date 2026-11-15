/* SCRIPTC_DYNAMIC_CLASSES=<name>[,<name>...]: whether the program makes
 * instances of the named classes dynamic values, and where.
 *
 * A class whose instances reach untyped code is compiled twice over: its
 * typed layout, and the keyed tables, checked casts and converters through
 * which untyped code reads it, for the class and for every class its fields
 * reach. In a typed program that is the cost of one conversion. The
 * compiler's own source paid it for its Lowerer three times in five days
 * (6% of the functions of its own build each time), through a helper whose
 * parameter was an interface the Lowerer satisfies, and nothing reported
 * it. scripts/self-compile-budget.mjs names the classes that must stay
 * typed in the compiler's own build and reads this report.
 *
 * The report is one line of standard error per site,
 *
 *   scriptc dynamic-class {"name":…,"class":…,"kind":…,"function":…,"file":…,"line":…,"column":…,"text":…}
 *
 * and one line that closes the report of a lowering pass and says the
 * pass was read:
 *
 *   scriptc dynamic-classes {"names":[…],"sites":N}
 *
 * A program that lowers more than once reports once per pass; the last
 * report is the program's. The kinds:
 *
 * - "dynamic": a value whose type is the class, or holds it, is made a
 *   dynamic value there (`through` spells the type when it is not the class
 *   itself). The types a value takes across with it are the ones the class
 *   dispatch pass follows (ClassDynamicDispatch.process, `discover`): an
 *   array's elements, a record's fields and index values, a union's arms, a
 *   function's result, a promise's value.
 * - "argument": a dynamic function is checked into a function type there,
 *   one of whose parameters is the class or holds it: the function receives
 *   the instance as a dynamic value.
 * - "cast": a dynamic value is checked into the class there.
 * - "boxed": the class dispatch pass counts the class among those whose
 *   instances are dynamic values, and none of the sites above explains it
 *   (a site form this file does not list). No position.
 *
 * The class dispatch pass's own helpers (`%dyn.class.…`: the keyed tables
 * and member dispatch of untyped code) check and box an instance of every
 * class that is a dynamic value, and a method value's receiver helper
 * (`%method.receiver:C`) checks the receiver it was called with into the
 * class. Those are what a site costs, not sites, and each helper is placed
 * at the first program site that uses it, so their bodies are not read. */
import {
  isDynTypedRefType,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import { everyStmtList } from "../../ir/traverse.js";
import * as ts from "../ts7/adapter.js";
import { CHECKED_CAST_PREFIX, DISPATCH_HELPER_PREFIX } from "./class-dynamic-dispatch.js";
import { METHOD_RECEIVER_PREFIX } from "./class-method-values.js";
import type { Lowerer } from "./lowerer.js";

/** The class names SCRIPTC_DYNAMIC_CLASSES asks about: empty when unset. */
export function watchedDynamicClasses(): string[] {
  return (process.env["SCRIPTC_DYNAMIC_CLASSES"] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

export interface DynamicClassSite {
  /** The watched name and the class's name in the IR. */
  name: string;
  class: string;
  kind: "dynamic" | "argument" | "cast" | "boxed";
  /** The function whose body holds the site. */
  function?: string;
  loc?: SrcLoc;
  /** The type that holds the class, when the site's value is not the class
   * itself. */
  through?: string;
}

/** What the report reads of a lowering. */
export interface DynamicClassHost {
  /** The watched name a class of the IR answers to, or null: its
   * declaration's name, whatever file or namespace declares it. */
  watched(className: string): string | null;
  /** A record's field and index value types, and a union's arms. */
  recordParts(shapeId: string): readonly IrType[];
  unionArms(unionId: string): readonly IrType[];
  fmt(type: IrType): string;
}

/** The sites of `functions` that make an instance of a watched class a
 * dynamic value, in the order the walk meets them, each place once per
 * class and kind. */
export function dynamicClassSites(
  functions: readonly IrFunction[],
  host: DynamicClassHost,
): DynamicClassSite[] {
  /** The watched classes a value of the type carries, by the type's key:
   * the IR names, in the order `discover` reaches them. */
  const carried = new Map<string, readonly string[]>();
  const carries = (type: IrType): readonly string[] => {
    const key = typeKey(type);
    const known = carried.get(key);
    if (known !== undefined) return known;
    // A recursive type meets itself with nothing more to add.
    carried.set(key, []);
    const found: string[] = [];
    const add = (part: IrType): void => {
      for (const name of carries(part)) if (!found.includes(name)) found.push(name);
    };
    if (type.kind === "object") {
      if (isDynTypedRefType(type) && host.watched(type.className) !== null)
        found.push(type.className);
    } else if (type.kind === "array") add(type.elem);
    else if (type.kind === "record") host.recordParts(type.shapeId).forEach(add);
    else if (type.kind === "union") host.unionArms(type.unionId).forEach(add);
    else if (type.kind === "func") add(type.ret);
    else if (type.kind === "promise") add(type.inner);
    carried.set(key, found);
    return found;
  };

  const sites: DynamicClassSite[] = [];
  const seen = new Set<string>();
  const site = (
    kind: DynamicClassSite["kind"],
    className: string,
    fn: IrFunction,
    loc: SrcLoc,
    type: IrType | null,
  ): void => {
    const key = `${kind}\0${className}\0${loc.file}\0${loc.start}\0${loc.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    sites.push({
      name: host.watched(className)!,
      class: className,
      kind,
      function: fn.name,
      loc,
      ...(type === null || (type.kind === "object" && type.className === className)
        ? {}
        : { through: host.fmt(type) }),
    });
  };
  for (const fn of functions) {
    if (fn.name.startsWith(DISPATCH_HELPER_PREFIX) || fn.name.startsWith(METHOD_RECEIVER_PREFIX))
      continue;
    everyStmtList(fn.body, {
      stmt: () => true,
      expr: (expr: IrExpr) => {
        if (expr.kind === "dynFrom") {
          for (const name of carries(expr.value.type))
            site("dynamic", name, fn, expr.loc, expr.value.type);
        } else if (expr.kind === "dynCheck") {
          const type = expr.type;
          if (type.kind === "func") {
            for (const param of type.params)
              for (const name of carries(param)) site("argument", name, fn, expr.loc, param);
          } else if (isDynTypedRefType(type) && host.watched(type.className) !== null)
            site("cast", type.className, fn, expr.loc, null);
        } else if (expr.kind === "call" && expr.callee.startsWith(CHECKED_CAST_PREFIX)) {
          const className = expr.callee.slice(CHECKED_CAST_PREFIX.length);
          if (host.watched(className) !== null) site("cast", className, fn, expr.loc, null);
        }
        return true;
      },
    });
  }
  return sites;
}

/** Writes the report of one lowering pass (the file's head) for the
 * classes named `names`. `boxed` are the classes the class dispatch pass
 * counts as dynamic values, when the pass ran. */
export function reportDynamicClasses(
  lowerer: Lowerer,
  functions: readonly IrFunction[],
  boxed: ReadonlySet<string> | undefined,
  names: readonly string[],
  write: (line: string) => void = (line) => process.stderr.write(line),
): void {
  const watched = (className: string): string | null => {
    const declared = lowerer.classes.get(className)?.decl?.name?.text;
    return declared !== undefined && names.includes(declared) ? declared : null;
  };
  const sites = dynamicClassSites(functions, {
    watched,
    recordParts: (shapeId) => {
      const shape = lowerer.shapes.get(shapeId);
      if (shape === undefined) return [];
      const parts = shape.fields.map((field) => field.type);
      if (shape.indexValue !== undefined) parts.push(shape.indexValue);
      return parts;
    },
    unionArms: (unionId) => lowerer.unions.get(unionId)?.arms ?? [],
    fmt: (type) => lowerer.fmt(type),
  });
  // A class the dispatch pass boxed, or a subclass of one (an instance of
  // the subclass is a value of the boxed class), with no site of its own.
  const explained = new Set(sites.map((found) => found.class));
  for (const className of lowerer.classes.keys()) {
    const name = watched(className);
    if (name === null || explained.has(className) || boxed === undefined) continue;
    const dynamic =
      boxed.has(className) ||
      [...boxed].some((other) => other !== className && lowerer.isSubclassOf(className, other));
    if (dynamic) sites.push({ name, class: className, kind: "boxed" });
  }
  const sources = new Map<string, ts.SourceFile | null>();
  const sourceOf = (file: string): ts.SourceFile | null => {
    let source = sources.get(file);
    if (source === undefined) {
      source = lowerer.moduleOrder.find((candidate) => candidate.fileName === file) ?? null;
      sources.set(file, source);
    }
    return source;
  };
  for (const found of sites) {
    const at = found.loc === undefined ? null : placeOf(sourceOf(found.loc.file), found.loc);
    write(
      `scriptc dynamic-class ${JSON.stringify({
        name: found.name,
        class: found.class,
        kind: found.kind,
        ...(found.function === undefined ? {} : { function: found.function }),
        ...(found.loc === undefined ? {} : { file: found.loc.file }),
        ...(at === null ? {} : { line: at.line, column: at.column, text: at.text }),
        ...(found.through === undefined ? {} : { through: found.through }),
      })}\n`,
    );
  }
  write(`scriptc dynamic-classes ${JSON.stringify({ names, sites: sites.length })}\n`);
}

/** The line and column of `loc` in its file, and the text of that line. */
function placeOf(
  source: ts.SourceFile | null,
  loc: SrcLoc,
): { line: number; column: number; text: string } | null {
  if (source === null) return null;
  const at = ts.getLineAndCharacterOfPosition(source, loc.start);
  const text = source.text;
  const from = text.lastIndexOf("\n", loc.start - 1) + 1;
  const to = text.indexOf("\n", loc.start);
  return {
    line: at.line + 1,
    column: at.character + 1,
    text: text
      .slice(from, to < 0 ? text.length : to)
      .trim()
      .slice(0, 160),
  };
}
