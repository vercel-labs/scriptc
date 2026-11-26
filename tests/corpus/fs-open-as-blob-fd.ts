// A file-backed Blob's held descriptor is close-on-exec: a subprocess does
// not inherit readable access to the Blob's backing file, which may hold
// bytes outside a slice or a file no longer reachable by pathname.
import { openAsBlob } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "linux") {
  console.log("skip non-linux");
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blob-fd-"));
  const file = path.join(dir, "blob-fd-secret.bin");
  fs.writeFileSync(file, "secret");
  const blob = await openAsBlob(file);
  await blob.text(); // opens and holds the descriptor
  const child = spawnSync(
    "sh",
    ["-c", "ls -l /proc/self/fd 2>/dev/null | grep -c blob-fd-secret || true"],
    { encoding: "utf8" }
  );
  console.log("child sees", (child.stdout ?? "").trim());
  fs.rmSync(dir, { recursive: true, force: true });
}
