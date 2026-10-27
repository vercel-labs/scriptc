import { open, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

async function main(): Promise<void> {
  let timeoutFired = false;
  {
    using timeout = setTimeout(() => {
      timeoutFired = true;
    }, 20);
    using immediate = setImmediate(() => {
      timeoutFired = true;
    });
    console.log(timeout.hasRef(), immediate.hasRef());
  }

  const path = `/tmp/scriptc-disposable-file-${process.pid}.txt`;
  await writeFile(path, "resource");
  {
    await using handle = await open(path, "r");
    console.log(handle.fd >= 0);
  }

  {
    using child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    console.log(child.pid !== undefined);
  }

  {
    using readline = createInterface({ input: process.stdin });
    console.log("readline");
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  console.log(timeoutFired);
}

main();
