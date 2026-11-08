// A parameter whose default is `null` and that has no annotation has the
// null type: every value it can hold is null. It is held like any other
// null-typed binding; an omitted argument or undefined takes the default
// (evaluated then, and only then), and a value that can only be null or
// undefined is always falsy and always nullish, so `x || y` and `x ?? y`
// are y once x has been evaluated, and `x && y` is x.
interface Reply {
  ok: boolean;
  status: number;
  detail?: { message?: string };
}

class ReplyFault extends Error {
  status: number;
  constructor(message: string, reply: Reply) {
    super(message);
    this.status = reply.status;
  }
}

let bumps = 0;
const bump = (): null => {
  bumps++;
  return null;
};

// The shape that started it: a fallback that defaults to null in an `||` chain.
async function replyFault(reply: Reply, fallbackText = null, extra = {}) {
  const text = reply.detail?.message || fallbackText || "Reply fault";
  return new ReplyFault(text + "/" + Object.keys(extra).length, reply);
}

function label(name: string, suffix = null): string {
  return name + (suffix || "-plain") + String(suffix);
}

function tests(a: number, b = null): string {
  return [a, b === null, b == undefined, typeof b, b ?? "dflt", String(b), JSON.stringify({ b })].join(" ");
}

function counted(a: number, b = bump()): string {
  return a + ":" + String(b);
}

function annotated(a: number, b: null = null): string {
  return a + ":" + String(b) + ":" + (b && "never");
}

function first(a = null, b: string): string {
  return String(a) + ":" + b;
}

function both(a = null, b = null): string {
  return String(a) + String(b);
}

const arrow = (a: string, b = null) => a + String(b);

function each(names: string[], visit: (name: string, mark?: null) => string): string {
  return names.map((n, i) => (i % 2 ? visit(n) : visit(n, null))).join(",");
}

class Slot {
  note: string;
  constructor(name: string, hint = null) {
    this.note = name + String(hint);
  }
  read(prefix: string, fallback = null): string {
    return prefix + this.note + (fallback ?? "?");
  }
}

function pick<T>(items: T[], fallback = null): T | null {
  return items.length > 0 ? items[0]! : fallback;
}

// Null-typed bindings that are not parameters take the same operators.
function fixed(a: string, b: null): string {
  const c = null;
  let d: null = null;
  d = b;
  return a + String(b) + (b || "-") + (b ?? "?") + (c || "!") + (d ?? "#") + String(c && a);
}

// The operand is evaluated even though its value cannot decide anything.
function effects(): string {
  const before = bumps;
  const viaOr = bump() || "or";
  const viaNullish = bump() ?? "nullish";
  const viaAnd = bump() && "and";
  return [viaOr, viaNullish, String(viaAnd), bumps - before].join(" ");
}

async function main(): Promise<void> {
  const a = await replyFault({ ok: false, status: 404, detail: { message: "no such row" } });
  const b = await replyFault({ ok: false, status: 500 });
  const c = await replyFault({ ok: false, status: 502, detail: {} }, null, { tried: 2 });
  const d = await replyFault({ ok: false, status: 503 }, undefined);
  for (const f of [a, b, c, d]) console.log(f.status, f.message);

  console.log(label("a"), label("b", null), label("c", undefined));
  console.log(tests(1), "|", tests(2, null), "|", tests(3, undefined));
  console.log(counted(1), counted(2, null), counted(3, undefined), "bumps", bumps);
  console.log(annotated(1), annotated(2, null));
  console.log(first(undefined, "x"), first(null, "y"));
  console.log(both(), both(null), both(undefined, null), both(null, null));
  console.log(arrow("x"), arrow("y", null), [arrow].map((p) => p("z"))[0]);
  console.log(each(["a", "b", "c"], (name, mark = null) => name + String(mark)));
  const s = new Slot("n");
  const t = new Slot("m", null);
  console.log(s.note, t.note, s.read(">"), t.read(">", null));
  console.log(pick([1, 2]), pick<string>([]), pick(["a"], null));
  console.log(fixed("x", null));
  console.log(effects());
}

main();
