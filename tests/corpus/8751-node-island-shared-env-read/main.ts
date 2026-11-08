// @requires-libnode
// @env: SCRIPTC_SHARED_ENV_LEVEL=debug
// Two island packages that share a dependency whose top level reads an
// environment variable. The build finds the variable unset and records the
// read in the first package's load only: the second finds the dependency
// already evaluated. Both carry the guard, so in this run, which sets the
// variable, both load at their imports and the second's constant is the
// run's value, not the one the build saw.
import { FIRST_LEVEL, first } from "first-pkg";
import { SECOND_LEVEL, second } from "second-pkg";

console.log("constants", FIRST_LEVEL, SECOND_LEVEL);
console.log(first(), second());
