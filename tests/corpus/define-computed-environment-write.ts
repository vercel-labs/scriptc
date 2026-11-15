// @define: process.env.NODE_ENV="production"
// A write to the environment through a name the build cannot read may change a variable `--define` fixes, so the conditions the define decides are not resolved at build time in this program: each follows the variable as under Node, through an assignment, a `delete` and a value held from `process.env`. A `const` keeps the value it was declared with, and a literal still decides.
export {};

const DEV = process.env.NODE_ENV !== "production";
const NEVER = false;
const held: unknown = { count: 1 };

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
  if (NEVER) {
    Object.freeze(held);
  }
  console.log(NEVER ? "never" : "always", Object.isFrozen(held));
}

report("defined");

const name: string = ["NODE", "ENV"].join("_");
process.env[name] = "development";
report("written");

delete process.env[name];
report("deleted");

const env = process.env;
env[name] = "test";
report("held");

console.log(delete process.env[name], process.env.NODE_ENV);
