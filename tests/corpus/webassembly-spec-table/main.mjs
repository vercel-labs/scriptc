// Executes WebAssembly spec tests (13 files); see tests/wasm-spec/runner.mjs.
import { run } from "../../wasm-spec/runner.mjs";
import { modules, script } from "./data.mjs";

run(modules, script);
