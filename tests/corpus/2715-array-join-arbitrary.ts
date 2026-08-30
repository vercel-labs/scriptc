// 2715 Array.join arbitrary: (string|null|undefined)[] and mixed arrays
const a: (string | null | undefined)[] = ["a", null, "b", undefined, "c"];
console.log(a.join(","));
console.log(a.join("|"));
console.log(a.join(""));

const mixed: (string | number | null | undefined)[] = ["x", 1, null, 2, undefined, "y"];
console.log(mixed.join("-"));
console.log(mixed.join(", "));

const withBool: (string | boolean | null | undefined)[] = ["hi", true, null, false, undefined];
console.log(withBool.join(","));

const numbersAndStrings: (number | string)[] = [1, "two", 3, "four"];
console.log(numbersAndStrings.join(","));

const onlyNullish: (null | undefined)[] = [null, undefined, null];
console.log(`<${onlyNullish.join(",")}>`);

const emptyMixed: (string | null | undefined)[] = [];
console.log(`<${emptyMixed.join(",")}>`);
console.log(["a", null].join(",") === "a,");
console.log([undefined, "b"].join(",") === ",b");
console.log([null, undefined].join(",") === ",");
