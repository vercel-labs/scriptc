// Iterator helpers lower over Map/Set iterators, generators and array,
// string and typed array iterators. These helper forms are refused
// explicitly.
const set = new Set<number>([1, 2]);
// return() on an iterator object that is not provably a helper object
// (array, string, Map and Set iterators have no return method).
function close(it: IteratorObject<number>): void {
  it.return!();
}
close(set.values().map((value) => value * 2));
// throw() on a helper object (helpers have no throw method).
set.values().map((value) => value + 1).throw!(new Error("stop"));
// Each helper call must produce a diagnostic.
