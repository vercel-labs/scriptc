// Object.assign adds its source's properties to the target in the order the
// source object created them, so the target lists the keys it gains in that
// order after the keys it already had.
interface Parcel {
  id: string;
  fragile?: boolean;
  label?: string;
  weight?: number;
}
type Extra = { fragile?: boolean; label?: string; weight?: number };

function show(parcel: Parcel): void {
  const seen: string[] = [];
  for (const key in parcel) seen.push(key);
  console.log(Object.keys(parcel).join(","), "|", seen.join(","), "|", JSON.stringify(parcel));
}

// A literal source: weight before label, the reverse of their names' order.
const first: Parcel = { id: "p1" };
Object.assign(first, { weight: 3, label: "books" });
show(first);

// Sources of one type built in different orders.
const heavy: Extra = { weight: 40, fragile: false, label: "anvil" };
const light: Extra = { label: "feathers", weight: 1 };
const second: Parcel = { id: "p2" };
Object.assign(second, heavy);
show(second);
const third: Parcel = { id: "p3" };
Object.assign(third, light);
show(third);

// A key the target already has keeps its place; the new ones follow.
const fourth: Parcel = { id: "p4", label: "kept" };
Object.assign(fourth, { weight: 9, label: "relabelled", fragile: true });
show(fourth);

// Through a function, and twice on one target.
function stamp(target: Parcel, extra: Extra): void {
  Object.assign(target, extra);
}
const fifth: Parcel = { id: "p5" };
stamp(fifth, { fragile: true });
stamp(fifth, heavy);
show(fifth);

// The source is unchanged, and entries follow the same order as keys.
console.log(Object.keys(heavy).join(","), Object.keys(light).join(","));
console.log(
  Object.entries(second)
    .map(([key, value]) => key + "=" + String(value))
    .join(" "),
);
