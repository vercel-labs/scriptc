// Object.freeze of records that other references still hold: writes
// through any reference then throw Node's TypeError (this module is strict
// mode code; 7405 covers sloppy mode). Covers static freezes, freezes
// through untyped values, Object.isFrozen, keyed writes and deletes,
// optional-field deletes, Object.assign, tuples, and frozen records that are
// released or collected as cycles.
export {};

type Counter = { count: number; label: string };
type Link = { name: string; next?: Link };

function report(e: unknown): void {
  console.log((e as Error).name + ": " + (e as Error).message);
}

function freezeUnknown(value: unknown): unknown {
  return Object.freeze(value);
}

function isFrozenUnknown(value: unknown): boolean {
  return Object.isFrozen(value);
}

function deepFreeze(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

type Config = { name: string; limits: { max: number; min: number } };

function bump(c: Counter): void {
  c.count += 1;
}

function writes(): void {
  const a: Counter = { count: 1, label: "a" };
  const alias = a;
  console.log(Object.isFrozen(a), isFrozenUnknown(a));
  const frozen = Object.freeze(alias);
  console.log(frozen === a, Object.isFrozen(a), isFrozenUnknown(alias));
  try { bump(a); } catch (e) { report(e); }
  try { a.label = "b"; } catch (e) { report(e); }
  console.log(a.count, a.label, JSON.stringify(a));

  const viaUnknown: Counter = { count: 10, label: "u" };
  const back = freezeUnknown(viaUnknown);
  console.log(back === viaUnknown, Object.isFrozen(viaUnknown));
  try { viaUnknown.count = 11; } catch (e) { report(e); }
  console.log(viaUnknown.count);

  const dict: Record<string, number> = { one: 1 };
  const dictAlias = dict;
  Object.freeze(dictAlias);
  try { dict["one"] = 2; } catch (e) { report(e); }
  try { dict["two"] = 2; } catch (e) { report(e); }
  try { delete dict["one"]; } catch (e) { report(e); }
  delete dict["three"];
  console.log(JSON.stringify(dict), Object.isFrozen(dict));

  const optional: { id: number; note?: string } = { id: 1, note: "n" };
  const optionalAlias = optional;
  Object.freeze(optionalAlias);
  try { delete optional.note; } catch (e) { report(e); }
  console.log(JSON.stringify(optional));
  const bare: { id: number; note?: string } = { id: 2 };
  Object.freeze(bare);
  delete bare.note;
  console.log(JSON.stringify(bare));

  const target: Counter = { count: 0, label: "t" };
  Object.freeze(target);
  try { Object.assign(target, { count: 5, label: "x" }); } catch (e) { report(e); }
  console.log(JSON.stringify(target));

  const pair: [string, number] = ["p", 1];
  Object.freeze(pair);
  try { pair[1] = 2; } catch (e) { report(e); }
  console.log(pair[0], pair[1]);
}

function deepFreezes(): void {
  const config: Config = JSON.parse('{"name":"c","limits":{"max":2,"min":1}}');
  const limits = config.limits;
  console.log(Object.isFrozen(config), Object.isFrozen(limits));
  deepFreeze(config);
  console.log(Object.isFrozen(config), Object.isFrozen(limits), isFrozenUnknown(config.limits));
  try { config.limits.max = 3; } catch (e) { report(e); }
  try { limits.min = 0; } catch (e) { report(e); }
  try { config.name = "d"; } catch (e) { report(e); }
  console.log(JSON.stringify(config));
}

function lifetimes(): void {
  const list: Counter[] = [];
  for (let i = 0; i < 4; i++) {
    const item: Counter = { count: i, label: "x" + i };
    list.push(item);
    if (i % 2 === 1) Object.freeze(item);
  }
  for (const item of list) {
    try { item.count = item.count * 10; } catch (e) { console.log(item.label, (e as Error).message); }
  }
  console.log(JSON.stringify(list));
  const kept = list[1]!;
  list.length = 0;
  console.log(kept.count, Object.isFrozen(kept));

  for (let round = 0; round < 3; round++) {
    const first: Link = { name: "first" + round };
    const second: Link = { name: "second" + round, next: first };
    first.next = second;
    Object.freeze(first);
    Object.freeze(second);
    try { first.name = "changed"; } catch (e) { report(e); }
    console.log(first.next?.name, second.next?.name);
  }
}

writes();
deepFreezes();
lifetimes();
