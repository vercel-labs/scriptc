/* The island's web-platform globals — the scriptc-ONLY half of the story.
 * Value behavior is differential (the web-streams npm fixture runs against
 * Node's real WHATWG streams); what lives here is what Node CANNOT oracle:
 * the fences. The island implements the subset the AI-SDK/eventsource-parser
 * paths exercise and rejects the rest with clear errors instead of silently
 * misbehaving — these tests pin the fence messages so the subset statement
 * in SEMANTICS.md stays honest.
 *
 * SCRIPTC_SAN=1 builds with ASan + the RC audit; the island's counting
 * allocator asserts zero live engine allocations at teardown.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Compiles an inline --dynamic program and runs it (nonzero exit ok). */
async function compileAndRun(name: string, source: string): Promise<RunResult> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `web-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.ts`);
  writeFileSync(file, source);
  // Deliberately NO backend pin: these are flagless-user-shaped --dynamic
  // builds, so the suite rides the release default (LLVM where the tier
  // claims the program, the transparent C fallback where it refuses). The
  // fence MESSAGES asserted below come from the island runtime the two
  // backends share, so they are lane-invariant by construction.
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    dynamic: true,
  });
  if (!result.ok) {
    throw new Error(
      "web-globals program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  }
}

/** Evaluates island code that must produce a one-line string. */
async function islandEval(name: string, js: string): Promise<string> {
  const r = await compileAndRun(name, `console.log(__island_eval(${JSON.stringify(js)}));\n`);
  expect(r.exitCode).toBe(0);
  expect(r.stderr).toBe("");
  return r.stdout.trimEnd();
}

describe(`island web globals (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("the subset is present; the fenced-by-absence globals are not", async () => {
    const out = await islandEval(
      "web-presence",
      `[
        typeof ReadableStream, typeof TransformStream, typeof TextEncoder,
        typeof TextDecoder, typeof TextDecoderStream, typeof URLSearchParams,
        typeof btoa, typeof atob, typeof Headers, typeof crypto, typeof console,
        typeof Blob, typeof File, typeof Event, typeof EventTarget, typeof CustomEvent,
        typeof WritableStream, typeof structuredClone, typeof FormData,
        typeof WebSocket,
      ].join(' ')`,
    );
    // Blob/File and the Event triple joined the subset when the vercel
    // CLI's graph started loading undici (its fileapi classes extend
    // Event and buffer.Blob at LOAD); structuredClone joined with the
    // globals lane (the HTML StructuredSerialize subset, cycles
    // included); WritableStream/FormData/WebSocket stay fenced by
    // absence.
    expect(out).toBe(
      "function function function function function function " +
        "function function function object object " +
        "function function function function function " +
        "undefined function undefined undefined",
    );
  });

  test("node:stream/web exposes only the implemented module constructors", async () => {
    const out = await islandEval(
      "web-stream-module-presence",
      `(() => {
        const m = globalThis.__scr_require('node:stream/web');
        return [
          typeof m.ReadableStream,
          typeof m.TransformStream,
          typeof m.TextDecoderStream,
          'WritableStream' in m,
          'TextEncoderStream' in m,
          'CountQueuingStrategy' in m,
          'ByteLengthQueuingStrategy' in m,
          'ReadableStreamDefaultReader' in m,
          'ReadableStreamDefaultController' in m,
          'WritableStreamDefaultWriter' in m,
        ].join(' ');
      })()`,
    );
    expect(out).toBe("function function function false false false false false false false");
  });

  test("structuredClone clones deep (cycles included) and validates options like Node", async () => {
    const out = await islandEval(
      "web-structured-clone",
      `(() => {
        const grab = (f) => { try { return String(f()); } catch (e) { return e.name + '/' + (e.code || '') + ': ' + e.message; } };
        const cyc = { n: 1 }; cyc.self = cyc;
        const cloned = structuredClone(cyc);
        const m = structuredClone(new Map([['k', [1, 2]]]));
        const dx = structuredClone(new DOMException('t', 'DataCloneError'));
        return [
          cloned !== cyc && cloned.self === cloned && cloned.n === 1,
          m.get('k').join(','),
          dx.name + ':' + dx.message + ':' + (dx instanceof DOMException),
          grab(() => structuredClone()),
          grab(() => structuredClone(undefined, '')),
          grab(() => structuredClone(undefined, { transfer: '' })),
          grab(() => structuredClone({}, { transfer: { *[Symbol.iterator]() {} } })) === '[object Object]',
          grab(() => structuredClone(() => {})),
        ].join(' | ');
      })()`,
    );
    expect(out).toBe(
      [
        "true",
        "1,2",
        "DataCloneError:t:true",
        'TypeError/ERR_MISSING_ARGS: The "The value argument must be specified" argument must be specified',
        "TypeError/ERR_INVALID_ARG_TYPE: Failed to execute 'structuredClone': Options cannot be converted to a dictionary",
        "TypeError/ERR_INVALID_ARG_TYPE: Failed to execute 'structuredClone': transfer in Options can not be converted to sequence.",
        "true",
        "DataCloneError/25: () => {} could not be cloned.",
      ].join(" | "),
    );
  });

  test("MessageChannel/MessagePort are globals; postMessage delivers clones", async () => {
    const out = await islandEval(
      "web-messagechannel",
      `(() => {
        const ch = new MessageChannel();
        const msg = { a: [1, 2] };
        ch.port1.postMessage(msg);
        const got = ch.port2._queue[0];
        return [
          typeof MessageChannel, typeof MessagePort,
          ch.port2 instanceof MessagePort,
          got.message !== msg && got.message.a.join(',') === '1,2',
        ].join(' ');
      })()`,
    );
    expect(out).toBe("function function true true");
  });

  test("tee, pipeTo, BYOB readers, and byte streams are fenced with clear errors", async () => {
    const out = await islandEval(
      "web-fences",
      `(() => {
        const grab = (f) => { try { f(); return 'no-throw'; } catch (e) { return e.message; } };
        return [
          grab(() => new ReadableStream().tee()),
          grab(() => new ReadableStream().pipeTo({})),
          grab(() => new ReadableStream().getReader({ mode: 'byob' })),
          grab(() => new ReadableStream({ type: 'bytes' })),
        ].join(' | ');
      })()`,
    );
    expect(out).toBe(
      [
        "ReadableStream.tee is not supported in the scriptc island",
        "ReadableStream.pipeTo is not supported in the scriptc island (use pipeThrough or a reader)",
        "BYOB readers are not supported in the scriptc island",
        "byte streams (type: 'bytes') are not supported in the scriptc island",
      ].join(" | "),
    );
  });

  test("TextDecoder is utf-8 only; base64 rejects like the platform", async () => {
    const out = await islandEval(
      "web-encoder-fences",
      `(() => {
        const grab = (f) => { try { f(); return 'no-throw'; } catch (e) { return e.name + ': ' + e.message; } };
        return [
          grab(() => new TextDecoder('latin1')),
          grab(() => atob('a')),
          grab(() => atob('a$==')),
          grab(() => btoa('é😀')),
        ].join(' | ');
      })()`,
    );
    expect(out).toBe(
      [
        "RangeError: the scriptc island's TextDecoder supports utf-8 only (got 'latin1')",
        "InvalidCharacterError: Invalid character",
        "InvalidCharacterError: Invalid character",
        "InvalidCharacterError: Invalid character",
      ].join(" | "),
    );
  });

  test("crypto bridges the runtime's CSPRNG: v4 UUIDs, real fills, spec limits", async () => {
    const out = await islandEval(
      "web-crypto",
      `(() => {
        const u = crypto.randomUUID();
        const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u);
        const a = new Uint8Array(32);
        const r = crypto.getRandomValues(a);
        let filled = false;
        for (let i = 0; i < a.length; i++) if (a[i] !== 0) filled = true;
        const distinct = crypto.randomUUID() !== u;
        let quota = 'no-throw';
        try { crypto.getRandomValues(new Uint8Array(65537)); } catch (e) { quota = e.name; }
        let mismatch = 'no-throw';
        try { crypto.getRandomValues(new Float64Array(2)); } catch (e) { mismatch = e.name; }
        return [shape, r === a, filled, distinct, quota, mismatch].join(' ');
      })()`,
    );
    expect(out).toBe("true true true true QuotaExceededError TypeMismatchError");
  });

  // The prelude's Date patch (divergence 289): quickjs-ng stops at the GMT
  // offset; Node appends the parenthesized timezone name. Shape-asserted —
  // the machine's zone decides the name (UTC's is byte-exact vs Node, other
  // zones render C-library names; the vercel e2e suite pins UTC end to end).
  test("Date#toString/#toTimeString carry the timezone-name suffix Node prints", async () => {
    const out = await islandEval(
      "web-date-tzname",
      `(() => {
        const full = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \\d{2} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT[+-]\\d{4} \\(.+\\)$/;
        const time = /^\\d{2}:\\d{2}:\\d{2} GMT[+-]\\d{4} \\(.+\\)$/;
        const d = new Date(0);
        return [
          full.test(d.toString()) ? 'suffixed' : 'BAD:' + d.toString(),
          full.test(String(d)) ? 'suffixed' : 'BAD:' + String(d),
          time.test(d.toTimeString()) ? 'suffixed' : 'BAD:' + d.toTimeString(),
          String(new Date(NaN)),
          new Date(NaN).toTimeString(),
        ].join(' | ');
      })()`,
    );
    expect(out).toBe("suffixed | suffixed | suffixed | Invalid Date | Invalid Date");
  });
});
