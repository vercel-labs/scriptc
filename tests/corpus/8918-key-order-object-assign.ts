// Object.assign creates the keys its target lacks in the source's own key
// order: the order a literal source writes them, a typed source's order, and
// the order of the text a parsed source came from. A key the target already
// has keeps its place.
function keysIn(value: object): string {
  const out: string[] = [];
  for (const k in value) out.push(k);
  return out.join(",");
}
interface Target { id: number; x?: number; y?: number; z?: number }
function show(tag: string, r: Target): void {
  console.log(tag, Object.keys(r).join(","), keysIn(r), JSON.stringify(r), r);
  console.log(tag, Object.keys({ ...r }).join(","), Object.entries(r).map((e) => e[0]).join(","));
}
const inline: Target = { id: 1 };
Object.assign(inline, { y: 1, x: 2 });
show("inline-source", inline);

interface Source { y: number; x: number }
const typedSource: Source = { y: 3, x: 4 };
const typed: Target = { id: 2 };
Object.assign(typed, typedSource);
show("typed-source", typed);

const existing: Target = { id: 3, x: 0 };
Object.assign(existing, { y: 5, x: 6 });
show("x-existing", existing);

function patch(target: Target, source: Partial<Target>): void {
  Object.assign(target, source);
}
const twice: Target = { id: 4 };
patch(twice, { y: 7 });
patch(twice, { x: 8 });
show("two-calls", twice);
const reversed: Target = { id: 5 };
patch(reversed, { z: 1, x: 2 });
patch(reversed, { y: 3, z: 4 });
show("patched", reversed);

const fromText: Target = { id: 6 };
Object.assign(fromText, JSON.parse('{"z":1,"x":2}') as Partial<Target>);
show("parsed-source", fromText);
const fromTextExisting: Target = { id: 7, z: 0 };
Object.assign(fromTextExisting, JSON.parse('{"y":1,"z":5,"x":2}') as Partial<Target>);
show("parsed-z-existing", fromTextExisting);

// A literal that spreads a dictionary builds its record source by source,
// and each source's keys arrive in that source's own order.
interface Settings { strict?: boolean; target?: number; label?: string; paths?: string[] }
const defaults: Settings = { target: 1, strict: false };
const extra: Record<string, unknown> = { paths: ["src"], label: "configured" };
const settings: Settings = { ...defaults, ...extra };
console.log(Object.keys(settings).join(","), keysIn(settings), JSON.stringify(settings));
const reversed2: Settings = { ...extra, ...defaults };
console.log(Object.keys(reversed2).join(","), keysIn(reversed2), JSON.stringify(reversed2));
const declared: Settings = { strict: true, target: 2, label: "l", paths: [] };
const kept: Settings = { ...declared, ...extra };
console.log(Object.keys(kept).join(","), JSON.stringify(kept));
