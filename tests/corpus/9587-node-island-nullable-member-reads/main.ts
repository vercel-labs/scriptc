// @requires-libnode
// A member an island package declares `T | null` is often absent in the
// object the island hands over (an SDK's usage counters that a proxy leaves
// out). Under Node the read is `undefined` and a defensive program handles
// it: `usage.input || 0`, `if (usage.input != null)`. The read used to
// convert to `number | null` first and throw `expected number | null at $,
// got undefined`, whatever was done with the value.
//
// A use that answers for every JavaScript value takes the island's value as
// it is: truthiness, `||`, `??`, `== null` and `!= null`, a comparison with
// a literal, `typeof`, `?.` and a template literal. Behind such a guard the
// read converts to the narrowed type. Every other use converts to the
// declared type as before (node-island.test.ts pins those throws). Three
// forms: the island's own type, a program type that views the island's
// object, and parsed data asserted to the island's type.
import {
  event,
  extras,
  keysOf,
  make,
  makeEvent,
  maybe,
  usage,
  type Event as IslandEvent,
} from "nullable-pkg";

interface Inner {
  n: number;
}
interface Usage {
  input: number | null;
  output: number;
  label: string | null;
  inner: Inner | null;
  flag: boolean | null;
  kind: "a" | "b" | null;
}
interface Event {
  type: "delta";
  usage: Usage;
}

function show(name: string, value: unknown): void {
  console.log(name, String(value));
}

function take(n: number): number {
  return n + 1;
}

for (const which of ["absent", "null", "zero", "present"]) {
  console.log("== the island's own type:", which);
  {
    const e = event(which);
    const u = usage(which);
    const x = extras(which);
    show("or", u.input || 0);
    show("or nested", e.usage.input || 0);
    show("or text", u.label || "none");
    show("nullish", u.input ?? -1);
    show("nullish text", u.label ?? "none");
    show("!= null", e.usage.input != null ? "has" : "none");
    show("== null", u.input == null);
    show("=== undefined", u.input === undefined);
    show("=== null", u.input === null);
    show("!== undefined", u.input !== undefined);
    if (u.input) show("if", "truthy");
    else show("if", "falsy");
    show("!", !u.input);
    show("!!", !!u.flag);
    show("?:", u.flag ? "on" : "off");
    show("&& in a condition", u.label && u.flag ? "both" : "not both");
    show("|| in a condition", u.label || u.flag ? "one" : "neither");
    let turns = 0;
    while (u.input) {
      turns++;
      break;
    }
    for (; u.flag; ) {
      turns++;
      break;
    }
    do {
      turns++;
    } while (u.label && turns < 2);
    show("loops", turns);
    show("typeof", typeof u.input);
    show("typeof test", typeof u.label === "string");
    show("=== literal", u.kind === "a");
    show("!== literal", u.kind !== "b");
    show("=== number", u.input === 11);
    show("literal first", 0 === u.input);
    show("?. object", u.inner?.n);
    show("?. nested", e.usage.inner?.n);
    show("?. text", u.label?.length);
    show("?. method", u.label?.toUpperCase());
    show("?. then ??", u.label?.length ?? -1);
    // The steps after the guard use the value at its type, as before.
    show("?. chain", u.label?.toUpperCase().length);
    show("?. chain of calls", u.label?.split("a").join("-"));
    show("?. index", u.label?.[0]);
    show("?. number", u.input?.toFixed(1));
    show("template", `<${u.input}> <${u.label}> <${u.flag}>`);
    show("element", u["input"] ?? "none");
    show("default of a default", (u.input ?? u.output) || 9);
    show("non-null", u.input! || 0);
    show("as", (u.input as number) || 0);
    show("comma", (u.input, 1));
    show("default as an argument", take(u.input ?? 0));
    show("default in arithmetic", (u.input || 0) + 1);
    if (e.usage.input != null) {
      const n: number = e.usage.input;
      show("behind != null", n + 1);
    } else show("behind != null", "skipped");
    if (u.label) {
      const s: string = u.label;
      show("behind a test", s.length);
    } else show("behind a test", "skipped");
    if (typeof u.input === "number") show("behind typeof", take(u.input));
    else show("behind typeof", "skipped");
    show("required", u.output + 1);
    show("call ??", maybe(which) ?? "none");
    show("call ||", maybe(which) || 0);
    show("call != null", maybe(which) != null ? "has" : "none");
    show("function typeof", typeof x.fn);
    show("function test", x.fn ? "function" : "none");
    show("function ?.()", x.fn?.());
    show("array test", x.list ? "array" : "none");
    show("array ?.", x.list?.length);
    // An array that goes on from `??` or `||` is the copy it has always been.
    show("array ??", (x.list ?? []).join("+"));
    show("array ||", (x.list || [0]).length);
    let sum = 0;
    for (const n of x.list ?? []) sum += n;
    show("array loop", sum);
    const mine = [7, 8];
    const picked = x.list ?? mine;
    show("array default is the program's", picked === mine);
    show("date test", x.when ? "date" : "none");
    show("bytes test", x.bytes ? "bytes" : "none");
    // A member that is there still converts where a typed value is needed.
    if (which !== "absent") {
      const n: number | null = u.input;
      show("binding", n);
    }
    show("keys", keysOf(u));
  }
  console.log("== a program type viewing the island's object:", which);
  {
    const e = makeEvent<Event>(which);
    const u = make<Usage>(which);
    show("or", u.input || 0);
    show("or nested", e.usage.input || 0);
    show("or text", u.label || "none");
    show("nullish", u.input ?? -1);
    show("nullish text", u.label ?? "none");
    show("!= null", e.usage.input != null ? "has" : "none");
    show("== null", u.input == null);
    show("=== undefined", u.input === undefined);
    show("=== null", u.input === null);
    show("!== undefined", u.input !== undefined);
    if (u.input) show("if", "truthy");
    else show("if", "falsy");
    show("!", !u.input);
    show("?:", u.flag ? "on" : "off");
    show("&& in a condition", u.label && u.flag ? "both" : "not both");
    show("typeof", typeof u.input);
    show("typeof test", typeof u.label === "string");
    show("=== literal", u.kind === "a");
    show("!== literal", u.kind !== "b");
    show("=== number", u.input === 11);
    show("?. object", u.inner?.n);
    show("?. text", u.label?.length);
    show("?. chain", u.label?.toUpperCase().length);
    show("?. number", u.input?.toFixed(1));
    show("template", `<${u.input}> <${u.label}> <${u.flag}>`);
    show("default of a default", (u.input ?? u.output) || 9);
    show("non-null", u.input! || 0);
    show("default as an argument", take(u.input ?? 0));
    if (e.usage.input != null) {
      const n: number = e.usage.input;
      show("behind != null", n + 1);
    } else show("behind != null", "skipped");
    show("?: on the guard", u.input != null ? u.input + 1 : -1);
    show("required", u.output + 1);
    if (which !== "absent") {
      const n: number | null = u.input;
      show("binding", n);
    }
    // The view is the island's object: an absent member stays absent.
    show("keys", keysOf(u));
    show("in", "input" in u);
  }
}

// Parsed data asserted to the island's type: a native value at a type whose
// members are read the same way.
function parse<T>(text: string): T {
  return JSON.parse(text) as T;
}
function apply(e: IslandEvent, totals: { input: number; output: number; cached: number }): void {
  if (e.usage.input != null) {
    totals.input = e.usage.input;
  }
  totals.cached = e.usage.input || 0;
  totals.output = e.usage.output;
}
const totals = { input: 11, output: 0, cached: 5 };
for (const text of [
  '{"type":"delta","usage":{"output":17}}',
  '{"type":"delta","usage":{"output":18,"input":null}}',
  '{"type":"delta","usage":{"output":19,"input":4}}',
]) {
  apply(parse<IslandEvent>(text), totals);
  console.log(totals.input, totals.output, totals.cached);
}
