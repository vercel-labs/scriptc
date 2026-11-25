import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);

// 'prefinish' on the HTTP/2 compatibility response is refused at run time,
// by name (scr_http_res_on_prefinish): the same lowering serves an HTTP/1
// response, where the event is implemented, so the build cannot tell the
// two apart. Node registers the listener and never calls it, so this is a
// native-only contract and not a differential program. Only a JavaScript
// source reaches it: in TypeScript the response's `on` takes "close" alone
// and the registration is a type error (SC0001). What this pins is that the
// refusal is an ordinary exception at the registration: a `try` around it
// catches it there, and the statement after the registration does not run
// first.
async function run(source: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "scriptc-http2-prefinish-refusal-"));
  const entry = join(outDir, "main.mjs");
  writeFileSync(entry, source);
  const result = await compile(entry, {
    backend: "llvm",
    sanitize: process.env["SCRIPTC_SAN"] === "1",
    outDir,
    outPath: join(outDir, "program"),
  });
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.ok) return { stdout: "", stderr: "", code: -1 };
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code ?? -1 };
  }
}

const REFUSAL = "Http2ServerResponse.on('prefinish') is not supported by the static runtime yet";

/** One request against a compatibility-API server whose handler is `handler`. */
function program(handler: string): string {
  return `import http2 from "node:http2";

const server = http2.createServer((request, response) => {
${handler}
});
server.listen(0, "127.0.0.1", () => {
  const client = http2.connect(\`http://127.0.0.1:\${server.address().port}\`);
  const request = client.request({ ":path": "/" });
  request.setEncoding("utf8");
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("close", () => {
    console.log("client body", body);
    client.close(() => server.close());
  });
  request.end();
});
`;
}

const CAUGHT = `  try {
    response.on("prefinish", () => console.log("prefinish fired (on)"));
    console.log("after on");
  } catch (error) {
    console.log("caught on:", error.message);
  }
  try {
    response.once("prefinish", () => console.log("prefinish fired (once)"));
    console.log("after once");
  } catch (error) {
    console.log("caught once:", error.message);
  }
  console.log("handler goes on");
  response.end("ok");`;

const CAUGHT_LINES = [
  `caught on: ${REFUSAL}`,
  `caught once: ${REFUSAL}`,
  "handler goes on",
  "client body ok",
  "",
];

test("a handler catches the refused 'prefinish' registration at the registration", async () => {
  const { stdout, stderr, code } = await run(program(CAUGHT));
  expect(stdout.split("\n")).toEqual(CAUGHT_LINES);
  expect(stderr).toBe("");
  expect(code).toBe(0);
}, 120_000);

test("an uncaught refusal ends the handler before the statement after the registration", async () => {
  const { stdout, stderr, code } = await run(
    program(`  response.on("prefinish", () => console.log("prefinish fired"));
  console.log("after registration");
  response.end("ok");`),
  );
  expect(stdout).toBe("");
  expect(stderr).toContain(`Uncaught Error: ${REFUSAL}`);
  // 1 in a plain build. A sanitized build ends with the audit's status
  // instead: an uncaught error leaves the session's handles live at exit,
  // whatever threw it in the handler.
  expect(code).not.toBe(0);
}, 120_000);
