// The disposable-mkdtemp records used without any explicit symbol access:
// a program that only reads `path` and calls `remove` never evaluates a
// well-known symbol, and still links (the record builders key their dispose
// member with one, so the call itself selects the symbol and dyn-async
// units).
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const base = path.join(os.tmpdir(), "mkdtemp-disposable-plain-");

const sync = fs.mkdtempDisposableSync(base);
console.log("sync path", sync.path.startsWith(base), fs.existsSync(sync.path));
fs.writeFileSync(path.join(sync.path, "entry"), "payload");
console.log("sync remove", sync.remove(), fs.existsSync(sync.path));

const asyncRecord = await fsp.mkdtempDisposable(base);
console.log("async path", asyncRecord.path.startsWith(base), fs.existsSync(asyncRecord.path));
fs.writeFileSync(path.join(asyncRecord.path, "entry"), "payload");
console.log("async remove", await asyncRecord.remove(), fs.existsSync(asyncRecord.path));
