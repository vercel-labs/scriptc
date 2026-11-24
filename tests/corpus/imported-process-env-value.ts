// `import { env } from "node:process"` (is-in-ci's shape) is the same
// environment object Node exports: `in` with a computed key, bracket reads,
// writes that reach setenv, and a bare use that snapshots. The harness pins
// SCRIPTC_TEST_ENV for both lanes.
import { env } from "node:process";
import { env as environment } from "node:process";

const key = "SCRIPTC_TEST_ENV";
console.log(key in env, env[key]);
console.log(environment === env);

const absent = "SCRIPTC_DEFINITELY_NOT_SET_XYZ";
console.log(absent in env, env[absent] === undefined);

// Object.keys over a bare use sees the live table.
console.log(Object.keys(env).includes("SCRIPTC_TEST_ENV"));

// Member writes through the imported binding reach the environment, and
// reads through the process global see them, as Node's one object does.
env.SCRIPTC_IMPORTED_WRITE = "written";
console.log(process.env.SCRIPTC_IMPORTED_WRITE);
delete env.SCRIPTC_IMPORTED_WRITE;
console.log(process.env.SCRIPTC_IMPORTED_WRITE === undefined);
