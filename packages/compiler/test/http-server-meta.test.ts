import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { analyze, compile, deserializeModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";

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

// The listener array is typed at the event's canonical arity while the
// searched function may declare fewer parameters: the search must still
// compile (the IR intrinsic types its needle at the element type) and
// must compare by identity, as Node's `Function ===` does.
test("a func search over a wider element type keeps the identity comparison", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-http-server-meta-"));
  try {
    const entry = join(dir, "main.ts");
    const output = join(dir, "main.ir.json");
    writeFileSync(
      entry,
      `
      const handlers: ((x: number, i: number) => void)[] = [];
      function log(x: number): void {
        console.log("log", x);
      }
      const quiet = (x: number): void => {};
      handlers.push(log);
      handlers.push(quiet);
      console.log(handlers.includes(log), handlers.indexOf(quiet));
      console.log(handlers.includes((x: number) => {}));
      `,
    );
    const result = await compile(entry, { outDir: dir, outPath: output, outputKind: "ir" });
    expect(result.ok ? [] : result.diagnostics.map((d) => `${d.code}: ${d.message}`)).toEqual([]);
    if (!result.ok) return;
    const llvm = emitLlvmModule(deserializeModule(readFileSync(output, "utf8")));
    // The comparison is by identity root, not by pointer: an adapted
    // needle stands for the function it forwards to.
    expect(llvm).toContain("@scr_closure_identity_equal(ptr");
    expect(llvm).toContain("@scr_closure_adopt_identity(ptr");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
