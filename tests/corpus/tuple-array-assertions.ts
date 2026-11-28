// A tuple and an array of matching elements assert through `unknown` in both
// directions: the layouts convert on either side, so neither assertion is an
// impossible layout claim. Node erases both assertions.
type Pair = [string, number];
const list: (string | number)[] = ["a", 1];
const asTuple = list as unknown as Pair;
console.log("tuple", asTuple[0], asTuple[1], asTuple.length);
const back = asTuple as unknown as (string | number)[];
console.log("array", back.length, back[0], back[1]);
const literal = ["x", 2] as unknown as Pair;
console.log("literal", literal[0], literal[1]);
