// The arguments object is not an array: Array.prototype.concat keeps it as
// one element, as a receiver and as an item, and JSON.stringify writes an
// object keyed by index. The compiled argument list is an array, so each is
// refused by name.
function tally(..._marks: number[]): number {
  return Array.prototype.concat.call(arguments, 0).length;
}

function gather(..._marks: number[]): number {
  return ([] as unknown[]).concat(arguments).length;
}

function append(..._marks: number[]): number {
  return Array.prototype.concat.apply([0], [arguments]).length;
}

function encode(..._marks: number[]): string {
  return JSON.stringify(arguments);
}

console.log(tally(1, 2), gather(3), append(4), encode(5));
