import { describe, test } from "vitest";
import {
  checkDiagnostics,
  checkLibraryContract,
  checkNativeBindings,
  checkNpmStatic,
  checkProgram,
  programs,
  useNativeFrontend,
} from "./native-frontend.js";

// The native frontend checks are split across self-hosting-native-frontend.test.ts,
// self-hosting-native-frontend-programs.test.ts and self-hosting-native-frontend-checks.test.ts,
// so that CI runs them in separate processes; each file builds the frontend once
// (about 4 minutes on a CI runner). The sanitized Linux suite runs them in the
// native_frontend_san jobs, away from the shards' corpus workers.
describe("the complete frontend produces executable IR without Node (llvm)", () => {
  const frontend = useNativeFrontend();
  test.for(programs.slice(12))("%s runs as under Node", async (file) =>
    checkProgram(frontend(), file),
  );
  test("opted-in npm packages lower statically and a deviant __toESM package is refused", () =>
    checkNpmStatic(frontend()));
  test("a type error and a static refusal report the Node pipeline's diagnostics", () =>
    checkDiagnostics(frontend()));
  test("the library syntax contract matches the Node pipeline", () =>
    checkLibraryContract(frontend()));
  test("FFI-bound native functions lower, link and run", () => checkNativeBindings(frontend()));
});
