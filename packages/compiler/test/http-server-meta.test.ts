import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze } from "../src/index.js";

test("HTTP Server off, listeners, and newListener lower without diagnostics", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-http-server-meta-"));
  try {
    const entry = join(dir, "main.ts");
    writeFileSync(
      entry,
      `
      import * as http from "node:http";
      const server = http.createServer();
      const rejectRequest = (_req: http.IncomingMessage, res: http.ServerResponse) => {
        res.end("reject");
      };
      const rejectUpgrade = (_req: http.IncomingMessage, socket: import("net").Socket) => {
        socket.end();
      };
      server.on("request", rejectRequest);
      server.on("upgrade", rejectUpgrade);
      server.on("newListener", function onNewListener(event) {
        if (event === "request") server.off("request", rejectRequest);
        if (event === "upgrade") server.off("upgrade", rejectUpgrade);
        if (
          !server.listeners("request").includes(rejectRequest) &&
          !server.listeners("upgrade").includes(rejectUpgrade)
        ) {
          server.off("newListener", onNewListener);
        }
      });
      server.on("request", (_req, res) => {
        res.end("ok");
      });
      `,
    );
    const { coverage } = analyze(entry, {});
    expect(coverage.preflightFailed).toBe(false);
    expect(coverage.diagnostics).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
