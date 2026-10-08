// A non-null assertion has no runtime effect: an out-of-range read stays
// undefined wherever array storage, an equality test, or an optional slot
// receives it.
class Child {
  v = 1;
}
const kids: Child[] = [new Child()];
const a = [kids[5]!];
console.log(a.length, a[0] === undefined);
const typed: Child[] = [kids[7]!, kids[0]!];
console.log(typed.length, typed[0] === undefined, typed[1] === kids[0]);
const later: Child[] = [];
later.push(kids[3]!);
later.unshift(kids[4]!);
later[2] = kids[0]!;
later[3] = kids[8]!;
console.log(later.length, later[0] === undefined, later[1] === undefined, later[2] === kids[0], later[3] === undefined);
function describe(c: Child | undefined): string {
  return c === undefined ? "missing" : "present " + c.v;
}
console.log(describe(kids[9]!), describe(kids[0]!));
const nums = [1, 2];
const b = [nums[4]!, nums[0]!];
console.log(b.length, b[0] === undefined, b[1]);
const words = ["x"];
const c = [(words[2]!), words[0]!];
console.log(c.length, c[0] === undefined, c[1], c.join("-"));
const xs = [1, 2, 3];
console.log(xs[3]! === undefined, xs[0]! === undefined, xs[5]! !== undefined, xs[1]! === 2);
console.log(kids[4]! === undefined, undefined === kids[4]!, kids[0]! === kids[0], kids[2]! == null);
