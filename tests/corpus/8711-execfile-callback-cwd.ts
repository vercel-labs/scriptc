// The exec/execFile callback form's cwd: the child starts in the given
// directory, a spawn failure there arrives through the callback's
// error-first argument (code ENOENT, never a throw), and the shell form
// (exec) takes it too.
import { exec, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "scr-execfile-cwd-"));
writeFileSync(join(dir, "marker.txt"), "from-dir\n");

console.log("scheduled");
execFile(
  "cat",
  ["marker.txt"],
  { cwd: dir, encoding: "utf8" },
  (error: Error | null, stdout: string, stderr: string) => {
    console.log("cwd", error === null, JSON.stringify(stdout), JSON.stringify(stderr));
    exec(
      "cat marker.txt",
      { cwd: dir, encoding: "utf8" },
      (shellError: Error | null, shellOut: string) => {
        console.log("shell cwd", shellError === null, JSON.stringify(shellOut));
        execFile(
          "sh",
          ["-c", "true"],
          { cwd: "/definitely-not-a-directory-xyz", encoding: "utf8" },
          (failed: Error | null, failedOut: string) => {
            console.log("bad cwd", failed !== null, JSON.stringify(failedOut));
            console.log(
              "code",
              failed === null ? "" : String((failed as NodeJS.ErrnoException).code),
            );
          },
        );
      },
    );
  },
);
console.log("returned");
