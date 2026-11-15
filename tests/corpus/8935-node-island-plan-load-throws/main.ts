// @exit: 1
// @requires-libnode
// A module of an island package throws while it loads: the error's text,
// the frames inside the package (file, line and column below the package
// directory), a second attempt, and the exit status when nothing catches
// it are Node's. Each file is still compiled under its own name.
import { load as loadModule } from "throwesm";
import { cached, load, must } from "throwpkg";

console.log(load());
console.log(load(), cached());
async function main(): Promise<void> {
  console.log(await loadModule());
  console.log(await loadModule());
  console.log("last");
  must();
  console.log("not reached");
}
void main();
