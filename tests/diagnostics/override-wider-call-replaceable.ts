// An override that declares a parameter past the inherited arity takes a
// wider call on its own type, also when the program's methods count as
// replaceable (corpus 8826). With a second override below it the call is
// virtual, and the inherited slot carries the inherited arity only.
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
class Quiet extends Row {
  override add(_child: string): void {}
}
const row: Row = new Quiet();
row.add("x", 2);

// A write whose key is a run-time value makes every method replaceable.
const holder = { target: {} as any };
holder.target[process.argv.length > 99 ? "add" : "other"] = 1;
