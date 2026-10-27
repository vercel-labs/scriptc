// JSON text parsed into discriminated unions: an event log with eight kinds
// of event and a nested expression tree with nine kinds of node, cast with
// `JSON.parse(text) as T`, then aggregated and evaluated. Argument: the
// number of rounds.
type Event =
  | { kind: "click"; target: string; x: number; y: number }
  | { key: string; kind: "key"; repeat: boolean }
  | { kind: "scroll"; offset: number }
  | { kind: "resize"; height: number; width: number }
  | { kind: "focus"; target: string }
  | { kind: "blur"; target: string }
  | { kind: "load"; ms: number; url: string }
  | { code: number; kind: "error"; message: string };

type Expr =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "neg"; operand: Expr }
  | { kind: "add"; left: Expr; right: Expr }
  | { kind: "sub"; left: Expr; right: Expr }
  | { kind: "mul"; left: Expr; right: Expr }
  | { kind: "max"; items: Expr[] }
  | { else: Expr; kind: "if"; test: Expr; then: Expr }
  | { body: Expr; kind: "let"; name: string; value: Expr };

let seed = 12345;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

const targets = ["menu", "search", "button", "list", "footer"];
function eventText(i: number): string {
  const target = targets[i % targets.length]!;
  switch (i % 8) {
    case 0:
      return `{"kind":"click","target":"${target}","x":${i % 640},"y":${i % 480}}`;
    case 1:
      return `{"key":"k${i % 26}","kind":"key","repeat":${i % 3 === 0}}`;
    case 2:
      return `{"kind":"scroll","offset":${(i * 7) % 2000}}`;
    case 3:
      return `{"height":${400 + (i % 300)},"kind":"resize","width":${600 + (i % 500)}}`;
    case 4:
      return `{"kind":"focus","target":"${target}"}`;
    case 5:
      return `{"kind":"blur","target":"${target}"}`;
    case 6:
      return `{"kind":"load","ms":${i % 900},"url":"/page/${i % 50}"}`;
    default:
      return `{"code":${400 + (i % 100)},"kind":"error","message":"failed ${i % 13}"}`;
  }
}

const names = ["a", "b", "c", "d"];
function exprText(depth: number): string {
  const pick = depth <= 0 ? Math.floor(random() * 2) : Math.floor(random() * 9);
  switch (pick) {
    case 0:
      return `{"kind":"num","value":${Math.floor(random() * 100)}}`;
    case 1:
      return `{"kind":"var","name":"${names[Math.floor(random() * names.length)]!}"}`;
    case 2:
      return `{"kind":"neg","operand":${exprText(depth - 1)}}`;
    case 3:
    case 4:
    case 5: {
      const kind = pick === 3 ? "add" : pick === 4 ? "sub" : "mul";
      return `{"kind":"${kind}","left":${exprText(depth - 1)},"right":${exprText(depth - 1)}}`;
    }
    case 6:
      return `{"items":[${exprText(depth - 1)},${exprText(depth - 2)},${exprText(depth - 2)}],"kind":"max"}`;
    case 7:
      return `{"else":${exprText(depth - 2)},"kind":"if","test":${exprText(depth - 1)},"then":${exprText(depth - 2)}}`;
    default:
      return `{"body":${exprText(depth - 1)},"kind":"let","name":"${names[Math.floor(random() * names.length)]!}","value":${exprText(depth - 2)}}`;
  }
}

function evaluate(e: Expr, env: Map<string, number>): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "var":
      return env.get(e.name) ?? 1;
    case "neg":
      return -evaluate(e.operand, env);
    case "add":
      return (evaluate(e.left, env) + evaluate(e.right, env)) % 1000003;
    case "sub":
      return (evaluate(e.left, env) - evaluate(e.right, env)) % 1000003;
    case "mul":
      return (evaluate(e.left, env) * evaluate(e.right, env)) % 1000003;
    case "max": {
      let best = -Infinity;
      for (const item of e.items) best = Math.max(best, evaluate(item, env));
      return best;
    }
    case "if":
      return evaluate(e.test, env) > 0 ? evaluate(e.then, env) : evaluate(e.else, env);
    case "let": {
      const inner = new Map(env);
      inner.set(e.name, evaluate(e.value, env));
      return evaluate(e.body, inner);
    }
  }
}

const rounds = Number(process.argv[2] ?? "6");
const eventsText = `[${Array.from({ length: 60000 }, (_, i) => eventText(i)).join(",")}]`;
const treesText = `[${Array.from({ length: 400 }, () => exprText(9)).join(",")}]`;
let clicks = 0;
let keys = 0;
let scrolled = 0;
let area = 0;
let loadMs = 0;
let errors = 0;
let focus = 0;
let total = 0;
for (let round = 0; round < rounds; round++) {
  const events = JSON.parse(eventsText) as Event[];
  for (const event of events) {
    switch (event.kind) {
      case "click":
        clicks += event.x + event.y;
        break;
      case "key":
        if (event.repeat) keys++;
        break;
      case "scroll":
        scrolled += event.offset;
        break;
      case "resize":
        area += (event.width * event.height) % 1000;
        break;
      case "focus":
      case "blur":
        focus += event.target.length;
        break;
      case "load":
        loadMs += event.ms;
        break;
      case "error":
        errors += event.code % 7;
        break;
    }
  }
  const trees = JSON.parse(treesText) as Expr[];
  const env = new Map([
    ["a", 3],
    ["b", 5],
  ]);
  for (const tree of trees) total = (total + evaluate(tree, env)) % 1000003;
}
console.log(clicks, keys, scrolled, area, loadMs, errors, focus, total);
