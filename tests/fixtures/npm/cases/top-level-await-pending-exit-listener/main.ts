import { deferNever, setExitCode } from "defer";

setExitCode(5);
process.on("exit", (code) => {
  console.log("exit", code);
  setExitCode(7);
});

await deferNever();

export {};
