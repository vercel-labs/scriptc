// JSON.parse into recursive discriminated unions: deep and wide trees,
// unions with primitive arms beside the records, unions whose records share
// a literal, and unions with a record arm that has no literal.

type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; text: string }
  | { kind: "add"; left: Expr; right: Expr }
  | { kind: "neg"; operand: Expr }
  | { kind: "call"; callee: string; args: Expr[] }
  | { kind: "cond"; test: Expr; then: Expr; otherwise: Expr | null }
  | { kind: "label"; inner: Expr; name?: string };

type Stmt =
  | { kind: "expr"; expr: Expr }
  | { kind: "ret"; value: Expr | undefined }
  | { kind: "block"; body: Stmt[] };

interface Fn {
  name: string;
  body: Stmt[];
}

function evaluate(e: Expr): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "str":
      return e.text.length;
    case "add":
      return evaluate(e.left) + evaluate(e.right);
    case "neg":
      return -evaluate(e.operand);
    case "call":
      return e.args.reduce((sum, arg) => sum + evaluate(arg), e.callee.length);
    case "cond":
      return evaluate(e.test) !== 0
        ? evaluate(e.then)
        : e.otherwise === null
          ? 0
          : evaluate(e.otherwise);
    case "label":
      return evaluate(e.inner) + (e.name?.length ?? 0);
  }
}

function depth(e: Expr): number {
  switch (e.kind) {
    case "num":
    case "str":
      return 1;
    case "add":
      return 1 + Math.max(depth(e.left), depth(e.right));
    case "neg":
      return 1 + depth(e.operand);
    case "call":
      return 1 + e.args.reduce((max, arg) => Math.max(max, depth(arg)), 0);
    case "cond":
      return 1 + Math.max(depth(e.test), depth(e.then), e.otherwise ? depth(e.otherwise) : 0);
    case "label":
      return 1 + depth(e.inner);
  }
}

function chain(n: number): string {
  let text = '{"kind":"num","value":1}';
  for (let i = 0; i < n; i++) {
    text =
      i % 3 === 0
        ? `{"kind":"neg","operand":${text}}`
        : i % 3 === 1
          ? `{"kind":"add","left":${text},"right":{"kind":"str","text":"ab"}}`
          : `{"kind":"label","inner":${text}${i % 2 === 0 ? ',"name":"x"' : ""}}`;
  }
  return text;
}

function wide(n: number, level: number): string {
  if (level === 0) return `{"kind":"num","value":${n}}`;
  const args: string[] = [];
  for (let i = 0; i < 3; i++) args.push(wide(n + i, level - 1));
  return `{"kind":"call","callee":"f${level}","args":[${args.join(",")}]}`;
}

for (const n of [0, 1, 5, 60, 400]) {
  const e = JSON.parse(chain(n)) as Expr;
  console.log("chain", n, e.kind, depth(e), evaluate(e));
}

const tree = JSON.parse(wide(1, 6)) as Expr;
console.log("wide", depth(tree), evaluate(tree));

const cond = JSON.parse(
  '{"kind":"cond","test":{"kind":"num","value":0},"then":{"kind":"num","value":5},"otherwise":null}',
) as Expr;
console.log("cond", evaluate(cond));

const fn = JSON.parse(
  JSON.stringify({
    name: "main",
    body: [
      { kind: "expr", expr: JSON.parse(chain(30)) },
      { kind: "block", body: [{ kind: "ret", value: JSON.parse(wide(2, 3)) }, { kind: "ret" }] },
    ],
  }),
) as Fn;
let statements = 0;
const visit = (stmts: Stmt[]): void => {
  for (const s of stmts) {
    statements++;
    if (s.kind === "block") visit(s.body);
    else if (s.kind === "expr") console.log("stmt expr", evaluate(s.expr));
    else console.log("stmt ret", s.value === undefined ? "none" : evaluate(s.value));
  }
};
visit(fn.body);
console.log("statements", statements);

// Primitive arms beside the records.
type Value = number | string | null | { kind: "list"; items: Value[] } | { kind: "pair"; first: Value; second: Value };
function show(v: Value): string {
  if (v === null || typeof v === "number" || typeof v === "string") return JSON.stringify(v);
  return v.kind === "list" ? `[${v.items.map(show).join(" ")}]` : `(${show(v.first)} . ${show(v.second)})`;
}
const values = JSON.parse(
  '[1,"a",null,{"kind":"list","items":[2,{"kind":"pair","first":"b","second":{"kind":"list","items":[null,3]}}]}]',
) as Value[];
console.log("values", values.map(show).join(" | "));

// Two records that share a literal: the arm follows the other fields.
type Shared = { kind: "a"; count: number } | { kind: "a"; name: string } | { kind: "b"; next: Shared[] };
function describe(s: Shared): string {
  if (s.kind === "b") return `b(${s.next.map(describe).join(",")})`;
  return "count" in s ? `count=${s.count}` : `name=${s.name}`;
}
const shared = JSON.parse(
  '{"kind":"b","next":[{"kind":"a","count":1},{"kind":"a","name":"n"},{"kind":"b","next":[{"kind":"a","name":"m"}]}]}',
) as Shared;
console.log("shared", describe(shared));

// A record arm without a literal beside records that have one.
type Loose = { kind: "leaf"; value: number } | { kind: "node"; children: Loose[] } | { weight: number; child: Loose };
function total(l: Loose): number {
  if ("weight" in l) return l.weight * total(l.child);
  return l.kind === "leaf" ? l.value : l.children.reduce((sum, c) => sum + total(c), 0);
}
const loose = JSON.parse(
  '{"kind":"node","children":[{"kind":"leaf","value":2},{"weight":3,"child":{"kind":"node","children":[{"kind":"leaf","value":4},{"weight":2,"child":{"kind":"leaf","value":5}}]}}]}',
) as Loose;
console.log("loose", total(loose));

// Optional and nullable members holding records and arrays of records.
type Box = { value: number; child?: Box; rest: Box[] | null };
function weigh(b: Box): number {
  let total = b.value;
  if (b.child !== undefined) total += 2 * weigh(b.child);
  for (const r of b.rest ?? []) total += weigh(r);
  return total;
}
let boxText = '{"value":1,"rest":null}';
for (let i = 2; i < 120; i++)
  boxText = i % 2 === 0 ? `{"value":${i},"child":${boxText},"rest":null}` : `{"value":${i},"rest":[${boxText},{"value":1,"rest":[]}]}`;
const boxes = JSON.parse(boxText) as Box;
console.log("boxes", weigh(boxes) % 1000003);
