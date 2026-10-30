#!/usr/bin/env node
// Waits until every package of a release resolves on the npm registry.
//
// usage: wait-npm-available.mjs <uploads file> [--interval <seconds>] [--timeout <seconds>]
//
// Each line of the uploads file is `<name>@<version>`, optionally followed by
// the Unix time (seconds) at which npm accepted the upload. Every interval
// (120 seconds by default), each package that has not resolved yet is asked
// for with `npm view <name>@<version> version --prefer-online`. A package
// resolves when npm prints its version. Each package is reported once it
// resolves, with the time from upload to the check that found it.
//
// Exits with 0 once every package resolves. When packages are still missing
// at the timeout (2 hours by default), prints their names and versions and
// exits with 1. The script only reads from the registry.
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

function usage() {
  throw new Error(
    "usage: wait-npm-available.mjs <uploads file> [--interval <seconds>] [--timeout <seconds>]",
  );
}

const args = process.argv.slice(2);
let file;
let intervalSeconds = 120;
let timeoutSeconds = 2 * 60 * 60;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--interval" || arg === "--timeout") {
    const value = Number(args[++i]);
    if (!Number.isFinite(value) || value <= 0) usage();
    if (arg === "--interval") intervalSeconds = value;
    else timeoutSeconds = value;
  } else if (file === undefined) {
    file = arg;
  } else {
    usage();
  }
}
if (file === undefined) usage();

const packages = [];
for (const line of readFileSync(file, "utf8").split("\n")) {
  const fields = line.trim().split(/\s+/);
  if (fields[0] === "") continue;
  const spec = fields[0];
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1 || fields.length > 2) {
    throw new Error(`malformed upload line: ${line}`);
  }
  const acceptedAt = fields[1] === undefined ? null : Number(fields[1]) * 1000;
  if (acceptedAt !== null && !Number.isFinite(acceptedAt)) {
    throw new Error(`malformed upload time: ${line}`);
  }
  packages.push({ spec, version: spec.slice(at + 1), acceptedAt, availableAt: null });
}
if (packages.length === 0) throw new Error(`${file} names no packages`);

function resolves(pkg) {
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["view", pkg.spec, "version", "--prefer-online"],
      { encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error === null && stdout.trim() === pkg.version) {
          resolve(true);
          return;
        }
        const code = /npm error code (\S+)/.exec(stderr)?.[1];
        if (error !== null && code !== "E404") {
          const reason = code ?? error.code ?? error.message.split("\n")[0];
          console.log(`${pkg.spec}: npm view failed (${reason}); checking again`);
        }
        resolve(false);
      },
    );
  });
}

function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function uploadToAvailable(pkg) {
  return pkg.acceptedAt === null
    ? "upload time not recorded"
    : duration(pkg.availableAt - pkg.acceptedAt);
}

function summary(missing) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const rows = packages.map(
    (pkg) =>
      `| \`${pkg.spec}\` | ${pkg.availableAt === null ? "missing" : uploadToAvailable(pkg)} |`,
  );
  const heading =
    missing.length === 0
      ? `Every package resolves on npm (${packages.length}).`
      : `${missing.length} of ${packages.length} packages do not resolve on npm after ${duration(timeoutSeconds * 1000)}.`;
  appendFileSync(
    summaryFile,
    [heading, "", "| Package | Upload to available |", "| --- | --- |", ...rows, ""].join("\n"),
  );
}

const started = Date.now();
const deadline = started + timeoutSeconds * 1000;
for (;;) {
  const pending = packages.filter((pkg) => pkg.availableAt === null);
  const checked = [];
  // A few checks at a time keep each round short without flooding the registry.
  for (let i = 0; i < pending.length; i += 8) {
    const batch = pending.slice(i, i + 8);
    const results = await Promise.all(batch.map(resolves));
    const now = Date.now();
    batch.forEach((pkg, j) => {
      if (results[j]) {
        pkg.availableAt = now;
        checked.push(pkg);
      }
    });
  }
  for (const pkg of checked) console.log(`${pkg.spec} is available (${uploadToAvailable(pkg)})`);
  const missing = packages.filter((pkg) => pkg.availableAt === null);
  if (missing.length === 0) {
    console.log(`Every package resolves on npm (${packages.length}).`);
    summary(missing);
    process.exit(0);
  }
  const now = Date.now();
  if (now >= deadline) {
    console.log(
      `${missing.length} of ${packages.length} packages do not resolve on npm after ${duration(now - started)}:`,
    );
    for (const pkg of missing) console.log(`::error::${pkg.spec} does not resolve on npm`);
    summary(missing);
    process.exit(1);
  }
  console.log(
    `${missing.length} of ${packages.length} packages do not resolve yet; checking again in ${duration(Math.min(intervalSeconds * 1000, deadline - now))}`,
  );
  await delay(Math.min(intervalSeconds * 1000, deadline - now));
}
