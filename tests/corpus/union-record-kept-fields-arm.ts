// A record flowing into a discriminated union where one record arm holds it
// by dropping fields and another keeps every field but declares an optional
// field the record lacks. The record's discriminant selects the arm that keeps
// its fields.

type Loc = { file: string; start: number };

type Expr =
  | { kind: "ref"; type: number; loc: Loc }
  | {
      kind: "closure";
      fnName: string;
      captures: string[];
      adapts?: true;
      type: number;
      loc: Loc;
    }
  | { kind: "call"; callee: string; args: Expr[]; type: number; loc: Loc };

function closureOf(name: string, loc: Loc): Expr {
  const closure = {
    kind: "closure" as const,
    fnName: name,
    captures: [],
    type: 1,
    loc,
  };
  return closure;
}

function describe(expr: Expr): string {
  if (expr.kind === "closure")
    return `closure ${expr.fnName}/${expr.captures.length} ${expr.adapts ?? "-"}`;
  if (expr.kind === "call")
    return `call ${expr.callee}(${expr.args.map(describe).join(", ")})`;
  return `ref ${expr.type}`;
}

const loc: Loc = { file: "a.ts", start: 3 };
const first = closureOf("pick", loc);
console.log(first.kind, describe(first), JSON.stringify(first));

const exprs: Expr[] = [first];
const captured = {
  kind: "closure" as const,
  fnName: "inner",
  captures: ["x"],
  type: 2,
  loc,
};
exprs.push(captured);
exprs.push({ kind: "ref", type: 7, loc });
console.log(
  describe({ kind: "call", callee: "run", args: exprs, type: 0, loc }),
);
console.log(exprs.map((e) => e.kind).join(","));
