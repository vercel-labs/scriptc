// fsPromises.watch compiles only as a `for await` source: Node's iterator
// starts nothing until it is iterated, while the compiled form opens the
// watch as soon as the call runs, so a standalone call would hold the loop
// open with a watch nothing drains or closes.
import { watch } from "node:fs/promises";

watch("/tmp");
