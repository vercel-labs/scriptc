// @requires-libnode
// Native arrays passed into a Node island are live arrays there (scope-B
// NI-5b): Array.isArray holds, island reads see the native elements, island
// writes (push, element and length assignment) change the native array,
// and the same array crosses as the same object.
import { show, append, bump, describe, entries, isKept, json, keep, keys, maxVersion, sum, truncate } from "list-pkg";

const nums: number[] = [1, 2, 3];
console.log(describe(nums), sum(nums));
console.log(maxVersion(["18.20.1", "22.3.0", "20.11.1"]));
console.log("append", append(nums, 4, 5), nums.join(","));
bump(nums);
console.log("bumped", nums.join(","), nums.length);
nums.push(7);
console.log("native push seen", sum(nums), json(nums));
truncate(nums, 2);
console.log("truncated", nums.length, nums.join(","));
const files: [string, { size: number }][] = [
  ["a.txt", { size: 3 }],
  ["b.txt", { size: 5 }],
];
console.log(entries(files));
keep(nums);
console.log("identity", isKept(nums), isKept([10, 20]));
console.log("keys", keys(nums));
const words = ["x", "y"];
console.log(describe(words), json({ words, n: words.length }));
console.log("inspect", show(nums), show(files), show(words));
words.push("z");
console.log("inspect again", show(words));
