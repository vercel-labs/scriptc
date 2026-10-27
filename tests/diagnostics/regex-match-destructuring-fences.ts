// Object patterns over regex match results compile for numeric positions,
// index, input and groups. A rest element would copy the result's own
// properties, a default on index or input has no lowering, and other array
// members are not data on the result.
const m = /(a)(b)?/.exec("ab")!;
const { index, ...rest } = m;
const { input = "none" } = m;
const { length } = m;
console.log(index, rest, input, length);
