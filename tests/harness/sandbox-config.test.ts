import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  defaultSandboxImage,
  sandboxBootstrapCommand,
  sandboxEffectWorkerAllocation,
  sandboxImageConfig,
  sandboxNativeReference,
  sandboxRunnerConfig,
  sandboxTestSourceConfig,
  sandboxTestWorkerAllocation,
  sandboxVcrConfig,
  sandboxVercelConfig,
  sandboxVercelEnvironment,
} from "../../scripts/sandbox-config.mjs";

const oidcToken = (claims: object) =>
  ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");

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
    sandboxTimeoutMs: 5_400_000,
  });
});

test("runner settings retain their documented defaults", () => {
  expect(sandboxRunnerConfig({})).toEqual({
    vcpus: "8",
    testWorkers: "4",
    localTestWorkers: "2",
    localCaseShards: "2",
    sandboxTimeout: "45m",
    sandboxTimeoutMs: 2_700_000,
  });
});

test("the local command deadline follows the configured Sandbox duration", () => {
  for (const [duration, milliseconds] of [
    ["120m", 7_200_000],
    ["2h", 7_200_000],
    ["30 s", 30_000],
    ["500ms", 500],
  ] as const) {
    expect(sandboxRunnerConfig({ SCRIPTC_SANDBOX_TIMEOUT: duration }).sandboxTimeoutMs).toBe(
      milliseconds,
    );
  }
  for (const duration of ["0m", "-1h", "forever", "1.5m", "999999999h"]) {
    expect(() => sandboxRunnerConfig({ SCRIPTC_SANDBOX_TIMEOUT: duration })).toThrow(
      "positive duration",
    );
  }
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
  const bootstrap = readFileSync(
    new URL("../../scripts/sandbox-bootstrap.sh", import.meta.url),
    "utf8",
  );
  expect(bootstrap).toContain("< .node-version");
  expect(bootstrap).toContain("ARG PNPM_VERSION=");
  expect(bootstrap).toContain("llvm-toolchain-${llvm_distro}-22");
  expect(bootstrap).toContain("install -D -m 0644");
  expect(bootstrap).toContain("clang-22");
  expect(bootstrap).toContain("libclang-rt-22-dev");
  expect(bootstrap).toContain("llvm-22-dev");
  expect(bootstrap).toContain("ninja-build");
  // CI links with ld.lld; without it Sandbox binaries link with GNU ld.
  expect(bootstrap).toContain("lld-22");
  const dockerfile = readFileSync(new URL("../../Dockerfile.sandbox", import.meta.url), "utf8");
  expect(dockerfile).toContain("lld-22");
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

test("prepared snapshots select the snapshot CLI source without changing project scope", () => {
  const config = sandboxTestSourceConfig({ SCRIPTC_SANDBOX_SNAPSHOT: " snap_ABC123 " });
  expect(config).toEqual({
    prepared: true,
    reference: "snap_ABC123",
    description: "prepared snapshot",
    createArgs: ["--snapshot", "snap_ABC123"],
  });
  expect(sandboxBootstrapCommand(config.prepared)).toBeUndefined();
});

test("test sources retain managed and custom image preparation", () => {
  expect(sandboxTestSourceConfig({})).toMatchObject({
    prepared: false,
    createArgs: ["--image", defaultSandboxImage],
  });
  const image = "vcr.vercel.com/team/project/tests:node24";
  expect(sandboxTestSourceConfig({ SCRIPTC_SANDBOX_IMAGE: image })).toMatchObject({
    prepared: true,
    createArgs: ["--image", image],
  });
});

test("ambiguous or malformed snapshot sources fail before creating workers", () => {
  expect(() =>
    sandboxTestSourceConfig({
      SCRIPTC_SANDBOX_SNAPSHOT: "snap_ABC123",
      SCRIPTC_SANDBOX_IMAGE: "image",
    }),
  ).toThrow("Set only one");
  expect(() => sandboxTestSourceConfig({ SCRIPTC_SANDBOX_SNAPSHOT: "wrong-id" })).toThrow(
    "snapshot ID",
  );
});

test("a native reference checkout needs a prepared source and an absolute path", () => {
  const snapshot = { SCRIPTC_SANDBOX_SNAPSHOT: "snap_ABC123" };
  expect(sandboxNativeReference(snapshot)).toBeUndefined();
  expect(
    sandboxNativeReference({
      ...snapshot,
      SCRIPTC_SANDBOX_NATIVE_REFERENCE: " /vercel/sandbox/prev/ ",
    }),
  ).toBe("/vercel/sandbox/prev");
  expect(() =>
    sandboxNativeReference({ SCRIPTC_SANDBOX_NATIVE_REFERENCE: "/vercel/sandbox/prev" }),
  ).toThrow("needs SCRIPTC_SANDBOX_SNAPSHOT");
  for (const path of ["prev", "/a/../b", "/a b", "/a;rm"])
    expect(() =>
      sandboxNativeReference({ ...snapshot, SCRIPTC_SANDBOX_NATIVE_REFERENCE: path }),
    ).toThrow("absolute path");
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

test("OIDC scope wins over complete or partial legacy environment scope", () => {
  for (const legacyScope of [
    { VERCEL_PROJECT_ID: "stale-project", VERCEL_TEAM_ID: "stale-team" },
    { VERCEL_TEAM_ID: "stale-team" },
  ]) {
    expect(
      sandboxVercelConfig({
        ...legacyScope,
        VERCEL_OIDC_TOKEN: "header.payload.signature",
      }),
    ).toMatchObject({
      authSource: "VERCEL_OIDC_TOKEN",
      oidc: true,
      project: undefined,
      scopeArgs: [],
      scopeSource: "VERCEL_OIDC_TOKEN claims",
      team: undefined,
    });
  }
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

test("VCR uses an access-token fallback with scope decoded from OIDC claims", () => {
  const token = oidcToken({ owner_id: "team_oidc", project_id: "prj_oidc" });
  const config = sandboxVercelConfig({
    VERCEL_OIDC_TOKEN: token,
    VERCEL_PROJECT_ID: "stale-project",
    VERCEL_TEAM_ID: "stale-team",
    VERCEL_TOKEN: "registryaccesstoken",
  });

  expect(
    sandboxVcrConfig(config, {
      VERCEL_AUTH_TOKEN: "stale-auth-token",
      VERCEL_OIDC_TOKEN: token,
      VERCEL_TOKEN: "registryaccesstoken",
    }),
  ).toEqual({
    authSource: "VERCEL_TOKEN",
    env: {
      VERCEL_OIDC_TOKEN: token,
      VERCEL_TOKEN: "registryaccesstoken",
    },
    scopeArgs: ["--scope", "team_oidc", "--project", "prj_oidc"],
    scopeSource: "VERCEL_OIDC_TOKEN claims",
  });
});

test("VCR never passes an OIDC JWT through VERCEL_TOKEN", () => {
  const token = oidcToken({ owner_id: "team_oidc", project_id: "prj_oidc" });
  const config = sandboxVercelConfig({
    VERCEL_OIDC_TOKEN: token,
    VERCEL_TOKEN: token,
  });

  expect(
    sandboxVcrConfig(config, {
      VERCEL_AUTH_TOKEN: token,
      VERCEL_OIDC_TOKEN: token,
      VERCEL_TOKEN: token,
    }),
  ).toEqual({
    authSource: "Vercel CLI login",
    env: { VERCEL_OIDC_TOKEN: token },
    scopeArgs: ["--scope", "team_oidc", "--project", "prj_oidc"],
    scopeSource: "VERCEL_OIDC_TOKEN claims",
  });
});

test("VCR uses the selected access token and explicit environment scope", () => {
  const config = sandboxVercelConfig({
    VERCEL_AUTH_TOKEN: "accesstoken",
    VERCEL_PROJECT_ID: "prj_example",
    VERCEL_TEAM_ID: "team_example",
  });

  expect(sandboxVcrConfig(config, { VERCEL_AUTH_TOKEN: "accesstoken" })).toEqual({
    authSource: "VERCEL_AUTH_TOKEN",
    env: { VERCEL_TOKEN: "accesstoken" },
    scopeArgs: ["--scope", "team_example", "--project", "prj_example"],
    scopeSource: "VERCEL_TEAM_ID + VERCEL_PROJECT_ID",
  });
});

test("VCR rejects JWT-shaped access tokens when OIDC is not selected", () => {
  const token = oidcToken({ owner_id: "team_example", project_id: "prj_example" });
  const config = sandboxVercelConfig({
    VERCEL_AUTH_TOKEN: token,
    VERCEL_PROJECT_ID: "prj_example",
    VERCEL_TEAM_ID: "team_example",
  });

  expect(() => sandboxVcrConfig(config, { VERCEL_AUTH_TOKEN: token })).toThrow(
    "is not a VCR-compatible access token",
  );
});

test("VCR rejects OIDC tokens without usable project claims", () => {
  const token = oidcToken({ owner_id: "team_oidc" });
  const config = sandboxVercelConfig({ VERCEL_OIDC_TOKEN: token });

  expect(() => sandboxVcrConfig(config, { VERCEL_OIDC_TOKEN: token })).toThrow(
    "owner_id and project_id claims",
  );
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

test("isolated Effect concurrency stays within the budget and only uses large Sandboxes", () => {
  for (const vcpus of [2, 8, 16, 30, 32]) {
    for (const workers of [1, 2, 4, 8]) {
      for (const sideTasks of [0, 1, 2, 3]) {
        const plan = sandboxEffectWorkerAllocation(workers, sideTasks, vcpus);
        expect(plan.caseWorkers).toBeGreaterThanOrEqual(1);
        const extraCompilers = Math.min(2, plan.caseWorkers) * (plan.effectConcurrency - 1);
        expect(plan.caseWorkers + plan.sideConcurrency + extraCompilers).toBeLessThanOrEqual(
          workers,
        );
        expect(plan.sideConcurrency).toBeLessThanOrEqual(sideTasks);
        expect(plan.effectConcurrency === 2).toBe(vcpus === 32 && workers >= 4);
      }
    }
  }
  expect(() => sandboxEffectWorkerAllocation(0, 1, 32)).toThrow();
  expect(() => sandboxEffectWorkerAllocation(4, -1, 32)).toThrow();
});
