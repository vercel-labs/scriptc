// Reflection over a builtin module namespace answers the shape the value
// has at run time. A dynamic import resolves to an ES module namespace
// object: its own keys are the export names sorted with "default", and
// "default" is present. The CommonJS spellings — require(), a default
// import, a sub-namespace member — answer the exports object: insertion
// order, no "default". Node evaluates the expression a reflection reads,
// so the answers below are taken over the import call itself as well as
// over bindings.
import * as fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const imported = await import("node:fs");
console.log("import keys", Object.keys(imported).length, Object.keys(imported).slice(0, 4).join(","));
console.log("import has", "default" in imported, "readFileSync" in imported, "nope" in imported);
console.log("import typeof", typeof imported);

const required = require("node:fs");
console.log("require keys", Object.keys(required).length, Object.keys(required).slice(0, 4).join(","));
console.log("require has", "default" in required, "readFileSync" in required);
console.log("require own", required.hasOwnProperty("readFileSync"), required.hasOwnProperty("default"));
console.log("require typeof", typeof required);

console.log("direct keys", Object.keys(await import("node:os")).length, "EOL" in (await import("node:os")));
console.log("types keys", Object.keys(await import("node:util/types")).length, "default" in (await import("node:util/types")));
console.log("types require", Object.keys(require("node:util/types")).length, "default" in require("node:util/types"));

const events = await import("node:events");
console.log("callable", typeof events, "default" in events, Object.keys(events).length);
console.log("callable require", typeof require("node:events"), "default" in require("node:events"));

console.log("same table", Object.keys(fs).length === Object.keys(imported).length);
