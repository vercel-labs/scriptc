// Records that get undeclared keys without any conversion written in the
// program: untyped code writes its own objects into typed values it was
// handed (a parameter, a callback's argument, an element, a map entry, a
// field). Each record still answers for the whole object.
type Rec = { a: number; b: string };

// A typed function called through an untyped reference.
function keysOf(r: Rec): string {
  return Object.keys(r).join(",") + " " + JSON.stringify(r) + " " + Object.values(r).length;
}
const call: any = keysOf;
console.log(call({ a: 1, b: "x", extra: 2 }));
console.log(keysOf({ a: 5, b: "t" }));

// A typed callback handed to an untyped array.
const loose: any = [{ b: "x", a: 1, extra: 1 }];
loose.forEach((r: Rec) => {
  console.log(Object.keys(r).join(","), JSON.stringify(r));
});

// An element pushed through an untyped view of a typed array.
const list: Rec[] = [{ a: 0, b: "z" }];
const listView: any = list;
listView.push({ a: 1, b: "x", extra: 1 });
console.log(Object.keys(list[0]!).join(","), Object.keys(list[1]!).join(","), JSON.stringify(list));

// An entry set through an untyped view of a typed map.
const byName = new Map<string, Rec>();
const mapView: any = byName;
mapView.set("k", { a: 1, b: "x", extra: 1 });
const got = byName.get("k")!;
console.log(Object.keys(got).join(","), JSON.stringify(got), Object.entries(got).length);

// A field written through an untyped view of its holder.
const holder: { inner: Rec; n: number } = { inner: { a: 1, b: "x" }, n: 1 };
const holderView: any = holder;
holderView.inner = { a: 2, b: "y", extra: 3 };
console.log(Object.keys(holder.inner).join(","), JSON.stringify(holder.inner), Object.values(holder.inner).length);
