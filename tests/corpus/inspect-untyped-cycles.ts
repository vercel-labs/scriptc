// A container that holds itself through an untyped value prints as Node
// prints it: <ref *N> on the value and [Circular *N] where it recurs.
import * as util from "node:util";

const list: unknown[] = [1];
list.push(list);
console.log(list);
console.log(util.inspect(list), util.inspect(list, { depth: 0 }));

const map = new Map<string, unknown>();
map.set("self", map);
console.log(map);

const set = new Set<unknown>();
set.add(set);
console.log(set);

const dictionary: Record<string, unknown> = { a: 1 };
dictionary.self = dictionary;
console.log(dictionary);

const owner: { name: string; kids: unknown[] } = { name: "o", kids: [] };
owner.kids.push(owner);
console.log(owner);
console.log(util.inspect(owner, { depth: 0 }));

const nested: unknown[][] = [[]];
nested[0]!.push(nested);
console.log(nested);

const pair: [unknown, number] = [null, 1];
pair[0] = pair;
console.log(pair);

const byKey = new Map<string, unknown[]>();
const inner: unknown[] = [];
byKey.set("k", inner);
inner.push(byKey);
console.log(byKey);
console.log(inner);

const members = new Set<unknown[]>();
const member: unknown[] = [];
members.add(member);
member.push(members);
console.log(members);

const a: unknown[] = [];
const b: unknown[] = [a];
a.push(b);
console.log(a, b);
console.log(util.inspect({ a, b }));
console.log(util.format("%o|%O|%j", a, b, [1]));
try {
  console.log(JSON.stringify(a));
} catch (error) {
  console.log((error as Error).name, (error as Error).message.split("\n")[0]);
}

const loose: any[] = [];
loose.push(loose);
console.log(loose, `${util.inspect(loose)}`);

// Shared but not circular values print in full each time.
const shared: unknown[] = [1, 2];
console.log([shared, shared], { x: shared, y: [shared] });
const sharedMap = new Map<string, unknown>([["k", 1]]);
console.log([sharedMap, sharedMap]);
