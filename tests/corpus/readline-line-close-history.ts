// readline's event surface on a non-terminal interface: 'line' per line,
// 'close' once at EOF, and a 'history' listener, which a non-terminal
// interface never fires (Node only emits it from the terminal editor). The
// harness's stdin is empty and closed, so the lines themselves come from
// the event-loop fixtures, which pipe input in.
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line: string) => console.log("line", JSON.stringify(line)));
rl.on("close", () => console.log("close"));
rl.on("history", (history: string[]) => console.log("history", history.length));
