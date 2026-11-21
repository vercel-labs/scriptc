// JavaScript subclasses narrow a method's JSDoc parameter types (`copy(source)`
// documented with the subclass), declare more parameters than a base that
// names its own only in a comment, and change the result. Every call binds the
// arguments it supplies and dispatches on the receiver's class, as Node does.
import { dispatch, run } from "./shapes.js";

run();
dispatch();
