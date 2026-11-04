// A class instance intersected with data members the class does not declare
// maps to the checked-dynamic model (tests/corpus/class-expando-intersection.ts).
// A constituent that restates a member the class declares, or an index
// signature that names every key, refines the class instead and keeps its
// refusal.
class Box {
  w = 1;
  area(): number {
    return this.w * 2;
  }
}
type Narrowed = Box & { w: 1; label?: string };
function narrowed(view: Narrowed): number {
  return view.w;
}
console.log(narrowed(new Box() as Narrowed));

type Keyed = Box & { [name: string]: number };
function keyed(view: Keyed, key: string): number {
  return view[key]!;
}
console.log(keyed(new Box() as Keyed, "w"));

type Labeled = Box & { label?: string };
function labeled(view: Labeled): string {
  return view.label ?? "none";
}
console.log(labeled(new Box()));
