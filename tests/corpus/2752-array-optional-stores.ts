// Missing reads stored into scalar arrays use the state byte and keep the number payload ABI.
const source: number[] = [10];
const target: number[] = [1, 2];
target[0] = source[0];
target[1] = source[9];
const literal = [source[0], source[9], 30];
const hole = [, source[0], source[9]];
console.log("store", target.length, target[0], target[1]);
console.log("literal", literal.length, literal[0], literal[1], literal[2]);
console.log("hole", hole.length, hole[0], hole[1], hole[2]);
