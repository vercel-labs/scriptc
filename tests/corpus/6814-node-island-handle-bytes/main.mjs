// @requires-libnode
// Byte stores across the island boundary (scope-B NI-4): a Buffer or typed
// array crossing either way shares its memory, so writes on one side are
// visible on the other without copies.
import { requireModule } from "@scriptc/node";

const lib = requireModule("./lib.cjs");

const buf = lib.makeBuffer();
console.log("from island", buf.length, buf.toString(), Buffer.isBuffer(buf));
buf[0] = 72 - 32 + 32; // 'H'
buf[1] = 69;
console.log("island sees native write", lib.read(lib.kept()));
lib.fill(lib.kept(), 120);
console.log("native sees island write", buf.toString(), buf[4]);
console.log("same buffer back", lib.same(buf, lib.kept()), buf === lib.kept());

const mine = new Uint8Array([1, 2, 3]);
console.log("into island", lib.read(mine));
lib.fill(mine, 9);
console.log("native sees fill", mine.join(","));

const nb = Buffer.from("abc");
lib.fill(nb, 122);
console.log("native buffer", nb.toString(), lib.read(nb));

const floats = lib.floats();
console.log("floats", floats.length, floats[0], Object.is(floats[1], -0), Number.isNaN(floats[2]));
floats[0] = 2.5;
floats[2] = 4;
console.log("float sum in island", lib.sum(floats));
