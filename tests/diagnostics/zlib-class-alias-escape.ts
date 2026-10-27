// A zlib class alias owns no runtime value: construction, instanceof,
// typeof and .name compile, other uses report at the use. instanceof on
// an untyped operand reports as well.
import * as zlib from "node:zlib";

const Gz = zlib.Gzip;
const classes = [Gz];
console.log(classes.length);

const parsed: unknown = JSON.parse("{}");
console.log(parsed instanceof Gz);
