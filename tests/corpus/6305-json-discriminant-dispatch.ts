// JSON cast into a union with many string discriminant literals: the cast
// reads the discriminant once and tests only the arm whose literal it
// holds, plus the arms that are not records. An arm can list several
// literals, and values that are not objects reach the other arms in
// canonical order. Valid casts only (see 1002-json-parse-cast.ts); JSON keys
// and record fields alphabetical for stringify parity.

type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; text: string }
  | { kind: "neg"; operand: Expr }
  | { kind: "add" | "mul"; left: Expr; right: Expr }
  | { args: Expr[]; kind: "call"; name: string }
  | { kind: "method"; name: string; target: Expr }
  | { kind: "list"; items: Expr[] };

function show(e: Expr): string {
  switch (e.kind) {
    case "num":
      return String(e.value);
    case "str":
      return JSON.stringify(e.text);
    case "neg":
      return `-(${show(e.operand)})`;
    case "add":
      return `(${show(e.left)} + ${show(e.right)})`;
    case "mul":
      return `(${show(e.left)} * ${show(e.right)})`;
    case "call":
      return `${e.name}(${e.args.map(show).join(", ")})`;
    case "method":
      return `${show(e.target)}.${e.name}()`;
    case "list":
      return `[${e.items.map(show).join(", ")}]`;
  }
}

function evaluate(e: Expr): number {
  switch (e.kind) {
    case "num":
      return e.value;
    case "str":
      return e.text.length;
    case "neg":
      return -evaluate(e.operand);
    case "add":
      return evaluate(e.left) + evaluate(e.right);
    case "mul":
      return evaluate(e.left) * evaluate(e.right);
    case "call":
      return e.args.reduce((sum, arg) => sum + evaluate(arg), 0);
    case "method":
      return evaluate(e.target);
    case "list":
      return e.items.length;
  }
}

const source =
  '{"kind":"add","left":{"kind":"mul","left":{"kind":"num","value":3},' +
  '"right":{"kind":"neg","operand":{"kind":"num","value":4}}},' +
  '"right":{"args":[{"kind":"str","text":"abc"},{"kind":"num","value":2}],"kind":"call","name":"sum"}}';
const tree = JSON.parse(source) as Expr;
console.log(show(tree));
console.log(evaluate(tree));
console.log(JSON.stringify(tree) === source);

const method = JSON.parse(
  '{"kind":"method","name":"size","target":{"items":[{"kind":"num","value":1}],"kind":"list"}}',
) as Expr;
console.log(show(method), evaluate(method));

// A deep list of every arm, built from text.
const parts: string[] = [];
for (let i = 0; i < 200; i++) {
  parts.push(
    i % 3 === 0
      ? `{"kind":"num","value":${i}}`
      : i % 3 === 1
        ? `{"kind":"neg","operand":{"kind":"num","value":${i}}}`
        : `{"kind":"mul","left":{"kind":"num","value":${i}},"right":{"kind":"str","text":"xy"}}`,
  );
}
const list = JSON.parse(`{"items":[${parts.join(",")}],"kind":"list"}`) as Expr;
if (list.kind === "list") {
  let total = 0;
  for (const item of list.items) total += evaluate(item);
  console.log(list.items.length, total);
}

// Arms that are not records: a value that is not an object can only be one
// of them.
type Token =
  | { kind: "ident"; name: string }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "punct"; symbol: string }
  | { kind: "comment"; line: number; text: string }
  | string
  | number;

function describe(token: Token): string {
  if (typeof token === "string") return `raw ${token}`;
  if (typeof token === "number") return `count ${token}`;
  switch (token.kind) {
    case "ident":
      return `ident ${token.name}`;
    case "number":
      return `number ${token.value}`;
    case "string":
      return `string ${JSON.stringify(token.value)}`;
    case "punct":
      return `punct ${token.symbol}`;
    case "comment":
      return `comment ${token.line}: ${token.text}`;
  }
}

const tokens = JSON.parse(
  '[{"kind":"ident","name":"x"},{"kind":"punct","symbol":"="},{"kind":"number","value":42},' +
    '{"kind":"string","value":"hi"},{"kind":"comment","line":3,"text":"note"},"spare",7]',
) as Token[];
for (const token of tokens) console.log(describe(token));
