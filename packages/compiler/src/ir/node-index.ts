/* One walk over a module's function bodies, recorded for analyses that
 * only collect facts from nodes of a few kinds. Each such analysis used to
 * walk every body itself; reading the recorded kind codes instead visits
 * the same nodes in the same order without recursing through the tree. */
import { InternalCompilerError } from "../errors.js";
import type { IrExpr, IrFunction, IrModule, IrStmt, IrType } from "./ir.js";
import { everyStmtList, everyTypeChild } from "./traverse.js";

/** An expression or statement kind. The two sets of kinds are disjoint. */
export type IrNodeKind = IrExpr["kind"] | IrStmt["kind"];

/** The code of a kind no node has: it matches no recorded node. */
const ABSENT = 255;

/** Every expression and statement of each function body of a module, in
 * the order everyStmtList visits them (a node before its children), with
 * a kind code per node and, per function, the set of kinds present.
 *
 * The bodies must not change while the index is in use. Its owner (the
 * LLVM emitter) builds it before its analyses run; no later pass rewrites
 * a recorded body in place, and a rewritten copy of a function is walked. */
export class IrNodeIndex {
  /** Every type object the typed module traversal (everyModuleNode)
   * reaches, nested ones included, each once. */
  readonly types: readonly IrType[];
  private readonly nodes: (IrExpr | IrStmt)[] = [];
  private readonly codes: Uint8Array;
  private readonly kindCodes = new Map<string, number>();
  /** By function object: an analysis may see a rewritten copy of a
   * function under the same name, whose nodes are not recorded here. */
  private readonly functionIndex = new Map<IrFunction, number>();
  /** nodes[starts[i]] .. nodes[starts[i + 1] - 1] belong to function i. */
  private readonly starts: Int32Array;
  /** Per function, eight words of kind-present bits. */
  private readonly present: Uint32Array;
  /** By the kind list (or excluded set) a scan was made from. */
  private readonly scans = new Map<object, IrKindScan>();
  /** By kind code: 1 for statement kinds. */
  private readonly statements = new Uint8Array(256);

  constructor(mod: IrModule) {
    const nodes = this.nodes;
    const types: IrType[] = [];
    const seenTypes = new Set<IrType>();
    // A type object's children never change: one visit covers its tree.
    const addType = (type: IrType): boolean => {
      if (seenTypes.has(type)) return true;
      seenTypes.add(type);
      types.push(type);
      return everyTypeChild(type, addType);
    };
    const statementKinds = new Set<string>();
    const visitor = {
      expr: (node: IrExpr): boolean => {
        nodes.push(node);
        addType(node.type);
        return true;
      },
      stmt: (node: IrStmt): boolean => {
        nodes.push(node);
        statementKinds.add(node.kind);
        return true;
      },
    };
    const functions = mod.functions;
    this.starts = new Int32Array(functions.length + 1);
    for (let f = 0; f < functions.length; f++) {
      this.functionIndex.set(functions[f]!, f);
      this.starts[f] = nodes.length;
      everyStmtList(functions[f]!.body, visitor);
    }
    this.starts[functions.length] = nodes.length;
    // The other type slots everyModuleNode visits.
    for (const fn of functions) {
      for (const param of fn.params) addType(param.type);
      addType(fn.returnType);
      for (const local of fn.locals) addType(local.type);
      for (const capture of fn.captures ?? []) addType(capture.type);
      for (const capture of fn.classCaptures ?? []) addType(capture.type);
      if (fn.generator !== undefined) {
        addType(fn.generator.yieldT);
        addType(fn.generator.nextT);
        addType(fn.generator.resultType);
      }
    }
    for (const cls of mod.classes ?? []) {
      for (const capture of cls.localCaptures ?? []) addType(capture.type);
      for (const field of cls.fields) addType(field.type);
    }
    for (const global of mod.globals ?? []) addType(global.type);
    for (const record of mod.records ?? []) {
      for (const field of record.fields) addType(field.type);
      if (record.indexValue !== undefined) addType(record.indexValue);
    }
    for (const union of mod.unions ?? []) for (const arm of union.arms) addType(arm);
    this.types = types;
    const codes = new Uint8Array(nodes.length);
    const present = new Uint32Array(functions.length * 8);
    let previousKind = "";
    let previousCode = ABSENT;
    for (let f = 0; f < functions.length; f++) {
      const end = this.starts[f + 1]!;
      for (let i = this.starts[f]!; i < end; i++) {
        const kind = nodes[i]!.kind;
        if (kind !== previousKind) {
          let code = this.kindCodes.get(kind);
          if (code === undefined) {
            code = this.kindCodes.size;
            if (code >= ABSENT) throw new InternalCompilerError("more IR node kinds than codes");
            this.kindCodes.set(kind, code);
          }
          previousKind = kind;
          previousCode = code;
        }
        codes[i] = previousCode;
        present[f * 8 + (previousCode >>> 5)]! |= 1 << (previousCode & 31);
      }
    }
    this.codes = codes;
    this.present = present;
    for (const [kind, code] of this.kindCodes)
      if (statementKinds.has(kind)) this.statements[code] = 1;
  }

  /** The positions of the expressions `wanted` in the index, which an
   * index of the same module in another process resolves with
   * expressionsAt. Null when an expression is not recorded, or is recorded
   * more than once. */
  expressionPositions(wanted: ReadonlySet<IrExpr>): number[] | null {
    const positions: number[] = [];
    if (wanted.size === 0) return positions;
    const found = new Set<IrExpr>();
    const { nodes, codes, statements } = this;
    for (let i = 0; i < nodes.length; i++) {
      if (statements[codes[i]!] !== 0) continue;
      const node = nodes[i]! as IrExpr;
      if (!wanted.has(node)) continue;
      if (found.has(node)) return null;
      found.add(node);
      positions.push(i);
    }
    return found.size === wanted.size ? positions : null;
  }

  /** The expressions at `positions` (expressionPositions). */
  expressionsAt(positions: readonly number[]): IrExpr[] {
    return positions.map((position) => {
      const code = this.codes[position];
      if (code === undefined || this.statements[code] !== 0)
        throw new InternalCompilerError(`no IR expression at index position ${position}`);
      return this.nodes[position]! as IrExpr;
    });
  }

  /** A scan for the nodes of `kinds`, for eachNodeOfKinds. Pass a
   * constant list: scans are kept by the list's identity. */
  scan(kinds: readonly IrNodeKind[]): IrKindScan {
    const known = this.scans.get(kinds);
    if (known !== undefined) return known;
    const codes: number[] = [];
    for (const kind of kinds) {
      const code = this.kindCodes.get(kind);
      if (code !== undefined) codes.push(code);
    }
    return this.scanOf(kinds, codes);
  }

  /** A scan for every expression. */
  expressions(): IrKindScan {
    const known = this.scans.get(this.statements);
    if (known !== undefined) return known;
    const codes: number[] = [];
    for (const code of this.kindCodes.values()) if (this.statements[code] === 0) codes.push(code);
    return this.scanOf(this.statements, codes);
  }

  /** A scan for the nodes of every kind but those in `excluded`. Pass a
   * constant set: scans are kept by the set's identity. */
  scanExcept(excluded: ReadonlySet<string>): IrKindScan {
    const known = this.scans.get(excluded);
    if (known !== undefined) return known;
    const codes: number[] = [];
    for (const [kind, code] of this.kindCodes) if (!excluded.has(kind)) codes.push(code);
    return this.scanOf(excluded, codes);
  }

  private scanOf(key: object, codes: readonly number[]): IrKindScan {
    const table = new Uint8Array(256);
    const words = new Uint32Array(8);
    for (const code of codes) {
      table[code] = 1;
      words[code >>> 5]! |= 1 << (code & 31);
    }
    const scan = { index: this, table, words };
    this.scans.set(key, scan);
    return scan;
  }

  /** The number of nodes recorded for `fn`, or undefined when `fn` is not
   * recorded. */
  nodeCount(fn: IrFunction): number | undefined {
    const f = this.functionIndex.get(fn);
    return f === undefined ? undefined : this.starts[f + 1]! - this.starts[f]!;
  }

  /** Calls `note` with each recorded node of `fn` whose kind `scan` names,
   * in walk order, until it answers false. False (nothing called) when
   * `fn` is not recorded. */
  visit(fn: IrFunction, scan: IrKindScan, note: IrNodeNote): boolean {
    const f = this.functionIndex.get(fn);
    if (f === undefined) return false;
    let any = 0;
    for (let w = 0; w < 8; w++) any |= this.present[f * 8 + w]! & scan.words[w]!;
    if (any === 0) return true;
    const { nodes, codes, statements } = this;
    const table = scan.table;
    const end = this.starts[f + 1]!;
    for (let i = this.starts[f]!; i < end; i++) {
      const code = codes[i]!;
      if (table[code] !== 0 && note(nodes[i]!, statements[code] !== 0) === false) break;
    }
    return true;
  }
}

/** Receives a node and whether it is a statement; false stops the visit. */
export type IrNodeNote = (node: IrExpr | IrStmt, statement: boolean) => boolean | void;

/** The kinds one analysis reads, resolved against one index. */
export interface IrKindScan {
  readonly index: IrNodeIndex;
  readonly table: Uint8Array;
  readonly words: Uint32Array;
}

/** Calls `note` for the nodes of `fn` in walk order (everyStmtList's)
 * until it answers false: with `scan`, only those of its kinds, read from
 * the index; without one (or for a function the index did not record),
 * every node, by walking. `note` must ignore the kinds the scan does not
 * name, so both answer the same. */
export function eachNodeOfKinds(
  fn: IrFunction,
  scan: IrKindScan | undefined,
  note: IrNodeNote,
): void {
  if (scan !== undefined && scan.index.visit(fn, scan, note)) return;
  everyStmtList(fn.body, {
    expr: (node) => note(node, false) !== false,
    stmt: (node) => note(node, true) !== false,
  });
}
