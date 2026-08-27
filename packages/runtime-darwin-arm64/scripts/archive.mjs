import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function createDeterministicArchive(archiver, output, objects) {
  await run(archiver, ["rcs", output, ...objects], {
    // Apple/BSD ar otherwise copies each freshly compiled object's timestamp
    // into the archive, changing the pack hashes on every release build.
    env: { ...process.env, ZERO_AR_DATE: "1" },
  });
}
