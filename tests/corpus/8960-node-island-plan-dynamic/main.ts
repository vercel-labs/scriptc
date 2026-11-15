// @requires-libnode
// import() inside an island package: of a literal path (answered by the
// load plan), of a computed one (resolved by Node), and of a module with a
// top-level await; a module imported twice is one module.
import { parts } from "dynpkg";

async function main(): Promise<void> {
  console.log(await parts("other"));
  console.log(await parts("fixed"));
}
void main();
