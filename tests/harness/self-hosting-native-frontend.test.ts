import { describe, test } from "vitest";
import { checkProgram, programs, useNativeFrontend } from "./native-frontend.js";

// The native frontend checks are split across self-hosting-native-frontend.test.ts,
// self-hosting-native-frontend-programs.test.ts and self-hosting-native-frontend-checks.test.ts,
// so that CI runs them in separate processes; each file builds the frontend once
// (about 4 minutes on a CI runner). The sanitized Linux suite runs them in the
// native_frontend_san jobs, away from the shards' corpus workers.
describe("the complete frontend produces executable IR without Node (llvm)", () => {
  const frontend = useNativeFrontend();
  test.for(programs.slice(0, 6))("%s runs as under Node", async (file) =>
    checkProgram(frontend(), file),
  );
});
