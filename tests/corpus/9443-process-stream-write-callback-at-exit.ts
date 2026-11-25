// A write callback on a process stream value is the last thing the program
// has to do: it still runs. Nothing else here keeps the event loop alive.
import type { WriteStream } from "node:tty";

function finish(panel: WriteStream, label: string): void {
  panel.write(label + " written\n", () => {
    console.log(label, "flushed");
  });
}
finish(process.stdout, "out");
finish(process.stderr, "err");
const loose: any = process.stdout;
loose.write("loose written\n", () => console.log("loose flushed"));
