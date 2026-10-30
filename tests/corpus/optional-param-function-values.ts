// Functions whose own parameters are optional, defaulted or extra take part
// as VALUES in slots that spell the completed signature (WP-A, the
// `tool-definition-wrapper` shape): a method's narrower required parameter
// against the declaring interface's optional one, a handler with more
// (trailing optional) parameters than the slot's type names, and a nested
// function declaration returned in an object literal. Node semantics: the
// slot passes fewer arguments than the value declares, so the missing ones
// are `undefined` and defaults apply.

interface Ctx {
  cwd: string;
}

interface ToolCtx extends Ctx {
  tools: string[];
}

interface RequiredSlot {
  run(id: string, ctx: ToolCtx): string;
}

// A: a method declaring its parameter OPTIONAL fills a slot that requires
// the (narrower) parameter: the slot always passes it, so the `undefined`
// arm is unreachable through that slot.
const a: RequiredSlot = {
  run(id: string, ctx?: Ctx): string {
    return `${id}@${ctx === undefined ? "-" : ctx.cwd}`;
  },
};
console.log(a.run("A", { cwd: "/a", tools: [] }));

// The same method through its own object: the omitted call is real here.
const aLiteral = {
  run(id: string, ctx?: Ctx): string {
    return `${id}@${ctx === undefined ? "-" : ctx.cwd}`;
  },
};
console.log(aLiteral.run("A"), aLiteral.run("A", { cwd: "/a" }));

// B: a handler with an EXTRA trailing optional parameter in a two-parameter
// slot: the slot never passes it, so it reads undefined.
type Handler = (id: string, payload: number) => string;
const handlers: Record<string, Handler> = {
  plain(id, payload, extra?: string) {
    return `${id}:${payload}:${extra === undefined ? "-" : extra}`;
  },
};
console.log(handlers["plain"]("one", 1));

const annotated: Handler = (id, payload, extra?: string) =>
  `${id}:${payload}:${extra === undefined ? "-" : extra}`;
console.log(annotated("two", 2));

// A defaulted trailing parameter: the slot's omission applies the default.
const withDefault: Handler = (id, payload, extra = "dflt") => `${id}:${payload}:${extra}`;
console.log(withDefault("three", 3));

// C: a nested function DECLARATION (overloaded, with an optional parameter)
// returned as a value: lowering the declaration builds its body; the value
// use at the return re-checks the completed signature against the slot.
interface Writer {
  (text: string): string;
}
function makeWriter(prefix: string): Writer {
  function write(text: string): string;
  function write(text: string, times?: number): string;
  function write(text: string, times?: number): string {
    const n = times === undefined ? 1 : times;
    let out = "";
    for (let i = 0; i < n; i++) out += `${prefix}${text}`;
    return out;
  }
  return write;
}
const writer = makeWriter("> ");
console.log(writer("x"));

// Control: the same signatures through direct calls.
function greet(name?: string): string {
  return name === undefined ? "hello" : `hello ${name}`;
}
console.log(greet(), greet("ada"));
function repeat(text: string, times = 3, sep = "|"): string {
  let out = "";
  for (let i = 0; i < times; i++) out += (i === 0 ? "" : sep) + text;
  return out;
}
console.log(repeat("z"), repeat("z", 2), repeat("z", 2, "+"));
const pick: (x: number | undefined) => number = (x?: number) => (x === undefined ? -1 : x);
console.log(pick(undefined), pick(4));

// A method whose optional parameter is READ through the value it was given
// (the `arguments.length`-free shape the tool registry uses).
interface UnsafeSlot {
  call(payload: string): string;
}
const unsafe: UnsafeSlot = {
  call(payload: string, options?: { tag: string }): string {
    return `${payload}/${options === undefined ? "-" : options.tag}`;
  },
};
console.log(unsafe.call("q"));

// A value stored in a union-typed slot (the omitted call stays observable).
type Runner = RequiredSlot | undefined;
const maybeRunner: Runner = a;
console.log(maybeRunner === undefined ? "none" : maybeRunner.run("U", { cwd: "/u", tools: [] }));
