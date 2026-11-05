// Localized failure, stage L4: expressions whose own type does not
// compile (casts, literals with an unmappable contextual type, spread
// clones, temporaries).
type Hook = Map<string, (x: number) => string> | AbortSignal | (() => number) | Set<string>;
interface Plugin {
  name: string;
  hook: Hook;
}
function load(text: string): unknown {
  return JSON.parse(text);
}
function count(p: { name: string }): number {
  return p.name.length;
}
const raw = load('{"name":"tags","hook":null}');
// A cast to a type that does not compile.
console.log(count(raw as Plugin));
// A literal whose contextual type does not compile, used without a slot.
console.log(count({ name: "lit", hook: () => 1 } as Plugin));
// A spread clone of such a value.
const base = { name: "base", hook: new Set(["a"]) };
console.log(count({ ...(base as Plugin), name: "clone" }));
// A temporary: an array literal of them, mapped.
console.log([{ name: "a", hook: () => 2 } as Plugin, { name: "bb", hook: new Set<string>() } as Plugin].map((p) => p.name).join("+"));
