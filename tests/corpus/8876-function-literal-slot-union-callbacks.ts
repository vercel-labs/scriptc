// Callbacks over recursive discriminated unions, the shapes a compiler's
// own tree walkers use: array methods over union elements, a visitor record
// of literals with fewer parameters, and a local predicate that names itself.
type Ty =
  | { kind: "num" }
  | { kind: "str" }
  | { kind: "arr"; elem: Ty }
  | { kind: "fn"; params: Ty[]; ret: Ty }
  | { kind: "union"; arms: readonly Ty[] };
type Expr =
  | { kind: "lit"; value: number; type: Ty }
  | { kind: "add"; left: Expr; right: Expr; type: Ty }
  | { kind: "call"; callee: string; args: Expr[]; type: Ty };
type Stmt =
  | { kind: "expr"; expr: Expr }
  | { kind: "ret"; value: Expr | null }
  | { kind: "block"; body: Stmt[] };

interface Visitor {
  expr: (e: Expr, depth: number) => boolean;
  stmt: (s: Stmt, depth: number) => boolean;
}
function everyExpr(e: Expr, v: Visitor, depth: number): boolean {
  if (!v.expr(e, depth)) return false;
  switch (e.kind) {
    case "lit":
      return true;
    case "add":
      return everyExpr(e.left, v, depth + 1) && everyExpr(e.right, v, depth + 1);
    case "call":
      return e.args.every((a) => everyExpr(a, v, depth + 1));
  }
}
function everyStmt(s: Stmt, v: Visitor, depth: number): boolean {
  if (!v.stmt(s, depth)) return false;
  switch (s.kind) {
    case "expr":
      return everyExpr(s.expr, v, depth + 1);
    case "ret":
      return s.value === null || everyExpr(s.value, v, depth + 1);
    case "block":
      return s.body.every((b) => everyStmt(b, v, depth + 1));
  }
}

const num: Ty = { kind: "num" };
const str: Ty = { kind: "str" };
const lit = (value: number): Expr => ({ kind: "lit", value, type: num });
const tree: Stmt = {
  kind: "block",
  body: [
    { kind: "expr", expr: { kind: "add", left: lit(1), right: lit(2), type: num } },
    { kind: "expr", expr: { kind: "call", callee: "f", args: [lit(3), lit(4)], type: str } },
    { kind: "ret", value: { kind: "add", left: lit(5), right: lit(6), type: num } },
  ],
};

let literals = 0;
let statements = 0;
everyStmt(
  tree,
  {
    expr: (e) => {
      if (e.kind === "lit") literals += e.value;
      return true;
    },
    stmt: () => {
      statements++;
      return true;
    },
  },
  0,
);
console.log("visitor", literals, statements);
console.log(
  "no calls",
  everyStmt(tree, { expr: (e) => e.kind !== "call", stmt: () => true }, 0),
  everyStmt(tree, { expr: () => true, stmt: (s) => s.kind !== "ret" }, 0),
);

// Array methods over union elements.
const arms: readonly Ty[] = [num, str, { kind: "arr", elem: num }, { kind: "union", arms: [num, str] }];
function isScalar(t: Ty): boolean {
  return t.kind === "num" || t.kind === "str";
}
console.log(
  "arms",
  arms.findIndex((arm) => arm.kind === "arr"),
  arms.every((arm) => arm.kind !== "fn"),
  arms.some((arm) => arm.kind === "union" && arm.arms.every((inner) => isScalar(inner))),
  arms.filter((arm) => isScalar(arm)).length,
  arms.map((arm) => arm.kind).join(","),
);
const table = new Map<string, readonly Ty[]>([["u1", arms]]);
console.log("table", table.get("u1")?.some((arm) => arm.kind === "str"), table.get("u2")?.some((arm) => arm.kind === "str"));

// A local predicate that names itself and is passed on.
function countDeep(root: Stmt): number {
  let n = 0;
  const expr = (e: Expr): boolean => {
    n++;
    if (e.kind === "add") return expr(e.left) && expr(e.right);
    if (e.kind === "call") return e.args.every(expr);
    return true;
  };
  const stmt = (s: Stmt): boolean => {
    n += 100;
    if (s.kind === "block") return s.body.every(stmt);
    if (s.kind === "expr") return expr(s.expr);
    return s.value === null || expr(s.value);
  };
  stmt(root);
  return n;
}
console.log("deep", countDeep(tree));
