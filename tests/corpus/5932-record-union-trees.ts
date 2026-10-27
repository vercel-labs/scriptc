// A recursive discriminated union (an expression tree) whose leaf arm holds
// no references: every arm shares the cycle collector's header, so trees
// can be built, rewritten, shared and dropped in cycles.
type Expr =
  | { kind: "num"; value: number }
  | { kind: "neg"; arg: Expr }
  | { kind: "add"; left: Expr; right: Expr }
  | { kind: "ref"; target: { expr: Expr | null } };

function evaluate(e: Expr): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "neg":
      return -evaluate(e.arg);
    case "add":
      return evaluate(e.left) + evaluate(e.right);
    case "ref":
      return e.target.expr === null ? 0 : evaluate(e.target.expr);
  }
}

function build(depth: number, seed: number): Expr {
  if (depth === 0) return { kind: "num", value: seed % 10 };
  if (seed % 4 === 0) return { kind: "neg", arg: build(depth - 1, seed + 1) };
  return { kind: "add", left: build(depth - 1, seed * 3 + 1), right: build(depth - 1, seed + 7) };
}

function simplify(e: Expr): Expr {
  switch (e.kind) {
    case "neg": {
      const inner = simplify(e.arg);
      return inner.kind === "neg" ? inner.arg : inner.kind === "num" ? { kind: "num", value: -inner.value } : { kind: "neg", arg: inner };
    }
    case "add": {
      const l = simplify(e.left);
      const r = simplify(e.right);
      if (l.kind === "num" && r.kind === "num") return { kind: "num", value: l.value + r.value };
      return l === e.left && r === e.right ? e : { kind: "add", left: l, right: r };
    }
    default:
      return e;
  }
}

function show(e: Expr): string {
  switch (e.kind) {
    case "num":
      return String(e.value);
    case "neg":
      return `-(${show(e.arg)})`;
    case "add":
      return `(${show(e.left)} + ${show(e.right)})`;
    case "ref":
      return "ref";
  }
}

let checksum = 0;
for (let round = 0; round < 50; round++) {
  const tree = build(6, round);
  const simple = simplify(tree);
  checksum += evaluate(tree) * 3 + evaluate(simple);
  // A cycle through a record arm: the tree refers back to itself.
  const target: { expr: Expr | null } = { expr: null };
  const loop: Expr = { kind: "add", left: tree, right: { kind: "ref", target } };
  target.expr = { kind: "num", value: round };
  checksum += evaluate(loop);
  target.expr = loop.left;
}
console.log(checksum);
console.log(show(simplify(build(3, 5))));
console.log(show(build(2, 4)), evaluate(build(4, 2)));

const shared: Expr = { kind: "num", value: 4 };
const twice: Expr = { kind: "add", left: shared, right: shared };
console.log(evaluate(twice), twice.kind === "add" && twice.left === twice.right);
