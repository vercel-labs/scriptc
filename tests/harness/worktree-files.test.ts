import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, test } from "vitest";
import {
  filterExistingWorktreePaths,
  workspaceResetCommand,
} from "../../scripts/worktree-files.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("archive path filtering omits unstaged deletions across stream chunks", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-worktree-files-"));
  roots.push(root);
  writeFileSync(join(root, "kept.ts"), "");
  writeFileSync(join(root, "blocking"), "");

  const input = Readable.from([
    Buffer.from("ke"),
    Buffer.from("pt.ts\0deleted.ts\0block"),
    Buffer.from("ing/child.ts\0"),
  ]);
  const chunks: Buffer[] = [];
  for await (const chunk of input.pipe(filterExistingWorktreePaths(root))) {
    chunks.push(Buffer.from(chunk));
  }

  expect(Buffer.concat(chunks)).toEqual(Buffer.from("kept.ts\0"));
});

test("workspace reset removes image manifests but retains the dependency cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptc-worktree-reset-"));
  roots.push(root);
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".pnpm"), { recursive: true });
  writeFileSync(join(root, "package.json"), "stale root manifest");
  writeFileSync(join(root, "packages", "cli", "package.json"), "stale package manifest");
  writeFileSync(join(root, "node_modules", ".pnpm", "cache"), "cached dependencies");

  const { command, args } = workspaceResetCommand(root);
  execFileSync(command, args);

  expect(readdirSync(root)).toEqual(["node_modules"]);
  expect(readFileSync(join(root, "node_modules", ".pnpm", "cache"), "utf8")).toBe(
    "cached dependencies",
  );
});

test("workspace reset keeps Linux Sandbox paths POSIX on every host", () => {
  const { command, args } = workspaceResetCommand("/workspace");

  expect(command).toBe("find");
  expect(args[0]).toBe("/workspace");
});

test("workspace reset refuses the filesystem root", () => {
  expect(() => workspaceResetCommand("/")).toThrow("refusing to reset a filesystem root");
});
