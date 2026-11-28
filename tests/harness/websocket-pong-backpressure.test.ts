/* A peer that sends pings and never reads the replies must not be able to
 * grow the client's write queue without bound: the automatic pong replies
 * stop once the unsent output passes a backlog, and resume as it drains.
 *
 * Node's client keeps reading and queuing in this situation, so the bound is
 * pinned here rather than in the differential corpus. The program floods a
 * million maximum-size pings at a client whose peer refuses the replies and
 * reports the process's peak resident size (`VmHWM`): with the bound the
 * flood leaves a few tens of megabytes behind, without it the same run peaks
 * at about 500 MB.
 * SCRIPTC_SAN=1 builds this with ASan + the RC audit like every harness lane. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

async function compileAndRun(name: string, source: string): Promise<string> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `ws-pong-backpressure-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
  });
  if (!result.ok) {
    throw new Error(
      "program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  const { stdout } = await execFileAsync(result.binaryPath, [], {
    encoding: "utf8",
    timeout: 240000,
  });
  return stdout;
}

const PROGRAM = `import * as http from "node:http";
import { type IncomingMessage } from "node:http";
import { type Socket } from "node:net";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

// A maximum-size ping (125 bytes of payload): every reply is 131 bytes.
const PING = Buffer.concat([Buffer.from([0x89, 0x7d]), Buffer.alloc(125, 0x61)]);
const CLOSE = Buffer.from([0x88, 0x02, 0x03, 0xe8]);
const TOTAL = 1000000;

const server = http.createServer();
server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
  socket.on("error", () => {});
  socket.write(
    "HTTP/1.1 101 Switching Protocols\\r\\n" +
      "Upgrade: websocket\\r\\n" +
      "Connection: Upgrade\\r\\n" +
      "Sec-WebSocket-Accept: " +
      acceptFor(String(req.headers["sec-websocket-key"])) +
      "\\r\\n\\r\\n"
  );
  let started = false;
  let sent = 0;
  socket.on("data", () => {
    if (started) return;
    started = true;
    // The peer never reads the replies while the flood runs.
    socket.pause();
    const pump = (): void => {
      let n = 0;
      while (n < 50000 && sent < TOTAL && socket.write(PING)) {
        sent++;
        n++;
      }
      if (sent < TOTAL) {
        setTimeout(pump, 0);
        return;
      }
      console.log("flooded " + String(sent));
      // The peer reads again: the replies drain and the close completes.
      socket.resume();
      socket.write(CLOSE);
      socket.end();
    };
    pump();
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const ws = new WebSocket("ws://127.0.0.1:" + String(port) + "/");
  ws.onopen = () => ws.send("start");
  ws.onerror = () => console.log("client-error");
  ws.onclose = (event: CloseEvent) => {
    const status = readFileSync("/proc/self/status", "utf8");
    const hwm = /VmHWM:\\s+(\\d+) kB/.exec(status);
    console.log("close " + String(event.code) + " hwm " + (hwm ? hwm[1] : "?"));
    server.close();
    process.exit(0);
  };
  setTimeout(() => {
    console.log("timeout");
    process.exit(0);
  }, 20000);
});
`;

test.skipIf(process.platform !== "linux")(
  "automatic pong replies stay bounded while the peer will not read",
  async () => {
    const stdout = await compileAndRun("pong-backpressure", PROGRAM);
    expect(stdout).toContain("flooded 1000000");
    const match = /close 1000 hwm (\d+)/.exec(stdout);
    expect(match).not.toBeNull();
    // The flood itself is a million pings (about 130 MB of replies into a
    // peer that is not reading); with the bound the process peaks in the
    // tens of megabytes, without it at about 500 MB.
    expect(Number(match?.[1])).toBeLessThan(150000);
  },
);
