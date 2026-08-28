import { lstatSync } from "node:fs";
import { posix, sep } from "node:path";
import { Transform } from "node:stream";

const NUL = Buffer.from([0]);

/**
 * Filter a NUL-delimited `git ls-files` stream to paths that still exist in
 * the working tree. The index continues to report tracked files after an
 * unstaged delete or filesystem rename; handing those names to tar makes an
 * otherwise valid dirty-worktree gate fail before any tests run.
 *
 * lstat intentionally retains broken symlinks: they are real worktree entries
 * even though existsSync would report them missing.
 */
export function filterExistingWorktreePaths(root) {
  const rootPrefix = Buffer.from(root.endsWith(sep) ? root : `${root}${sep}`);
  let buffered = Buffer.alloc(0);

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buffered = Buffer.concat([buffered, chunk]);
        let nul;
        while ((nul = buffered.indexOf(0)) !== -1) {
          const path = buffered.subarray(0, nul);
          buffered = buffered.subarray(nul + 1);
          if (path.length === 0) continue;
          try {
            lstatSync(Buffer.concat([rootPrefix, path]));
          } catch (error) {
            if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
            throw error;
          }
          this.push(path);
          this.push(NUL);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      if (buffered.length !== 0) {
        callback(new Error("git ls-files returned a path without a NUL terminator"));
      } else {
        callback();
      }
    },
  });
}

/**
 * Build the command that clears image-seeded worktree entries before an
 * uploaded archive is extracted. The dependency tree is an image cache rather
 * than worktree input, so retain it for pnpm to reconcile after extraction.
 *
 * Removing every other top-level entry makes absence meaningful: a manifest
 * deleted or renamed in the uploaded worktree cannot survive from the image.
 */
export function workspaceResetCommand(workspaceRoot) {
  if (!posix.isAbsolute(workspaceRoot)) {
    throw new Error("workspace reset root must be absolute");
  }
  const normalizedRoot = posix.resolve(workspaceRoot);
  if (normalizedRoot === posix.parse(normalizedRoot).root) {
    throw new Error("refusing to reset a filesystem root");
  }
  return {
    command: "find",
    args: [
      normalizedRoot,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "!",
      "-name",
      "node_modules",
      "-exec",
      "rm",
      "-rf",
      "--",
      "{}",
      "+",
    ],
  };
}
