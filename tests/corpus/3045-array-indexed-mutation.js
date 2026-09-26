/** @param {number[]} a */
function describe(a) {
  return JSON.stringify(a);
}

const filled = [0, 1, 2, 3];
console.log("fill", filled.fill(9, "1", "3") === filled, describe(filled));
console.log("fill-default", describe([0, 1].fill()), describe([0, 1].fill(8, undefined, undefined)));
console.log("fill-coerce", describe([0, 1, 2, 3].fill(9, true, null)), describe([0, 1, 2, 3].fill(9, NaN, Infinity)));
console.log("fill-negative", describe([0, 1, 2, 3].fill(8, -3, -1)), describe([0, 1].fill(8, -Infinity, 1)));
console.log("fill-empty", describe([0, 1, 2].fill(8, 2, 1)));
/** @type {number[]} */
const sparse = [];
sparse.length = 4;
sparse[3] = 7;
console.log("fill-hole", describe(sparse.fill(5, 1, 3)), 0 in sparse, 1 in sparse, 2 in sparse);
const optional = [1];
const absent = optional[9];
console.log("fill-missing-read", describe([0, 1].fill(absent)));

const forward = [0, 1, 2, 3, 4];
console.log("copy-forward", forward.copyWithin(0, 2) === forward, describe(forward));
const backward = [0, 1, 2, 3, 4];
console.log("copy-backward", backward.copyWithin(1, 0, 4) === backward, describe(backward));
console.log("copy-default", describe([0, 1, 2].copyWithin()), describe([0, 1, 2].copyWithin(undefined, 1, undefined)));
console.log("copy-negative", describe([0, 1, 2, 3].copyWithin(-2, -4, -1)));
console.log("copy-coerce", describe([0, 1, 2, 3].copyWithin("1", true, "3.8")));
console.log("copy-bounds", describe([0, 1, 2].copyWithin(99, 0)), describe([0, 1, 2].copyWithin(0, -Infinity, Infinity)));
/** @type {number[]} */
const holes = [0, , 2, , 4];
console.log("copy-holes-forward", describe(holes.copyWithin(0, 1, 4)), 0 in holes, 1 in holes, 2 in holes, 3 in holes);
/** @type {number[]} */
const holesBack = [, 1, , 3, 4];
console.log("copy-holes-backward", describe(holesBack.copyWithin(1, 0, 4)), 0 in holesBack, 1 in holesBack, 2 in holesBack, 3 in holesBack);
const missing = [10, 20];
missing[1] = missing[9];
console.log("copy-undefined", describe(missing.copyWithin(0, 1)), 0 in missing);

const effects = [];
const effectTarget = [0, 1, 2];
const fillReturn = (() => { effects.push("receiver"); return effectTarget; })().fill(
  (() => { effects.push("value"); return 8; })(),
  (() => { effects.push("start"); return "1"; })(),
  (() => { effects.push("end"); return 3; })(),
);
console.log("fill-order", effects.join(","), fillReturn === effectTarget, describe(effectTarget));
const copyEffects = [];
const copyReturn = (() => { copyEffects.push("receiver"); return effectTarget; })().copyWithin(
  (() => { copyEffects.push("target"); return "0"; })(),
  (() => { copyEffects.push("start"); return 1; })(),
  (() => { copyEffects.push("end"); return "3"; })(),
);
console.log("copy-order", copyEffects.join(","), copyReturn === effectTarget, describe(effectTarget));
