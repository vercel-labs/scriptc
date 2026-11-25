// @skip-darwin
// macOS: closing fd 1 makes the Node reference abort while it exits (libuv's
// uv__close asserts that the descriptor is above stderr), so there is no
// reference output there; the program is compared on the other platforms.
//
// A write that fails on a process stream value (its descriptor is closed):
// write answers false, the callback gets the error from a tick, and the
// 'error' listeners that are still registered get it from the tick after
// that, so a tick queued right after the write runs between the two. A
// removed listener is not called and a once listener is called once. The
// stream is not destroyed: the next failing write reports again.
// Everything is reported on stderr.
import * as fs from "node:fs";
import type { WriteStream } from "node:tty";

function arm(panel: WriteStream): void {
  const removed = (problem: Error) => console.error("removed listener ran", problem.message);
  const kept = (problem: Error & { code?: string }) =>
    console.error("kept listener", problem.message, problem.code);
  const first = (problem: Error) => console.error("once listener", problem.message);
  panel.on("error", removed);
  panel.on("error", kept);
  panel.once("error", first);
  panel.removeListener("error", removed);
  fs.closeSync(1);
  const accepted = panel.write("lost\n", (problem) => {
    console.error("callback", problem ? problem.message : String(problem));
  });
  console.error("accepted", accepted);
  process.nextTick(() => {
    console.error("tick after the write");
    const again = panel.write(Buffer.from("lost again\n"), (problem) => {
      console.error("second callback", problem ? problem.message : String(problem));
    });
    console.error("accepted again", again);
  });
}
arm(process.stdout);
