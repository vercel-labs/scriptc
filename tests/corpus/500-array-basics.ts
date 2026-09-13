// Array fundamentals: literals, reads, writes, .length, append via
// a[a.length], nested arrays. All indices stay in bounds — OOB traps are a
// documented divergence covered by the runtime C tests, not the corpus.
const nums: number[] = [10, 20, 30];
console.log(nums.length, nums[0], nums[1], nums[2]);

nums[1] = -0.5;
console.log(nums[1], nums.length);

// write at index == length appends (JS: no hole created here)
nums[nums.length] = 40;
console.log(nums.length, nums[3]);

const empty: number[] = [];
console.log(empty.length);
empty[0] = 7;
console.log(empty.length, empty[0]);

const words: string[] = ["alpha", "beta"];
console.log(`${words[0]}`, words[1]);
words[0] = words[1] + "!";
console.log(words[0]);

const flags: boolean[] = [true, false, true];
console.log(flags[0], flags[1], flags[2]);
flags[1] = !flags[1];
console.log(flags[1]);

// nested arrays: element type is itself an array
const grid: number[][] = [[1, 2, 3], [4, 5], []];
console.log(grid.length, grid[0].length, grid[1].length, grid[2].length);
console.log(grid[0][2], grid[1][0]);
grid[2][0] = 9;
console.log(grid[2][0], grid[2].length);

// expressions as elements and as indices
const i: number = 1;
const computed: number[] = [i + 1, i * 10, nums[0]];
console.log(computed[0], computed[1], computed[2]);
console.log(computed[i], computed[computed.length - 1]);

// .length in conditions and arithmetic
if (nums.length > 3) {
  console.log("long", nums.length * 2);
}
console.log(nums.length === 4, empty.length === 1);
