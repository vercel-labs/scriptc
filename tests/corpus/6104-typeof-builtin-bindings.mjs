// typeof on named, default-destructured and namespace-destructured builtin
// bindings in an ES module: Node answers by the export's kind.
import util, { inspect as namedInspect, format } from "node:util";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { promises } from "node:fs";
const { inspect, promisify } = util;
const { join } = path;
console.log(typeof inspect, typeof promisify, typeof namedInspect, typeof format);
console.log(typeof join, typeof createHash, typeof util.inspect, typeof promises);
console.log(namedInspect("s"), format("%d", 2), join("x", "y"));
