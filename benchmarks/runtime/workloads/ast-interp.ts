// A tokenizer, recursive-descent parser, and class-based tree-walking
// evaluator for a small expression language with variables.
abstract class Expr {
  abstract evaluate(env: Map<string, number>): number;
}
class Num extends Expr {
  readonly value: number;
  constructor(value: number) {
    super();
    this.value = value;
  }
  evaluate(_env: Map<string, number>): number {
    return this.value;
  }
}
class Var extends Expr {
  readonly name: string;
  constructor(name: string) {
    super();
    this.name = name;
  }
  evaluate(env: Map<string, number>): number {
    return env.get(this.name) ?? 0;
  }
}
class Binary extends Expr {
  readonly op: string;
  readonly left: Expr;
  readonly right: Expr;
  constructor(op: string, left: Expr, right: Expr) {
    super();
    this.op = op;
    this.left = left;
    this.right = right;
  }
  evaluate(env: Map<string, number>): number {
    const l = this.left.evaluate(env);
    const r = this.right.evaluate(env);
    switch (this.op) {
      case "+":
        return l + r;
      case "-":
        return l - r;
      case "*":
        return l * r;
      case "/":
        return r === 0 ? 0 : l / r;
      default:
        return l % (r === 0 ? 1 : r);
    }
  }
}
class Call extends Expr {
  readonly name: string;
  readonly args: Expr[];
  constructor(name: string, args: Expr[]) {
    super();
    this.name = name;
    this.args = args;
  }
  evaluate(env: Map<string, number>): number {
    const values = this.args.map((arg) => arg.evaluate(env));
    if (this.name === "max") return Math.max(...values);
    if (this.name === "min") return Math.min(...values);
    return values.reduce((a, b) => a + b, 0);
  }
}

type TokenKind = "num" | "ident" | "op" | "lparen" | "rparen" | "comma" | "end";
interface Token {
  kind: TokenKind;
  text: string;
}

function isDigit(c: number): boolean {
  return (c >= 48 && c <= 57) || c === 46;
}
function isIdent(c: number): boolean {
  return (c >= 97 && c <= 122) || c === 95;
}
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source.charCodeAt(i);
    if (c === 32) {
      i++;
    } else if (c >= 48 && c <= 57) {
      const start = i;
      while (i < source.length && isDigit(source.charCodeAt(i))) i++;
      tokens.push({ kind: "num", text: source.slice(start, i) });
    } else if (isIdent(c)) {
      const start = i;
      while (i < source.length && isIdent(source.charCodeAt(i))) i++;
      tokens.push({ kind: "ident", text: source.slice(start, i) });
    } else if (c === 40) {
      tokens.push({ kind: "lparen", text: "(" });
      i++;
    } else if (c === 41) {
      tokens.push({ kind: "rparen", text: ")" });
      i++;
    } else if (c === 44) {
      tokens.push({ kind: "comma", text: "," });
      i++;
    } else {
      tokens.push({ kind: "op", text: source[i]! });
      i++;
    }
  }
  tokens.push({ kind: "end", text: "" });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  private peek(): Token {
    return this.tokens[this.pos]!;
  }
  private next(): Token {
    return this.tokens[this.pos++]!;
  }
  parseExpr(): Expr {
    let left = this.parseTerm();
    while (this.peek().kind === "op" && (this.peek().text === "+" || this.peek().text === "-")) {
      const op = this.next().text;
      left = new Binary(op, left, this.parseTerm());
    }
    return left;
  }
  private parseTerm(): Expr {
    let left = this.parseFactor();
    while (this.peek().kind === "op" && (this.peek().text === "*" || this.peek().text === "/" || this.peek().text === "%")) {
      const op = this.next().text;
      left = new Binary(op, left, this.parseFactor());
    }
    return left;
  }
  private parseFactor(): Expr {
    const token = this.next();
    if (token.kind === "num") return new Num(Number(token.text));
    if (token.kind === "lparen") {
      const inner = this.parseExpr();
      this.next();
      return inner;
    }
    if (this.peek().kind === "lparen") {
      this.next();
      const args: Expr[] = [];
      while (this.peek().kind !== "rparen") {
        args.push(this.parseExpr());
        if (this.peek().kind === "comma") this.next();
      }
      this.next();
      return new Call(token.text, args);
    }
    return new Var(token.text);
  }
}

let seed = 7;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}
const names = ["alpha", "beta", "gamma", "delta", "x", "y"];
const ops = ["+", "-", "*", "/", "%"];
function generate(depth: number): string {
  const r = random();
  if (depth === 0 || r < 0.2) return r < 0.1 ? String(Math.floor(random() * 100)) : names[Math.floor(random() * names.length)]!;
  if (r < 0.3) return `max(${generate(depth - 1)}, ${generate(depth - 1)}, ${generate(depth - 1)})`;
  if (r < 0.4) return `(${generate(depth - 1)})`;
  return `${generate(depth - 1)} ${ops[Math.floor(random() * ops.length)]!} ${generate(depth - 1)}`;
}

const scale = Number(process.argv[2] ?? "1");
const sources: string[] = [];
for (let i = 0; i < Math.floor(400 * scale); i++) sources.push(generate(7));
const env = new Map<string, number>();
let total = 0;
let chars = 0;
for (const source of sources) {
  const tree = new Parser(tokenize(source)).parseExpr();
  chars += source.length;
  for (let step = 0; step < 40; step++) {
    env.set("alpha", step);
    env.set("beta", step * 2 + 1);
    env.set("gamma", 3);
    env.set("delta", step % 7);
    env.set("x", 1.5);
    env.set("y", -2);
    const value = tree.evaluate(env);
    if (Number.isFinite(value)) total += value;
  }
}
console.log("sources", sources.length, "chars", chars, "total", total.toFixed(6));
