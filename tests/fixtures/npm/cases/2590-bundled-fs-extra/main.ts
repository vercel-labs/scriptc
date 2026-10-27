// A bundle that embeds fs-extra 9.0.0 (as build-utils does): its fs-extra
// chunk compiles as scriptc's built-in fs-extra, and the package's own
// chunks (graceful-fs, universalify, jsonfile) are never loaded.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demo } from "gtfsxbundle";

demo(mkdtempSync(join(tmpdir(), "scriptc-bundled-fs-extra-"))).then((result) => console.log(result));
