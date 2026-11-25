// A class of an import cycle with a field held as a checked-dynamic value
// (`any`). Such a class is registered when a reference reaches it, and the
// cycle's initialization check is one: the class gets its flag like any
// other class of the cycle. The module evaluated first reaches the class
// before its declaration ran (Node's ReferenceError names the class) and
// constructs it afterwards.
import Hub from "./hub.ts";
import { earlyResult, spare } from "./helper.ts";

const hub = new Hub("main");
const before = hub.describe();
hub.meta = { depth: 2 };
console.log(earlyResult);
console.log(before, hub.describe(), spare().describe(), JSON.stringify(hub.meta), hub instanceof Hub);
