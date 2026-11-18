// The callback readFile forms: readFile(path, callback) without an options
// argument answers the file's bytes, a failed read calls back with the error
// and no data, and the descriptor open's callback hands back flows into the
// fs.write and fs.close that follow it (write(fd, string, callback)).
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = fs.mkdtempSync(join(tmpdir(), "callback-readfile-"));
const file = join(dir, "data.txt");
fs.writeFileSync(file, "hello");

const fail = (error: Error | null): string =>
  error === null ? "ok" : `${(error as NodeJS.ErrnoException).code}`;

fs.readFile(file, (error, data) => {
  console.log("readFile", fail(error), Buffer.isBuffer(data), String(data));
  fs.readFile(join(dir, "missing"), (missingError, missingData) => {
    console.log("readFile missing", fail(missingError), missingData === undefined);
    fs.readFile(file, "utf8", (textError, text) => {
      console.log("readFile utf8", fail(textError), typeof text, text);
      fs.open(join(dir, "copy.txt"), "w", (openError, fd) => {
        fs.write(fd, "copied", (writeError) => {
          fs.close(fd, (closeError) => {
            console.log("open flow", fail(openError), typeof fd, fail(writeError), fail(closeError));
            console.log("copy", fs.readFileSync(join(dir, "copy.txt"), "utf8"));
            fs.rmSync(dir, { recursive: true, force: true });
          });
        });
      });
    });
  });
});
