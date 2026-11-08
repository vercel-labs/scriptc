// @requires-libnode
// An island-closed constant whose island call reads a file and catches a
// failure with a fallback. The build evaluates the initializer to decide
// whether it can wait, and does not read the program's files while it
// does: the read is refused there, the package catches the refusal and
// returns its fallback. That value is the probe's, not the program's, so
// the constant must not be taken from it: it evaluates in the run, where
// the read succeeds, as in Node.
import { motto, strict } from "motto-kit";

const text: string = motto();
const size: number = strict();
console.log(text, size);
