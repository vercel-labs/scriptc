// Object.assign onto an array held in an untyped value: the members arrive
// on the array, index keys write its elements, and the result is the same
// array.

const shelf: any = [];
const stocked = Object.assign(shelf, { aisle: "c", bins: ["x", "y"] });
console.log(stocked === shelf, stocked.aisle, stocked.bins.length, stocked.length);
console.log(Object.keys(stocked).join(","), "aisle" in shelf);

const row: any = ["a"];
const filled = Object.assign(row, { 0: "z", 2: "y" });
console.log(filled.length, filled.join("|"), filled === row);

function restock(target: any, source: any): string {
  const result = Object.assign(target, source);
  return `${result.length}:${Object.keys(result).join(",")}`;
}
console.log(restock([], { tier: 2 }), restock(["p"], { 1: "q", tier: 3 }), restock([], JSON.parse('{"lot":"k"}')));
