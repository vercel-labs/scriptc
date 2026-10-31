// A record converted from an object with more properties, then viewed as
// unknown: the view lists and tests the object's other properties as Node
// does, and writes through it still reach the record.
type Two = { a: number; b: number };
const source = { a: 1, b: 2, c: 3 };
const two: Two = source;
const view: unknown = two;
const obj = view as Record<string, unknown>;
console.log(Object.keys(obj).join(","), JSON.stringify(view), "c" in obj, Object.hasOwn(obj, "c"));
console.log(Object.values(obj), Object.entries(obj));
const seen: string[] = [];
for (const k in obj) seen.push(k);
console.log(seen.join(","), obj["c"]);
const { a: first, ...rest } = obj;
console.log(first, rest, Object.assign({}, obj), { ...obj });

// Writes through the view, before and after the view lists its keys.
obj.a = 10;
console.log(two.a, JSON.stringify(two), Object.keys(obj).length);
obj.b = 20;
console.log(two.b, JSON.stringify(view));

// A nested record written through the view after a key walk.
type Point = { x: number; y: number };
type Box = { inner: Point; tag: string };
const wide = { inner: { x: 1, y: 2 }, tag: "t", extra: true };
const box: Box = wide;
const boxView: unknown = box;
const boxObj = boxView as { inner: Record<string, unknown> } & Record<string, unknown>;
console.log(Object.keys(boxObj).join(","), JSON.stringify(boxView));
boxObj.inner.x = 7;
console.log(box.inner.x, JSON.stringify(box));

// A copy converted twice, viewed as unknown.
type One = { a: number };
const one: One = two;
const oneView: unknown = one;
console.log(JSON.stringify(oneView), Object.keys(oneView as object).join(","));

// A spread of a linked copy keeps the copy's other properties, and a copy
// of a spread-built record views as its source does.
const spreadOfCopy: Two = { ...two };
console.log(Object.keys(spreadOfCopy).join(","), JSON.stringify(spreadOfCopy));
type Wide = { a: number; b: number; c: number };
const wideRecord: Wide = { a: 1, b: 2, c: 3 };
const fromSpread: Two = { ...wideRecord };
const fromSpreadView: unknown = fromSpread;
console.log(JSON.stringify(fromSpreadView), Object.keys(fromSpreadView as object).join(","));
const fromSpreadCopy: One = fromSpread;
console.log(JSON.stringify(fromSpreadCopy), Object.keys(fromSpreadCopy as object).join(","));
