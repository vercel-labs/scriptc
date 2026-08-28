// This outside importer reaches the already-running cycle through b, whose
// own evaluation completes before the cycle root a's top-level await. Node
// waits for the cycle root before starting this body.
import "./b.ts";

console.log("waiter");
