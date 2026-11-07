/* Node islands: the prototype methods of class instances inside an island.
 *
 * A class instance crosses into an island by reference: a capsule over the
 * native object answers the island's reads of its fields. Its prototype
 * methods live in compiled code, so the island reads them from a table of
 * the instance's own class (name -> the unbound method value).
 *
 * Which table an instance gets cannot depend on how it reached the island.
 * A crossing expression rarely names the class: the instance may be held
 * in a binding typed by the island's interface, in `unknown`, in a member
 * of a record or an array, or come back from a program callback, and a
 * binding typed by a base class holds instances of its subclasses. So the
 * tables are not registered at crossings. The program has one function,
 * from a capsule to the table of the class the object was constructed as,
 * and the runtime asks it when an island first reads a method of an
 * exported instance (scr_node_island_export.c).
 *
 * The function covers every class a checked-dynamic value can hold: the
 * classes the dispatch pass found boxed, and the constructed subclasses of
 * each. That is the set the ordinary dynamic tier dispatches member reads
 * over, and it grows with the pass's waves. A program without island
 * values has no such function. */
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import {
  BOOL,
  DYN,
  STRING,
  VOID,
  funcOf,
  typeKey,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
  type SrcLoc,
} from "../../ir/ir.js";
import type { ClassInfo } from "./lower-classes.js";
import { classMethodsTable } from "./lower-node-island.js";
import type { Lowerer } from "./lowerer.js";

const RESOLVER = "%island.classMethods";

export class IslandClassTables {
  private resolver: IrFunction | null = null;
  /** The capsule classes and the classes under each, as last emitted. */
  private emitted = "[]";
  /** What the class tables looked like when `emitted` was computed. */
  private revision = "";

  /** Brings the resolver up to date with the classes `boxed` names (the
   * capsule classes, in the dispatch pass's fixed order). Called only for
   * a program that holds island values, which already links the island
   * runtime. True when the resolver or a table changed. */
  process(lowerer: Lowerer, boxed: ReadonlySet<string>, loc: SrcLoc): boolean {
    // Classes join `boxed`, the class table and the constructed set, and
    // never leave them.
    const revision = `${boxed.size}:${lowerer.classes.size}:${lowerer.subclassLinks}:${lowerer.constructedClassCount()}`;
    if (revision === this.revision) return false;
    this.revision = revision;
    const depth = (info: ClassInfo): number => {
      let n = 0;
      for (let c = info.base; c; c = c.base) n++;
      return n;
    };
    // Per capsule class: the classes an object under that capsule can have
    // been constructed as, most derived first, so the first match is the
    // object's own class.
    const arms: { capsule: ClassInfo; classes: ClassInfo[] }[] = [];
    for (const name of boxed) {
      const capsule = lowerer.classes.get(name);
      if (!capsule || capsule.def.runtime) continue;
      const classes: ClassInfo[] = [];
      const visit = (info: ClassInfo): void => {
        // No object was constructed as an abstract class.
        if (!info.def.runtime && !info.def.abstract && lowerer.classCanBeConstructed(info))
          classes.push(info);
        for (const child of info.subclasses) visit(child);
      };
      visit(capsule);
      if (classes.length === 0) continue;
      classes.sort(
        (a, b) =>
          depth(b) - depth(a) || (a.def.name < b.def.name ? -1 : a.def.name > b.def.name ? 1 : 0),
      );
      arms.push({ capsule, classes });
    }
    const signature = JSON.stringify(
      arms.map(({ capsule, classes }) => [capsule.def.name, classes.map((info) => info.def.name)]),
    );
    if (signature === this.emitted) return false;
    this.emitted = signature;
    const value = varRef("value", DYN, loc);
    const tableOf = (info: ClassInfo): IrExpr => {
      const table = classMethodsTable(lowerer, info.def.name, loc);
      return table === null
        ? dynUndefinedExpr(loc)
        : { kind: "call", callee: table, args: [], type: DYN, loc };
    };
    const body: IrStmt[] = [];
    for (const { capsule, classes } of arms) {
      const type: IrType = { kind: "object", className: capsule.def.name };
      const then: IrStmt[] = [];
      for (const info of classes) {
        if (info === capsule) continue;
        then.push({
          kind: "if",
          cond: {
            kind: "instanceOf",
            value: { kind: "dynCheck", value, type, loc },
            className: info.def.name,
            type: BOOL,
            loc,
          },
          then: [{ kind: "return", value: tableOf(info), loc }],
          else_: null,
          loc,
        });
      }
      then.push({
        kind: "return",
        value: classes.includes(capsule) ? tableOf(capsule) : dynUndefinedExpr(loc),
        loc,
      });
      body.push({
        kind: "if",
        cond: {
          kind: "libCall",
          fn: "dyn.typedRefIs",
          args: [value, { kind: "strLit", value: typeKey(type), type: STRING, loc }],
          type: BOOL,
          loc,
        },
        then,
        else_: null,
        loc,
      });
    }
    body.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
    if (this.resolver === null) {
      this.resolver = {
        name: RESOLVER,
        params: [{ localId: "value", name: "value", type: DYN }],
        returnType: DYN,
        locals: [{ id: "value", name: "value", type: DYN, mutable: false }],
        body,
        loc,
      };
      lowerer.liftedFns.push(this.resolver);
      lowerer.shareHelper(this.resolver);
      // %main hands the resolver to the runtime before any module runs.
      lowerer.mainPrelude.push({
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "nodeIsland.classTables",
          args: [
            {
              kind: "dynFrom",
              value: {
                kind: "closure",
                fnName: RESOLVER,
                captures: [],
                type: funcOf([DYN], DYN),
                loc,
              },
              type: DYN,
              loc,
            },
          ],
          type: VOID,
          loc,
        },
        loc,
      });
    } else {
      this.resolver.body = body;
    }
    return true;
  }
}
