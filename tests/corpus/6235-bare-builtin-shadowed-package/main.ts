// A bare core-module specifier names the Node builtin even when an npm
// package of the same name is installed (pi depends on string_decoder
// transitively): Node checks its builtins before node_modules.
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";
import { createRequire } from "node:module";

const decoder = new StringDecoder("utf8");
console.log(decoder.write(Buffer.from([0xe2, 0x82])) + decoder.end(Buffer.from([0xac])));

const emitter = new EventEmitter();
emitter.on("ping", (n: number) => console.log("ping", n));
emitter.emit("ping", 1);

const require = createRequire(import.meta.url);
const helper = require("./helper.cjs") as { decodeEuro(): string };
console.log("cjs", helper.decodeEuro());
