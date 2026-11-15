// `const view = value as T` where T names a member the value's own layout
// does not hold: a write through the binding would land on the conversion
// while Node erases the assertion and writes the original object. Refused
// by name instead of diverging. An assertion that only ADDS optional
// members keeps the value's layout, so the write to the added member is
// refused where it happens; the union operand and the reshaped view below
// convert, and those bindings' writes are refused at the declaration.
interface Base {
  a: number;
}
const base: Base = { a: 1 };

// File scope: the binding keeps the value's layout, and the write to the
// added member has no slot to reach.
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

// A shared write before a write to the added member does not hide the
// latter: the nested write reaches the value's own child, and the added
// member is refused where it is written.
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
