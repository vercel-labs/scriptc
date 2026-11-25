import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { load } from "js-yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  chooseProbes,
  collectSpecs,
  confirmed,
  firstParentCommits,
  narrow,
  resolution,
  stillFailing,
} from "../../scripts/ci/bisect.mjs";
import {
  commandFor,
  envFor,
  meetsExpectation,
  outcome,
  runsBySpec,
} from "../../scripts/ci/bisect-candidate.mjs";

const sha = (index: number) => `${index}`.padStart(40, "a");

test("only first-parent main commits are probes, never an intermediate pull request commit", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-bisect-first-parent-"));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
      expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0);
      return result.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.name", "t");
    git("config", "user.email", "t@t");
    const commit = (file: string, message: string) => {
      writeFileSync(join(directory, file), message);
      git("add", file);
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    const base = commit("base", "base");
    git("checkout", "-q", "-b", "feature");
    const pullRequestCommit = commit("pr", "pull request");
    git("checkout", "-q", "main");
    const mergedMain = commit("main", "main work");
    git("merge", "--no-ff", "-q", "-m", "merge feature", "feature");
    const mergeCommit = git("rev-parse", "HEAD");
    const tip = commit("tip", "tip");
    expect(firstParentCommits(base, tip, directory)).toEqual([mergedMain, mergeCommit, tip]);
    expect(firstParentCommits(base, tip, directory)).not.toContain(pullRequestCommit);
    // Every commit is still reachable, so a plain rev-list would have probed the pull request snapshot.
    expect(
      spawnSync("git", ["rev-list", "--reverse", `${base}..${tip}`], {
        cwd: directory,
        encoding: "utf8",
      }).stdout,
    ).toContain(pullRequestCommit);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the failing tests of a run come from its failure reports, once per flavor", () => {
  const specs = collectSpecs([
    {
      name: "failure-report-tests-san-12-30",
      tests: [
        {
          file: "tests/harness/differential.test.ts",
          fullName: "differential corpus > 001-hello.ts",
        },
        { file: "tests/harness/differential.test.ts", name: "differential corpus > 002.ts" },
      ],
    },
    {
      name: "failure-report-tests-san-13-30",
      tests: [
        {
          file: "tests/harness/differential.test.ts",
          fullName: "differential corpus > 001-hello.ts",
        },
      ],
    },
    {
      name: "failure-report-tests-plain-4-20",
      tests: [
        {
          file: "tests/harness/differential.test.ts",
          fullName: "differential corpus > 001-hello.ts",
        },
      ],
    },
  ]);
  expect(specs).toEqual([
    {
      file: "tests/harness/differential.test.ts",
      fullName: "differential corpus > 001-hello.ts",
      san: false,
    },
    {
      file: "tests/harness/differential.test.ts",
      fullName: "differential corpus > 001-hello.ts",
      san: true,
    },
    {
      file: "tests/harness/differential.test.ts",
      fullName: "differential corpus > 002.ts",
      san: true,
    },
  ]);
});

test("a round probes up to eight commits between the known pass and the known failure", () => {
  const probes = chooseProbes(15, -1, 14);
  expect(probes.length).toBe(8);
  expect(new Set(probes).size).toBe(probes.length);
  expect(probes).toEqual([...probes].sort((a, b) => a - b));
  for (const index of probes) {
    expect(index).toBeGreaterThan(-1);
    expect(index).toBeLessThan(14);
  }
  // A two-commit range needs one probe; a one-commit range is already the culprit.
  expect(chooseProbes(2, -1, 1)).toEqual([0]);
  expect(chooseProbes(1, -1, 0)).toEqual([]);
  expect(resolution(1, -1, 0)).toMatchObject({ resolved: true, culprit: 0, predecessor: -1 });
});

test("a round narrows to the passing and failing probes either side of the boundary", () => {
  const probes = chooseProbes(15, -1, 14);
  const results = probes.map((index) => ({ index, pass: index < 6 }));
  const narrowed = narrow(15, -1, 14, results);
  expect(narrowed).toEqual({ low: 4, high: 6 });
  // Order does not matter: the result that passed at 5 narrows the same range.
  expect(narrow(15, -1, 14, [...results].reverse())).toEqual({ low: 4, high: 6 });
  expect(resolution(15, 4, 6)).toMatchObject({ resolved: false });
  expect(resolution(15, 4, 5)).toMatchObject({ resolved: true, culprit: 5, predecessor: 4 });
  // A passing probe past a failing one does not widen the bracket.
  expect(
    narrow(15, -1, 14, [
      { index: 4, pass: false },
      { index: 9, pass: true },
    ]),
  ).toEqual({
    low: -1,
    high: 4,
  });
});

test("a flake screen and a confirmation use the reported tests' own outcomes", () => {
  expect(stillFailing([{ pass: true }, { pass: true }])).toBe(false);
  expect(stillFailing([{ pass: true }, { pass: false }])).toBe(true);
  const fail = { pass: false };
  const pass = { pass: true };
  expect(confirmed([fail, fail, fail], [pass, pass, pass])).toBe(true);
  expect(confirmed([fail, fail], [pass, pass, pass])).toBe(false);
  expect(confirmed([fail, fail, pass], [pass, pass, pass])).toBe(false);
  expect(confirmed([fail, fail, fail], [pass, fail, pass])).toBe(false);
  expect(confirmed([{ pass: false, infra: true }, fail, fail], [pass, pass, pass])).toBe(false);
});

test("the same test in both lanes is confirmed once per lane, not as one group of six", () => {
  const spec = { file: "tests/harness/differential.test.ts", fullName: "corpus > case.ts" };
  const runs = (san: boolean, codes: number[]) =>
    codes.map((code) => ({ spec: { ...spec, san }, code }));
  const both = [...runs(false, [1, 1, 1]), ...runs(true, [1, 1, 1])];
  const groups = runsBySpec(both);
  expect(groups).toEqual([
    [1, 1, 1],
    [1, 1, 1],
  ]);
  expect(meetsExpectation("fail", groups)).toBe(true);
  // A pass in either lane's three still rejects the boundary.
  expect(
    meetsExpectation("fail", runsBySpec([...runs(false, [1, 0, 1]), ...runs(true, [1, 1, 1])])),
  ).toBe(false);
});

test("the candidate runner re-runs exactly one reported test", () => {
  expect(commandFor({ file: "tests/harness/x.test.ts", fullName: "suite > case (1)" })).toEqual([
    "exec",
    "vitest",
    "run",
    "tests/harness/x.test.ts",
    "-t",
    "^suite(?: > | )case \\(1\\)$",
  ]);
  expect(commandFor({ file: "tests/harness/x.test.ts", fullName: "" })).toEqual([
    "exec",
    "vitest",
    "run",
    "tests/harness/x.test.ts",
  ]);
  // Vitest joins a suite and its test with a space in --testNamePattern; the reporter joins them with " > ".
  expect(commandFor({ file: "x.test.ts", fullName: "outer > inner > leaf" })[5]).toBe(
    "^outer(?: > | )inner(?: > | )leaf$",
  );
  expect(envFor({ san: true })).toEqual({ SCRIPTC_SAN: "1", ASAN_OPTIONS: "detect_leaks=0" });
  expect(envFor({ san: false })).toEqual({});
  expect(outcome([0, 0])).toBe("pass");
  expect(outcome([0, 1])).toBe("fail");
  expect(outcome([127])).toBe("infra");
  expect(outcome([null])).toBe("infra");
  expect(outcome([])).toBe("infra");
});

test("a confirmation holds only for three failures with no infrastructure error, or three passes, per test", () => {
  expect(meetsExpectation("pass", [[0, 0, 0]])).toBe(true);
  expect(meetsExpectation("pass", [[0, 0, 1]])).toBe(false);
  expect(meetsExpectation("fail", [[1, 1, 1]])).toBe(true);
  // One pass among three failures is a flake, not a confirmation.
  expect(meetsExpectation("fail", [[1, 0, 1]])).toBe(false);
  // A runner failure (125 and above, or a signal) is not a test failure.
  expect(meetsExpectation("fail", [[1, 125, 1]])).toBe(false);
  expect(meetsExpectation("fail", [[1, null, 1]])).toBe(false);
  expect(meetsExpectation("fail", [[1, 1]])).toBe(false);
  // Every failing test needs its own three failures: several tests must not be judged as one run.
  expect(
    meetsExpectation("fail", [
      [1, 1, 1],
      [1, 1, 1],
    ]),
  ).toBe(true);
  expect(
    meetsExpectation("fail", [
      [1, 1, 1],
      [1, 0, 1],
    ]),
  ).toBe(false);
  expect(
    meetsExpectation("pass", [
      [0, 0, 0],
      [0, 0, 1],
    ]),
  ).toBe(false);
  expect(meetsExpectation("pass", [])).toBe(false);
  expect(() => meetsExpectation("maybe", [[1, 1, 1]])).toThrow();
});

test("the workflow's plan and narrow commands speak JSON", () => {
  const directory = mkdtempSync(join(tmpdir(), "ci-bisect-"));
  try {
    const commitsPath = join(directory, "commits.json");
    const resultsPath = join(directory, "results.json");
    const commits = Array.from({ length: 12 }, (_, index) => sha(index));
    writeFileSync(commitsPath, JSON.stringify(commits));
    const plan = spawnSync(
      "node",
      [
        new URL("../../scripts/ci/bisect.mjs", import.meta.url).pathname,
        "plan",
        "--commits",
        commitsPath,
        "--base",
        sha(0),
        "--head",
        sha(11),
      ],
      { encoding: "utf8" },
    );
    expect(plan.status, plan.stderr).toBe(0);
    const planned = JSON.parse(plan.stdout);
    expect(planned.low).toBe(-1);
    expect(planned.high).toBe(11);
    expect(planned.probes.length).toBe(8);
    const results = planned.probes.map((probe: { index: number; sha: string }) => ({
      sha: probe.sha,
      pass: probe.index < 3,
    }));
    writeFileSync(resultsPath, JSON.stringify(results));
    const narrowed = spawnSync(
      "node",
      [
        new URL("../../scripts/ci/bisect.mjs", import.meta.url).pathname,
        "narrow",
        "--commits",
        commitsPath,
        "--low",
        String(planned.low),
        "--high",
        String(planned.high),
        "--results",
        resultsPath,
        "--base",
        sha(0),
      ],
      { encoding: "utf8" },
    );
    expect(narrowed.status, narrowed.stderr).toBe(0);
    const decision = JSON.parse(narrowed.stdout);
    expect(decision.high).toBeGreaterThanOrEqual(3);
    expect(decision.next).toEqual([]);
    if (decision.resolved) expect(decision.culpritSha).toBe(commits[decision.culprit]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the culprit search starts on a failed post-merge CI run on main or canary and never writes either", () => {
  const workflow = load(
    readFileSync(new URL("../../.github/workflows/bisect-main.yml", import.meta.url), "utf8"),
  ) as {
    on: { workflow_run: { workflows: string[]; types: string[] } };
    jobs: Record<
      string,
      {
        if?: string;
        permissions?: Record<string, string>;
        steps?: {
          id?: string;
          env?: Record<string, string>;
          uses?: string;
          run?: string;
          with?: Record<string, string>;
        }[];
      }
    >;
  };
  expect(workflow.on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"] });
  // The trigger is checked in a step, so the plan job always provides a valid probe-slot list.
  const trigger = workflow.jobs.plan!.steps!.find((step) => step.id === "trigger")!;
  expect(trigger.env!.EVENT).toBe("${{ github.event.workflow_run.event }}");
  expect(trigger.run).toContain('"$CONCLUSION" = failure');
  expect(trigger.run).toContain('"$BRANCH" = main');
  expect(trigger.run).toContain('"$BRANCH" = canary');
  // The search's checkout is the failed branch, not main.
  const checkout = workflow.jobs.plan!.steps!.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  )!;
  expect(checkout.with!.ref).toBe("${{ github.event.workflow_run.head_branch }}");
  expect(workflow.jobs.plan!.permissions).toEqual({ actions: "read", contents: "read" });
  expect(workflow.jobs.unresolved!.if).toContain("needs.plan.outputs.applicable == 'true'");
  // The boundary ends with three runs on each side of the culprit.
  // Every job that uses the local action checks the repository out first: a local action cannot be resolved
  // before the checkout.
  for (const name of ["flake_screen", "probe_1", "probe_2", "confirm"]) {
    const steps = workflow.jobs[name]!.steps!;
    const index = steps.findIndex((step) => step.uses === "./.github/actions/bisect-probe");
    expect(index, name).toBeGreaterThan(0);
    expect(steps[index - 1]!.uses, name).toContain("actions/checkout@");
  }
  // Round two never skips: a skipped job would suppress the confirmation that needs it.
  expect(workflow.jobs.probe_2!.if).not.toContain("resolved");
  expect(workflow.jobs.narrow_2!.if).toContain("always()");
  const narrow2 = workflow.jobs.narrow_2!.steps!.find((step) => step.id === "narrow")!;
  expect(narrow2.run).toContain('"${{ needs.narrow_1.outputs.resolved }}" = true');
  const confirm = workflow.jobs.confirm!;
  expect(confirm.if).toContain("always()");
  const probe = confirm.steps!.find((step) => step.uses === "./.github/actions/bisect-probe")!;
  expect(probe.with!.repeat).toBe("3");
  expect(probe.with!.expect).toBe("${{ matrix.expect }}");
  // The baseline falls back to the newest successful push run when the tag is absent or stale.
  const planStep = workflow.jobs.plan!.steps!.find((step) => step.id === "plan")!;
  expect(planStep.run).toContain("git/ref/tags/green-$BRANCH");
  expect(planStep.run).toContain("branch=$BRANCH");
  expect(planStep.run).toContain("status=success");
  // Every successful run is a candidate, not only the newest: the branch may have passed a newer commit already.
  expect(planStep.run).toContain("workflow_runs[].head_sha");
  expect(planStep.run).toContain("--paginate --slurp");
  expect(planStep.run).toContain("merge-base --is-ancestor");
  // The revert lands on the branch that failed, not on main.
  const revert = workflow.jobs.conclude!.steps!.find((step) =>
    step.run?.includes("revert-pr.mjs"),
  )!;
  expect(revert.run).toContain('--base "$BRANCH"');
  expect(revert.env!.BRANCH).toBe("${{ github.event.workflow_run.head_branch }}");
  // The job that writes has exactly the tag-free writes it needs, and the revert never force-pushes.
  expect(workflow.jobs.conclude!.permissions).toEqual({
    contents: "write",
    "pull-requests": "write",
    issues: "write",
  });
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps ?? [])
      expect(step.run ?? "").not.toMatch(/push\s+(--force|-f)\b|push\s+origin\s+(main|canary)\b/);
});

test("the probe action runs the reported tests and keeps their result", () => {
  const action = readFileSync(
    new URL("../../.github/actions/bisect-probe/action.yml", import.meta.url),
    "utf8",
  );
  // The runner is copied out before the probe checkout: an older commit does not carry it.
  expect(action).toContain(
    'cp scripts/ci/bisect-candidate.mjs "$RUNNER_TEMP/bisect-candidate.mjs"',
  );
  expect(action).toContain('--root "$GITHUB_WORKSPACE"');
  // The probe checkout keeps the token out of the workspace the tests run in.
  expect(action).toContain("persist-credentials: false");
  expect(action).toContain("--expect");
  expect(action).toContain('--out "$RUNNER_TEMP/result.json"');
  expect(action).toContain("actions/upload-artifact@");
  expect(action).toContain("native-linux-x64-gnu");
  // The failed run's native packages are reused only when the commit leaves their inputs alone.
  expect(action).toContain("git diff --quiet");
});
