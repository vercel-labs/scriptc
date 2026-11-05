import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tsgoExecutable } from "./rpc-api.js";

/** An API server the TypeScript client tests run against. */
export interface Ts7TestServer {
  /** The label tests append to their names. */
  name: string;
  executable: string;
  /** Whether the server speaks TypeScript 7.1's protocol. */
  ts71: boolean;
}

const require = createRequire(import.meta.url);

/** tsc 7.0.2 from the pinned `typescript` package and tsc 7.1.0-beta from
 * the `typescript-7.1` test dependency, so the client's protocol 5 and
 * protocol 9 paths answer the same cases. For tests only. */
export function ts7TestServers(): Ts7TestServer[] {
  const root = dirname(require.resolve("typescript-7.1/package.json"));
  const { default: getExePath } = require(join(root, "lib/getExePath.js")) as {
    default: () => string;
  };
  return [
    { name: "tsc 7.0", executable: tsgoExecutable(), ts71: false },
    { name: "tsc 7.1", executable: getExePath(), ts71: true },
  ];
}
