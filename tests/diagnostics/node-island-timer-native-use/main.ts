// A timer created by island code stays the island's Timeout object. The
// program's own timer handles are numbers, so a slot typed as a timer
// cannot hold it: the assignment is refused at the island boundary. A const
// initialized with the island's timer keeps the handle and may be cleared.
import { start } from "timer-pkg";

let pending: ReturnType<typeof setTimeout> | undefined;
pending = start(10, "stored in a typed slot");
clearTimeout(pending);
