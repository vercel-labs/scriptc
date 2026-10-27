// Data members of the process object taken off by destructuring.
import process from "node:process";

const { env, argv, platform } = process;
console.log(env.SCRIPTC_TEST_ENV, "SCRIPTC_TEST_ENV" in env, "SCRIPTC_NOT_SET_ANYWHERE" in env);
console.log(Array.isArray(argv), typeof argv[0], platform === process.platform);

function readFlags() {
  const { env: environment, pid } = process;
  return [typeof environment.SCRIPTC_TEST_ENV, pid === process.pid];
}
console.log(readFlags().join(" "));
