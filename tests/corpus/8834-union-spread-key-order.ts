// A spread whose source is a union with several record arms (or a record
// that may be absent) into one declared record copies the running arm's own
// keys, in the arm's own order, then the literal's later contributions:
// Object.keys and JSON.stringify must match Node.
//
// The arm values are created in an order that differs from their arm's
// declaration order, which is what makes the order value-dependent. The
// creation order of a plain (non-union) record source is a separate,
// pre-existing limitation and is not exercised here.

interface Opts {
  apiKey?: string;
  headers?: string;
  env?: string;
  maxTokens?: number;
  label?: string;
}

function show(o: Opts): string {
  return JSON.stringify(o) + " " + Object.keys(o).join(",");
}

type Src = { env?: string; apiKey: string } | { label: string; headers?: string } | undefined;

// A multi-arm union and its absent arm into one declared record: each arm
// copies only the keys it holds, in the order its value holds them, and the
// literal's own keys follow.
function merge(base: Opts, src: Src): string {
  return show({ ...base, ...src, maxTokens: 1 });
}

// apiKey before env, as the arm's value was created (the arm declares env
// first).
console.log(merge({ headers: "h0" }, { apiKey: "k", env: "e" }));
// An override keeps the earlier position; the arm's remaining key appends.
console.log(merge({ apiKey: "k0", headers: "h0" }, { apiKey: "k" }));
console.log(merge({ headers: "h0" }, { label: "l" }));
console.log(merge({ headers: "h0" }, { label: "l", headers: "h1" }));
// The absent arm copies nothing.
console.log(merge({ apiKey: "k0" }, undefined));

interface Compat {
  b?: string;
  image?: boolean;
  a?: boolean;
}

interface Chat {
  type?: "chat";
  id: string;
  window: number;
  compat?: Compat;
}

function showChat(c: Chat): string {
  return JSON.stringify(c) + " " + Object.keys(c).join(",");
}

// A nested spread of a record that may be absent (`Compat | undefined`) into
// the declared `Compat`: the absent value contributes no keys, and `a` lands
// after the keys the present value holds.
function rebase(chat: Chat, compat: Compat | undefined): string {
  return showChat({ ...chat, compat: { ...compat, a: true } });
}

console.log(rebase({ id: "c", window: 1 }, { b: "y", image: true }));
console.log(rebase({ id: "c", window: 2, compat: { b: "x" } }, undefined));

// The spread sources are copied, never written.
const base: Opts = { headers: "h" };
const src: Src = { env: "e2", apiKey: "k" };
console.log(merge(base, src));
console.log(JSON.stringify(base), JSON.stringify(src));
