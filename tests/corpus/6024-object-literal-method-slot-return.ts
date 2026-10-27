// An object-literal method returns the type its slot declares. The literal
// statements below have their own inferred type, a union of records whose
// `init` fields are `Expr` or `null` and whose tryCatch member has fields
// the declared `Stmt` does not; the method still returns `Stmt[]`.
type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; text: string }
  | { kind: "ref"; name: string };
type Stmt =
  | { kind: "varDecl"; name: string; init: Expr | null }
  | { kind: "exprStmt"; expr: Expr }
  | { kind: "if"; cond: Expr; then: Stmt[]; else_: Stmt[] | null }
  | { kind: "loop"; init: Stmt | null; body: Stmt[] }
  | {
      kind: "tryCatch";
      tryBody: Stmt[];
      catchBody: Stmt[] | null;
      catchName: string | null;
      finallyBody: Stmt[] | null;
    };

interface Step {
  label: string;
  build(source: Expr, append: (value: Expr) => Stmt[]): Stmt[];
  first(source: Expr): Stmt | Expr;
}

const ref = (name: string): Expr => ({ kind: "ref", name });

function arrayStep(label: string): Step {
  return {
    label,
    build(source, append) {
      const loop: Stmt = {
        kind: "loop",
        init: { kind: "varDecl", name: "cursor", init: { kind: "num", value: 0 } },
        body: [...append(ref("value"))],
      };
      return [
        { kind: "varDecl", name: "array", init: source },
        { kind: "varDecl", name: "close", init: ref("flag") },
        { kind: "varDecl", name: "value", init: null },
        {
          kind: "tryCatch",
          tryBody: [loop],
          catchBody: null,
          catchName: null,
          finallyBody: [{ kind: "if", cond: ref("close"), then: [], else_: null }],
        },
      ];
    },
    first(source) {
      if (source.kind === "num") return { kind: "varDecl", name: "n", init: null };
      return source;
    },
  };
}

function show(expr: Expr | null): string {
  if (expr === null) return "null";
  switch (expr.kind) {
    case "num":
      return String(expr.value);
    case "str":
      return JSON.stringify(expr.text);
    case "ref":
      return expr.name;
  }
}

function print(stmts: Stmt[], depth: number): void {
  const pad = "  ".repeat(depth);
  for (const s of stmts) {
    switch (s.kind) {
      case "varDecl":
        console.log(`${pad}let ${s.name} = ${show(s.init)}`);
        break;
      case "exprStmt":
        console.log(`${pad}${show(s.expr)}`);
        break;
      case "if":
        console.log(`${pad}if ${show(s.cond)} (else: ${s.else_ === null ? "none" : s.else_.length})`);
        print(s.then, depth + 1);
        break;
      case "loop":
        console.log(`${pad}loop`);
        if (s.init) print([s.init], depth + 1);
        print(s.body, depth + 1);
        break;
      case "tryCatch":
        console.log(`${pad}try (catch: ${s.catchName ?? "none"})`);
        print(s.tryBody, depth + 1);
        if (s.catchBody) print(s.catchBody, depth + 1);
        if (s.finallyBody) {
          console.log(`${pad}finally`);
          print(s.finallyBody, depth + 1);
        }
        break;
    }
  }
}

const step = arrayStep("array");
console.log(step.label);
const stmts = step.build({ kind: "str", text: "items" }, (value) => [
  { kind: "exprStmt", expr: value },
  { kind: "varDecl", name: "done", init: null },
]);
print(stmts, 0);
console.log(stmts.length, JSON.stringify(stmts[2]));
for (const source of [{ kind: "num", value: 1 }, ref("x")] satisfies Expr[]) {
  const head = step.first(source);
  console.log(head.kind, "name" in head ? head.name : "", JSON.stringify(head));
}

// A literal under `satisfies` keeps its own type, so its methods keep their
// inferred returns: callers read the fields the constraint does not name.
interface Point {
  x: number;
}
const located = {
  point() {
    return { x: 1, y: 2 };
  },
  rows() {
    return [{ x: 3, label: "three" }];
  },
} satisfies { point(): Point; rows(): Point[] };
const point = located.point();
console.log(point.x, point.y, located.rows()[0].label);
