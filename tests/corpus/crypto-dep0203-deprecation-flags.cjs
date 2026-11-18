// DEP0203 under the process deprecation flags: with process.throwDeprecation
// the report is thrown from its own tick instead (reaching the
// 'uncaughtException' handler as a DeprecationWarning error with its code,
// and no 'warning' listener), and without a handler the first one ends the
// process with exit status 1; with process.noDeprecation the report and the
// listeners both stay silent. The program re-runs itself and prints each
// child's stdout and status.
"use strict";
const { spawnSync } = require("child_process");

async function passCryptoKey() {
  const crypto = require("node:crypto");
  const key = await crypto.subtle.importKey("raw", Buffer.alloc(16, 2), "AES-CBC", false, [
    "encrypt",
  ]);
  crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 1));
  return "created";
}

const mode = process.argv[2];

if (mode === "throwing") {
  process.on("warning", (warning) => console.log("listener:", warning.name));
  process.on("uncaughtException", (error) => {
    console.log("uncaught:", error.name, error.code, error instanceof Error);
    console.log(error.message);
  });
  process.throwDeprecation = true;
  passCryptoKey().then((result) => {
    console.log(result);
    console.log("end of turn:", process.throwDeprecation);
  });
} else if (mode === "unhandled") {
  process.throwDeprecation = true;
  passCryptoKey().then((result) => console.log(result));
  setTimeout(() => console.log("not reached"), 0);
} else if (mode === "silent") {
  process.noDeprecation = true;
  passCryptoKey().then((result) => {
    console.log(result);
    setTimeout(() => console.log("settled"), 0);
  });
} else {
  for (const child of ["throwing", "unhandled", "silent"]) {
    const run = spawnSync(process.execPath, [process.argv[1], child], { encoding: "utf8" });
    console.log(`${child} status: ${run.status}`);
    console.log(run.stdout);
  }
}
