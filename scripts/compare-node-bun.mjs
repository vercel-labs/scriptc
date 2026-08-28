#!/usr/bin/env node
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { compile } from "../packages/compiler/src/index.ts";

const TESTS = [
  {
    id: "1200",
    name: "Array.isArray Extended",
    code: `
const a: unknown = [1, 2, 3];
const b: unknown = "hello";
console.log(Array.isArray(a));
console.log(Array.isArray(b));
console.log(Array.isArray([10, 20]));
`,
  },
  {
    id: "1201",
    name: "Array.splice with Items",
    code: `
const arr = [1, 2, 3, 4, 5];
const removed = arr.splice(1, 2, 100, 200, 300);
console.log(arr.join(","));
console.log(removed.join(","));
`,
  },
  {
    id: "1202",
    name: "crypto.timingSafeEqual",
    code: `
import { timingSafeEqual } from "crypto";
const b1 = Buffer.from("secret123");
const b2 = Buffer.from("secret123");
const b3 = Buffer.from("secret456");
console.log(timingSafeEqual(b1, b2));
console.log(timingSafeEqual(b1, b3));
`,
  },
  {
    id: "1203",
    name: "crypto bare digest()",
    code: `
import { createHash } from "crypto";
const buf = createHash("sha256").update("hello world").digest();
console.log(buf.length);
console.log(buf[0]);
`,
  },
  {
    id: "1204",
    name: "net.isIP / isIPv4 / isIPv6",
    code: `
import { isIP, isIPv4, isIPv6 } from "net";
console.log(isIP("127.0.0.1"));
console.log(isIP("::1"));
console.log(isIP("invalid"));
console.log(isIPv4("192.168.1.1"));
console.log(isIPv6("fe80::1"));
`,
  },
  {
    id: "1205",
    name: "URL.port property",
    code: `
const u1 = new URL("http://localhost:8080/test");
const u2 = new URL("https://example.com/path");
console.log(u1.port);
console.log(u2.port);
console.log(u1.hostname);
`,
  },
  {
    id: "1206",
    name: "process.memoryUsage()",
    code: `
const mem = process.memoryUsage();
console.log(mem.rss > 0);
console.log(mem.heapTotal > 0);
console.log(mem.heapUsed > 0);
`,
  },
  {
    id: "1207",
    name: "Array.from(Set / Array)",
    code: `
const s = new Set([10, 20, 30]);
const a1 = Array.from(s);
console.log(a1.join("-"));
const a2 = Array.from([1, 2, 3]);
console.log(a2.join("+"));
`,
  },
  {
    id: "1208",
    name: "Nullable Set/Date in Unions",
    code: `
function testDate(d: Date | null): string {
  if (d === null) return "null";
  return "date:" + d.getTime();
}
function testSet(s: Set<number> | undefined): number {
  if (s === undefined) return 0;
  return s.size;
}
console.log(testDate(null));
console.log(testDate(new Date(1700000000000)));
console.log(testSet(undefined));
console.log(testSet(new Set([1, 2, 3, 4])));
`,
  },
  {
    id: "1209",
    name: "Array.of static method",
    code: `
const arr = Array.of(10, 20, 30, 40);
console.log(arr.length);
console.log(arr.join(":"));
`,
  },
  {
    id: "1210",
    name: "Object.fromEntries & Object.entries",
    code: `
const entries: [string, number][] = [["apple", 5], ["banana", 10]];
const obj = Object.fromEntries(entries);
console.log(obj["apple"]);
console.log(obj["banana"]);
console.log(Object.keys(obj).join(","));
console.log(Object.values(obj).join(","));
`,
  },
  {
    id: "1211",
    name: "new Set with Array Iterable",
    code: `
const s = new Set([1, 2, 2, 3, 3, 3]);
console.log(s.size);
console.log(s.has(1));
console.log(s.has(2));
console.log(s.has(4));
`,
  },
];

async function run() {
  console.log("==========================================================================================");
  console.log(" COMPARATIVE DIFFERENTIAL TEST SUITE: ScriptC vs Node.js vs Bun.js");
  console.log("==========================================================================================");

  let passed = 0;
  for (const t of TESTS) {
    const tmp = mkdtempSync(join(tmpdir(), "cmp-test-"));
    const srcFile = join(tmp, "app.ts");
    const binFile = join(tmp, "app");
    writeFileSync(srcFile, t.code);

    // 1. Run with Node.js
    const nodeRes = spawnSync(process.execPath, ["--import", "tsx", srcFile], { encoding: "utf8" });
    const nodeOut = (nodeRes.stdout || "").trim();

    // 2. Run with Bun.js
    let bunOut = "";
    const bunBin = existsSync("/home/ivan/.bun/bin/bun")
      ? "/home/ivan/.bun/bin/bun"
      : spawnSync("which", ["bun"]).stdout?.toString().trim() || "bun";
    const bunRes = spawnSync(bunBin, ["run", srcFile], { encoding: "utf8" });
    bunOut = (bunRes.stdout || "").trim();

    // 3. Compile and Run with ScriptC
    let scriptcOut = "";
    try {
      const res = await compile(srcFile, { outPath: binFile, outDir: tmp, dynamic: false, backend: "c" });
      if (!res.ok) {
        scriptcOut = "COMPILE FAILED: " + res.diagnostics.map((d) => d.code + ": " + d.message).join("; ");
      } else {
        const scrRes = spawnSync(binFile, [], { encoding: "utf8" });
        scriptcOut = (scrRes.stdout || "").trim();
        if (!scriptcOut && scrRes.stderr) {
          scriptcOut = "STDERR: " + scrRes.stderr;
        } else if (scrRes.status !== 0) {
          scriptcOut = `EXIT ${scrRes.status}: ` + scrRes.stderr;
        }
      }
    } catch (e) {
      scriptcOut = "COMPILE ERROR: " + (e.message || e);
    }

    const nodeMatch = scriptcOut === nodeOut;
    const bunMatch = scriptcOut === bunOut;
    const allMatch = nodeMatch && bunMatch;

    if (allMatch) {
      passed++;
      console.log(`[PASS] ${t.id} - ${t.name.padEnd(35)} | Node: MATCH | Bun: MATCH | ScriptC: MATCH`);
    } else {
      console.log(`[FAIL] ${t.id} - ${t.name.padEnd(35)}`);
      console.log(`       Node   : ${JSON.stringify(nodeOut)}`);
      console.log(`       Bun    : ${JSON.stringify(bunOut)}`);
      console.log(`       ScriptC: ${JSON.stringify(scriptcOut)}`);
    }

    rmSync(tmp, { recursive: true, force: true });
  }

  console.log("==========================================================================================");
  console.log(` SUMMARY: ${passed}/${TESTS.length} tests passed byte-for-byte identical across Node, Bun & ScriptC.`);
  console.log("==========================================================================================");
  if (passed !== TESTS.length) {
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});