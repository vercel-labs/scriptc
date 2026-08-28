const ro: readonly string[] = ["x", "y", "z"];
console.log(ro.includes("y"));
console.log(ro.includes("w"));

const nums: readonly number[] = [1, 2, 3];
console.log(nums.includes(2));
console.log(nums.includes(99));
