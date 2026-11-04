import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPreflightTs7 } from "./program.js";
import { Ts7Api } from "./ts7/api.js";
import { Ts7Host } from "./ts7/program-host.js";
import { Ts7RpcClient } from "./ts7/rpc-client.js";
import { TS7_FILE_SYSTEM_CALLBACKS } from "./ts7/rpc-filesystem.js";
import { spawnTs7Wire } from "./ts7/rpc-process.js";
import { ts7TestServers } from "./ts7/test-servers.js";

test("an `import source` declaration from tsc 7.1 is reported as unsupported (SC1090)", () => {
  const server = ts7TestServers().find((candidate) => candidate.ts71)!;
  const dir = mkdtempSync(join(tmpdir(), "scriptc-source-phase-"));
  const entry = join(dir, "main.ts");
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const declaration = 'import source mod from "./x.wasm";';
  writeFileSync(entry, `${declaration}\nconsole.log(typeof mod);\n`);
  const host = new Ts7Host(
    (options) =>
      new Ts7Api(
        new Ts7RpcClient(
          spawnTs7Wire(server.executable, [
            "--api",
            "--cwd",
            options.cwd,
            `--callbacks=${TS7_FILE_SYSTEM_CALLBACKS}`,
          ]),
        ),
        options.fs,
        options.collectTiming,
      ),
    { cwd: dir },
  );
  try {
    const { diags } = checkPreflightTs7(entry, host);
    const unsupported = diags.filter((diag) => diag.code === "SC1090");
    expect(unsupported.map(({ message, loc }) => [message, loc.start, loc.end])).toEqual([
      ["source phase imports (`import source`) are not supported yet", 0, declaration.length],
    ]);
  } finally {
    host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
