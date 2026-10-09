// Writes that cannot hold a function never replace a class method, so they
// must not turn same-named method calls elsewhere into dynamic dispatch:
// a string-keyed dictionary of data records, and constructor writes to data
// fields that share a name with an unrelated class's method.
interface Entry {
  name: string;
  weight: number;
  aliases: Map<string, number> | undefined;
}
interface Changes {
  changed?: string[];
  deleted?: string[];
}
type Json =
  | { type: "null" }
  | { type: "boolean"; value: boolean }
  | { type: "object"; entries: Map<string, Json> };

class Registry {
  private readonly byName = new Map<string, Entry>();
  constructor(entries: readonly Entry[]) {
    for (const entry of entries) this.byName.set(entry.name.toLowerCase(), entry);
  }
  get(name: string): Entry | undefined {
    return this.byName.get(name.toLowerCase());
  }
}

class Scanner {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
  literal(word: string, value: Json): Json | undefined {
    if (!this.text.startsWith(word, this.pos)) return undefined;
    this.pos += word.length;
    return value;
  }
}

class Token {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}
class LiteralNode {
  literal: Token;
  value: string;
  constructor(literal: Token) {
    this.literal = literal;
    this.value = literal.text;
  }
}

function collect(ids: readonly string[]): Record<string, Changes> | undefined {
  let changes: Record<string, Changes> | undefined;
  for (const id of ids) {
    changes ??= {};
    changes[id] = { changed: [id] };
  }
  return changes;
}

function weightOf(entry: Entry | undefined): number {
  return entry === undefined ? -1 : entry.weight;
}
function show(json: Json | undefined): string {
  if (json === undefined) return "none";
  if (json.type === "object") return `object ${json.entries.size}`;
  return json.type === "boolean" ? `boolean ${json.value}` : "null";
}

const registry = new Registry([
  { name: "Alpha", weight: 3, aliases: new Map([["a", 1]]) },
  { name: "beta", weight: 5, aliases: undefined },
]);
console.log(weightOf(registry.get("alpha")), weightOf(registry.get("BETA")), weightOf(registry.get("gamma")));
const scanner = new Scanner("truenull");
console.log(show(scanner.literal("true", { type: "boolean", value: true })));
console.log(show(scanner.literal("true", { type: "boolean", value: true })));
console.log(show(scanner.literal("null", { type: "null" })));
console.log(show(new Scanner("{}").literal("{}", { type: "object", entries: new Map() })));
console.log(registry.get("alpha")?.aliases?.get("a"), registry.get("beta")?.aliases);
const node = new LiteralNode(new Token("42"));
console.log(node.literal.text, node.value);
const changes = collect(["p1", "p2"]);
for (const [id, change] of Object.entries(changes ?? {})) console.log(id, change.changed?.join(","), change.deleted);
console.log(collect([]));
