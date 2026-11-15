// The untyped empty array of `{ files: [] }` is typed by where its value
// goes, wherever that is: another module, a record stored in a Map and also
// returned, a callback's result, a conditional arm, an assertion through
// `unknown`. Each holder sees the one array.
import { count, shared } from "./state.ts";

interface Info {
  names: string[];
  count: number;
}

// Another module reads the field at a typed slot.
function addTo(list: string[], value: string): void {
  list.push(value);
}
addTo(shared.files, "x");
const local: string[] = shared.files;
local.push("y");
console.log("module", count(), shared.files.length, local === shared.files);

// A record stored in a Map and returned from the same function: the Map and
// the caller hold the same record and the same array.
const table = new Map<string, Info>();
function infoFor(key: string): Info {
  const existing = table.get(key);
  if (existing) return existing;
  const created = { names: [], count: 0 };
  table.set(key, created);
  return created;
}
infoFor("a").names.push("first");
infoFor("a").count += 1;
infoFor("a").names.push("second");
console.log(
  "stored and returned",
  table.get("a")!.names.join(","),
  table.get("a")!.count,
  infoFor("a") === table.get("a"),
  infoFor("a").names === table.get("a")!.names,
);

// A callback's result into a typed array.
interface Row {
  name: string;
  tags: string[];
}
const rows: Row[] = ["a", "b"].map((name) => ({ name, tags: [] }));
rows[0]!.tags.push("t");
console.log("callback", JSON.stringify(rows));

// A conditional arm beside a typed value.
function load(): Info {
  return { names: ["loaded"], count: 1 };
}
const flag = process.argv.length < 99;
const picked = flag ? { names: [], count: 0 } : load();
picked.names.push("picked");
console.log("conditional", JSON.stringify(picked));

// An assertion through `unknown`.
interface Result {
  content: string[];
}
function normalize(value: { content?: string[] }): Result {
  return (value.content === undefined ? { ...value, content: [] } : value) as unknown as Result;
}
const normalized = normalize({});
normalized.content.push("c");
console.log("assertion", normalized.content.length, JSON.stringify(normalized));

// A const table: an empty tuple read where a readonly array is declared.
const commands = [
  { name: "list", aliases: ["ls"] },
  { name: "agent", aliases: [] },
] as const;
function aliasesOf(command: { name: string; aliases: readonly string[] }): string {
  return [command.name, ...command.aliases].join("|");
}
console.log("const table", aliasesOf(commands[0]), aliasesOf(commands[1]), commands[1].aliases.length);
const agent = { name: "agent", aliases: [] } as const;
const view: readonly string[] = agent.aliases;
console.log("const record", view === agent.aliases, view.length);

// A shared empty constant used as a sentinel: every reader gets the one array.
const NONE = [] as const;
function tagsOf(known: boolean): readonly string[] {
  return known ? ["t"] : NONE;
}
const none = tagsOf(false);
console.log("sentinel", none.length, none === NONE, tagsOf(false) === tagsOf(false), tagsOf(true).length);
