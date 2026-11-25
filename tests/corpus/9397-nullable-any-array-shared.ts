// Pins: a value typed `any[] | undefined` or `any[] | null` is the same
// checked-dynamic array an `any[]` is. A function that receives one and
// writes to it writes to the caller's array, and a function may hand it on
// to another function whose parameter has the same type.
function append(bucket: any[] | undefined, item: unknown): any[] {
  const target = bucket ?? [];
  target.push(item);
  return target;
}
const shelf: any[] = ["atlas"];
const same = append(shelf, 7);
console.log(JSON.stringify(same), same === shelf, JSON.stringify(shelf), shelf.length);
const fresh = append(undefined, "solo");
console.log(JSON.stringify(fresh), fresh.length, Array.isArray(fresh));

// Handed on: both functions declare the nullable array.
function count(bucket: any[] | null): number {
  return bucket === null ? -1 : bucket.length;
}
function grow(bucket: any[] | null): number {
  if (bucket !== null) bucket.push({ added: true });
  return count(bucket) + 1;
}
const crate: any[] = [1, "two"];
console.log(grow(crate), grow(null), JSON.stringify(crate));

function latest(bucket: any[] | undefined): any[] | undefined {
  return bucket;
}
function drain(bucket: any[] | undefined): string {
  const held = latest(bucket);
  if (held === undefined) return "none";
  const last = held.pop();
  return `${String(last)} of ${held.length + 1}`;
}
const queue: any[] = ["a", "b", "c"];
console.log(drain(queue), drain(queue), drain(undefined), JSON.stringify(queue));

// A declared local that takes the parameter, and a ternary with a literal.
function collect(seed: any[] | undefined, extra: number): any[] {
  let list: any[] = [];
  if (seed !== undefined) list = seed;
  list.push(extra);
  return list;
}
const seeds: any[] = [true];
const collected = collect(seeds, 3);
console.log(JSON.stringify(collected), collected === seeds, JSON.stringify(collect(undefined, 4)));

function orEmpty(seed: any[] | null): any[] {
  return seed === null ? [] : seed;
}
const kept: any[] = [null, "x"];
const again = orEmpty(kept);
again.push([1, 2]);
console.log(JSON.stringify(kept), again === kept, JSON.stringify(orEmpty(null)), orEmpty(null).length);

// An optional parameter is the same nullable type.
function tag(names?: any[]): number {
  const all = names ?? [];
  all.push("tagged");
  return all.length;
}
const names: any[] = ["n"];
console.log(tag(names), tag(), JSON.stringify(names));
