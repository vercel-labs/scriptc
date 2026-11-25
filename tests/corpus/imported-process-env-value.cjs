// The CommonJS twin of the named import: `const { env } =
// require("node:process")` holds Node's one environment object too, so
// membership, reads and writes behave like process.env's.
const { env } = require("node:process");

const key = "SCRIPTC_TEST_ENV";
console.log(key in env, env[key]);
console.log("SCRIPTC_DEFINITELY_NOT_SET_XYZ" in env);

env.SCRIPTC_IMPORTED_WRITE = "written";
console.log(process.env.SCRIPTC_IMPORTED_WRITE);
