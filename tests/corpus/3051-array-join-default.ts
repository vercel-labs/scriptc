console.log([1, 2, 3].join(), ["a", "b"].join(), [true, false].join());
console.log([1, 2].join(undefined), [1, 2].join(void 0));
console.log([1, 2].join("|"), [1].join(), ([] as number[]).join());

let calls = 0;
function missing(): undefined { calls++; return undefined; }
console.log([5, 6].join(missing()), calls);

// @ts-ignore JavaScript accepts a numeric separator.
console.log([1, 2, 3].join(0));
// @ts-ignore JavaScript accepts a boolean separator.
console.log([1, 2].join(false));
// @ts-ignore JavaScript accepts a null separator.
console.log([1, 2].join(null));

function optionalSeparator(usePipe: boolean): string | undefined { return usePipe ? "|" : undefined; }
console.log([1, 2].join(optionalSeparator(true)), [1, 2].join(optionalSeparator(false)));
