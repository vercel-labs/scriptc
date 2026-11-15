// A class that extends Array, declared inside a function: its methods build
// their results through a helper that constructs the class by name, and a
// function-local class is constructed from the class value of its
// evaluation, so the class is refused where it is declared.
function total(values: number[]): number {
  class Row extends Array<number> {
    sum(): number {
      let s = 0;
      for (const v of this) s += v;
      return s;
    }
  }
  const row = new Row();
  for (const v of values) row.push(v);
  return row.sum();
}

console.log(total([1, 2, 3]));
