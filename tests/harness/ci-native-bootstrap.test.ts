import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { load } from "js-yaml";
import {
  nativeBootstrapPlan,
  runBootstrapAndPackageChecks,
  runNativeBootstrapChecks,
} from "../../scripts/ci-native-bootstrap.mjs";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const recordingChecks = (completed: string[]) =>
  Object.fromEntries(
    ["commands", "rebuild", "rebuild-frontend", "rebuild-emit"].map((phase) => [
      phase,
      async () => {
        completed.push(phase);
      },
    ]),
  );

test("CI partitions both bootstrap lanes without dropping or duplicating phase contracts", async () => {
  const workflow = load(
    readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ) as {
    jobs: {
      bootstrap: {
        strategy: { matrix: { include: { flavor: string; phase: string }[] } };
        env: Record<string, string>;
      };
      test: { needs: string[]; steps: { run: string }[] };
    };
  };
  const bootstrap = workflow.jobs.bootstrap;
  expect(bootstrap.env.SCRIPTC_BOOTSTRAP_PHASE).toBe("${{ matrix.phase }}");
  expect(bootstrap.env.SCRIPTC_SAN).toBe("${{ matrix.flavor == 'san' && '1' || '' }}");
  const jobs = bootstrap.strategy.matrix.include;
  expect([...new Set(jobs.map((job) => job.flavor))].toSorted()).toEqual(["plain", "san"]);
  for (const flavor of ["plain", "san"]) {
    const sanitize = flavor === "san";
    const completed: string[] = [];
    let packageOwners = 0;
    for (const { phase } of jobs.filter((job) => job.flavor === flavor)) {
      const plan = nativeBootstrapPlan({ phase, sanitize });
      // Each CI job must own one expensive phase on its own runner.
      expect(plan.phases).toHaveLength(1);
      if (plan.packageChecks) packageOwners++;
      await runNativeBootstrapChecks(plan, recordingChecks(completed));
    }
    // Together the jobs run exactly the phases of a direct invocation.
    expect(completed.toSorted()).toEqual(nativeBootstrapPlan({ sanitize }).phases.toSorted());
    expect(packageOwners).toBe(sanitize ? 0 : 1);
  }
  expect(workflow.jobs.test.needs).toContain("bootstrap");
  expect(
    workflow.jobs.test.steps.some((step) =>
      step.run.includes('test "${{ needs.bootstrap.result }}" = success'),
    ),
  ).toBe(true);
});

test("the sanitizer lane splits its self-rebuild at the IR boundary", () => {
  expect(nativeBootstrapPlan({ sanitize: true }).phases).toEqual([
    "commands",
    "rebuild-frontend",
    "rebuild-emit",
  ]);
  expect(nativeBootstrapPlan({ phase: "rebuild", sanitize: true }).phases).toEqual([
    "rebuild-frontend",
    "rebuild-emit",
  ]);
  expect(nativeBootstrapPlan({ phase: "rebuild" }).phases).toEqual(["rebuild"]);
  for (const phase of ["rebuild-frontend", "rebuild-emit"]) {
    expect(nativeBootstrapPlan({ phase, sanitize: true }).phases).toEqual([phase]);
    expect(() => nativeBootstrapPlan({ phase })).toThrow("is a sanitizer bootstrap phase");
  }
});

test("direct bootstrap invocations retain every phase and the plain package checks", async () => {
  for (const sanitize of [false, true]) {
    const plan = nativeBootstrapPlan({ sanitize });
    // Every phase must start before any finishes: they run concurrently.
    const started = plan.phases.map(() => latch());
    const all = Promise.all(started.map((item) => item.promise));
    const completed: string[] = [];
    await runNativeBootstrapChecks(
      plan,
      Object.fromEntries(
        plan.phases.map((phase, index) => [
          phase,
          async () => {
            started[index]!.release();
            await all;
            completed.push(phase);
          },
        ]),
      ),
    );
    expect(completed.toSorted()).toEqual(
      (sanitize
        ? ["commands", "rebuild-frontend", "rebuild-emit"]
        : ["commands", "rebuild"]
      ).toSorted(),
    );
    expect(plan.packageChecks).toBe(!sanitize);
  }
});

test("bootstrap phase failures drain their siblings and preserve both errors", async () => {
  const completed = latch();
  const commandFailure = new Error("command probe failed");
  const rebuildFailure = new Error("self rebuild failed");
  let rebuilt = false;
  const result = runNativeBootstrapChecks(nativeBootstrapPlan(), {
    commands: () => {
      completed.release();
      throw commandFailure;
    },
    rebuild: async () => {
      await completed.promise;
      rebuilt = true;
      throw rebuildFailure;
    },
  });
  await expect(result).rejects.toMatchObject({ errors: [commandFailure, rebuildFailure] });
  expect(rebuilt).toBe(true);
});

test("invalid bootstrap phase selection fails before any contracts can be skipped", () => {
  for (const phase of ["", "command", "seed", "commands,rebuild", " all "]) {
    expect(() => nativeBootstrapPlan({ phase })).toThrow(
      "SCRIPTC_BOOTSTRAP_PHASE must be all, commands, rebuild, rebuild-frontend, or rebuild-emit",
    );
  }
});

test("a missing phase callback fails instead of silently passing its contracts", async () => {
  await expect(
    runNativeBootstrapChecks(nativeBootstrapPlan({ phase: "rebuild" }), {
      commands: async () => {},
    }),
  ).rejects.toMatchObject({ errors: [expect.any(TypeError)] });
});

test("package checks wait for publication and overlap the running bootstrap", async () => {
  const published = latch();
  const checked = latch();
  let ready = false;
  const events: string[] = [];
  await runBootstrapAndPackageChecks({
    bootstrap: async () => {
      events.push("building seed");
      expect(events).toEqual(["building seed"]);
      ready = true;
      published.release();
      await checked.promise;
      events.push("bootstrap complete");
    },
    packageReady: () => ready,
    poll: () => published.promise,
    packageChecks: async () => {
      events.push("checking package");
      checked.release();
    },
  });
  expect(events).toEqual(["building seed", "checking package", "bootstrap complete"]);
});

test("a bootstrap failure before publication ends the package wait", async () => {
  const failure = new Error("seed failed");
  await expect(
    runBootstrapAndPackageChecks({
      bootstrap: async () => {
        throw failure;
      },
      packageReady: () => false,
      poll: () => Promise.resolve(),
      packageChecks: async () => {
        throw new Error("package checks must not start");
      },
    }),
  ).rejects.toMatchObject({
    errors: [
      failure,
      expect.objectContaining({
        message: expect.stringContaining("before its native package was ready"),
      }),
    ],
  });
});

test("package failures drain the running bootstrap and preserve both errors", async () => {
  const checked = latch();
  const seedFailure = new Error("self rebuild failed");
  const packageFailure = new Error("installation failed");
  let finished = false;
  await expect(
    runBootstrapAndPackageChecks({
      bootstrap: async () => {
        await checked.promise;
        finished = true;
        throw seedFailure;
      },
      packageReady: () => true,
      packageChecks: async () => {
        checked.release();
        throw packageFailure;
      },
    }),
  ).rejects.toMatchObject({ errors: [seedFailure, packageFailure] });
  expect(finished).toBe(true);
});
