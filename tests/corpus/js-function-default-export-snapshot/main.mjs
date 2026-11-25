import snapshot, { pick } from "./lib.mjs";

console.log(snapshot(), pick(), snapshot === pick);
