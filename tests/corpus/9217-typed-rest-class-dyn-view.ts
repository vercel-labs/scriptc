// A class whose only non-data member is a typed-rest callback still has a
// faithful checked-dynamic view: the typed-rest signature is inside the
// checked conversion's domain, so the view exists, reads the data fields
// live (functions are omitted by JSON, as in Node), and the value comes back
// by identity with its rest callback intact.
class Bucket {
  readonly items = new Map<string, number>();
  readonly add = (...values: number[]): number => values.length;
  total = 0;
  push(value: number): number {
    this.total += value;
    this.items.set(String(this.total), value);
    return this.total;
  }
}
function throughUnknown(value: unknown): unknown { return value; }
const bucket = new Bucket();
const view = throughUnknown(bucket);
for (let i = 1; i <= 3; i++) {
  if (JSON.stringify(view) !== JSON.stringify(bucket)) throw new Error("view diverged");
  const back = view as Bucket;
  if (back !== bucket) throw new Error("identity lost");
  console.log(back.push(i), back.add(1, 2, 3));
}
console.log(JSON.stringify(view), view instanceof Bucket);
