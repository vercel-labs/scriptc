import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const customImageExample = "vcr.vercel.com/<team>/<project>/<repository>:<tag>";
export const defaultSandboxImage = "vercel/sandbox/universal";
const localEnv = fileURLToPath(new URL("../.env.local", import.meta.url));
let loadedLocalEnv = false;

function loadLocalEnv() {
  if (loadedLocalEnv) return;
  loadedLocalEnv = true;
  try {
    // Node preserves variables already present in the process environment,
    // allowing an agent or shell to override values from this local file.
    loadEnvFile(localEnv);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function sandboxRunnerConfig(env) {
  loadLocalEnv();
  const source = env ?? process.env;
  return {
    vcpus: source.SCRIPTC_SANDBOX_VCPUS ?? "8",
    testWorkers: source.SCRIPTC_TEST_WORKERS ?? "4",
    localTestWorkers: source.SCRIPTC_LOCAL_TEST_WORKERS ?? "2",
    localCaseShards: source.SCRIPTC_LOCAL_CASE_SHARDS ?? "2",
    sandboxTimeout: source.SCRIPTC_SANDBOX_TIMEOUT ?? "45m",
  };
}

/** Select Sandbox credentials and scope without coupling either to the image.
 * OIDC is project-scoped and takes precedence over legacy access tokens. */
export function sandboxVercelConfig(env) {
  loadLocalEnv();
  const source = env ?? process.env;
  const team = source.VERCEL_TEAM_ID?.trim();
  const project = source.VERCEL_PROJECT_ID?.trim();
  if (Boolean(team) !== Boolean(project)) {
    throw new Error(
      "VERCEL_TEAM_ID and VERCEL_PROJECT_ID must be set together; " +
        "Sandbox scope is independent of SCRIPTC_SANDBOX_IMAGE",
    );
  }

  const oidcToken = source.VERCEL_OIDC_TOKEN?.trim();
  const accessToken = source.VERCEL_TOKEN?.trim() || source.VERCEL_AUTH_TOKEN?.trim();
  const authSource = oidcToken
    ? "VERCEL_OIDC_TOKEN"
    : accessToken
      ? source.VERCEL_TOKEN?.trim()
        ? "VERCEL_TOKEN"
        : "VERCEL_AUTH_TOKEN"
      : "Vercel CLI login";
  if (accessToken && !oidcToken && (!team || !project)) {
    throw new Error(
      `${authSource} requires VERCEL_TEAM_ID and VERCEL_PROJECT_ID for Sandbox access`,
    );
  }

  return {
    authSource,
    authToken: oidcToken || accessToken,
    oidc: Boolean(oidcToken),
    project,
    scopeArgs: team && project ? ["--scope", team, "--project", project] : [],
    scopeSource:
      team && project
        ? "VERCEL_TEAM_ID + VERCEL_PROJECT_ID"
        : oidcToken
          ? "VERCEL_OIDC_TOKEN claims"
          : "linked/default Vercel CLI project",
    team,
  };
}

/** Build a child environment that makes the selected authentication source
 * unambiguous. The Vercel wrapper otherwise prefers a stored/access token to
 * VERCEL_OIDC_TOKEN when both are available. */
export function sandboxVercelEnvironment(config, env) {
  const childEnv = { ...(env ?? process.env) };
  if (config.authToken) childEnv.VERCEL_AUTH_TOKEN = config.authToken;
  if (config.oidc) delete childEnv.VERCEL_TOKEN;
  return childEnv;
}

export function sandboxBootstrapCommand(customImage) {
  if (customImage) return undefined;
  return {
    install: {
      args: ["scripts/sandbox-bootstrap.sh"],
      command: "sh",
      workdir: "/workspace",
    },
    prepareWorkspace: {
      args: [
        "-c",
        "sudo mkdir -p /workspace && sudo chown \"$(id -u):$(id -g)\" /workspace",
      ],
      command: "sh",
      workdir: "/vercel",
    },
  };
}

/** Reserve one Vitest worker for each concurrently scheduled side process
 * without ever starving the case-sharded corpus or exceeding the configured
 * per-Sandbox worker budget. Extra side processes share the reserved slots. */
export function sandboxTestWorkerAllocation(workerCount, sideTaskCount) {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new Error("workerCount must be a positive integer");
  }
  if (!Number.isInteger(sideTaskCount) || sideTaskCount < 0) {
    throw new Error("sideTaskCount must be a non-negative integer");
  }
  const sideConcurrency = Math.min(sideTaskCount, Math.max(0, workerCount - 1));
  return {
    caseWorkers: workerCount - sideConcurrency,
    sideConcurrency,
  };
}

export function sandboxImageConfig(env) {
  loadLocalEnv();
  const source = env ?? process.env;
  const configuredReference = source.SCRIPTC_SANDBOX_IMAGE?.trim();
  if (!configuredReference) {
    return {
      custom: false,
      reference: defaultSandboxImage,
      sandboxImage: defaultSandboxImage,
    };
  }

  const match = /^vcr\.vercel\.com\/([^/]+)\/([^/]+)\/([^/:]+):([^/:]+)$/.exec(
    configuredReference,
  );
  if (!match) {
    throw new Error(
      `SCRIPTC_SANDBOX_IMAGE must be a fully qualified VCR image (${customImageExample})`,
    );
  }

  const [, , , repository, tag] = match;
  return {
    custom: true,
    reference: configuredReference,
    repository,
    tag,
    // Preserve the full reference: Sandbox scope comes from Vercel auth,
    // never from path segments in this image name.
    sandboxImage: configuredReference,
  };
}

export function requiredSandboxImageConfig(env) {
  const config = sandboxImageConfig(env);
  const reference = (env ?? process.env).SCRIPTC_SANDBOX_IMAGE?.trim();
  if (!reference) {
    throw new Error(
      `SCRIPTC_SANDBOX_IMAGE is required to build an image (for example: ${customImageExample})`,
    );
  }
  return config;
}
