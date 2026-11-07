import * as state from "process-reader";

process.env["CONFORMANCE_SET_BY_PROGRAM"] = "program";
console.log(state.env("CONFORMANCE_SET_BY_PROGRAM"), state.env("CONFORMANCE_NEVER_SET"));
state.setEnv("CONFORMANCE_SET_BY_PACKAGE", "package");
console.log(process.env["CONFORMANCE_SET_BY_PACKAGE"]);
delete process.env["CONFORMANCE_SET_BY_PROGRAM"];
console.log(state.env("CONFORMANCE_SET_BY_PROGRAM"));
console.log(state.pid() === process.pid, state.platform() === process.platform);
