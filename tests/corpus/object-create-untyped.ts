// Object.create results kept untyped: the created object inherits from its
// prototype, owns only what is defined on it, and sees later writes to the
// prototype.
const proto = { greet(): string { return "hi " + this.name; }, name: "proto", shared: 1 };
const child: any = Object.create(proto);
child.name = "own";
console.log(child.greet(), Object.keys(child).join(","), JSON.stringify(child), Object.hasOwn(child, "shared"));
console.log(Object.getPrototypeOf(child) === proto, child.shared);
proto.shared = 2;
console.log(child.shared, "shared" in child);

const bare: any = Object.create(null);
bare.x = 1;
console.log(Object.getPrototypeOf(bare) === null, Object.keys(bare).join(","), "toString" in bare);

const described: any = Object.create(null, { v: { value: 3, enumerable: true }, h: { value: 4 } });
console.log(described.v, described.h, Object.keys(described).join(","), Object.getPrototypeOf(described) === null);

const both: any = Object.create({ p: 1 }, { v: { value: 3, enumerable: true, writable: true }, g: { get() { return 7; }, enumerable: true } });
both.v = 5;
console.log(both.v, both.g, both.p, Object.keys(both).join(","), JSON.stringify(both));

const dictionary: Record<string, number> = Object.create(null);
dictionary.a = 1;
console.log(Object.keys(dictionary).join(","), JSON.stringify(dictionary), "toString" in dictionary);
const viewed = Object.create(proto) as Record<string, unknown>;
console.log(viewed.name, Object.keys(viewed).length, Object.getPrototypeOf(viewed) === proto);

// A descriptor's value is the program's own object: the created object
// holds it by reference.
const list = [1];
const shared = { n: 1 };
const holder: any = Object.create(null, {
  list: { value: list, enumerable: true },
  shared: { value: shared, enumerable: true, writable: true },
});
list.push(2);
shared.n = 2;
console.log(holder.list === list, holder.list.length, holder.shared === shared, holder.shared.n);
const target: any = {};
Object.defineProperties(target, { list: { value: list, enumerable: true }, hidden: { value: shared } });
list.push(3);
console.log(target.list === list, target.list.length, target.hidden === shared, Object.keys(target).join(","));
