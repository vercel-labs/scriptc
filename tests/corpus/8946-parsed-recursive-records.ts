// Records of a recursive type that come from JSON.parse and from literals in
// one program: a parsed value is a tree, so it shares nothing and refers to
// nothing twice, and the values the program builds around it hold parsed
// subtrees like any other record (shared between parents, cloned with
// spreads, dropped in a loop).
type Expr =
  | { kind: "num"; value: number }
  | { kind: "add"; left: Expr; right: Expr }
  | { kind: "neg"; operand: Expr }
  | { kind: "list"; items: Expr[] };

interface Chain {
  name: string;
  next?: Chain;
}

interface Dir {
  name: string;
  entries: Record<string, Dir>;
}

function evaluate(e: Expr): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "add":
      return evaluate(e.left) + evaluate(e.right);
    case "neg":
      return -evaluate(e.operand);
    case "list":
      return e.items.reduce((total, item) => total + evaluate(item), 0);
  }
}

function show(e: Expr): string {
  switch (e.kind) {
    case "num":
      return String(e.value);
    case "add":
      return `(${show(e.left)} + ${show(e.right)})`;
    case "neg":
      return `-${show(e.operand)}`;
    case "list":
      return `[${e.items.map(show).join(", ")}]`;
  }
}

function bump(e: Expr): Expr {
  switch (e.kind) {
    case "num":
      return { ...e, value: e.value + 1 };
    case "add":
      return { ...e, left: bump(e.left), right: bump(e.right) };
    case "neg":
      return { ...e, operand: bump(e.operand) };
    case "list":
      return { ...e, items: e.items.map(bump) };
  }
}

function build(depth: number): Expr {
  if (depth === 0) return { kind: "num", value: depth + 1 };
  if (depth % 3 === 0) return { kind: "neg", operand: build(depth - 1) };
  if (depth % 4 === 0) return { kind: "list", items: [build(depth - 1), build(depth - 2)] };
  return { kind: "add", left: build(depth - 1), right: build(depth - 1) };
}

const text =
  '{"kind":"add","left":{"kind":"list","items":[{"kind":"num","value":2},' +
  '{"kind":"neg","operand":{"kind":"num","value":5}}]},"right":{"kind":"num","value":40}}';
const parsed = JSON.parse(text) as Expr;
console.log(show(parsed), evaluate(parsed));

// The parsed tree under parents the program builds, twice under one of them.
const both: Expr = { kind: "add", left: parsed, right: parsed };
const wrapped: Expr = { kind: "list", items: [both, { kind: "neg", operand: parsed }, build(3)] };
console.log(show(wrapped), evaluate(wrapped));
console.log(both.kind === "add" && both.left === both.right);

// Clones of parsed and built values.
const bumped = bump(wrapped);
console.log(show(bumped), evaluate(bumped));
console.log(show(parsed), evaluate(parsed));

// Many values, each dropped before the next: parsed ones and built ones.
let total = 0;
for (let i = 0; i < 200; i++) {
  const again = JSON.parse(text) as Expr;
  const tree: Expr = { kind: "add", left: again, right: build(i % 6) };
  total += evaluate(bump(tree));
}
console.log(total);

// A parsed list behind links the program adds in front of it.
const tail = JSON.parse('{"name":"c","next":{"name":"d","next":{"name":"e"}}}') as Chain;
const chain: Chain = { name: "a", next: { name: "b", next: tail } };
const names: string[] = [];
for (let at: Chain | undefined = chain; at !== undefined; at = at.next) names.push(at.name);
console.log(names.join(" "), chain.next?.next === tail, tail.next?.next?.next === undefined);

// A recursive type through an index signature.
const root = JSON.parse(
  '{"name":"/","entries":{"etc":{"name":"etc","entries":{}},"usr":{"name":"usr","entries":{"bin":{"name":"bin","entries":{}}}}}}',
) as Dir;
function paths(dir: Dir, prefix: string, out: string[]): string[] {
  out.push(prefix === "" ? dir.name : prefix);
  for (const name of Object.keys(dir.entries)) paths(dir.entries[name]!, `${prefix}/${name}`, out);
  return out;
}
const home: Dir = { name: "home", entries: { shared: root.entries["usr"]! } };
console.log(paths(root, "", []).join(" "), paths(home, "/home", []).join(" "));
console.log(JSON.stringify(parsed) === text, JSON.stringify(tail));
