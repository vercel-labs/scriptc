import { loadInstalled } from "addon-probe";

console.log("before");
console.log(loadInstalled(process.argv[2] === "module" ? "module" : "addon"));
