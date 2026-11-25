// A native WeakMap or WeakSet has no island export (weak storage cannot
// cross), so passing one into an island is SC8010 where it crosses, not a
// TypeError from the runtime when the program runs. A weak collection is a
// checked-dynamic value natively, so the refusal is decided by its declared
// type, before the representation is asked. A member of a literal crosses
// by the same rule, and so does a union with such an arm.
import { take, line } from "take-pkg";

const labels = new WeakMap<object, string>();
const seen = new WeakSet<object>();
function pass(either: WeakSet<object> | string): string {
  return take(either);
}

console.log(take(labels));
console.log(take(seen));
console.log(pass(seen));
console.log(line({ user: "ada", labels }));
// What the table holds still crosses: a Map, a Set, bytes.
console.log(take(new Map<string, number>()), take(new Set<number>()), take(new Uint8Array(1)));
