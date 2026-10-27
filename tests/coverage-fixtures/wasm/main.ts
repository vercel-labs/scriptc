// The WebAssembly modules this program can load are visible to the build in
// four ways (wasm/discover.ts): a path the compiler resolves (glue.js,
// including a .so shared library), an inline base64 literal (glue.js), a
// .wasm file shipped by a package whose code mentions WebAssembly
// (wasm-fixture-pkg), and the scriptc.wasm list in package.json
// (build/generated.wasm).
import { hasModule, inlineModule, sharedLibraries } from "./glue.js";
import { describeModule } from "wasm-fixture-pkg";

console.log(hasModule(), inlineModule().length, describeModule(), sharedLibraries());
