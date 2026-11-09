// @requires-libnode
// @define: process.env.NODE_ENV="production"
// A package that runs in a Node island shares the process's environment, and the build does not read its JavaScript, so the package can change a variable `--define` fixes. The conditions the define decides are therefore evaluated when this program runs: each follows the variable as under Node, before and after the island's write and its `delete`. A `const` keeps the value it was declared with.
import { clearMode, setMode } from "env-setter";

const DEV = process.env.NODE_ENV !== "production";

function report(stage: string): void {
  console.log(stage, process.env.NODE_ENV);
  if (process.env.NODE_ENV !== "production") {
    console.log("development branch");
  } else {
    console.log("production branch");
  }
  console.log(process.env.NODE_ENV === "production" ? "production arm" : "development arm");
  console.log(process.env.NODE_ENV !== "production" && "development operand");
  console.log(process.env.NODE_ENV === "production" || "development operand");
  console.log(DEV ? "development constant" : "production constant");
}

report("defined");
setMode("development");
report("written by the island");
clearMode();
report("deleted by the island");
