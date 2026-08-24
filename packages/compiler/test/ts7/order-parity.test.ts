/* The MODULE-ORDER (and preflight-verdict) canary: every entry runs the
 * REAL lifecycle through the native (tsgo) frontend and must produce
 * exactly the RECORDED baseline's preflight diagnostics (code, message
 * text, span — the full structured diagnostic) and module evaluation
 * order (baselines/order-parity.json).
 *
 * The baselines were recorded from the typescript@5.9.3 program.ts lane at
 * the phase-4 flip commit — the last commit where both frontends shipped —
 * after the phase-2/3 parity sweeps held the two lanes byte-identical over
 * this same entry set. So "matches the baseline" IS "matches 5.9.3",
 * without keeping the deleted 5.9.3 pipeline alive to ask.
 *
 * ── tsgo UPGRADE PLAYBOOK ────────────────────────────────────────────────
 * This suite (order-parity here; parity.test.ts / resolver-parity.test.ts /
 * facade.test.ts against the live typescript5 island) is the canary lane
 * for bumping the "typescript" (tsgo) dependency:
 *  1. Bump the pin in packages/compiler/package.json, pnpm install,
 *     pnpm build (world-check.ts must still refuse cross-world objects).
 *  2. Run this directory's suites with the full sweep:
 *     SCRIPTC_TS7_ALL=1 pnpm exec vitest run packages/compiler/test/ts7.
 *  3. Every failure is a BEHAVIOR MOVE in the new tsgo. Triage each one:
 *     an intended upstream change (diagnostic wording, constituent order)
 *     gets reviewed and re-recorded; anything else is a regression to
 *     report upstream before shipping the bump.
 *  4. Re-record intentionally: SCRIPTC_UPDATE_BASELINES=1 pnpm exec vitest
 *     run packages/compiler/test/ts7/order-parity.test.ts rewrites
 *     baselines/order-parity.json from the CURRENT native lane; commit it
 *     with the behavior delta stated in the message, one bump per commit.
 *  5. Then the real gates: pnpm build + lint, both vitest lanes uncached,
 *     and the diagnostics snapshots (tests/harness/__snapshots__) — those
 *     re-pin the same way, one snapshot per commit with the delta named.
 *
 * Frontend-only (no lowering, no clang), so an entry costs one tsgo
 * program. The default lane runs a deterministic subset weighted toward
 * the risky shapes (every JS/CJS/MJS entry, every multi-file directory
 * case, every diagnostics fixture, the npm and strictness fixtures);
 * SCRIPTC_TS7_ALL=1 widens to the ENTIRE recorded set — the acceptance
 * sweep and the upgrade playbook's step 2. */

import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { checkPreflightTs7 } from "../../src/frontend/program.js";
import { Ts7Host } from "../../src/frontend/ts7/program-adapter.js";
import type { ScrDiagnostic } from "../../src/diagnostics/diagnostic.js";

const repoRoot = join(import.meta.dirname, "../../../..");
const baselinePath = join(import.meta.dirname, "baselines/order-parity.json");
const UPDATE = process.env["SCRIPTC_UPDATE_BASELINES"] === "1";

interface BaselineEntry {
  order: string[];
  diags: ScrDiagnostic[];
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
  entries: Record<string, BaselineEntry>;
};

/** Machine-independent spelling: absolute repo paths become "<repo>/…" in
 * file fields AND message text (cycle messages embed paths). */
const rel = (s: string): string => s.split(repoRoot + "/").join("<repo>/");

function nativeAnswer(host: Ts7Host, entry: string): BaselineEntry {
  const t7 = checkPreflightTs7(entry, host);
  return {
    order: t7.moduleOrder.map(rel),
    diags: t7.diags.map((d) => ({
      ...d,
      message: rel(d.message),
      loc: { ...d.loc, file: rel(d.loc.file) },
    })),
  };
}

function entriesUnder(dir: string): string[] {
  const exts = ["ts", "js", "mjs", "cjs"];
  return exts
    .flatMap((ext) => [
      ...globSync(join(repoRoot, dir, `*.${ext}`)),
      ...globSync(join(repoRoot, dir, `*/main.${ext}`)),
    ])
    .sort();
}

const FULL = process.env["SCRIPTC_TS7_ALL"] === "1" || UPDATE;

function allEntries(): string[] {
  return [
    ...entriesUnder("tests/corpus"),
    ...entriesUnder("tests/diagnostics"),
    ...entriesUnder("tests/fixtures/npm/cases"),
    ...globSync(join(repoRoot, "tests/fixtures/strictness/*/main.ts")).sort(),
    ...globSync(join(repoRoot, "tests/fixtures/node-types/*.ts")).sort(),
  ];
}

function pickEntries(): string[] {
  const all = allEntries();
  if (FULL) return all;
  // The default subset: everything whose SHAPE is order/preflight-sensitive,
  // plus a deterministic slice of the plain-TS corpus.
  const corpus = entriesUnder("tests/corpus");
  const rest = all.filter((f) => !corpus.includes(f));
  const risky = corpus.filter((f) => !f.endsWith(".ts") || f.endsWith("/main.ts"));
  const plain = corpus.filter((f) => !risky.includes(f)).filter((_, i) => i % 40 === 0);
  return [...risky, ...plain, ...rest];
}

const entries = pickEntries();
const host = new Ts7Host();
afterAll(() => host.close());

/* Entries run in CHUNKS of an async test each, with an event-loop yield
 * between entries: each entry is a fully synchronous blocking tsgo
 * round-trip, and hundreds of back-to-back synchronous tests starve the
 * vitest worker's RPC loop (the full sweep reproducibly died with
 * "[vitest-worker]: Timeout calling onTaskUpdate" — all tests green, exit
 * code 1). The chunking is cosmetic only: every assertion still names its
 * entry. */
const CHUNK = 20;
const chunks: string[][] = [];
for (let i = 0; i < entries.length; i += CHUNK) chunks.push(entries.slice(i, i + CHUNK));

if (UPDATE) {
  test("re-record baselines from the current native frontend", async () => {
    const record: Record<string, BaselineEntry> = {};
    for (const entry of allEntries()) {
      await new Promise((r) => setImmediate(r));
      record[rel(entry)] = nativeAnswer(host, entry);
    }
    writeFileSync(baselinePath, JSON.stringify({ entries: record }, null, 1) + "\n");
  });
} else {
  describe(`preflight/order canary vs recorded 5.9.3 baselines (${entries.length} entries${FULL ? ", full sweep" : ""})`, () => {
    test.for(chunks.map((c) => [`${c[0]!.slice(repoRoot.length + 1)} … +${c.length - 1}`, c] as const))(
      "%s",
      async ([, chunk]) => {
        for (const entry of chunk) {
          await new Promise((r) => setImmediate(r)); // keep the worker RPC alive
          const name = entry.slice(repoRoot.length + 1);
          const recorded = baseline.entries[rel(entry)];
          expect(
            recorded,
            `${name}: no recorded baseline — new fixture? re-record with SCRIPTC_UPDATE_BASELINES=1 (see the playbook comment)`,
          ).toBeDefined();
          const native = nativeAnswer(host, entry);
          expect(native.order, `${name}: module evaluation order`).toEqual(recorded!.order);
          expect(native.diags, `${name}: preflight diagnostics`).toEqual(recorded!.diags);
        }
      },
    );
  });
}

test("a malformed tsconfig fails preflight (JSON.parse wording — the pinned 5.9.3 delta)", () => {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-ts7-badcfg-"));
  writeFileSync(join(dir, "tsconfig.json"), '{ "compilerOptions": { "strict": true, }\n'); // missing brace
  writeFileSync(join(dir, "main.ts"), "console.log(1);\n");
  const entry = join(dir, "main.ts");
  const t7 = checkPreflightTs7(entry, host);
  rmSync(dir, { recursive: true, force: true });
  // Exactly one SC0001 anchored at the tsconfig. The TEXT is JSON.parse's
  // (program.ts's jsoncSyntaxError comment) — 5.9.3 said "'}' expected.";
  // no snapshot pins the wording.
  expect(t7.diags.map((d) => [d.code, d.loc.file])).toEqual([["SC0001", join(dir, "tsconfig.json")]]);
});

test("harness sanity: the subset always covers the order-sensitive shapes", () => {
  expect(entries.some((f) => f.endsWith(".cjs"))).toBe(true);
  expect(entries.some((f) => f.endsWith(".mjs"))).toBe(true);
  expect(entries.some((f) => f.endsWith(".js"))).toBe(true);
  expect(entries.some((f) => f.includes("/main."))).toBe(true);
  expect(entries.some((f) => readFileSync(f, "utf8").includes("require("))).toBe(true);
});
