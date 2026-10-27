/* Splits the Limitations page into partials and joins them back.
 *
 * content/docs/limitations.mdx keeps the frontmatter, the headings and the
 * anchor spans. Everything else lives in content/limitations/:
 *
 *   introduction.mdx                  prose before the first heading
 *   <section>.mdx                     a section's prose (paragraphs, code
 *                                     blocks, unlabeled lists)
 *   <section>/<label>.mdx             one labeled bullet (`- **Label:** ...`),
 *                                     one sentence per line, continuation
 *                                     lines indented two spaces
 *
 * <section> is the slug of the nearest heading and <label> the slug of the
 * bullet's bold label. The page includes each partial with
 * `<include>../limitations/<path>.mdx</include>` in page order; the remark
 * step in src/lib/remark-docs.ts joins consecutive bullet partials back into
 * one list.
 *
 * Usage (from docs/):
 *   node scripts/limitations-partials.mjs join [page]          print the page with partials inlined
 *   node scripts/limitations-partials.mjs split <file> [page]  write the page and partials from one file
 *   node scripts/limitations-partials.mjs merge <base> <theirs>
 *       three-way merge a branch's single-file page (<theirs>, forked from
 *       <base>) into the current partials, then split the result
 *   node scripts/limitations-partials.mjs check   fail on a partial line that holds two sentences
 *   node scripts/limitations-partials.mjs fix     put each such sentence on its own line
 *
 * One sentence per line keeps changes to different sentences on different
 * lines, so concurrent edits merge. Markdown joins the lines with a space,
 * so the rendered page is the same. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = fileURLToPath(new URL("../", import.meta.url));
const defaultPage = join(docsRoot, "content/docs/limitations.mdx");
const partialsDir = join(docsRoot, "content/limitations");
const includeLine = /^<include>(\.\.\/limitations\/[\w/-]+\.mdx)<\/include>$/;
const labeledBullet = /^- \*\*([^*]+?):\*\*/;
const bulletContinuation = /^ {2}\S/;

export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The page with every partial include replaced by the partial's text. */
export function joinPage(page = defaultPage) {
  const out = [];
  for (const line of readFileSync(page, "utf8").split("\n")) {
    const include = line.match(includeLine);
    out.push(include ? readFileSync(resolve(dirname(page), include[1]), "utf8").replace(/\n$/, "") : line);
  }
  // Consecutive bullet partials sit between blank lines in the page; the
  // single file has them as one list.
  let text = out.join("\n");
  for (let prev; prev !== text; ) {
    prev = text;
    text = text.replace(/^(- \*\*[^\n]*(?:\n {2}\S[^\n]*)*)\n\n(?=- \*\*)/gm, "$1\n");
  }
  return text.replace(/\n*$/, "\n");
}

/** Page text and partials (path relative to content/limitations → text). */
export function splitPage(text) {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines[0] !== "---") throw new Error("the page has no frontmatter");
  const fmEnd = lines.indexOf("---", 1);
  const page = lines.slice(0, fmEnd + 1);
  const partials = new Map();
  let section = "introduction";
  let prose = [];
  let proseCount = 0;
  const flushProse = () => {
    while (prose.length && prose[prose.length - 1] === "") prose.pop();
    while (prose.length && prose[0] === "") prose.shift();
    if (!prose.length) return;
    const name = `${section}${proseCount ? `-${proseCount + 1}` : ""}.mdx`;
    proseCount++;
    add(name, prose.join("\n"));
    prose = [];
  };
  const add = (name, body) => {
    if (partials.has(name)) throw new Error(`two partials named ${name}`);
    partials.set(name, body + "\n");
    page.push("", `<include>../limitations/${name}</include>`);
  };
  let inFence = false;
  let bulletName = null;
  let bulletLines = [];
  const flushBullet = () => {
    if (bulletName !== null) add(bulletName, bulletLines.join("\n"));
    bulletName = null;
    bulletLines = [];
  };
  for (const line of lines.slice(fmEnd + 1)) {
    if (bulletName !== null && bulletContinuation.test(line)) {
      bulletLines.push(line);
      continue;
    }
    if (bulletName !== null && line !== "" && !labeledBullet.test(line) && !/^#{2,6} /.test(line))
      throw new Error(`a labeled bullet is followed by a line that is not a blank line, bullet, heading or indented continuation: ${line.slice(0, 60)}`);
    flushBullet();
    if (/^(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && line.match(/^#{2,6} (.*)$/);
    const anchor = !inFence && /^<span id="[\w-]+" \/>$/.test(line);
    const bullet = !inFence && line.match(labeledBullet);
    if (heading || anchor) {
      flushProse();
      page.push("", line);
      if (heading) {
        section = slug(heading[1]);
        proseCount = 0;
      }
    } else if (bullet) {
      flushProse();
      bulletName = `${section}/${slug(bullet[1])}.mdx`;
      bulletLines = [line];
    } else {
      prose.push(line);
    }
  }
  flushBullet();
  flushProse();
  // Collapse the blank-line runs the pushes above produce.
  const pageText = page.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
  return { page: pageText, partials };
}

function write(text, page = defaultPage) {
  const { page: pageText, partials } = splitPage(text);
  rmSync(partialsDir, { recursive: true, force: true });
  for (const [name, body] of partials) {
    const file = join(partialsDir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  writeFileSync(page, pageText);
  const roundTrip = joinPage(page);
  if (roundTrip !== text) throw new Error("joining the partials does not reproduce the input");
  console.error(`${relative(docsRoot, page)}: ${partials.size} partials in ${relative(docsRoot, partialsDir)}/`);
}

// A sentence ends at `.`, `!` or `?` (after any closing `)`, `"` or `*`)
// followed by a space and a capital letter, a code span, a link or bold
// text. Abbreviations don't end one.
const sentenceEnd = /(?<!\b(?:e\.g|i\.e|etc|vs|cf))([.!?][)"*]*) (?=[A-Z`[*])/g;

/** The partial text with each sentence of a prose line on its own line;
 * a bullet's sentences continue with the two-space indent. Code fences,
 * headings, tables, HTML and include lines are left alone, as are code
 * spans and link targets. */
export function splitSentences(text) {
  let inFence = false;
  const out = [];
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence || /^\s*(```|~~~|#|<|\||$)/.test(line)) {
      out.push(line);
      continue;
    }
    const indent = /^\s*(?:[-*]|\d+\.) /.test(line) ? "  " : line.match(/^\s*/)[0];
    // Mask code spans (all but the opening backtick, which can start a
    // sentence) and link targets, so their periods never split.
    const masked = line.replace(/`[^`]*`|\]\([^)]*\)/g, (m) => m[0] + "\0".repeat(m.length - 1));
    const pieces = [];
    let start = 0;
    for (const match of masked.matchAll(sentenceEnd)) {
      const end = match.index + match[1].length;
      pieces.push(line.slice(start, end));
      start = end + 1;
    }
    pieces.push(line.slice(start));
    out.push(pieces[0], ...pieces.slice(1).map((piece) => indent + piece));
  }
  return out.join("\n");
}

function listPartials(dir = partialsDir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listPartials(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const [command, ...args] = process.argv.slice(2);
if (command === "join") {
  process.stdout.write(joinPage(args[0] ?? defaultPage));
} else if (command === "split") {
  write(readFileSync(args[0], "utf8"), args[1] ?? defaultPage);
} else if (command === "merge") {
  const [base, theirs] = args;
  const work = mkdtempSync(join(tmpdir(), "scriptc-limitations-"));
  try {
    const ours = join(work, "ours.mdx");
    writeFileSync(ours, joinPage());
    let conflicted = false;
    try {
      execFileSync("git", ["merge-file", "-L", "main", "-L", "base", "-L", "branch", ours, base, theirs]);
    } catch (error) {
      if (error.status > 0 && error.status < 128) conflicted = true;
      else throw error;
    }
    const merged = readFileSync(ours, "utf8");
    if (conflicted) {
      const out = join(docsRoot, "limitations.merged.mdx");
      writeFileSync(out, merged);
      console.error(`conflicts: resolve them in ${relative(process.cwd(), out)}, then run: node scripts/limitations-partials.mjs split ${relative(docsRoot, out)}`);
      process.exitCode = 1;
    } else {
      write(merged);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else if (command === "check" || command === "fix") {
  let unsplit = 0;
  for (const file of listPartials().sort()) {
    const text = readFileSync(file, "utf8");
    const split = splitSentences(text);
    if (split === text) continue;
    unsplit++;
    if (command === "fix") writeFileSync(file, split);
    else console.error(`${relative(docsRoot, file)}: put each sentence on its own line (node docs/scripts/limitations-partials.mjs fix)`);
  }
  if (command === "check" && unsplit > 0) process.exitCode = 1;
} else if (command === "list") {
  for (const file of listPartials().sort()) console.log(relative(docsRoot, file));
} else {
  console.error("usage: limitations-partials.mjs join [page] | split <file> [page] | merge <base> <theirs> | check | fix | list");
  process.exitCode = 2;
}
