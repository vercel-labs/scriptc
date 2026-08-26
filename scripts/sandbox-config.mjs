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
 * OIDC is project-scoped and takes precedence over legacy access tokens and
 * their explicit environment scope. */
export function sandboxVercelConfig(env) {
  loadLocalEnv();
  const source = env ?? process.env;
  const oidcToken = source.VERCEL_OIDC_TOKEN?.trim();
  const configuredTeam = source.VERCEL_TEAM_ID?.trim();
  const configuredProject = source.VERCEL_PROJECT_ID?.trim();
  if (!oidcToken && Boolean(configuredTeam) !== Boolean(configuredProject)) {
    throw new Error(
      "VERCEL_TEAM_ID and VERCEL_PROJECT_ID must be set together; " +
        "Sandbox scope is independent of SCRIPTC_SANDBOX_IMAGE",
    );
  }
  const team = oidcToken ? undefined : configuredTeam;
  const project = oidcToken ? undefined : configuredProject;

  const accessToken = source.VERCEL_TOKEN?.trim() || source.VERCEL_AUTH_TOKEN?.trim();
  const accessTokenSource = source.VERCEL_TOKEN?.trim()
    ? "VERCEL_TOKEN"
    : source.VERCEL_AUTH_TOKEN?.trim()
      ? "VERCEL_AUTH_TOKEN"
      : undefined;
  const authSource = oidcToken
    ? "VERCEL_OIDC_TOKEN"
    : accessToken
      ? accessTokenSource
      : "Vercel CLI login";
  if (accessToken && !oidcToken && (!team || !project)) {
    throw new Error(
      `${authSource} requires VERCEL_TEAM_ID and VERCEL_PROJECT_ID for Sandbox access`,
    );
  }

  return {
    accessToken,
    accessTokenSource,
    authSource,
    authToken: oidcToken || accessToken,
    oidc: Boolean(oidcToken),
    project,
    scopeArgs: team && project ? ["--scope", team, "--project", project] : [],
    scopeSource: oidcToken
      ? "VERCEL_OIDC_TOKEN claims"
      : team && project
        ? "VERCEL_TEAM_ID + VERCEL_PROJECT_ID"
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

/** Adapt the selected Sandbox credential to the legacy VCR command surface.
 * Unlike the Sandbox CLI, `vercel vcr` rejects JWTs in VERCEL_TOKEN and cannot
 * infer registry scope from OIDC claims. OIDC therefore supplies only VCR's
 * scope; authentication uses an explicit access token or the Vercel CLI login. */
export function sandboxVcrConfig(config, env) {
  const childEnv = { ...(env ?? process.env) };
  delete childEnv.VERCEL_AUTH_TOKEN;
  let authSource = "Vercel CLI login";
  const vcrAccessToken = /^\w+$/.test(config.accessToken ?? "")
    ? config.accessToken
    : undefined;
  if (config.accessToken && !vcrAccessToken && !config.oidc) {
    throw new Error(
      `${config.accessTokenSource} is not a VCR-compatible access token; ` +
        "use VERCEL_TOKEN with a classic access token or run `vercel login`",
    );
  }
  if (vcrAccessToken) {
    childEnv.VERCEL_TOKEN = vcrAccessToken;
    authSource = config.accessTokenSource;
  } else {
    delete childEnv.VERCEL_TOKEN;
  }

  if (config.team && config.project) {
    return {
      authSource,
      env: childEnv,
      scopeArgs: ["--scope", config.team, "--project", config.project],
      scopeSource: "VERCEL_TEAM_ID + VERCEL_PROJECT_ID",
    };
  }
  if (!config.oidc) {
    return {
      authSource,
      env: childEnv,
      scopeArgs: [],
      scopeSource: "linked/default Vercel CLI project",
    };
  }

  let claims;
  try {
    const segments = config.authToken?.split(".") ?? [];
    if (segments.length !== 3 || !segments[1]) throw new Error("token is not a JWT");
    claims = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8"));
  } catch (cause) {
    throw new Error(
      "VERCEL_OIDC_TOKEN must be a JWT with owner_id and project_id claims for VCR access",
      { cause },
    );
  }
  const team = typeof claims.owner_id === "string" ? claims.owner_id.trim() : "";
  const project = typeof claims.project_id === "string" ? claims.project_id.trim() : "";
  if (!team || !project) {
    throw new Error(
      "VERCEL_OIDC_TOKEN must contain owner_id and project_id claims for VCR access",
    );
  }
  return {
    authSource,
    env: childEnv,
    scopeArgs: ["--scope", team, "--project", project],
    scopeSource: "VERCEL_OIDC_TOKEN claims",
  };
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
