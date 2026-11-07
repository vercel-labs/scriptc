import { BOOL, F64, STRING, typeEquals, VOID } from "./ir.js";
import type { IrExpr, IrFunction, IrLocal, IrModule, IrStmt, IrType, SrcLoc } from "./ir.js";
import { everyStmtList, transformStmtList } from "./traverse.js";

/** A run of rows is built by a loop when it has more rows than one batch of
 * array values holds (the backend stores up to 64 and makes one call): a
 * literal that fits a batch compiles as it always has. */
export const TABLE_MIN_ROWS = 65;

type Constant = number | string | boolean;

/** The value of a number literal, negated forms included, or null. */
function numberLeaf(e: IrExpr): number | null {
  if (e.type.kind !== "f64") return null;
  if (e.kind === "numLit") return e.value;
  if (e.kind === "unary" && e.op === "-" && e.operand.kind === "numLit") return -e.operand.value;
  return null;
}

/** Whether every surrogate of `text` is half of a pair. A lone surrogate
 * makes the module tell the runtime that one exists, which the backend
 * decides from the literals it interns, so such a string stays a literal. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit > 0xdbff || i + 1 === text.length) return false;
    const next = text.charCodeAt(i + 1);
    if (next < 0xdc00 || next > 0xdfff) return false;
    i++;
  }
  return true;
}

/** Appends the constants of a row to `out` in the order `template` meets
 * them, and answers whether the row is built of constants alone: record
 * literals, array literals without spreads and union wraps over numbers,
 * well-formed strings, booleans and unit values. Evaluating such a row runs
 * no user code and reads no binding, so neither the order in which rows are
 * built nor the place its constants come from can be observed. */
function constants(e: IrExpr, out: Constant[]): boolean {
  const number = numberLeaf(e);
  if (number !== null) {
    out.push(number);
    return true;
  }
  switch (e.kind) {
    case "strLit":
      if (e.type.kind !== "string" || !wellFormed(e.value)) return false;
      out.push(e.value);
      return true;
    case "boolLit":
      if (e.type.kind !== "bool") return false;
      out.push(e.value);
      return true;
    case "unitLit":
      return true;
    case "unionWrap":
      return constants(e.value, out);
    case "arrayLit":
      if (e.spreads !== undefined && e.spreads.length > 0) return false;
      for (const elem of e.elems) if (!constants(elem, out)) return false;
      return true;
    case "recordLit":
      for (const field of e.fields) if (!constants(field.value, out)) return false;
      return true;
    default:
      return false;
  }
}

/** Whether two rows of constants are the same expression apart from the
 * values of their numbers, strings and booleans: the same nodes with equal
 * types, field names, tags and lengths. One row's expression, with the other
 * row's constants in place of its own, then evaluates to the other row. */
function sameSkeleton(a: IrExpr, b: IrExpr): boolean {
  if (!typeEquals(a.type, b.type)) return false;
  if (numberLeaf(a) !== null) return numberLeaf(b) !== null;
  switch (a.kind) {
    case "strLit":
      return b.kind === "strLit";
    case "boolLit":
      return b.kind === "boolLit";
    case "unitLit":
      return b.kind === "unitLit" && a.unit === b.unit;
    case "unionWrap":
      return (
        b.kind === "unionWrap" &&
        a.unionId === b.unionId &&
        a.tag === b.tag &&
        sameSkeleton(a.value, b.value)
      );
    case "arrayLit": {
      if (b.kind !== "arrayLit" || a.elems.length !== b.elems.length) return false;
      if (a.capacity !== b.capacity) return false;
      for (let i = 0; i < a.elems.length; i++)
        if (!sameSkeleton(a.elems[i]!, b.elems[i]!)) return false;
      return true;
    }
    case "recordLit": {
      if (b.kind !== "recordLit" || a.fields.length !== b.fields.length) return false;
      if (a.nullProto !== b.nullProto) return false;
      for (let i = 0; i < a.fields.length; i++) {
        const left = a.fields[i]!;
        const right = b.fields[i]!;
        if (left.name !== right.name || left.overflow !== right.overflow) return false;
        if (!sameSkeleton(left.value, right.value)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/** `row` with each constant that differs between the rows of its run read
 * from that constant's column at `index`. `columns[c]` holds constant `c` of
 * every row, or null when all rows agree on it; `next` counts the constants
 * met so far, in the order `constants` appends them. */
function template(
  row: IrExpr,
  columns: readonly (Constant[] | null)[],
  next: { at: number },
  index: () => IrExpr,
): IrExpr {
  if (numberLeaf(row) !== null || row.kind === "strLit" || row.kind === "boolLit") {
    const values = columns[next.at++]!;
    if (values === null) return row;
    const loc = row.loc;
    if (row.kind === "strLit")
      return {
        kind: "constCell",
        strings: values as string[],
        index: index(),
        type: row.type,
        loc,
      };
    if (row.kind !== "boolLit")
      return {
        kind: "constCell",
        numbers: values as number[],
        index: index(),
        type: row.type,
        loc,
      };
    // A boolean column holds 1 for true: the cell is that number's test.
    const numbers = (values as boolean[]).map((value) => (value ? 1 : 0));
    return {
      kind: "bin",
      op: "!==",
      left: { kind: "constCell", numbers, index: index(), type: F64, loc },
      right: { kind: "numLit", value: 0, type: F64, loc },
      type: row.type,
      loc,
    };
  }
  switch (row.kind) {
    case "unionWrap":
      return { ...row, value: template(row.value, columns, next, index) };
    case "arrayLit":
      return { ...row, elems: row.elems.map((elem) => template(elem, columns, next, index)) };
    case "recordLit":
      return {
        ...row,
        fields: row.fields.map((field) => ({
          ...field,
          value: template(field.value, columns, next, index),
        })),
      };
    default:
      return row;
  }
}

/** One item of a literal as the expressions that build it: an array
 * element, a Map entry's key and value, or an index-signature field's name
 * and value. */
type Item = readonly IrExpr[];

interface Run {
  start: number;
  end: number;
  /** The constants of each item of the run, in the order `template` meets
   * them. */
  rows: Constant[][];
}

/** The runs of `items` a loop builds: `[start, end)` ranges of at least
 * TABLE_MIN_ROWS consecutive items of constants with one skeleton. An item
 * `rolls` refuses never joins a run. */
function runs(items: readonly Item[], rolls: (item: Item) => boolean): Run[] {
  const found: Run[] = [];
  const constantsOf = (item: Item, out: Constant[]): boolean =>
    rolls(item) && item.every((part) => constants(part, out));
  let start = 0;
  while (start + TABLE_MIN_ROWS <= items.length) {
    const first = items[start]!;
    const rows: Constant[][] = [[]];
    if (!constantsOf(first, rows[0]!)) {
      start++;
      continue;
    }
    let end = start + 1;
    for (; end < items.length; end++) {
      const item = items[end]!;
      const row: Constant[] = [];
      if (!item.every((part, i) => sameSkeleton(first[i]!, part)) || !constantsOf(item, row)) break;
      rows.push(row);
    }
    if (end - start >= TABLE_MIN_ROWS) found.push({ start, end, rows });
    start = end;
  }
  return found;
}

/** A literal the pass can build in pieces. */
interface Table {
  literal: IrExpr;
  items: Item[];
  rolls: (item: Item) => boolean;
  /** The literal with only its first `count` items; it reserves what the
   * whole literal reserves. */
  first: (count: number) => IrExpr;
  /** Statements that add `items`, in order, to the value `ref` reads. */
  add: (ref: () => IrExpr, items: readonly Item[]) => IrStmt[];
}

/** The literal `e` as a table when it is long enough to hold a run:
 *
 * - an array literal without spreads. A bare number never joins a run: the
 *   backend appends a run of number literals from the image in one call.
 *   Elements outside the runs are appended a batch at a time, because a
 *   `push` evaluates all its arguments before it appends any;
 * - a seeded Map. The seeds are `set` in source order, which is what the
 *   literal does with them;
 * - a record literal that ends in index-signature entries. Those insert
 *   into the record's overflow map in source order, like a keyed write of a
 *   name that is no declared field; a declared field never joins a run and
 *   must precede the first one (the callers check). */
function tableOf(e: IrExpr): Table | null {
  const loc = e.loc;
  if (e.kind === "arrayLit") {
    if (e.elems.length < TABLE_MIN_ROWS || (e.spreads?.length ?? 0) > 0) return null;
    if (e.type.kind !== "array") return null;
    const push = (ref: () => IrExpr, values: IrExpr[]): IrStmt => ({
      kind: "exprStmt",
      expr: { kind: "arrIntrinsic", method: "push", receiver: ref(), args: values, type: F64, loc },
      loc,
    });
    return {
      literal: e,
      items: e.elems.map((elem) => [elem]),
      rolls: (item) => numberLeaf(item[0]!) === null,
      first: (count) => ({ ...e, elems: e.elems.slice(0, count), capacity: e.elems.length }),
      add: (ref, items) => {
        const stmts: IrStmt[] = [];
        const batch = TABLE_MIN_ROWS - 1;
        for (let i = 0; i < items.length; i += batch)
          stmts.push(
            push(
              ref,
              items.slice(i, i + batch).map((item) => item[0]!),
            ),
          );
        return stmts;
      },
    };
  }
  if (e.kind === "mapNew") {
    const seed = e.seed;
    if (seed === undefined || seed.length < TABLE_MIN_ROWS || e.type.kind !== "map") return null;
    return {
      literal: e,
      items: seed.map((pair) => [pair.key, pair.value]),
      rolls: () => true,
      first: (count) => ({ ...e, seed: seed.slice(0, count) }),
      add: (ref, items) =>
        items.map((item) => ({
          kind: "exprStmt",
          expr: {
            kind: "mapIntrinsic",
            method: "set",
            receiver: ref(),
            args: [item[0]!, item[1]!],
            type: VOID,
            loc,
          },
          loc,
        })),
    };
  }
  if (e.kind === "recordLit") {
    const type = e.type;
    if (e.fields.length < TABLE_MIN_ROWS || type.kind !== "record") return null;
    // A field's name is its item's first expression, so that names are a
    // column like any other constant. A declared field is marked by an
    // empty item, which no run admits.
    const items = e.fields.map((field): Item =>
      field.overflow === true
        ? [{ kind: "strLit", value: field.name, type: STRING, loc }, field.value]
        : [],
    );
    return {
      literal: e,
      items,
      rolls: (item) => item.length === 2,
      first: (count) => ({ ...e, fields: e.fields.slice(0, count) }),
      add: (ref, added) =>
        added.map((item) => ({
          kind: "recordKeySet",
          obj: ref(),
          shapeId: type.shapeId,
          key: item[0]!,
          value: item[1]!,
          overflowOnly: true,
          loc,
        })),
    };
  }
  return null;
}

/** Builds the rows of large literals in loops over constants in the program
 * image.
 *
 * A literal evaluates one expression per element. When thousands of
 * consecutive elements are the same expression apart from the numbers,
 * strings and booleans in it (the rows of a lookup table), the initializer
 * that evaluates them one by one is a function whose size, and whose compile
 * time and memory in the code generator, grow with the table. This pass
 * evaluates such a run in a counted loop instead: the row expression once,
 * with each constant that differs between rows read from a column of
 * constants (`constCell`), and the result added to the table. It does so
 * for the elements of an array literal, the seeds of a Map and the
 * index-signature entries of a record literal.
 *
 * The table and its rows are the values the literal built before: the same
 * constructors run for every row, in the same order, on the same constants,
 * and every row is a fresh object. A row of constants runs no user code and
 * reads no binding, so there is no evaluation order to change. Rows that are
 * not constants, or that differ in shape from their neighbours, are added
 * one by one in their places, as are runs shorter than TABLE_MIN_ROWS. */
export function rollLiteralTables(mod: IrModule): IrModule {
  let changed = false;
  const functions = mod.functions.map((fn) => {
    const rolled = rollFunction(fn);
    if (rolled !== fn) changed = true;
    return rolled;
  });
  return changed ? { ...mod, functions } : mod;
}

function rollFunction(fn: IrFunction): IrFunction {
  // Most functions hold no literal of that length: look before rebuilding.
  const none = everyStmtList(fn.body, { stmt: () => true, expr: (e) => tableOf(e) === null });
  if (none) return fn;
  const used = new Set(fn.locals.map((local) => local.id));
  const locals: IrLocal[] = [];
  let serial = 0;
  const local = (name: string, type: IrType, mutable: boolean): string => {
    let id = `${name}.${serial}`;
    while (used.has(id)) id = `${name}.${++serial}`;
    used.add(id);
    locals.push({ id, name, type, mutable });
    return id;
  };
  let rolledAny = false;
  const body = transformStmtList(fn.body, {
    stmt: (s) => s,
    expr: (e) => {
      const table = tableOf(e);
      if (table === null) return e;
      const found = runs(table.items, table.rolls);
      if (found.length === 0) return e;
      // Every item from the first run on is added by a statement, which a
      // declared record field cannot be.
      if (table.items.slice(found[0]!.start).some((item) => item.length === 0)) return e;
      rolledAny = true;
      serial++;
      return rollTable(table, found, local);
    },
  });
  if (!rolledAny) return fn;
  return { ...fn, locals: [...fn.locals, ...locals], body };
}

function rollTable(
  table: Table,
  found: readonly Run[],
  local: (name: string, type: IrType, mutable: boolean) => string,
): IrExpr {
  const e = table.literal;
  const loc: SrcLoc = e.loc;
  const id = local("%table", e.type, false);
  const ref = (): IrExpr => ({ kind: "varRef", localId: id, type: e.type, loc });
  const number = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
  // The items before the first run stay in the literal.
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: id, init: table.first(found[0]!.start), loc },
  ];
  let at = found[0]!.start;
  for (const run of found) {
    stmts.push(...table.add(ref, table.items.slice(at, run.start)));
    const count = run.end - run.start;
    const width = run.rows[0]!.length;
    const columns: (Constant[] | null)[] = [];
    for (let c = 0; c < width; c++) {
      const first = run.rows[0]![c]!;
      let varies = false;
      // Object.is: 0 and -0 are different constants, and NaN equals itself.
      for (let r = 1; r < count && !varies; r++) varies = !Object.is(run.rows[r]![c]!, first);
      columns.push(varies ? run.rows.map((row) => row[c]!) : null);
    }
    const row = local("%tableRow", F64, true);
    const rowRef = (): IrExpr => ({ kind: "varRef", localId: row, type: F64, loc });
    const next = { at: 0 };
    const built = table.items[run.start]!.map((part) => template(part, columns, next, rowRef));
    // A `while`: the statements an expression may hold have no `for`.
    stmts.push({ kind: "varDecl", localId: row, init: number(0), loc });
    stmts.push({
      kind: "while",
      cond: { kind: "bin", op: "<", left: rowRef(), right: number(count), type: BOOL, loc },
      body: [
        ...table.add(ref, [built]),
        {
          kind: "assign",
          localId: row,
          value: { kind: "bin", op: "+", left: rowRef(), right: number(1), type: F64, loc },
          loc,
        },
      ],
      loc,
    });
    at = run.end;
  }
  stmts.push(...table.add(ref, table.items.slice(at)));
  return { kind: "seqExpr", stmts, result: ref(), type: e.type, loc };
}
