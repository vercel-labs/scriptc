import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { failureLine, trackingBody } from "../../scripts/ci/bisect-report.mjs";

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
  const source = readFileSync(
    new URL("../../.github/workflows/bisect-main.yml", import.meta.url),
    "utf8",
  );
  const workflow = load(source) as {
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
  // gh rejects --slurp with --jq. Joining the shell's continuations reads each command as gh runs it.
  const commands = source.replace(/\\\n\s*/g, " ").split("\n");
  const api = commands.filter((command) => command.includes("gh api"));
  expect(api.length).toBeGreaterThan(0);
  for (const command of api)
    expect(command.includes("--slurp") && command.includes("--jq"), command).toBe(false);
  // The jobs query is the search's first step; a flag gh rejects stopped every search before it recorded jobs.
  expect(planStep.run).toContain("jobs.jsonl");
  expect(planStep.run).toContain("jq -s");
  // The revert lands on the branch that failed, not on main.
  // The reporter is copied out of the working tree before the revert checks the culprit's commit out: a run whose
  // culprit predates the reporter still reports a conflict or a failed push.
  const concludeSteps = workflow.jobs.conclude!.steps!;
  const copied = concludeSteps.findIndex((step) =>
    step.run?.includes('cp scripts/ci/bisect-report.mjs "$RUNNER_TEMP/bisect-report.mjs"'),
  );
  const revertAt = concludeSteps.findIndex((step) => step.run?.includes("revert-pr.mjs"));
  expect(copied).toBeGreaterThan(0); // after the checkout
  expect(copied).toBeLessThan(revertAt);
  // No report runs the tree's copy, which the moved checkout can remove.
  expect(source.match(/node scripts\/ci\/bisect-report\.mjs/g)).toBeNull();
  expect(source.match(/node "\$RUNNER_TEMP\/bisect-report\.mjs"/g)?.length).toBe(4);
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

test("a failure no search places adds a line to one open tracking issue", () => {
  expect(
    failureLine({
      branch: "main",
      red: "0123456789abcdef0123456789abcdef01234567",
      reason: "the search stopped unexpectedly",
      jobs: "",
      run: "https://example.test/runs/1",
    }),
  ).toBe(
    "- `012345678` on main: the search stopped unexpectedly (failed jobs: none recorded) — https://example.test/runs/1",
  );
  expect(trackingBody("- x")).toContain("\n\n- x");
  const directory = mkdtempSync(join(tmpdir(), "ci-bisect-report-"));
  try {
    // gh records what it is asked and answers as the open tracking issue (or its absence) requires.
    const log = join(directory, "gh.log");
    const bin = join(directory, "gh");
    writeFileSync(
      bin,
      `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
case "$*" in
  *"label create"*) exit 0 ;;
  *"issue list"*) [ -n "$FAKE_GH_EXISTING" ] && echo "$FAKE_GH_EXISTING"; exit 0 ;;
  *"issue create"*) echo "https://example.test/issues/1"; exit 0 ;;
  *"issue comment"*) echo "https://example.test/issues/$3"; exit 0 ;;
esac
exit 0
`,
    );
    chmodSync(bin, 0o755);
    const args = [
      new URL("../../scripts/ci/bisect-report.mjs", import.meta.url).pathname,
      "--repo",
      "o/r",
      "--label",
      "tracked",
      "--title",
      "Tracking",
      "--branch",
      "main",
      "--red",
      "0123456789abcdef0123456789abcdef01234567",
      "--reason",
      "the search stopped unexpectedly",
      "--jobs",
      "",
      "--run",
      "https://example.test/runs/1",
    ];
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env["PATH"] ?? ""}`,
      FAKE_GH_EXISTING: "",
    };
    // The first failure opens the tracking issue.
    const created = spawnSync(process.execPath, args, { encoding: "utf8", env });
    expect(created.status, created.stderr).toBe(0);
    const first = readFileSync(log, "utf8").split("\n");
    expect(
      first.some((line) => line.startsWith("issue create") && line.includes("--label tracked")),
    ).toBe(true);
    // The next failure finds the open issue and adds one line to it instead.
    const commented = spawnSync(process.execPath, args, {
      encoding: "utf8",
      env: { ...env, FAKE_GH_EXISTING: "12" },
    });
    expect(commented.status, commented.stderr).toBe(0);
    const all = readFileSync(log, "utf8").split("\n");
    expect(all.filter((line) => line.startsWith("issue create")).length).toBe(1);
    expect(
      all.some(
        (line) =>
          line.startsWith("issue comment 12") &&
          line.includes(
            "- `012345678` on main: the search stopped unexpectedly (failed jobs: none recorded)",
          ),
      ),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("every report goes through the tracking-issue script, never a new issue", () => {
  const text = readFileSync(
    new URL("../../.github/workflows/bisect-main.yml", import.meta.url),
    "utf8",
  );
  expect(text).not.toMatch(/gh issue create/);
  const reports = [...text.matchAll(/node "\$RUNNER_TEMP\/bisect-report\.mjs"/g)];
  expect(reports.length).toBe(4);
  for (const label of [
    "post-merge-bisect-unresolved",
    "post-merge-bisect-revert",
    "post-merge-bisect-unconfirmed",
  ])
    expect(text).toContain(`--label ${label}`);
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
