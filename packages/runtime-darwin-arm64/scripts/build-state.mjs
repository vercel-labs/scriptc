import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function lockIsActive(lockPath) {
  try {
    const owner = JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8"));
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  } catch {
    // mkdir() wins before owner.json is written. Treat a fresh owner-less
    // directory as active, but recover one left behind by a crashed builder.
    const info = await stat(lockPath).catch(() => null);
    return info !== null && Date.now() - info.mtimeMs < 5_000;
  }
}

export async function withBuildLock(
  lockPath,
  task,
  { retryMilliseconds = 50, timeoutMilliseconds = 10 * 60_000 } = {},
) {
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath);
      await writeFile(`${lockPath}/owner.json`, JSON.stringify({ pid: process.pid }));
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!(await lockIsActive(lockPath))) {
        const abandoned = `${lockPath}.abandoned-${process.pid}-${Math.random().toString(36).slice(2)}`;
        try {
          await rename(lockPath, abandoned);
          await rm(abandoned, { recursive: true, force: true });
        } catch (takeoverError) {
          if (takeoverError?.code !== "ENOENT") throw takeoverError;
        }
        continue;
      }
      if (Date.now() - started >= timeoutMilliseconds) {
        throw new Error(`timed out waiting for runtime-pack build lock: ${lockPath}`);
      }
      await wait(retryMilliseconds);
    }
  }
  try {
    return await task();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function moveAside(path, backup) {
  try {
    await rename(path, backup);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function installRuntimePack({
  outputRoot,
  manifestPath,
  stagedOutputRoot,
  stagedManifestPath,
  backupRoot,
  backupManifestPath,
}) {
  let outputBackedUp = false;
  let manifestBackedUp = false;
  let outputInstalled = false;
  let manifestInstalled = false;
  try {
    outputBackedUp = await moveAside(outputRoot, backupRoot);
    manifestBackedUp = await moveAside(manifestPath, backupManifestPath);
    await rename(stagedOutputRoot, outputRoot);
    outputInstalled = true;
    await rename(stagedManifestPath, manifestPath);
    manifestInstalled = true;
  } catch (error) {
    if (manifestInstalled) await rm(manifestPath, { force: true }).catch(() => undefined);
    if (outputInstalled) await rm(outputRoot, { recursive: true, force: true }).catch(() => undefined);
    if (manifestBackedUp) await rename(backupManifestPath, manifestPath).catch(() => undefined);
    if (outputBackedUp) await rename(backupRoot, outputRoot).catch(() => undefined);
    throw error;
  }
  // Backup cleanup is outside the transactional install. Once both staged
  // outputs are live, a cleanup failure must not remove them or attempt a
  // rollback from a backup that may already have been deleted.
  await Promise.all([
    rm(backupRoot, { recursive: true, force: true }).catch(() => undefined),
    rm(backupManifestPath, { force: true }).catch(() => undefined),
  ]);
}
