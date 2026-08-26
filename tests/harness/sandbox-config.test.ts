import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  defaultSandboxImage,
  sandboxBootstrapCommand,
  sandboxImageConfig,
  sandboxRunnerConfig,
  sandboxTestWorkerAllocation,
  sandboxVercelConfig,
  sandboxVercelEnvironment,
} from "../../scripts/sandbox-config.mjs";

test("runner settings are read after loading the sandbox environment", () => {
  expect(
    sandboxRunnerConfig({
      SCRIPTC_SANDBOX_VCPUS: "16",
      SCRIPTC_TEST_WORKERS: "7",
      SCRIPTC_LOCAL_TEST_WORKERS: "3",
      SCRIPTC_LOCAL_CASE_SHARDS: "4",
      SCRIPTC_SANDBOX_TIMEOUT: "90m",
    }),
  ).toEqual({
    vcpus: "16",
    testWorkers: "7",
    localTestWorkers: "3",
    localCaseShards: "4",
    sandboxTimeout: "90m",
  });
});

test("runner settings retain their documented defaults", () => {
  expect(sandboxRunnerConfig({})).toEqual({
    vcpus: "8",
    testWorkers: "4",
    localTestWorkers: "2",
    localCaseShards: "2",
    sandboxTimeout: "45m",
  });
});

test("the managed Sandbox image is the default", () => {
  expect(sandboxImageConfig({})).toEqual({
    custom: false,
    reference: defaultSandboxImage,
    sandboxImage: "vercel/sandbox/universal",
  });
});

test("the managed image bootstraps the ScriptC native toolchain and workspace", () => {
  const bootstrap = sandboxBootstrapCommand(false);
  expect(bootstrap?.prepareWorkspace).toMatchObject({ command: "sh", workdir: "/vercel" });
  expect(bootstrap?.prepareWorkspace.args.join(" ")).toContain("mkdir -p /workspace");
  expect(bootstrap?.install).toEqual({
    args: ["scripts/sandbox-bootstrap.sh"],
    command: "sh",
    workdir: "/workspace",
  });
  expect(sandboxBootstrapCommand(true)).toBeUndefined();
});

test("the managed-image bootstrap pins the custom image's Node, pnpm, and LLVM", () => {
  const bootstrap = readFileSync(new URL("../../scripts/sandbox-bootstrap.sh", import.meta.url), "utf8");
  expect(bootstrap).toContain("< .node-version");
  expect(bootstrap).toContain("ARG PNPM_VERSION=");
  expect(bootstrap).toContain("llvm-toolchain-noble-18");
  expect(bootstrap).toContain("clang-18");
  expect(bootstrap).toContain("libclang-rt-18-dev");
  expect(bootstrap).toContain("llvm-18");
});

test("a custom image does not select the Sandbox team or project", () => {
  expect(
    sandboxImageConfig({
      SCRIPTC_SANDBOX_IMAGE: "vcr.vercel.com/image-team/image-project/scriptc-tests:node24",
    }),
  ).toEqual({
    custom: true,
    reference: "vcr.vercel.com/image-team/image-project/scriptc-tests:node24",
    repository: "scriptc-tests",
    sandboxImage: "vcr.vercel.com/image-team/image-project/scriptc-tests:node24",
    tag: "node24",
  });
});

test("custom images must be fully qualified VCR references", () => {
  expect(() => sandboxImageConfig({ SCRIPTC_SANDBOX_IMAGE: "scriptc-tests:node24" })).toThrow(
    "fully qualified VCR image",
  );
});

test("OIDC authentication wins and supplies its own Sandbox scope", () => {
  const config = sandboxVercelConfig({
    VERCEL_OIDC_TOKEN: "header.payload.signature",
    VERCEL_TOKEN: "legacy-token",
  });
  expect(config).toMatchObject({
    authSource: "VERCEL_OIDC_TOKEN",
    authToken: "header.payload.signature",
    oidc: true,
    scopeArgs: [],
    scopeSource: "VERCEL_OIDC_TOKEN claims",
  });
  expect(
    sandboxVercelEnvironment(config, {
      VERCEL_OIDC_TOKEN: "header.payload.signature",
      VERCEL_TOKEN: "legacy-token",
    }),
  ).toEqual({
    VERCEL_AUTH_TOKEN: "header.payload.signature",
    VERCEL_OIDC_TOKEN: "header.payload.signature",
  });
});

test("access-token authentication uses explicit environment scope", () => {
  expect(
    sandboxVercelConfig({
      VERCEL_PROJECT_ID: "prj_example",
      VERCEL_TEAM_ID: "team_example",
      VERCEL_TOKEN: "legacy-token",
    }),
  ).toMatchObject({
    authSource: "VERCEL_TOKEN",
    authToken: "legacy-token",
    oidc: false,
    project: "prj_example",
    scopeArgs: ["--scope", "team_example", "--project", "prj_example"],
    scopeSource: "VERCEL_TEAM_ID + VERCEL_PROJECT_ID",
    team: "team_example",
  });
});

test("access-token scope failures explain every required variable", () => {
  expect(() => sandboxVercelConfig({ VERCEL_TOKEN: "legacy-token" })).toThrow(
    "VERCEL_TOKEN requires VERCEL_TEAM_ID and VERCEL_PROJECT_ID",
  );
  expect(() => sandboxVercelConfig({ VERCEL_TEAM_ID: "team_example" })).toThrow(
    "VERCEL_TEAM_ID and VERCEL_PROJECT_ID must be set together",
  );
});

test("test processes stay within the per-Sandbox worker budget", () => {
  expect(sandboxTestWorkerAllocation(4, 1)).toEqual({
    caseWorkers: 3,
    sideConcurrency: 1,
  });
  expect(sandboxTestWorkerAllocation(4, 2)).toEqual({
    caseWorkers: 2,
    sideConcurrency: 2,
  });
  expect(sandboxTestWorkerAllocation(2, 2)).toEqual({
    caseWorkers: 1,
    sideConcurrency: 1,
  });
  expect(sandboxTestWorkerAllocation(1, 2)).toEqual({
    caseWorkers: 1,
    sideConcurrency: 0,
  });
});
