// @skip-darwin
// macOS: closing fd 1 makes the Node reference abort while it exits (libuv's
// uv__close asserts that the descriptor is above stderr), so there is no
// reference output there; the program is compared on the other platforms.
//
// The failing write of a process stream from a JavaScript source: the
// callback first, then the 'error' listeners from a later tick; twice,
// because Node never destroys process.stdout.
import * as fs from "node:fs";

process.stdout.once("error", (problem) => console.error("once listener", problem.code));
process.stdout.on("error", (problem) => console.error("listener", problem.message));
fs.closeSync(1);
process.stdout.write("lost\n", (problem) => console.error("first callback", problem.code));
process.nextTick(() => {
  console.error("tick");
  const accepted = process.stdout.write("lost again\n", (problem) =>
    console.error("second callback", problem.code),
  );
  console.error("accepted", accepted);
});
