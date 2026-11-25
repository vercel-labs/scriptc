// exec's callback in a typed source whose parameters are `any`: the
// adapter hands the native (Error | null, string) values to the program's
// function with the checked-dynamic conversion its parameters take.
import { exec } from "node:child_process";

exec("echo typed", (error: any, stdout: any) => {
  console.log("first", error === null, JSON.stringify(stdout));
  exec("exit 2", (failure: any, out: any, errOut: any) => {
    console.log("second", failure.code, JSON.stringify(out), JSON.stringify(errOut));
  });
});
