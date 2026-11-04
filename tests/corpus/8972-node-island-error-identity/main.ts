// @requires-libnode
// An error island code throws keeps its realm's identity: the native frame
// that catches it reads `constructor` from V8, so the test harness's
// `thrown.constructor === TypeError` holds with the TypeError the island
// crossed, and instanceof agrees.
import "./lib.ts";
import "./island.cjs";
