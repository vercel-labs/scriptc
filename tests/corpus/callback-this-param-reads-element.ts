// An explicit `this` parameter is not a data parameter of a callback: a
// function expression that reads its element still receives it, even when
// values written through a dynamic view make the element type foreign.
const viewed: number[] = [1];
const view: unknown[] = viewed;
view.push("x");

function doubled(values: number[]): number[] {
  return values.map(function (this: unknown, value: number) {
    return value * 2;
  });
}
function selected(values: number[]): number[] {
  return values.filter(function (this: unknown, value: number) {
    return value > 1;
  });
}
function visited(values: number[]): void {
  values.forEach(function (this: unknown, value: number) {
    console.log("value", value);
  });
}
console.log(doubled([1, 2]), selected([1, 2, 3]));
visited([4, 5]);
