// A package's own functions, read off an object the checker cannot type,
// on the right of `instanceof`: Node walks the value's prototype chain for
// an ES5 constructor's prototype, at module load and in calls, and throws a
// TypeError for an arrow function, which has no prototype, when the value
// is an object.
import { arrowCheck, arrowObjects, describe, rejects, tags } from "tag-types";

console.log(tags());
console.log(describe("{}"), describe("[1]"), describe("null"), describe('"s"'));
console.log(rejects('{"tag":"!x"}'));
console.log(arrowCheck("{}"), arrowCheck("1"));
console.log(arrowObjects());
