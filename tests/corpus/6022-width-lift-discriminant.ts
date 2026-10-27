// A record built in a map callback whose fields width-lift into several
// members of a discriminated union (a nested literal with a narrowed field,
// and a member that only needs `kind` and `loc`): its discriminant selects
// the member.
interface Loc {
  start: number;
}
type Expr =
  | { kind: "get"; obj: Expr; field: string; loc: Loc }
  | { kind: "ref"; name: string; loc: Loc }
  | { kind: "undef"; loc: Loc };
type Stmt =
  | { kind: "set"; obj: Expr; field: string; value: Expr; loc: Loc }
  | { kind: "break"; label?: string; loc: Loc }
  | { kind: "return"; value: Expr | null; loc: Loc };

function showExpr(expr: Expr): string {
  switch (expr.kind) {
    case "get":
      return `${showExpr(expr.obj)}.${expr.field}`;
    case "ref":
      return expr.name;
    case "undef":
      return "undefined";
  }
}

function show(stmt: Stmt): string {
  switch (stmt.kind) {
    case "set":
      return `${showExpr(stmt.obj)}.${stmt.field} = ${showExpr(stmt.value)}`;
    case "break":
      return `break${stmt.label === undefined ? "" : " " + stmt.label}`;
    case "return":
      return `return ${stmt.value === null ? "-" : showExpr(stmt.value)}`;
  }
}

function copies(fields: string[], source: Expr & { kind: "ref" }, dst: Expr, loc: Loc): Stmt[] {
  return fields.map((field) => ({
    kind: "set",
    obj: dst,
    field,
    value: { kind: "get", obj: source, field, loc },
    loc,
  }));
}

const loc: Loc = { start: 0 };
const out: Expr = { kind: "ref", name: "out", loc };
const span: Expr = { kind: "ref", name: "span", loc };
if (span.kind === "ref") console.log(copies(["lo", "hi"], span, out, loc).map(show).join("; "));
const stops: Stmt[] = ["a", "b"].map((label) => ({ kind: "break", label, loc }));
console.log(stops.map(show).join("; "));
