// An override that declares a parameter past the inherited arity takes a
// wider call on its own type, also when the program's methods count as
// replaceable (corpus 8826). Two branches of the family disagree about the
// extra slot's type, so one vtable slot cannot carry both ABIs: the slot
// keeps the inherited arity and a wider call through the virtual slot is
// refused.
class Box {
  kids: string[] = [];
  add(child: string): void {
    this.kids.push(child);
  }
}
class Row extends Box {
  weights: number[] = [];
  override add(child: string, weight: number = 0): void {
    super.add(child);
    this.weights.push(weight);
  }
}
class Tagged extends Box {
  tags: string[] = [];
  override add(child: string, tag: string = ""): void {
    super.add(child);
    this.tags.push(tag);
  }
}
class Quiet extends Row {
  override add(_child: string, _weight: number = 0): void {}
}
const row: Row = new Quiet();
row.add("x", 2);

// A write whose key is a run-time value makes every method replaceable.
const holder = { target: {} as any };
holder.target[process.argv.length > 99 ? "add" : "other"] = 1;
console.log(typeof Tagged);
