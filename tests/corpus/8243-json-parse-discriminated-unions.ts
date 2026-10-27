// JSON.parse cast to discriminated unions of records: arrays of them,
// whole documents, members (with null and optional arms) and recursive
// trees. The discriminant appears first, last or between other members,
// escaped, repeated, and beside undeclared members; values hold escapes
// and non-ASCII text.

type Event =
  | { kind: "click"; x: number; y: number }
  | { kind: "focus" | "blur"; target: string }
  | { key: string; kind: "key"; repeat: boolean }
  | { kind: "load"; ms: number; next: Event | null; note?: string };

type Expr =
  | { kind: "num"; value: number }
  | { kind: "neg"; operand: Expr }
  | { items: Expr[]; kind: "max" }
  | { body: Expr; kind: "let"; name: string; value: Expr };

function describe(e: Event): string {
  switch (e.kind) {
    case "click":
      return `click ${e.x},${e.y}`;
    case "focus":
    case "blur":
      return `${e.kind} ${e.target}`;
    case "key":
      return `key ${e.key}${e.repeat ? " (repeat)" : ""}`;
    case "load":
      return `load ${e.ms}${e.note === undefined ? "" : ` "${e.note}"`}${e.next === null ? "" : ` then ${describe(e.next)}`}`;
  }
}

function evaluate(e: Expr, env: Map<string, number>): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "neg":
      return -evaluate(e.operand, env);
    case "max": {
      let best = -Infinity;
      for (const item of e.items) best = Math.max(best, evaluate(item, env));
      return best;
    }
    case "let": {
      const inner = new Map(env);
      inner.set(e.name, evaluate(e.value, env));
      return evaluate(e.body, inner) + (inner.get(e.name) ?? 0);
    }
  }
}

const events = JSON.parse(`[
  {"kind":"click","x":1,"y":2},
  {"x":3,"y":4,"kind":"click"},
  {"y":6,"kind":"click","x":5},
  {"kind":"focus","target":"input"},
  {"target":"button","kind":"blur"},
  {"key":"Enter","kind":"key","repeat":false},
  {"repeat":true,"key":"\\u00e9","kind":"key"},
  {"kind":"load","ms":12,"next":null},
  {"kind":"load","ms":7,"note":"caf\\u00e9 \\ud83d\\ude00","next":{"kind":"blur","target":"tab"}},
  {"next":{"kind":"load","ms":1,"next":{"kind":"click","x":0,"y":-1}},"ms":30,"kind":"load"},
  {"k\\u0069nd":"focus","target":"escaped key"},
  {"kind":"bl\\u0075r","target":"escaped value"},
  {"kind":"click","kind":"focus","target":"repeated"},
  {"kind":"click","x":8,"y":9,"extra":{"kind":"not an event","list":[1,[2]]}},
  { "kind" : "key" , "key" : "space" , "repeat" : true }
]`) as Event[];
console.log(events.length);
for (const e of events) console.log(describe(e));
console.log(JSON.stringify(events[12]), JSON.stringify(events[13]));

const empty = JSON.parse("[]") as Event[];
console.log(empty.length);

const single = JSON.parse('{"target":"whole document","kind":"focus"}') as Event;
console.log(describe(single));

const tree = JSON.parse(`{
  "body": {"items": [{"kind":"num","value":4}, {"kind":"neg","operand":{"kind":"num","value":-9}}, {"items":[],"kind":"max"}], "kind": "max"},
  "kind": "let",
  "name": "x",
  "value": {"kind":"neg","operand":{"kind":"neg","operand":{"kind":"num","value":2.5}}}
}`) as Expr;
console.log(evaluate(tree, new Map()));

const forest = JSON.parse(
  `[${Array.from({ length: 50 }, (_, i) =>
    i % 3 === 0
      ? `{"kind":"num","value":${i}}`
      : i % 3 === 1
        ? `{"operand":{"kind":"num","value":${i}},"kind":"neg"}`
        : `{"items":[{"kind":"num","value":${i}},{"kind":"num","value":${50 - i}}],"kind":"max"}`,
  ).join(",")}]`,
) as Expr[];
let total = 0;
for (const t of forest) total += evaluate(t, new Map());
console.log(forest.length, total);

// Parsing the same text again builds separate values.
const again = JSON.parse('[{"kind":"num","value":1},{"kind":"num","value":2}]') as Expr[];
const twice = JSON.parse('[{"kind":"num","value":1},{"kind":"num","value":2}]') as Expr[];
console.log(again.length + twice.length, again[0] === twice[0]);

// Malformed text throws Node's SyntaxError, including text that ends
// inside the members before the discriminant or inside its value.
for (const text of [
  '[{"kind":"click","x":1,"y":2},',
  '[{"x":1,"kind"',
  '[{"x":[1,2,"kind":"click"}]',
  '[{"kind":"cl',
  '[{"target":"a" "kind":"focus"}]',
]) {
  try {
    console.log((JSON.parse(text) as Event[]).length);
  } catch (error) {
    console.log(error instanceof SyntaxError, (error as Error).message);
  }
}
