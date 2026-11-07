// A get or set accessor written as a member of a property descriptor map
// literal. Object.defineProperties and Object.create read the map as any
// object: the member's value is what its getter answers, and a member with
// only a setter reads as undefined, which is not a descriptor.
const items: number[] = [1];
const target: Record<string, unknown> = {};
Object.defineProperties(target, {
  plain: { value: 1, enumerable: true },
  get computed() {
    return { value: items, enumerable: true };
  },
});
console.log(Object.keys(target), target["plain"], target["computed"] === items);

let reads = 0;
const counted: Record<string, unknown> = {};
Object.defineProperties(counted, {
  get first() {
    reads++;
    return { value: reads, enumerable: true };
  },
  second: { value: "two", enumerable: false },
});
console.log(reads, counted["first"], Object.keys(counted), counted["second"]);

try {
  const created: unknown = Object.create(null, {
    set ignored(_descriptor: PropertyDescriptor) {},
  });
  console.log("created", created);
} catch (e) {
  console.log(e instanceof TypeError, (e as Error).message);
}
