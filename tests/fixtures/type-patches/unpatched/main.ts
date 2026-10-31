// termctx's lying JSDoc without the project's type patches: each failing
// check's TypeError names the declaration and the patch that admits the
// value (native only; Node never checks).
import { Terminal } from "termctx";

const term = new Terminal(false);
for (const read of [() => term.columns(), () => term.outputContext(false).width]) {
  try {
    console.log(read());
  } catch (e) {
    console.log((e as Error).message);
  }
}
