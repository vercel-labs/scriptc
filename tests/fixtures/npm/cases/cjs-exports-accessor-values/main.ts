// Packages whose export object is an accessor, with getters that answer
// other things than one object. Node's loader reads the export while the
// module loads, and how often depends on what the reads answer: a falsy
// second read ends the load after three reads, a Proxy on the third after
// four, anything else after five; the last read is what `require()`
// returns. Each getter prints its calls, so the lines below show the reads
// as well as the values.
import { report } from "painter";

for (const line of report()) console.log(line);
