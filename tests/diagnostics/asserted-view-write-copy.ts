// `const view = value as T` where T names a member the value's own layout
// does not hold builds a copy of the value, so a write through the binding
// would land on that copy while Node erases the assertion and writes the
// original object. Refused by name instead of diverging; reads of such a
// copy are equal either way and stay allowed.
interface Base {
  a: number;
}
const base: Base = { a: 1 };

// File scope: the copy would live in the module binding.
const widened = base as { a: number; extra?: string };
widened.extra = "x";

// A function's local binding takes the same path.
function widen(b: Base): void {
  const local = b as { a: number; extra?: string };
  local.extra = "y";
}

// A union operand whose arms hold no such member copies too.
function widenUnion(u: Base | { a: number; b: number }): void {
  const view = u as { extra?: string };
  view.extra = "z";
}

// A nested write is still a write to the copy when the view reshapes the
// member it goes through: the copy rebuilds that child, so the write would
// not reach the value's own child.
interface Bag {
  id: number;
  item: { n: number };
  extra: string;
}
interface WideBag {
  item: { n: number; label: string };
  extra: string;
}
const bag: Bag = { id: 1, item: { n: 0 }, extra: "x" };
const bagView = bag as unknown as WideBag;
bagView.item.n = 2;

// A shared write before a write to the copy's own field does not hide the
// latter: the refusal names the own-field write.
interface Holder {
  item: { n: number };
  extra: string;
}
interface HolderView {
  item: { n: number };
  extra: string;
  tag?: string;
}
const holder: Holder = { item: { n: 0 }, extra: "x" };
const holderView = holder as unknown as HolderView;
holderView.item.n = 3;
holderView.tag = "t";

widen(base);
widenUnion(base);
