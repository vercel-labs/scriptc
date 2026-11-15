// fs.opendir in its callback form and Dir's callback members: read(callback)
// answers entries in operation order (a buffered entry on a next tick, a
// freshly read batch on the loop's deferred queue), close(callback) ends the
// handle, and readSync() while a read is in flight throws
// ERR_DIR_CONCURRENT_OPERATION and a closed Dir at the call site.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opendir-cb-"));
for (const name of ["a", "b", "c", "d", "e"]) fs.writeFileSync(path.join(dir, name), "");

fs.opendir(dir, (error, handle) => {
  if (error) {
    console.log("open failed", error.code);
    return;
  }
  console.log("path", handle.path === dir);
  handle.read((firstError, first) => {
    console.log("first", firstError === null, first !== null);
    if (first !== null) {
      console.log(
        "kinds",
        first.isFile(),
        first.isDirectory(),
        first.isSymbolicLink(),
        first.isFIFO(),
        first.isSocket(),
        first.isCharacterDevice(),
        first.isBlockDevice(),
      );
    }
    try {
      handle.readSync();
      console.log("readSync in a fresh read", "allowed");
    } catch (thrown) {
      console.log("readSync in a fresh read", (thrown as { code?: string }).code);
    }
    handle.read((secondError, second) => {
      console.log("second", secondError === null, second !== null);
      const buffered = handle.readSync();
      console.log("readSync in a buffered read", buffered !== null);
      handle.close((closeError) => {
        console.log("close", closeError === null);
        try {
          handle.read((neverError) => {
            console.log("read after close", neverError === null);
          });
        } catch (thrown) {
          console.log("read after close", (thrown as { code?: string }).code);
        }
        handle.close((secondCloseError) => {
          console.log("close twice", secondCloseError?.code);
          fs.rmSync(dir, { recursive: true });
          console.log("removed", fs.existsSync(dir));
        });
      });
    });
  });
});
