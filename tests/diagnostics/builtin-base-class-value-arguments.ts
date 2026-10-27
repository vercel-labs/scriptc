// A class without a constructor that extends a stream class inherits the
// runtime constructor, which takes no arguments here. Passing arguments
// through the class's value reports at the first argument, as direct
// construction does.
import { Transform } from "node:stream";

class Upper extends Transform {}
const registry = { upper: Upper };
const upper = new registry.upper({ objectMode: true });
upper.destroy();

const Kind = Upper;
const other = new Kind({ highWaterMark: 4 });
other.destroy();
