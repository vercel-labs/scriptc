#!/usr/bin/env node
/* Rehome a branch's changes across a module split.
 *
 * A split moves whole declarations out of one module into new files, so git
 * cannot follow a branch's edits into them: merging the split reports every
 * edit to a moved declaration as a conflict. This script carries the branch
 * across instead. It applies the same split (split-module.mjs,
 * split-methods.mjs or move-state.mjs with the split's config; each also
 * formats with oxfmt) to the branch's merge base and to the branch tip, and
 * cherry-picks the difference onto the target. That is a three-way merge
 * whose base and branch side already use the new layout, so each hunk lands
 * in the file its declaration moved to. Hunks in declarations that stay, and
 * declarations the branch adds, stay in the module.
 *
 *   node rehome-split.mjs --branch <ref> --onto <ref> --config <split config>
 *       [--out <branch name>] [--squash] [--scratch <dir prefix>]
 *
 * Run it from a checkout with node_modules installed (it supplies typescript
 * and oxfmt). --onto is a commit that contains the split, usually main.
 * The result is a new branch (default <branch>-rehomed). By default its tip
 * is a merge commit with parents <branch> and <onto>: the branch's history
 * is kept and the result reads as "merge main into the branch", so it can be
 * pushed without rewriting the branch. --squash makes one ordinary commit on
 * <onto> instead. When the cherry-pick conflicts, the script stops and
 * leaves the work tree with the conflicts to resolve; see the message. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confine } from "./confine.mjs";
import { formatFiles } from "./format.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const branch = opt("branch");
const onto = opt("onto");
const configPath = opt("config");
if (!branch || !onto || !configPath) {
  console.error(
    "usage: rehome-split.mjs --branch <ref> --onto <ref> --config <split config> [--out <name>] [--squash]",
  );
  process.exit(2);
}
const out = opt("out", `${branch.replace(/^.*\//, "")}-rehomed`);
const tools = process.cwd();
const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(configPath, "utf8"));
// A config with "groups" moves fields into feature state (move-state.mjs),
// one with "methods" moves methods (split-methods.mjs), and any other moves
// top-level declarations (split-module.mjs).
const splitTool = join(
  here,
  config.groups ? "move-state.mjs" : config.class ? "split-methods.mjs" : "split-module.mjs",
);

const git = (...a) =>
  execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitIn = (cwd, ...a) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Every commit the script makes is authored and committed as the branch's
// last author.
const author = (format) => git("log", "-1", `--format=${format}`, branch);
const ident = {
  GIT_AUTHOR_NAME: author("%an"),
  GIT_AUTHOR_EMAIL: author("%ae"),
};
ident.GIT_COMMITTER_NAME = ident.GIT_AUTHOR_NAME;
ident.GIT_COMMITTER_EMAIL = ident.GIT_AUTHOR_EMAIL;
Object.assign(process.env, ident);

const tip = git("rev-parse", `${branch}^{commit}`);
const target = git("rev-parse", `${onto}^{commit}`);
// The split must not be in the branch already, or there is nothing to rehome.
const moduleFile = config.module;
// With several merge bases (criss-cross history, such as a branch that
// carries another branch's commits that main merged), merge them into one
// virtual base, as git's merge does, so the cherry-pick sees the same base.
let base = git("merge-base", tip, target);
{
  const bases = git("merge-base", "--all", tip, target).split("\n").filter(Boolean);
  for (const next of bases.slice(1)) {
    const merged = spawnSync("git", ["merge-tree", "--write-tree", base, next], {
      encoding: "utf8",
    });
    const tree = merged.stdout.split("\n")[0];
    base = git("commit-tree", tree, "-p", base, "-p", next, "-m", "virtual merge base");
  }
}

// Scratch worktrees go next to the checkout: not inside it (they would show
// as untracked files) and not under node_modules (oxfmt skips those paths).
const scratch = mkdtempSync(opt("scratch", join(dirname(tools), ".rehome-")));
const worktree = (name, commit) => {
  const dir = join(scratch, name);
  git("worktree", "add", "--detach", "-q", dir, commit);
  return dir;
};
const split = (dir) => {
  execFileSync(
    process.execPath,
    [splitTool, "apply", configPath, "--repo", dir, "--tools", tools],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  gitIn(dir, "add", "-A");
  return gitIn(dir, "write-tree");
};
const commitTree = (tree, parents, message) =>
  execFileSync("git", ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...ident,
    },
  }).trim();

let baseDir, tipDir;
try {
  baseDir = worktree("base", base);
  tipDir = worktree("tip", tip);
  const splitBase = commitTree(split(baseDir), [base], "split of the merge base");
  const splitTip = commitTree(split(tipDir), [splitBase], "split of the branch tip");
  if (git("rev-parse", `${splitBase}^{tree}`) === git("rev-parse", `${splitTip}^{tree}`)) {
    console.log(`${branch} has no changes relative to ${base.slice(0, 9)}`);
    process.exit(0);
  }
  const touched = git("diff", "--name-only", splitBase, splitTip).split("\n").filter(Boolean);
  console.log(`${branch}: ${touched.length} files changed in the split layout`);
  // Apply the branch's changes onto the target in a worktree of its own.
  const resultDir = worktree("result", target);
  const pick = spawnSync(
    "git",
    ["-c", "merge.conflictStyle=merge", "cherry-pick", "--no-commit", splitTip],
    {
      cwd: resultDir,
      encoding: "utf8",
    },
  );
  // Moved declarations bring short import blocks, where an import main added
  // and one the branch added can sit on adjacent lines. Resolve conflicts
  // made only of import declarations to the union of both sides.
  if (pick.status !== 0) {
    // Only the files the split writes: other conflicts are the branch's own.
    // A method split names its files in the config; a module split, in its manifest.
    const files = config.groups
      ? [
          ...config.groups.map((g) => g.file),
          ...Object.keys(config.create ?? {}),
          ...(config.replacements ?? []).map((r) => r.file),
        ]
      : config.class
        ? Object.keys(config.methods)
        : Object.keys(
            (({ files, ...rest }) => files ?? rest)(
              JSON.parse(
                confine(dirname(resolve(configPath))).read(
                  resolve(dirname(resolve(configPath)), config.manifest),
                ),
              ),
            ),
          );
    const moduleDir = config.dir ?? dirname(moduleFile);
    const splitFiles = new Set([moduleFile, ...files.map((f) => join(moduleDir, f))]);
    for (const file of gitIn(resultDir, "diff", "--name-only", "--diff-filter=U")
      .split("\n")
      .filter(Boolean)) {
      if (
        splitFiles.has(file) &&
        resolveImportConflicts(confine(resultDir), join(resultDir, file))
      ) {
        formatFiles(tools, [file], { cwd: resultDir, stdio: ["ignore", "ignore", "inherit"] });
        gitIn(resultDir, "add", file);
        console.log(`${file}: import conflicts resolved to both sides' imports`);
      }
    }
  }
  if (pick.status !== 0 && gitIn(resultDir, "diff", "--name-only", "--diff-filter=U") !== "") {
    const conflicts = gitIn(resultDir, "diff", "--name-only", "--diff-filter=U");
    console.error(
      `conflicts in:\n${conflicts}\n\nResolve them in ${resultDir}, then run:\n  git -C ${resultDir} add -A && git -C ${resultDir} commit -m "Merge ${onto} into ${branch}" # or rerun with the resolution\nThe scratch worktrees stay until you remove ${scratch}.`,
    );
    process.exit(1);
  }
  const tree = gitIn(resultDir, "write-tree");
  const subjects = git("log", "--format=%s", `${base}..${tip}`).split("\n").filter(Boolean);
  const result = has("squash")
    ? commitTree(
        tree,
        [target],
        subjects.length === 1
          ? subjects[0]
          : `${subjects.at(-1)}\n\n${subjects.map((s) => `- ${s}`).join("\n")}`,
      )
    : commitTree(
        tree,
        [tip, target],
        `Merge ${onto} into ${branch.replace(/^.*\//, "")}\n\nCarries the branch's changes to ${moduleFile} into the files its declarations moved to.`,
      );
  git("branch", "-f", out, result);
  console.log(
    `${out} -> ${result.slice(0, 9)} (${has("squash") ? "one commit on" : "merge of"} ${onto})`,
  );
  for (const dir of [baseDir, tipDir, resultDir]) git("worktree", "remove", "--force", dir);
  rmSync(scratch, { recursive: true, force: true });
} catch (error) {
  console.error(error.stderr?.toString() || error.message);
  console.error(`scratch worktrees left in ${scratch}`);
  process.exit(1);
}

/* Rewrites every conflict in `path` whose two sides hold only import
 * declarations as the union of both: one declaration per module and kind,
 * with the named imports of both sides in first-seen order, read and
 * written through the result checkout's guard. Returns false,
 * leaving the file unchanged, when any conflict holds other code. */
function resolveImportConflicts(checkout, path) {
  const ts = createRequire(join(tools, "package.json"))("typescript");
  const text = checkout.read(path);
  const region = /^<<<<<<< [^\n]*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> [^\n]*\n/gm;
  const imports = (side) => {
    const sf = ts.createSourceFile("side.ts", side, ts.ScriptTarget.Latest, true);
    return sf.statements.every(ts.isImportDeclaration) ? sf.statements : null;
  };
  let ok = true;
  const imported = new Set();
  const resolved = text.replace(region, (whole, ours, theirs) => {
    const a = imports(ours),
      b = imports(theirs);
    if (!a || !b) {
      ok = false;
      return whole;
    }
    const merged = new Map();
    for (const decl of [...a, ...b]) {
      const clause = decl.importClause;
      const named =
        clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings
          : null;
      if (!clause || !named || clause.name) {
        // Side-effect, default and namespace imports are kept as written, once.
        merged.set(decl.getText(), null);
        continue;
      }
      const key = `${clause.isTypeOnly ? "type " : ""}${decl.moduleSpecifier.getText()}`;
      const entry = merged.get(key) ?? {
        typeOnly: clause.isTypeOnly,
        from: decl.moduleSpecifier.getText(),
        names: [],
      };
      for (const element of named.elements) {
        imported.add(element.name.text);
        if (!entry.names.includes(element.getText())) entry.names.push(element.getText());
      }
      merged.set(key, entry);
    }
    return (
      [...merged]
        .map(([key, entry]) =>
          entry === null
            ? key
            : `import ${entry.typeOnly ? "type " : ""}{ ${entry.names.join(", ")} } from ${entry.from};`,
        )
        .join("\n") + "\n"
    );
  });
  if (!ok || resolved === text) return false;
  checkout.write(path, pruneUnusedImports(ts, resolved, imported));
  return true;
}

/* Drops the named imports among `names` that nothing outside import
 * declarations references: a side's import whose use the other side's code
 * replaced. The split computes each file's imports from its references, so
 * this keeps a rehomed file's imports the ones the split would write. */
function pruneUnusedImports(ts, text, names) {
  const sf = ts.createSourceFile("file.ts", text, ts.ScriptTarget.Latest, true);
  const used = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const edits = [];
  for (const decl of sf.statements) {
    const named = decl.importClause?.namedBindings;
    if (
      !ts.isImportDeclaration(decl) ||
      !named ||
      !ts.isNamedImports(named) ||
      decl.importClause.name
    )
      continue;
    const kept = named.elements.filter((e) => !names.has(e.name.text) || used.has(e.name.text));
    if (kept.length === named.elements.length) continue;
    const from = decl.moduleSpecifier.getText();
    const prefix = decl.importClause.isTypeOnly ? "import type" : "import";
    // A dropped declaration takes its line break with it.
    const end = kept.length || text[decl.getEnd()] !== "\n" ? decl.getEnd() : decl.getEnd() + 1;
    edits.push([
      decl.getStart(),
      end,
      kept.length ? `${prefix} { ${kept.map((e) => e.getText()).join(", ")} } from ${from};` : "",
    ]);
  }
  for (const [start, end, replacement] of edits.reverse())
    text = text.slice(0, start) + replacement + text.slice(end);
  return text;
}
