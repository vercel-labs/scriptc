// Pins: an array literal that reaches an `unknown[]` or `any[]` slot through
// `??`, `||`, `?:`, a default or a return is the array the program keeps:
// any value the static type allows can be pushed into it afterwards. The
// element type of an empty literal comes from that context, not from the
// literal (which has none).

// Grouping: an untyped record holds one list per station.
const byStation: Record<string, unknown> = {};
function log(station: string, reading: unknown): void {
  const readings = (byStation[station] as unknown[] | undefined) ?? [];
  readings.push(reading);
  byStation[station] = readings;
}
log("north", 12.5);
log("north", "offline");
log("pier", { gust: 31 });
log("pier", null);
log("north", [1, 2]);
console.log(JSON.stringify(byStation));

function nullish(x: unknown[] | undefined): unknown[] {
  const list = x ?? [];
  list.push("s", 1, { a: 1 }, [2], null, true);
  return list;
}
function or(x: unknown[] | undefined): unknown[] {
  const list = x || [];
  list.push("s");
  list.push(2);
  return list;
}
function conditional(x: unknown[] | undefined): unknown[] {
  const list = x ? x : [];
  list.push({ k: "v" });
  list.push("t");
  return list;
}
function conditionalFirst(x: unknown[] | undefined): unknown[] {
  const list = x === undefined ? [] : x;
  list.push(3, "u");
  return list;
}
function defaulted(list: unknown[] = []): unknown[] {
  list.push("d", 4);
  return list;
}
function destructured(options: { items?: unknown[] }): unknown[] {
  const { items = [] } = options;
  items.push("e", 5);
  return items;
}
function fromMember(options: { items?: unknown[] }): unknown[] {
  const list = options.items ?? [];
  list.push("m", 6);
  return list;
}
function fromIndex(table: Record<string, unknown[]>, key: string): unknown[] {
  const list = table[key] ?? [];
  list.push("i", 7);
  return list;
}
function returned(x: unknown[] | undefined): unknown[] {
  return x ?? [];
}
function passed(x: unknown[] | undefined): unknown[] {
  return defaulted(x ?? []);
}

const given: unknown[] = ["z"];
console.log(JSON.stringify(nullish(undefined)), JSON.stringify(or(undefined)));
console.log(JSON.stringify(conditional(undefined)), JSON.stringify(conditionalFirst(undefined)));
console.log(JSON.stringify(defaulted()), JSON.stringify(destructured({})));
console.log(JSON.stringify(fromMember({})), JSON.stringify(fromIndex({}, "k")));
const fresh = returned(undefined);
fresh.push("r", 8);
console.log(JSON.stringify(fresh), JSON.stringify(passed(undefined)));

// A value that is present keeps its identity: the push is the caller's too.
console.log(nullish(given) === given, or(given) === given, conditional(given) === given);
console.log(conditionalFirst(given) === given, defaulted(given) === given);
console.log(destructured({ items: given }) === given, fromMember({ items: given }) === given);
console.log(fromIndex({ k: given }, "k") === given, returned(given) === given, passed(given) === given);
console.log(given.length, JSON.stringify(given));

// A filled literal is the program's array as well: its elements do not fix
// what may follow them.
function filled(x: unknown[] | undefined): unknown[] {
  const list = x ?? ["first"];
  list.push(2, { third: 3 });
  return list;
}
function filledConditional(x: unknown[] | undefined): unknown[] {
  const list = x ? x : [1, 2];
  list.push("three");
  return list;
}
console.log(JSON.stringify(filled(undefined)), JSON.stringify(filledConditional(undefined)));

// `any[]` slots take the literal the same way.
function anyNullish(x: any[] | undefined): any[] {
  const list = x ?? [];
  list.push("s", 1, { a: 1 });
  return list;
}
function anyDeclared(): any[] {
  const list: any[] = [];
  list.push("s");
  list.push(2, [3]);
  return list;
}
function anyDestructured(options: { items?: any[] }): any[] {
  const { items = [] } = options;
  items.push("e", 5);
  return items;
}
function anyMember(options: { items?: any[] }): any[] {
  const list = options.items ?? [];
  list.push("m", null);
  return list;
}
console.log(JSON.stringify(anyNullish(undefined)), JSON.stringify(anyDeclared()));
console.log(JSON.stringify(anyDestructured({})), JSON.stringify(anyMember({})));

// Typed slots are unchanged: the literal takes the slot's element type.
function strings(x: string[] | undefined): string[] {
  const list = x ?? [];
  list.push("only strings");
  return list;
}
function mixed(x: (string | number)[] | undefined): (string | number)[] {
  const list = x ? x : [];
  list.push("a", 1);
  return list;
}
console.log(JSON.stringify(strings(undefined)), JSON.stringify(mixed(undefined)));
