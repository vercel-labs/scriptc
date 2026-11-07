import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { expect, test } from "vitest";
// @ts-expect-error -- a plain script without declarations
import {
  compareRequests,
  requestsOf,
  targets,
  undefinedBehaviorFlags,
} from "../../scripts/fuzz.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const fuzz = join(root, "tests", "fuzz");
const names = (targets as { name: string; kind: string }[]).map((target) => target.name);

test("the driver's targets are the fuzz program's subcommands", () => {
  const program = readFileSync(join(fuzz, "main.ts"), "utf8");
  const subcommands = [...program.matchAll(/target === "([a-z-]+)"/g)].map((match) => match[1]);
  expect(subcommands.toSorted()).toEqual(names.toSorted());
});

test("every target has a seed corpus and a regression directory of well-formed cases", () => {
  for (const kind of ["seeds", "regressions"]) {
    expect(readdirSync(join(fuzz, kind)).toSorted(), kind).toEqual(names.toSorted());
    for (const name of names) {
      const directory = join(fuzz, kind, name);
      const files = readdirSync(directory).filter((file) => file.endsWith(".json"));
      if (kind === "seeds") expect(files.length, directory).toBeGreaterThan(0);
      for (const file of files) {
        const fields: unknown = JSON.parse(readFileSync(join(directory, file), "utf8"));
        expect(Array.isArray(fields), file).toBe(true);
        expect((fields as unknown[]).length, file).toBeGreaterThanOrEqual(3);
        for (const field of fields as unknown[]) expect(typeof field, file).toBe("string");
      }
    }
  }
});

test("the sanitized build stops at undefined behavior", () => {
  expect(undefinedBehaviorFlags).toContain("-fsanitize=undefined");
  expect(undefinedBehaviorFlags).toContain("-fno-sanitize-recover=undefined");
});

test("the framing comparison fails only when both servers deliver a different request", () => {
  const log = [
    { from: 1, method: "POST", url: "/", version: "1.1", headers: 4 },
    { from: 2, method: "GET", url: "/other", version: "1.1", headers: 2 },
    { from: 1, url: "/", body: 3, trailers: 0 },
    { from: 1, method: "GET", url: "/next", version: "1.1", headers: 2 },
  ];
  expect(requestsOf(log, 1)).toEqual(["POST / HTTP/1.1 4 body 3+0", "GET /next HTTP/1.1 2"]);
  expect(requestsOf(log, 3)).toEqual([]);

  expect(compareRequests(["A body 3+0", "B"], ["A body 3+0", "B"])).toBe("agree");
  expect(compareRequests([], [])).toBe("agree");
  // One server refused the stream, or stopped, earlier than the other.
  expect(compareRequests(["A body 3+0"], ["A body 3+0", "B"])).toBe("stricter");
  expect(compareRequests(["A"], ["A body 0+2"])).toBe("stricter");
  expect(compareRequests(["A body 3+0", "B"], ["A body 3+0", "B body 0+0", "C"])).toBe("stricter");
  // The same position, two different requests: where one ends is where the other does not.
  expect(compareRequests(["A body 3+0"], ["A body 5+0"])).toBe("framing");
  expect(compareRequests(["A body 3+0", "B"], ["A body 3+0", "C"])).toBe("framing");
  expect(compareRequests(["A", "B"], ["A body 3+0", "B"])).toBe("framing");
});

test("the fuzz workflow runs the driver for pull requests that change the runtime, and nightly", () => {
  const path = join(root, ".github", "workflows", "fuzz.yml");
  expect(existsSync(path)).toBe(true);
  const workflow = load(readFileSync(path, "utf8")) as {
    on: { pull_request: { paths: string[] }; schedule: { cron: string }[] };
    permissions: Record<string, string>;
    jobs: Record<string, { steps: { run?: string }[] }>;
  };
  expect(workflow.on.pull_request.paths).toEqual(
    expect.arrayContaining(["packages/runtime/**", "tests/fuzz/**", "scripts/fuzz.mjs"]),
  );
  expect(workflow.on.schedule).toHaveLength(1);
  expect(workflow.permissions).toEqual({ contents: "read" });
  const runs = Object.values(workflow.jobs).flatMap((job) =>
    job.steps.map((step) => step.run ?? ""),
  );
  expect(runs.some((run) => run.includes("node scripts/fuzz.mjs"))).toBe(true);
});
