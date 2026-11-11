// Contextual typing from the target literal reaches the empty array
// literals inside a spread source. tsc infers `never[][]` for a literal
// array of empty arrays, which the compiler represents as `number[][]` and
// used to refuse when spreading into a `string[][]` literal; each element
// now builds as the literal's own element type.

const fromSpread: string[][] = [...[[], []], ["a"]];
console.log("spread", fromSpread.length, fromSpread[0].length, fromSpread[2][0]);

const merged: string[][] = [...[[], []], ...[[], []], []];
console.log(
  "merged",
  merged.length,
  merged.map((row) => row.length).join(","),
);

const numbers: number[][] = [...[[], []]];
numbers[0].push(1);
console.log("numbers", numbers.length, numbers[0].length, numbers[1].length);

// Both arms of a conditional spread source take the literal's element type.
const choose = process.argv.length > 1;
const conditional: string[][] = [...(choose ? [[], []] : [["y"]])];
console.log(
  "conditional",
  conditional.length,
  conditional[0].length,
  conditional[1].length,
);

// The element type reaches an inner literal two levels down.
const grid: string[][][] = [...[[[], []]]];
grid[0][1].push("deep");
console.log(
  "grid",
  grid.length,
  grid[0].length,
  grid[0][0].length,
  grid[0][1].length,
);
