// What a process stream held as a value still refuses by name: events other
// than 'resize', 'error' and 'close', an event name the compiler cannot
// read, and written data that is neither a string nor bytes.
import type { WriteStream } from "node:tty";

function wire(panel: WriteStream, event: string, payload: any): void {
  panel.on("drain", () => {});
  panel.on(event, () => {});
  panel.write(payload, () => {});
}
wire(process.stdout, "resize", 1);
