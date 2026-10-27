// An optional chain short-circuits EVERY later step when its guarded
// receiver is nullish, even when the checker calls that receiver present:
// an array read past the end or a missing index-signature key is undefined
// at runtime, so `choices[0]?.delta.content` must not read `.content` from
// undefined (the streaming SSE shape). Covers property, element, call,
// non-null-assertion, and nested tails, plus the forms that must still throw.
type Delta = { content?: string; parts: number[] };
type Choice = {
  delta: Delta;
  pick(): { c: string };
  maybe?: () => { c: string };
};

const none: Choice[] = [];
const some: Choice[] = [
  { delta: { content: "hi", parts: [7, 8] }, pick: () => ({ c: "picked" }) },
  { delta: { parts: [] }, pick: () => ({ c: "second" }), maybe: () => ({ c: "maybe" }) },
];

// Property tails.
console.log("prop", none[0]?.delta.content, some[0]?.delta.content, some[1]?.delta.content);
console.log("prop ===", none[0]?.delta.content === undefined);
console.log("prop ??", none[0]?.delta.content ?? "none", some[0]?.delta.content ?? "none");
console.log("prop len", none[0]?.delta.parts.length, some[0]?.delta.parts.length);

// Element tails, with lazy index side effects on the short-circuit.
let evals = 0;
function at(i: number): number {
  evals++;
  return i;
}
console.log("elem", none[0]?.delta.parts[at(0)], "evals", evals);
console.log("elem", some[0]?.delta.parts[at(1)], "evals", evals);
console.log("elem ?.[]", none?.[0]?.delta.parts[0], some?.[0]?.delta.parts[0]);

// Call tails: method call results and optional calls inside the chain.
console.log("call", none[0]?.pick().c, some[0]?.pick().c);
console.log("call ?.()", none[0]?.maybe?.().c, some[0]?.maybe?.().c, some[1]?.maybe?.().c);
let pushed = 0;
function sideEffect(): number {
  pushed++;
  return 1;
}
none[0]?.delta.parts.push(sideEffect());
some[1]?.delta.parts.push(sideEffect());
console.log("call args", pushed, some[1]!.delta.parts.length);

// A non-null assertion stays inside the chain (`a?.b!.c` is one chain).
console.log("assert", none[0]?.delta!.content, some[0]?.delta!.content);
console.log("assert ===", none[0]?.delta!.parts.length === undefined);

// Index-signature records: a missing key is undefined.
const byId: { [id: string]: Choice } = { a: some[0]! };
console.log("index", byId["zz"]?.delta.content, byId["a"]?.delta.content);
console.log("index dot", byId.zz?.delta.parts.length, byId.a?.delta.parts.length);

// Nested receivers and nested guards.
const grid: Choice[][] = [[], some];
console.log("nested", grid[0]?.[0]?.delta.content, grid[1]?.[0]?.delta.content);
console.log("nested", grid[5]?.[0].delta.content, grid[1]?.[1]?.delta.content);

// Optional members holding arrays.
const holder: { list?: Choice[] } = {};
const full: { list?: Choice[] } = { list: some };
console.log("member", holder.list?.[0].delta.content, full.list?.[0].delta.content);

// Strings and conditions.
const words: string[] = [];
const padded = ["  ab "];
console.log("string", words[0]?.trim().length, padded[0]?.trim().length);
console.log("typeof", typeof none[0]?.delta.content, typeof some[0]?.delta.content);
if (none[0]?.delta.content) console.log("unreachable");
else console.log("cond ok");
console.log(`template ${none[0]?.delta.content} ${some[0]?.delta.content}`);

// Typed JSON.parse results: an empty choices array short-circuits too.
type Chunk = { choices: { delta: Delta }[] };
const streamChunk = JSON.parse('{"choices":[]}') as Chunk;
console.log("json", streamChunk.choices[0]?.delta.content ?? "(no delta)");
const textChunk = JSON.parse('{"choices":[{"delta":{"content":"tok","parts":[]}}]}') as Chunk;
console.log("json", textChunk.choices[0]?.delta.content ?? "(no delta)");

// A PRESENT receiver followed by a missing step still throws: the guard
// covers only the receiver it tests.
function message(f: () => unknown): string {
  try {
    f();
    return "no throw";
  } catch (e) {
    return (e as Error).message;
  }
}
console.log("throws", message(() => some?.[5].delta));
console.log("throws", message(() => none[0].delta));
// Parentheses end the chain: the outer read sees undefined.
const loose = JSON.parse("{}");
console.log("parens", message(() => (loose.missing?.deep).deeper));
console.log("no parens", message(() => loose.missing?.deep.deeper));
