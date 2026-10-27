// A module of an import cycle re-exports another member with `export *`
// (pi-coding-agent's sdk.js → agent-session-runtime.js →
// agent-session-services.js → sdk.js). The re-exported names are live
// bindings of the member that declares them, so they read the same values,
// and the same temporal dead zone errors, as in Node.
import { createSession, describeRuntime, Runtime, SDK_VERSION } from "./sdk.ts";
import { servicesReport } from "./services.ts";

console.log(servicesReport());
console.log(createSession("main").describe());
console.log(describeRuntime(), new Runtime("direct").name, SDK_VERSION);
