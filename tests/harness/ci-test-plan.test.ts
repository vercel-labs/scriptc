import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";
import {
  ciTestPlan,
  corpusFiles,
  darwinCorpusFiles,
  darwinFiles,
  effectFiles,
  fileExclusions,
  caseShardedSideFiles,
  isolatedFiles,
  leakSuppressions,
  memoryHeavyFiles,
  sanitizedNodesJobEnv,
  sideOwners,
  testCosts,
} from "../../scripts/ci-test-plan.mjs";
import { runCiTestPlan } from "../../scripts/ci-test.mjs";

test.for([1, 3, 5, 10, 20])(
  "CI retains every suite with %i shards without mixing partition axes",
  (count) => {
    for (const flavor of ["plain", "san"]) {
      const plans = Array.from({ length: count }, (_, index) =>
        ciTestPlan({ shard: `${index + 1}/${count}`, flavor }),
      );
      const sideFiles = plans.flatMap((plan) =>
        plan.side.filter((task) => task.args.length === 2).map((task) => task.args[1]),
      );
      for (const file of fileExclusions.filter(
        (file) =>
          !corpusFiles.includes(file) &&
          !effectFiles.includes(file) &&
          !file.includes("native-driver") &&
          !file.includes("coverage") &&
          !file.includes("native-toolchain"),
      )) {
        // A suite that splits its own tests runs on every shard; the others on one.
        const everyShard = caseShardedSideFiles.some(([, sharded]) => sharded === file);
        expect(
          sideFiles.filter((selected) => selected === file),
          file,
        ).toHaveLength(everyShard ? count : 1);
      }
      // Each measured or memory-heavy file runs on exactly one shard, outside
      // vitest's file shard.
      const isolated = new Set(isolatedFiles.map(([, file]) => file));
      const balanced = plans.flatMap((plan) =>
        plan.side
          .filter((task) => task.name === "cost-balanced tests")
          .flatMap((task) => task.args.slice(2)),
      );
      const measured = [
        ...new Set([...Object.keys(testCosts[flavor]), ...Object.keys(memoryHeavyFiles)]),
      ].filter((file) => !isolated.has(file));
      expect(measured.length).toBeGreaterThan(0);
      expect(balanced.toSorted()).toEqual(measured.toSorted());
      for (const plan of plans) {
        expect(plan.corpus.args).toEqual(["test", ...corpusFiles]);
        expect(plan.side[0]!.args).toContain(`--shard=${plan.corpus.env.SCRIPTC_TEST_SHARD}`);
        for (const file of [
          ...fileExclusions,
          ...Object.keys(testCosts[flavor]),
          ...Object.keys(memoryHeavyFiles),
        ])
          expect(plan.side[0]!.args).toContain(`--exclude=${file}`);
        const cache = plan.side.find((task) => task.name === "native-cache correctness");
        expect(Boolean(cache)).toBe(flavor === "plain");
        if (cache) {
          expect(cache.env.SCRIPTC_CACHE_TEST_SHARD).toBe(plan.corpus.env.SCRIPTC_TEST_SHARD);
          expect(cache.env.SCRIPTC_TEST_STABLE_TOOLCHAIN).toBe("0");
        }
        expect(plan.side.some((task) => task.name === "coverage sweep")).toBe(flavor === "plain");
      }
    }
  },
);

test("LeakSanitizer runs over the sanitized corpus on Linux only", () => {
  const plan = (flavor: "plain" | "san", platform: string) =>
    ciTestPlan({ shard: "1/20", flavor, workers: 4, platform });
  const linuxSan = plan("san", "linux").corpus.env;
  expect(linuxSan.ASAN_OPTIONS).toBe("detect_leaks=1");
  expect(linuxSan.LSAN_OPTIONS).toBe(`suppressions=${leakSuppressions}:print_suppressions=0`);
  expect(existsSync(leakSuppressions)).toBe(true);
  for (const env of [plan("plain", "linux").corpus.env, plan("san", "darwin").corpus.env]) {
    expect(env.ASAN_OPTIONS).toBeUndefined();
    expect(env.LSAN_OPTIONS).toBeUndefined();
  }
  for (const task of plan("san", "linux").side) expect(task.env.ASAN_OPTIONS).toBeUndefined();
});

test("the sanitized three.js nodes build leaves the Linux corpus for its own job", () => {
  const plan = (flavor: "plain" | "san", platform: string) =>
    ciTestPlan({ shard: "1/20", flavor, workers: 4, platform });
  const [name, value] = Object.entries(sanitizedNodesJobEnv)[0]!;
  expect(plan("san", "linux").corpus.env[name]).toBe(value);
  for (const env of [plan("plain", "linux").corpus.env, plan("san", "darwin").corpus.env])
    expect(env[name]).toBeUndefined();
  const three = readFileSync(new URL("./three.test.ts", import.meta.url), "utf8");
  expect(three).toContain(`process.env["${name}"] === "${value}"`);
  const { jobs } = load(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as {
    jobs: Record<
      string,
      { needs: string[]; env: Record<string, string>; steps: { run?: string }[] }
    >;
  };
  const job = jobs["three_nodes_san"]!;
  expect(job.needs).toContain("native_linux");
  expect(jobs["test"]!.needs).toContain("three_nodes_san");
  expect(job.env[name]).toBeUndefined();
  expect(job.env["SCRIPTC_SAN"]).toBe("1");
  // The same LeakSanitizer settings as the corpus it left.
  const corpus = plan("san", "linux").corpus.env;
  expect(job.env["ASAN_OPTIONS"]).toBe(corpus.ASAN_OPTIONS);
  expect(job.env["LSAN_OPTIONS"]).toBe(
    corpus.LSAN_OPTIONS!.replace(
      leakSuppressions,
      "${{ github.workspace }}/tests/harness/lsan.supp",
    ),
  );
  expect(job.steps.at(-1)!.run).toBe(
    `pnpm test tests/harness/three.test.ts -t "'nodes' runs statically through LLVM on 'native'"`,
  );
});

test("the side queue balances measured files across the twenty Linux shards", () => {
  for (const flavor of ["plain", "san"] as const) {
    const costs = testCosts[flavor] as Record<string, number>;
    const owned = new Set([...Object.keys(costs), ...isolatedFiles.map(([, file]) => file)]);
    const shards = Array.from({ length: 20 }, (_, index) => {
      const files = ciTestPlan({ shard: `${index + 1}/20`, flavor })
        .side.slice(1)
        .flatMap((task) => task.args.filter((arg) => owned.has(arg)));
      return { files, load: files.reduce((sum, file) => sum + (costs[file] ?? 0) + 1000, 0) };
    });
    // A file heavier than an even share holds a shard alone; the shards
    // sharing several files are within 10% of each other.
    const shared = shards.filter((shard) => shard.files.length > 1).map((shard) => shard.load);
    expect(shared.length).toBeGreaterThan(10);
    expect(Math.max(...shared)).toBeLessThanOrEqual(Math.min(...shared) * 1.1);
    // The longest file starts from the last shard, away from the longest
    // corpus and three.js cases, which balance from the first.
    const longest = [...owned].sort((a, b) => (costs[b] ?? 0) - (costs[a] ?? 0))[0]!;
    expect(shards[19]!.files).toContain(longest);
  }
});

test("memory-heavy side files run whole in the cost-balanced task, on shards of their own", () => {
  for (const flavor of ["plain", "san"] as const) {
    const owners = sideOwners(flavor, 20);
    const heavy = Object.keys(memoryHeavyFiles);
    const shards = heavy.map((file) => owners.get(file));
    expect(shards.every((shard) => shard !== undefined)).toBe(true);
    expect(new Set(shards).size).toBe(Math.min(heavy.length, 20));
    for (const file of heavy) {
      const plan = ciTestPlan({ shard: `${owners.get(file)}/20`, flavor });
      const balanced = plan.side.find((task) => task.name === "cost-balanced tests")!;
      expect(balanced.args).toContain(file);
      // The file-sharded task leaves it out on every shard.
      for (let shard = 1; shard <= 20; shard++)
        expect(ciTestPlan({ shard: `${shard}/20`, flavor }).side[0]!.args).toContain(
          `--exclude=${file}`,
        );
    }
  }
});

test.for([1, 2, 4, 8])(
  "CI overlaps reserved lanes within a budget of %i workers",
  async (workers) => {
    const plan = ciTestPlan({ shard: "1/10", flavor: "plain", workers });
    const events: string[] = [];
    let active = 0;
    let peak = 0;
    let finishCorpus!: () => void;
    const corpusWait = new Promise<void>((resolve) => {
      finishCorpus = resolve;
    });
    await runCiTestPlan(plan, async (task) => {
      const cost = Number(task.env.SCRIPTC_TEST_WORKERS);
      active += cost;
      peak = Math.max(peak, active);
      events.push(`start:${task.name}`);
      if (task === plan.corpus && workers > 1) await corpusWait;
      else await Promise.resolve();
      events.push(`end:${task.name}`);
      active -= cost;
      if (task === plan.side.at(-1)) finishCorpus();
    });
    expect(peak).toBeLessThanOrEqual(workers);
    expect(events.filter((event) => event.startsWith("start:")).sort()).toEqual(
      [plan.corpus, ...plan.side].map((task) => `start:${task.name}`).sort(),
    );
    for (let index = 1; index < plan.side.length; index++) {
      expect(events.indexOf(`start:${plan.side[index]!.name}`)).toBeGreaterThan(
        events.indexOf(`end:${plan.side[index - 1]!.name}`),
      );
    }
    if (workers === 1)
      expect(events.indexOf(`start:${plan.side[0]!.name}`)).toBeGreaterThan(
        events.indexOf(`end:${plan.corpus.name}`),
      );
    else
      expect(events.indexOf(`start:${plan.side[0]!.name}`)).toBeLessThan(
        events.indexOf(`end:${plan.corpus.name}`),
      );
  },
);

test("CI reports failures after running every scheduled suite", async () => {
  const plan = ciTestPlan({ shard: "1/10", flavor: "plain" });
  const seen: string[] = [];
  let failure: AggregateError | undefined;
  try {
    await runCiTestPlan(plan, async (task) => {
      seen.push(task.name);
      if (task === plan.corpus || task === plan.side[0]) throw new Error(task.name);
    });
  } catch (error) {
    failure = error as AggregateError;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure!.errors).toHaveLength(2);
  expect(seen.sort()).toEqual([plan.corpus, ...plan.side].map((task) => task.name).sort());
});

test.for([1, 2, 3])("the darwin suite retains every darwin file with %i shards", (count) => {
  for (const flavor of ["plain", "san"]) {
    const plans = Array.from({ length: count }, (_, index) =>
      ciTestPlan({ shard: `${index + 1}/${count}`, flavor, suite: "darwin" }),
    );
    const caseShards: string[] = [];
    plans.forEach((plan, index) => {
      const halves = [plan.corpus, plan.side[1]!];
      expect(plan.side).toHaveLength(2);
      for (const half of halves) {
        expect(half.args).toEqual(["test", ...darwinCorpusFiles]);
        expect(half.env.SCRIPTC_SAN).toBe(flavor === "san" ? "1" : "");
        expect(half.env.SCRIPTC_TEST_WORKERS).toBe("1");
        caseShards.push(half.env.SCRIPTC_TEST_SHARD!);
      }
      expect(plan.side[0]!.args).toEqual([
        "test",
        "--passWithNoTests",
        `--shard=${index + 1}/${count}`,
        ...darwinFiles,
      ]);
    });
    // The halves of all slices are the case shards of twice as many slices,
    // each run once.
    expect(caseShards).toEqual(
      Array.from({ length: 2 * count }, (_, index) => `${index + 1}/${2 * count}`),
    );
  }
  // The full suite still runs every darwin file through its file shards.
  for (const file of [...darwinCorpusFiles, ...darwinFiles]) {
    expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(true);
    if (!darwinCorpusFiles.includes(file)) expect(fileExclusions).not.toContain(file);
  }
  expect(corpusFiles).toEqual(expect.arrayContaining(darwinCorpusFiles));
});

/** Expands the ${{ }} expressions of a workflow value for one event: string
 * literals, ==, !=, !, &&, || and fromJSON, with matrix.shard left as
 * "{shard}". A value that is a single expression returns its result. */
function expand(value: string, context: { event: string; macosSuite: string | null }): unknown {
  const evaluate = (expression: string): unknown =>
    new Function(
      `return (${expression
        .replaceAll("github.event_name", JSON.stringify(context.event))
        .replaceAll("inputs.macos_suite", JSON.stringify(context.macosSuite))
        .replaceAll("fromJSON", "JSON.parse")});`,
    )();
  const single = /^\$\{\{(.*)\}\}$/s.exec(value);
  if (single && !single[1]!.includes("}}")) return evaluate(single[1]!);
  return value.replace(/\$\{\{(.*?)\}\}/g, (_match, expression: string) =>
    expression.trim() === "matrix.shard" ? "{shard}" : String(evaluate(expression)),
  );
}

test("pull requests run the full suite on Linux and the darwin suite on macOS", () => {
  type Job = {
    "runs-on": string;
    needs: string[];
    strategy: { matrix: { flavor: string[]; shard: number[] | string } };
    env: Record<string, string>;
    steps: { run?: string; uses?: string; with?: { name?: string } }[];
  };
  const { jobs } = load(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as { jobs: Record<string, Job> };
  const linux = jobs["tests"]!;
  const macos = jobs["tests_macos"]!;
  expect(linux["runs-on"]).toBe("ubuntu-24.04");
  expect(linux.needs).toContain("native_linux");
  expect(linux.strategy.matrix.shard).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(linux.env["SCRIPTC_TEST_SHARD"]).toBe("${{ matrix.shard }}/20");
  expect(linux.env["SCRIPTC_CI_SUITE"]).toBeUndefined();
  expect(linux.steps.some((step) => step.uses === "./.github/actions/llvm-linux")).toBe(true);
  expect(
    linux.steps.find((step) => step.uses?.startsWith("actions/download-artifact"))!.with!.name,
  ).toBe("native-linux-x64-gnu");
  expect(macos["runs-on"]).toBe("macos-15");
  expect(macos.needs).toContain("native_macos");
  // Pull requests and manual runs with macos_suite set to darwin run the darwin
  // suite in three slices; the nightly sweep and other manual runs run the
  // complete suite in ten.
  for (const [event, macosSuite, full] of [
    ["pull_request", null, false],
    ["workflow_dispatch", "darwin", false],
    ["workflow_dispatch", "full", true],
    ["schedule", null, true],
  ] as const) {
    const context = { event, macosSuite };
    const label = `${event} ${macosSuite}`;
    expect(expand(String(macos.strategy.matrix.shard), context), label).toEqual(
      full ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1, 2, 3],
    );
    expect(expand(macos.env["SCRIPTC_TEST_SHARD"]!, context), label).toBe(
      full ? "{shard}/10" : "{shard}/3",
    );
    expect(expand(macos.env["SCRIPTC_CI_SUITE"]!, context), label).toBe(full ? "full" : "darwin");
  }
  // Expected aborts must not stream cores through Ubuntu's piped handler.
  const coreStep = linux.steps.findIndex(
    (step) => step.run === "sudo sysctl -w kernel.core_pattern=core",
  );
  expect(coreStep).toBeGreaterThan(-1);
  expect(coreStep).toBeLessThan(linux.steps.length - 1);
  // Linux runs the suites in a memory-capped scope where systemd manages the
  // runner, and directly elsewhere.
  const linuxRun = linux.steps.at(-1)!.run as string;
  expect(linuxRun.startsWith("ulimit -c 0\n")).toBe(true);
  expect(linuxRun).toContain("systemd-run --scope --quiet -p MemoryMax=15G -p OOMPolicy=continue");
  expect(linuxRun).toMatch(
    /-- env PATH="\$PATH" HOME="\$HOME" NODE_OPTIONS="--max-old-space-size=4096" node scripts\/ci-test\.mjs\n/,
  );
  expect(linuxRun.endsWith("fi\nnode scripts/ci-test.mjs\n")).toBe(true);
  expect(macos.steps.at(-1)!.run).toBe("node scripts/ci-test.mjs");
  for (const job of [linux, macos]) expect(job.strategy.matrix.flavor).toEqual(["plain", "san"]);
});

test("CI rejects malformed scheduling inputs", () => {
  for (const shard of [undefined, "", "0/10", "11/10", "2/x"])
    expect(() => ciTestPlan({ shard, flavor: "plain" })).toThrow();
  for (const workers of [0, -1, 1.5, NaN, Infinity])
    expect(() => ciTestPlan({ shard: "1/10", flavor: "plain", workers })).toThrow();
  expect(() => ciTestPlan({ shard: "1/10", flavor: "unknown" })).toThrow();
  expect(() => ciTestPlan({ shard: "1/10", flavor: "plain", suite: "unknown" })).toThrow();
});
