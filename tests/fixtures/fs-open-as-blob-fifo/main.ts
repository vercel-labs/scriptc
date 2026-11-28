// fs.openAsBlob over a FIFO: the call stats the path and must answer at
// once, as Node's does. A blocking open would park the event loop until a
// writer appeared, and the second line below would never print.
// Usage: main <fifo-path>
import { openAsBlob } from "node:fs";

let ticked = false;
setTimeout(() => {
  ticked = true;
}, 10);
const blob = await openAsBlob(process.argv[2]!);
console.log("after", blob.size, ticked);
