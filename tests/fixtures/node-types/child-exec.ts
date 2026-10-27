import { exec } from "node:child_process";

exec("printf typed-exec; printf err >&2", (error, stdout, stderr) => {
  if (error !== null) throw error;
  console.log(stdout, stderr);
  exec("exit 2", { encoding: "utf8" }, (failed) => {
    console.log(JSON.stringify(failed === null ? "" : failed.message));
  });
});
