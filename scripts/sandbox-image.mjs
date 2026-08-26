#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  requiredSandboxImageConfig,
  sandboxVcrConfig,
  sandboxVercelConfig,
} from "./sandbox-config.mjs";
import { linuxAmd64ManifestDigest } from "./oci-manifest.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const { reference: image, repository, tag } = requiredSandboxImageConfig();
const vercelConfig = sandboxVercelConfig();
const vcrConfig = sandboxVcrConfig(vercelConfig);
const scopeArgs = vcrConfig.scopeArgs;
const nodeVersion = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim();

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...vcrConfig.env, NO_UPDATE_NOTIFIER: "1" },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${signal ?? code}${stderr ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

console.log(
  `Authenticating Docker with ${vercelConfig.authSource} ` +
    `(scope: ${vcrConfig.scopeSource})...`,
);
await run("vercel", ["vcr", "login", "docker", ...scopeArgs]);

console.log(`Building and pushing ${image} for linux/amd64...`);
await run("docker", [
  "buildx",
  "build",
  "--platform",
  "linux/amd64",
  "--build-arg",
  `NODE_VERSION=${nodeVersion}`,
  "--file",
  "Dockerfile.sandbox",
  "--output",
  `type=image,name=${image},push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true`,
  ".",
]);

const inspection = JSON.parse(
  await run(
    "docker",
    ["buildx", "imagetools", "inspect", image, "--format", "{{json .}}"],
    { capture: true },
  ),
);
let amd64Digest;
try {
  amd64Digest = linuxAmd64ManifestDigest(inspection);
} catch (error) {
  throw new Error(`could not find the linux/amd64 manifest for ${image}`, {
    cause: error,
  });
}

console.log("Waiting for VCR to prepare the image for Sandbox...");
const deadline = Date.now() + 5 * 60_000;
while (Date.now() < deadline) {
  const listing = JSON.parse(
    await run(
      "vercel",
      ["vcr", "image", "ls", repository, "--format", "json", ...scopeArgs],
      { capture: true },
    ),
  );
  const manifest = listing.images?.find((candidate) => candidate.manifestDigest === amd64Digest);
  if (manifest?.status === "ready") {
    console.log(`${repository}:${tag} is ready for Vercel Sandbox.`);
    process.exit(0);
  }
  if (manifest?.status === "unoptimized") {
    throw new Error(`${repository}:${tag} is unoptimized; Vercel Sandbox requires linux/amd64`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

throw new Error(`VCR did not prepare ${repository}:${tag} within 5 minutes`);
