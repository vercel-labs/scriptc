import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { checkerServerName } from "./checker-server.js";

const dir = mkdtempSync(join(tmpdir(), "scriptc-checker-server-"));
const executable = join(dir, "tsc-ts");
writeFileSync(executable, "server");
const enabled = { SCRIPTC_CHECKER_SERVER: "1" };
const posix = process.platform === "linux" || process.platform === "darwin";

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("builds use the shared checker server by default outside CI, on Linux and macOS, with tsc-ts", () => {
  expect(checkerServerName(executable, dir, false, { SCRIPTC_CHECKER_SERVER: "0" })).toBeNull();
  expect(checkerServerName(executable, dir, false, { SCRIPTC_CHECKER: "tsgo" })).toBeNull();
  expect(
    checkerServerName(executable, dir, false, { ...enabled, SCRIPTC_CHECKER: "tsgo" }),
  ).toBeNull();
  // CI turns the default off; SCRIPTC_CHECKER_SERVER=1 turns it back on.
  expect(checkerServerName(executable, dir, false, { CI: "true" })).toBeNull();
  expect(checkerServerName(executable, dir, false, { CI: "1" })).toBeNull();
  const name = checkerServerName(executable, dir, false, {});
  for (const env of [enabled, { CI: "false" }, { CI: "0" }, { CI: "" }, { ...enabled, CI: "true" }])
    expect(checkerServerName(executable, dir, false, env)).toBe(name);
  if (!posix) expect(name).toBeNull();
  else expect(name).toMatch(/^[0-9a-f]{32}$/);
});

test.skipIf(!posix)(
  "the server's name changes with what its answers depend on, and with nothing else",
  () => {
    const name = checkerServerName(executable, dir, false, enabled);
    expect(
      checkerServerName(executable, dir, false, { ...enabled, SCRIPTC_CHECKER: "tsc-ts" }),
    ).toBe(name);
    expect(checkerServerName(executable, dir, false, { ...enabled, PATH: "/elsewhere" })).toBe(
      name,
    );
    const others = [
      checkerServerName(executable, join(dir, "other"), false, enabled),
      checkerServerName(executable, dir, true, enabled),
      checkerServerName(executable, dir, false, { ...enabled, TSC_TS_LIB_DIR: dir }),
      checkerServerName(executable, dir, false, { ...enabled, TSC_TS_LISTEN_MEMORY: "512" }),
    ];
    for (const other of others) expect(other).not.toBe(name);
    // An updated tsc-ts executable gets its own server.
    utimesSync(executable, new Date(0), new Date(0));
    expect(checkerServerName(executable, dir, false, enabled)).not.toBe(name);
  },
);
