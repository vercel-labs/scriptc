// A record that converts into several arms of a discriminated union takes
// the arm its discriminant names. The `map` callback below builds statement
// records whose `value` is an expression literal; that literal also fits the
// shorter `ref` expression, and the statement also fits `brk` (by dropping
// fields), but the `kind` values pick `get` and `set`, as in Node.
type Expr =
  | { kind: "get"; obj: Expr | null; field: string }
  | { kind: "ref"; obj: Expr | null }
  | { kind: "num"; n: number };
type Stmt =
  | { kind: "set"; obj: Expr; field: string; value: Expr }
  | { kind: "brk"; label?: string };

function fill(target: Expr, names: string[]): Stmt[] {
  return names.map((name) => ({
    kind: "set",
    obj: target,
    field: name,
    value: { kind: "get", obj: target, field: name },
  }));
}

function describe(s: Stmt): string {
  switch (s.kind) {
    case "set":
      return `set ${s.field} = ${s.value.kind}${s.value.kind === "get" ? `.${s.value.field}` : ""} on ${s.obj.kind}`;
    case "brk":
      return `brk ${s.label ?? "-"}`;
  }
}

for (const s of fill({ kind: "num", n: 1 }, ["a", "b"])) console.log(describe(s));

// The same records with the other discriminant value take the other arm.
function pick(kind: "set" | "brk", label: string): Stmt[] {
  return [label].map((l) =>
    kind === "set"
      ? { kind: "set" as const, obj: { kind: "num" as const, n: 2 }, field: l, value: { kind: "ref" as const, obj: null } }
      : { kind: "brk" as const, label: l },
  );
}
console.log(pick("set", "x").map(describe).join("; "));
console.log(pick("brk", "y").map(describe).join("; "));

// A record that fits one arm only, by dropping a field, still takes it.
const extra = { kind: "brk" as const, label: "z", note: 1 };
const stmts: Stmt[] = [extra];
console.log(stmts.map(describe).join("; "));
