// Mutating and copying array methods materialize optional undefined values as present slots.
const source: number[] = [4];
source.length = 3;
const pushed: number[] = [];
console.log("push-result", pushed.push(source[0], source[9]), pushed.length, pushed[0], pushed[1]);
const unshifted: number[] = [8];
console.log("unshift-result", unshifted.unshift(source[0], source[9]), unshifted.length, unshifted[0], unshifted[1], unshifted[2]);
const changed = source.with(1, source[9]);
console.log("with", source.length, source[1], changed.length, changed[0], changed[1], changed[2]);
const spliced = source.toSpliced(1, 0, source[9], source[0]);
console.log("toSpliced", spliced.length, spliced[0], spliced[1], spliced[2], spliced[3], source.length);
