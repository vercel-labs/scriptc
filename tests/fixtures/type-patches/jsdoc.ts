// A JSDoc @typedef property and a @returns that say number for a value
// that is undefined off a TTY, fixed by the project's type patches.
import { Terminal } from "termctx";

for (const tty of [false, true]) {
  const term = new Terminal(tty);
  const context = term.outputContext(false);
  console.log(context.error, context.width, term.columns());
  console.log(term.describe(context));
  console.log(term.describe(term.outputContext(true)));
}
