#!/usr/bin/env node

/* Generate the website's complete Node.js v24 parity inventory.
 *
 * Node owns the denominator: the pinned index.md names every API chapter and all.json
 * supplies the structured API tree (classes, methods, properties, events,
 * globals, overloads, and conceptual sections). scriptc owns the projection:
 * the compiler surface and dedicated native compatibility manifests.
 * Anything those sources do not prove is either "not-implemented" (when a
 * known implementation surface has no matching implementation) or
 * "unreviewed" (when no compatibility subsystem owns the classification).
 * Neither state is optimistically treated as support or an explicit refusal.
 *
 *   pnpm node-compat                fetch latest-v24.x and rewrite the snapshot
 *   pnpm node-compat --check        fetch and fail if the snapshot would change
 *   pnpm node-compat --local        rewrite the snapshot without fetching: reclassify
 *                                   the committed rows from the current sources
 *   pnpm node-compat:check          offline implementation/profile drift check
 *
 * Every mode writes or checks the two refusal-table artifacts as well:
 * generated/node-v24-refusals.json and its published copy,
 * packages/experimental/refusals.json.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildRefusals, renderRefusals } from "./refusals.mjs";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const internalOutputPath = `${packageRoot}generated/node-v24-internal.json`;
const publicOutputPath = `${root}docs/src/generated/node-v24-compatibility.json`;
const refusalsOutputPath = `${packageRoot}generated/node-v24-refusals.json`;
// Published from the experimental package so a program that reads the table
// imports it from the installed package rather than an internal path.
const publishedRefusalsPath = `${root}packages/experimental/refusals.json`;
const compilerVersion = JSON.parse(
  readFileSync(`${root}packages/compiler/package.json`, "utf8"),
).version;
// Files derived from the ledger elsewhere: the docs build computes the
// metadata from the public artifact, and `pnpm node-compat:backlog` builds
// the backlog in memory. A merge that keeps a branch's copy would bring
// back a file every compatibility change rewrites.
const retiredOutputPaths = [
  `${root}docs/src/generated/node-v24-compatibility-meta.json`,
  `${packageRoot}generated/node-v24-backlog.json`,
];
const compilerManifestPath = `${root}packages/compiler/surface-manifest.json`;
const compilerCompatPath = `${packageRoot}static-support.json`;
const pinPath = `${packageRoot}node-v24.json`;
const pin = JSON.parse(readFileSync(pinPath, "utf8"));
const NODE_BASE = pin.markdownBaseUrl;
const CHILD_FIELDS = ["modules", "classes", "methods", "properties", "events", "globals", "miscs"];
const NON_FUNCTIONAL_CHAPTERS = new Set(["documentation", "synopsis"]);
const STATUSES = [
  "supported",
  "partial",
  "island-served",
  "refused",
  "not-implemented",
  "by-design",
  "unreviewed",
  "not-applicable",
];
const STATUS_SET = new Set(STATUSES);
const VERIFICATION_BASES = new Set([
  "test-backed",
  "island-test-backed",
  "explicit-refusal",
  "verified-absence",
  "declared-gap",
  "registry-gap",
  "architectural-policy",
  "unreviewed",
  "not-applicable",
  "derived",
]);

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSymbol(value) {
  if (!value) return "";
  let out = value
    .replaceAll("`", "")
    .replace(/^new\s+/, "")
    .trim();
  out = out.replace(/\s+Type:\s*.*$/, "").replace(/\s*\{[^}]*\}\s*$/, "");
  const call = out.indexOf("(");
  if (call >= 0) out = out.slice(0, call);
  out = out
    .replace(/\[.*$/, "")
    .replace(/\s*=.*$/, "")
    .replace(/^Class:\s*/, "");
  out = out.replace(/^Event:\s*/, "").replace(/^Static method:\s*/, "");
  return out.trim();
}

function apiSymbolOf(node) {
  const code = node.textRaw?.match(/`([^`]+)`/)?.[1];
  return normalizeSymbol(code ?? node.name ?? node.textRaw ?? "");
}

/** Exact tools/doc/html.mjs getId() algorithm at the pinned Node commit. */
function nodeAnchor(textRaw, counters) {
  const base = String(textRaw ?? "")
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
  const count = counters.get(base) ?? 0;
  counters.set(base, count + 1);
  return count === 0 ? base : `${base}_${count}`;
}

function displayLabel(textRaw) {
  const raw = String(textRaw ?? "");
  // all.json expands property headings with type/description prose. The
  // visible Node heading is the first code span; keep the table equally terse.
  if (raw.startsWith("`")) {
    const firstCode = raw.match(/^`([^`]+)`/)?.[1];
    if (firstCode !== undefined) return firstCode;
  }
  return raw
    .replaceAll("`", "")
    .replace(/^(?:Class|Event|Static method):\s*/, "")
    .trim();
}

const STABILITY_LABELS = {
  0: "Deprecated",
  1: "Experimental",
  2: "Stable",
  3: "Legacy",
};

function nodeStability(node, inherited) {
  if (node.stability === undefined || node.stability === null) {
    return inherited === null ? null : { ...inherited, inherited: true };
  }
  const level = Number(node.stability);
  const text = String(node.stabilityText ?? STABILITY_LABELS[level] ?? "").trim();
  const sublevel = level === 1 ? text.match(/^\.(\d+)\s*-\s*(.*)$/s) : null;
  return {
    index: sublevel ? `1.${sublevel[1]}` : String(level),
    level,
    text: sublevel?.[2]?.trim() || text || STABILITY_LABELS[level] || `Stability ${level}`,
    inherited: false,
  };
}

function manifestIndex() {
  const manifest = JSON.parse(readFileSync(compilerManifestPath, "utf8"));
  const byName = new Map();
  for (const item of manifest.entries) {
    if (item.kind !== "node-builtin" && item.kind !== "stdlib") continue;
    const key = normalizeSymbol(item.name);
    const current = byName.get(key);
    if (!current || current.status !== "static") byName.set(key, item);
  }
  return byName;
}

function firstEvidenceForManifestId(id, compat) {
  let match = null;
  for (const [prefix, files] of Object.entries(compat.evidenceByManifestPrefix)) {
    if (id.startsWith(prefix) && (match === null || prefix.length > match.prefix.length)) {
      match = { prefix, files };
    }
  }
  return match?.files ?? [];
}

function validateEvidence(paths, label) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(`${label} makes a support claim without test evidence`);
  }
  for (const path of paths) {
    try {
      readFileSync(`${root}${path}`, "utf8");
    } catch {
      throw new Error(`${label} names missing evidence '${path}'`);
    }
  }
}

function validateStatus(status, label) {
  if (!STATUS_SET.has(status)) throw new Error(`${label} has unknown status '${status}'`);
}

/** The statuses that are positive behavioral claims, native or island, and
 * therefore must name the tests that back them. */
function requiresEvidence(status) {
  return status === "supported" || status === "partial" || status === "island-served";
}

function dedicatedIndex(compat) {
  const out = new Map();
  for (const entry of compat.dedicated) {
    validateStatus(entry.status, `dedicated symbols ${entry.symbols.join(", ")}`);
    if (requiresEvidence(entry.status)) {
      validateEvidence(entry.evidence, `dedicated symbols ${entry.symbols.join(", ")}`);
    }
    for (const symbol of entry.symbols) {
      if (out.has(symbol)) throw new Error(`duplicate dedicated compatibility symbol '${symbol}'`);
      out.set(symbol, entry);
    }
  }
  return out;
}

function featureEntries(compat) {
  for (const entry of compat.features ?? []) {
    validateStatus(entry.status, `${entry.chapter} compatibility features`);
    if (requiresEvidence(entry.status)) {
      validateEvidence(entry.evidence, `${entry.chapter} compatibility features`);
    }
    // A not-implemented entry that names a test claims a verified absence:
    // the test must exist, like the evidence of a positive claim.
    if (entry.status === "not-implemented" && (entry.evidence?.length ?? 0) > 0) {
      validateEvidence(entry.evidence, `${entry.chapter} compatibility features`);
    }
    // A by-design entry takes its policy from another chapter: the errors
    // chapter lists the codes that node:vm, the inspector and the other
    // by-design chapters raise. It names that chapter, whose policy must
    // be by-design.
    if (entry.status === "by-design" && compat.chapterPolicies[entry.policy] !== "by-design") {
      throw new Error(
        `${entry.chapter} compatibility features: a by-design entry names a by-design chapter as its 'policy'`,
      );
    }
  }
  return compat.features ?? [];
}

function featureOf(row, entries, parentSignature) {
  return entries.find(
    (entry) =>
      entry.chapter === row.chapter &&
      (entry.parent === undefined || entry.parent === parentSignature) &&
      ((entry.symbols ?? []).includes(row.apiSymbol) ||
        (entry.signatures ?? []).includes(row.signature)),
  );
}

function symbolCandidates(row) {
  const result = new Set([row.apiSymbol]);
  // A global's own row (`WebAssembly`) matches the compiler's
  // `globalThis.<name>` entries.
  if (row.chapter === "globals" && row.apiSymbol && !row.apiSymbol.includes("."))
    result.add(`globalThis.${row.apiSymbol}`);
  const aliases = [
    ["fsPromises.", "fs/promises."],
    ["dnsPromises.", "dns/promises."],
    ["timersPromises.", "timers/promises."],
    ["streamPromises.", "stream/promises."],
    ["streamConsumers.", "stream/consumers."],
  ];
  for (const value of [...result]) {
    for (const [from, to] of aliases)
      if (value.startsWith(from)) result.add(to + value.slice(from.length));
  }
  return [...result].filter(Boolean);
}

function directExportName(row, module) {
  const symbol = row.apiSymbol;
  const subpathAliases = {
    "fs/promises": "fsPromises",
    "dns/promises": "dnsPromises",
    "stream/promises": "streamPromises",
    "stream/consumers": "streamConsumers",
    "timers/promises": "timersPromises",
  };
  const alias = subpathAliases[module];
  if (alias) {
    // A chapter can contain both a bare module and one or more subpaths. Do
    // not let the chapter prefix make a bare-module row look like an export
    // from a subpath (for example, fs.chmod must not match
    // fs/promises.chmod). The alias is the only valid spelling for a
    // subpath's rows; the fallback prefixes below are for bare modules.
    if (!symbol.startsWith(`${alias}.`)) return null;
    const direct = symbol.slice(alias.length + 1);
    return direct.includes(".") ? null : direct;
  }
  const moduleDots = module.replaceAll("/", ".");
  const prefixes = new Set([
    moduleDots,
    module.split("/").at(-1),
    row.chapter,
    row.chapter.replaceAll("_", ""),
  ]);
  for (const prefix of prefixes) {
    if (prefix && symbol.startsWith(`${prefix}.`)) {
      const direct = symbol.slice(prefix.length + 1);
      return direct.includes(".") ? null : direct;
    }
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(symbol)) return symbol;
  if (row.depth === 1 && ["class", "method", "property", "global"].includes(row.kind))
    return row.name;
  return null;
}

function manifestSymbolCandidates(row) {
  const modules = pin.chapterModules[row.chapter] ?? [];
  const result = new Set(symbolCandidates(row).filter((candidate) => candidate.includes(".")));
  for (const module of modules) {
    const direct = directExportName(row, module);
    if (!direct) continue;
    result.add(`${module}.${direct}`);
    if (module.includes("/") && direct === module.split("/").at(-1)) result.add(module);
  }
  return [...result];
}

function tier(status, _reason, evidence) {
  return {
    status,
    ...(evidence?.source ? { evidence: evidence.source } : {}),
    ...(evidence?.tests?.length ? { tests: evidence.tests } : {}),
  };
}

function scopeOf(row) {
  if (row.depth === 0) return "api";
  if (
    row.chapter === "cli" ||
    row.apiSymbol.startsWith("-") ||
    /\bcommand-line option\b/i.test(row.signature) ||
    (row.chapter === "environment_variables" && row.apiSymbol === "export")
  )
    return "configuration";
  if (row.chapter === "deprecations") return "metadata";
  if (row.chapter === "intl" && row.kind === "module") return "metadata";
  return row.depth > 0 &&
    (row.kind === "module" || row.kind === "misc") &&
    !row.signature.includes("`")
    ? "documentation"
    : "api";
}

function classificationContext() {
  const compilerCompat = JSON.parse(readFileSync(compilerCompatPath, "utf8"));
  for (const [chapter, status] of Object.entries(compilerCompat.chapterPolicies)) {
    validateStatus(status, `static chapter policy '${chapter}'`);
  }
  return {
    manifest: manifestIndex(),
    compilerCompat,
    dedicated: dedicatedIndex(compilerCompat),
    staticFeatures: featureEntries(compilerCompat),
  };
}

function classifyStatic(row, chapter, ctx, parentSignature) {
  if (row.depth === 0) return tier("unreviewed", "", { source: "chapter-summary" });
  if (row.scope === "documentation" || row.scope === "configuration")
    return tier("not-applicable", "", { source: row.scope });
  const feature = featureOf(row, ctx.staticFeatures, parentSignature);
  if (feature)
    return tier(feature.status, "", {
      source:
        feature.status === "by-design"
          ? `compiler-chapter-policy:${feature.policy}`
          : `compiler-feature:${row.chapter}.${row.apiSymbol}`,
      tests: feature.evidence,
    });
  for (const candidate of symbolCandidates(row)) {
    // Dedicated lowering paths are authoritative when an older generic
    // fence row shares the same API name (the surface manifest documents
    // its omissions explicitly; this overlay closes them with evidence).
    const dedicated = ctx.dedicated.get(candidate);
    if (dedicated)
      return tier(dedicated.status, "", {
        source: `compiler-dedicated:${candidate}`,
        tests: dedicated.evidence,
      });
  }
  for (const candidate of manifestSymbolCandidates(row)) {
    const item = ctx.manifest.get(candidate);
    if (item) {
      if (item.status === "static") {
        const tests = firstEvidenceForManifestId(item.id, ctx.compilerCompat);
        if (tests.length === 0) return tier("unreviewed", "");
        validateEvidence(tests, item.id);
        return tier("partial", "", { source: `surface-manifest:${item.id}`, tests });
      }
      return tier("refused", "", { source: `surface-manifest:${item.status}:${item.id}` });
    }
  }
  const policy = ctx.compilerCompat.chapterPolicies[row.chapter];
  if (policy && policy !== "unreviewed") {
    return tier(policy, "", { source: `compiler-chapter-policy:${row.chapter}` });
  }
  if (
    (pin.chapterModules[row.chapter] ?? []).length > 0 ||
    row.chapter === "globals" ||
    row.chapter === "errors"
  ) {
    return tier("not-implemented", "", { source: `compiler-unmatched:${row.chapter}` });
  }
  return tier("unreviewed", "");
}

function treeSize(node) {
  let size = 1;
  for (const field of CHILD_FIELDS) for (const child of node[field] ?? []) size += treeSize(child);
  return size;
}

function topLevelNodes(allJson) {
  const result = [];
  for (const field of CHILD_FIELDS) for (const node of allJson[field] ?? []) result.push(node);
  return result;
}

function flattenChapter(rootNode, chapter, ctx) {
  const rows = [];
  const seenIds = new Map();
  const anchorCounters = new Map();
  const walk = (node, parents, depth, inheritedStability) => {
    const signature = `${chapter.slug}\0${node.type}\0${parents.map((parent) => parent.name).join("/")}\0${node.name}\0${node.textRaw}`;
    const baseId = `${chapter.slug}:${sha(signature).slice(0, 12)}`;
    const duplicate = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, duplicate + 1);
    const id = duplicate === 0 ? baseId : `${baseId}:${duplicate + 1}`;
    const apiSymbol = apiSymbolOf(node);
    const stability = nodeStability(node, inheritedStability);
    // Count every structured heading, including the chapter root, in the
    // same preorder Node's Markdown renderer visits.
    const generatedAnchor = nodeAnchor(node.textRaw, anchorCounters);
    const row = {
      id,
      chapter: chapter.slug,
      kind: node.type ?? "section",
      name: node.name ?? node.textRaw ?? "(unnamed)",
      signature: node.textRaw ?? node.name ?? "(unnamed)",
      label: displayLabel(node.textRaw ?? node.name ?? "(unnamed)"),
      apiSymbol,
      depth,
      scope: "api",
      anchor: depth > 0 ? generatedAnchor : "",
      nodeStability: stability,
    };
    row.scope = scopeOf(row);
    const parentSignature = parents.at(-1)?.textRaw ?? parents.at(-1)?.name;
    row.static = classifyStatic(row, chapter, ctx, parentSignature);
    rows.push(row);
    for (const field of CHILD_FIELDS) {
      for (const child of node[field] ?? []) walk(child, [...parents, node], depth + 1, stability);
    }
  };
  walk(rootNode, [], 0, null);
  return rows;
}

function apiChapterLinks(indexMarkdown) {
  const links = [...indexMarkdown.matchAll(/^\* \[(.+?)\]\(([^)]+\.md)\)$/gm)].map((match) => ({
    title: match[1].replaceAll("`", ""),
    file: match[2],
    slug: match[2].slice(0, -3),
  }));
  return links.filter((link) => !NON_FUNCTIONAL_CHAPTERS.has(link.slug));
}

function summarizeTier(rows, key, chapterPolicy) {
  const descendants = rows
    .slice(1)
    .filter((row) => row.scope === "api")
    .map((row) => row[key]);
  const statuses = new Set(descendants.map((tier) => tier.status));
  const tests = [...new Set(descendants.flatMap((tier) => tier.tests ?? []))].sort();
  if (statuses.size === 0 && chapterPolicy) {
    return tier(chapterPolicy, "", {
      source: `compiler-chapter-policy:${rows[0].chapter}`,
    });
  }
  if (statuses.size === 1)
    return tier([...statuses][0], "", { source: "derived:descendants", tests });
  if (statuses.has("supported") || statuses.has("partial")) {
    return tier("partial", "", { source: "derived:descendants", tests });
  }
  if (statuses.has("unreviewed")) return tier("unreviewed", "", { source: "derived:descendants" });
  if (statuses.has("not-implemented"))
    return tier("not-implemented", "", { source: "derived:descendants" });
  if (statuses.has("refused")) return tier("refused", "", { source: "derived:descendants" });
  if (statuses.has("by-design")) return tier("by-design", "", { source: "derived:descendants" });
  // A chapter with island-served descendants and no other claim still is not
  // a native-support claim; keep the conservative statuses above it.
  if (statuses.has("island-served"))
    return tier("island-served", "", { source: "derived:descendants", tests });
  return tier("unreviewed", "", { source: "derived:descendants" });
}

function verifiedAnchorIds(html) {
  return new Set(
    [...html.matchAll(/<a class="mark" href="#[^"]+" id="([^"]+)">#/g)].map((match) => match[1]),
  );
}

function verifyAnchors(snapshot, htmlByChapter) {
  let verified = 0;
  let ancestorFallback = 0;
  let chapterFallback = 0;
  const ancestors = [];
  for (const row of snapshot.rows) {
    if (row.depth === 0) {
      ancestors.length = 0;
      ancestors[0] = row;
      row.anchorSource = "chapter";
      continue;
    }
    ancestors.length = row.depth;
    const ids = htmlByChapter.get(row.chapter);
    if (ids?.has(row.anchor)) {
      verified += 1;
      row.anchorSource = "exact";
    } else {
      const ancestor = [...ancestors]
        .reverse()
        .find((candidate) => candidate?.anchorSource === "exact" && candidate.anchor !== "");
      if (ancestor) {
        row.anchor = ancestor.anchor;
        row.anchorSource = "ancestor";
        ancestorFallback += 1;
      } else {
        // A chapter link is useful and correct; an invented fragment is not.
        row.anchor = "";
        row.anchorSource = "chapter";
        chapterFallback += 1;
      }
    }
    ancestors[row.depth] = row;
  }
  snapshot.anchors = { verified, ancestorFallback, chapterFallback };
}

/** Node documents its globals twice: in the globals chapter and in the
 * chapter of the module that owns them (`URLSearchParams` in url,
 * `__dirname` in modules). The two rows describe one API, so a snapshot in
 * which one is claimed and the other fell through unmatched is a mapping
 * defect, not a fact. A deliberate difference stays expressible: classify
 * both rows explicitly (a `features` entry can declare or verify a gap). */
function assertGlobalTwinsAgree(snapshot) {
  const unmatched = (row) => (row.static.evidence ?? "").startsWith("compiler-unmatched:");
  const claimed = (row) => row.static.status === "supported" || row.static.status === "partial";
  const direct = (row) => row.depth === 1 && row.scope === "api" && row.apiSymbol !== "";
  // The owning chapter may nest the class under a heading (webstreams lists
  // its classes under "API"), so a class row owns its global at any depth.
  const owner = (row) => direct(row) || (row.kind === "class" && row.scope === "api");
  const owners = new Map();
  for (const row of snapshot.rows) {
    if (!owner(row) || row.apiSymbol === "" || row.chapter === "globals") continue;
    const rows = owners.get(row.apiSymbol) ?? [];
    rows.push(row);
    owners.set(row.apiSymbol, rows);
  }
  const disagreements = [];
  for (const row of snapshot.rows) {
    if (!direct(row) || row.chapter !== "globals") continue;
    for (const owner of owners.get(row.apiSymbol) ?? []) {
      if ((unmatched(row) && claimed(owner)) || (claimed(row) && unmatched(owner))) {
        disagreements.push(
          `globals '${row.apiSymbol}' is ${row.static.status}, ${owner.chapter} '${owner.apiSymbol}' is ${owner.static.status}`,
        );
      }
    }
  }
  if (disagreements.length > 0) {
    throw new Error(
      `a global and the chapter that owns it disagree; map both rows in static-support.json, or classify the difference explicitly:\n  ${disagreements.join("\n  ")}`,
    );
  }
}

function buildSnapshot({ allJson, indexMarkdown, allSha256, indexSha256 }) {
  const chapterLinks = apiChapterLinks(indexMarkdown);
  const top = topLevelNodes(allJson);
  const ctx = classificationContext();
  const chapters = [];
  const rows = [];

  if (chapterLinks.length === 0)
    throw new Error("the pinned Node index contains no functional API chapters");

  for (const link of chapterLinks) {
    const source = `doc/api/${link.file}`;
    const candidates = top
      .filter((node) => node.source === source)
      .sort((a, b) => treeSize(b) - treeSize(a));
    if (candidates.length === 0) throw new Error(`all.json has no root for ${source}`);
    const chapter = { slug: link.slug, title: link.title };
    const chapterRows = flattenChapter(candidates[0], chapter, ctx);
    chapterRows[0].static = summarizeTier(
      chapterRows,
      "static",
      ctx.compilerCompat.chapterPolicies[link.slug],
    );
    chapters.push({
      slug: link.slug,
      title: link.title,
      entries: chapterRows.length,
      apiEntries: chapterRows.filter((row) => row.scope === "api").length,
    });
    rows.push(...chapterRows);
  }

  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`duplicate generated row id ${row.id}`);
    ids.add(row.id);
  }
  assertGlobalTwinsAgree({ rows });
  return {
    schemaVersion: 5,
    nodeVersion: pin.version,
    nodeTag: pin.tag,
    nodeCommit: pin.commit,
    sources: {
      allJson: { url: pin.allJsonUrl, sha256: allSha256 },
      indexMarkdown: { url: pin.indexMarkdownUrl, sha256: indexSha256 },
      sourceBaseUrl: pin.sourceBaseUrl,
    },
    supportManifests: {
      compilerSurface: "packages/compiler/surface-manifest.json",
      compilerDedicated: "internal/compatibility/static-support.json",
    },
    chapters,
    rows,
  };
}

function render(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function refusalsRendered(snapshot) {
  return renderRefusals(
    buildRefusals(snapshot, { chapterModules: pin.chapterModules, compilerVersion }),
  );
}

function writeRefusals(snapshot) {
  const rendered = refusalsRendered(snapshot);
  writeFileSync(refusalsOutputPath, rendered);
  writeFileSync(publishedRefusalsPath, rendered);
}

function publicDetail(tier) {
  const source = tier.evidence ?? "";
  if (source === "derived:descendants") return "Derived from the exact API rows in this chapter.";
  if (tier.status === "island-served")
    return "Answered by a Node island in an island build, not by native code; a build without islands keeps the refusal. This is not native support.";
  if (tier.status === "unreviewed") return "Not yet classified; tracked as open parity work.";
  if (source.startsWith("surface-manifest:unsupported:"))
    return "Explicitly rejected by a named compiler diagnostic.";
  if (
    /^surface-manifest:node-builtin\.fs\.(?:statfsSync|promises\.statfs)$/.test(source) ||
    source === "compiler-feature:fs.fs.statfs"
  ) {
    return "Reads filesystem capacity using string, Buffer, or file URL paths with number or BigInt fields and deferred callbacks; StatFs prototype behavior and complete filesystem error metadata remain unsupported.";
  }
  if (source === "surface-manifest:node-builtin.util.inherits") {
    return "Links constructor-function prototypes and sets super_, with Node's argument errors; class constructors are refused.";
  }
  if (source === "surface-manifest:node-builtin.util.deprecate") {
    return "Warns once per code or wrapper on the next tick, forwards receivers, arguments, and construction, and observes process.noDeprecation and process.throwDeprecation; class constructors are refused.";
  }
  if (source === "surface-manifest:node-builtin.util.callbackify") {
    return "Calls back on the next tick with results, rejection reasons, and ERR_FALSY_VALUE_REJECTION, forwarding receivers; typed callbacks must accept a null error.";
  }
  if (/^surface-manifest:node-builtin\.util\.debug(?:log)?$/.test(source)) {
    return "Matches sections against NODE_DEBUG as the process started and writes formatted SECTION PID lines to stderr; colored object output and %o over objects are refused.";
  }
  if (/^surface-manifest:node-builtin\.crypto\.create(?:Cipheriv|Decipheriv)$/.test(source)) {
    return "Supports aes-128/192/256 in cbc, ctr, gcm, ccm, ecb, cfb, cfb8, cfb1, ofb, and key-wrap modes, des-ede3 and des-ede, chacha20, and chacha20-poly1305 with Node's argument, IV, tag-length, key, and encoding errors; other OpenSSL ciphers are refused.";
  }
  if (/^surface-manifest:node-builtin\.crypto\.createECDH$/.test(source)) {
    return "Supports prime192v1, secp224r1, prime256v1, secp384r1, secp521r1, secp192k1, secp224k1, secp256k1, brainpoolP256r1, brainpoolP384r1 and brainpoolP512r1 with Node's curve, key, point, format and encoding errors; other curves Node knows are refused.";
  }
  if (
    /^surface-manifest:node-builtin\.crypto\.(?:createDiffieHellman|createDiffieHellmanGroup|getDiffieHellman)$/.test(
      source,
    )
  ) {
    return "Supports the modp groups, explicit primes and generators, and generated safe primes up to 8192 bits with Node's argument, generator and modulus errors.";
  }
  if (source.startsWith("surface-manifest:"))
    return "Implemented for the call shapes accepted by the compiler lowering.";
  if (/^compiler-dedicated:assert\.doesNot(?:Throw|Reject)$/.test(source)) {
    return "Supports callbacks or native promises with messages, Error classes, regular expressions, and validators accepting unknown values; object expectations and complete AssertionError metadata remain unsupported.";
  }
  if (/^compiler-dedicated:(?:ECDH|ecdh\.)/.test(source)) {
    return "Matches Node's key formats, point encodings, private-key range checks, key-pair checks and errors on the supported curves; ECDH.convertKey is supported, and property reads and writes are refused.";
  }
  if (/^compiler-dedicated:(?:DiffieHellman|diffieHellman\.)/.test(source)) {
    return "Matches Node's private key lengths, DH_check results, public key range checks, secret padding and errors; primes longer than 8192 bits, property writes and property reads other than verifyError are refused.";
  }
  if (/^compiler-dedicated:(?:Cipheriv|Decipheriv|cipher\.|decipher\.)/.test(source)) {
    return "Matches Node's update() output lengths, padding, authentication tags, AAD and key forms (including KeyObject and CryptoKey keys), string encodings, and state errors for the supported ciphers, and its stream.Transform behavior: chunks written through update(), final() pushed at the end, and its errors reported through 'error'.";
  }
  if (source.startsWith("compiler-dedicated:"))
    return "Implemented by a dedicated static compiler/runtime path.";
  if (source.startsWith("compiler-feature:")) {
    if (source === "compiler-feature:fs.fs.StatFs") {
      return "Capacity snapshots expose seven mutable number or BigInt fields; StatFs prototype reflection and constructor behavior remain unsupported.";
    }
    if (/^compiler-feature:fs\.(?:type|bsize|blocks|bfree|bavail|files|ffree)$/.test(source)) {
      return "Filesystem-capacity fields preserve unsigned platform values as numbers or BigInts.";
    }
    if (/^compiler-feature:fs\.fs\.(?:link|symlink|readlink)$/.test(source)) {
      return "Creates hard or symbolic links and reads link targets using string, Buffer, or file URL paths, with encoded results and deferred error-first callbacks; complete filesystem error metadata remains unsupported.";
    }
    if (
      /^compiler-feature:fs\.(?:fs\.(?:utimes|futimes|lutimes)|filehandle\.utimes)$/.test(source)
    ) {
      return "Changes timestamps using numeric seconds, numeric strings, and Dates with tested argument validation; link variants update the symlink itself.";
    }
    if (/^compiler-feature:fs\.fs\.(?:exists|existsSync)$/.test(source)) {
      return "Answers path existence for strings, Buffers, and file URLs; a path getValidatedPath rejects answers false, the deprecated exists validates its callback first and answers a rejected path through the callback synchronously, and existsSync reports DEP0187 once for invalid argument types.";
    }
    if (/^compiler-feature:fs\.dir(?:\.|$)/.test(source)) {
      return "Opens a directory as a Dir and walks it one Dirent at a time, with read, readSync, close, closeSync, path, disposal, and for-await iteration; a closed Dir reports ERR_DIR_CLOSED and a synchronous member used while an asynchronous operation is outstanding reports ERR_DIR_CONCURRENT_OPERATION.";
    }
    if (source.startsWith("compiler-feature:fs.dirent.")) {
      return "Classifies each entry as a file, directory, symbolic link, FIFO, socket, block device, or character device from the directory handle's entry metadata.";
    }
    if (source === "compiler-feature:fs.constants") {
      return "Exposes the platform's open flags, file-type bits, and permission bits as read-only members of a null-prototype object.";
    }
    if (/^compiler-feature:errors\.ERR_DIR_(?:CLOSED|CONCURRENT_OPERATION)$/.test(source)) {
      return "Reports a closed Dir or a synchronous member used during an asynchronous operation as an Error with Node's name, code, and message.";
    }
    if (/^compiler-feature:buffer\.buffer\.(?:isAscii|isUtf8)$/.test(source)) {
      return "Validates bytes in ArrayBuffer and typed-array views with Node-compatible argument errors.";
    }
    if (source === "compiler-feature:buffer.buffer.transcode") {
      return "Converts Buffer and Uint8Array inputs among ASCII, Latin-1, UTF-8, and UTF-16LE, including encoding aliases and conversion errors.";
    }
    if (source === "compiler-feature:util.textEncoder.encodeInto") {
      return "Writes complete UTF-8 characters into Uint8Array or Buffer views and reports UTF-16 units read and bytes written.";
    }
    if (/^compiler-feature:util\.(?:encoding|fatal|ignoreBOM)$/.test(source)) {
      return "Codec properties expose the canonical encoding and decoder flags.";
    }
    if (/^compiler-feature:process\.process\.hrtime(?:\.bigint)?$/.test(source)) {
      return "Native monotonic clock supports tuple and bigint results, including stored JavaScript callable values.";
    }
    if (source === "compiler-feature:errors.stackTraceLimit") {
      return "Numeric limits control the frames captured by newly created native errors.";
    }
    if (source === "compiler-feature:errors.stack") {
      return "Native errors capture synchronous source frames; V8 stack customization and async stack stitching remain unsupported.";
    }
    if (
      source === "compiler-feature:errors.ERR_BUFFER_TOO_LARGE" ||
      source === "compiler-feature:errors.ERR_TRAILING_JUNK_AFTER_STREAM_END"
    ) {
      return "zlib raises these with Node's message, code and errno when maxOutputLength is exhausted and when rejectGarbageAfterEnd finds bytes after the stream end, in the sync, callback and promisified one-shots and the stream classes.";
    }
    if (source === "compiler-feature:errors.ERR_ZLIB_INITIALIZATION_FAILED") {
      return "zstd raises this with Node's message when a known parameter belongs to the other direction, when a compressor receives a decompression parameter or a decompressor a compression parameter, in the sync, callback and promisified one-shots and the stream classes; the zlib and Brotli constructors report the same code if their engine initialization fails.";
    }
    if (source === "compiler-feature:process.allowedNodeEnvironmentFlags") {
      return "One stable set answers the compatibility target's NODE_OPTIONS flag names for exact spellings; Node's Set subclass also accepts undashed, underscored, and =value spellings in has(), and its add, delete, and clear do nothing.";
    }
    if (
      /^compiler-feature:process\.process\.(?:setuid|seteuid|setgid|setegid|setgroups|initgroups)$/.test(
        source,
      )
    ) {
      return "Validates ids as Node does (a uint32 number or a name string), throws ERR_UNKNOWN_CREDENTIAL for names that do not resolve, and answers the kernel's ErrnoException when the change is refused; the members are absent on Windows, as in Node.";
    }
    if (
      /^compiler-feature:process\.process\.(?:hasUncaughtExceptionCaptureCallback|setUncaughtExceptionCaptureCallback)$/.test(
        source,
      )
    ) {
      return "The capture callback is stored once per process, still runs uncaughtExceptionMonitor first, takes precedence over uncaughtException listeners, and a second callback throws ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET.";
    }
    if (/^compiler-feature:process\.process\.(?:ref|unref)$/.test(source)) {
      return "Reads the nodejs.ref / nodejs.unref symbol on the argument (running its getter), falls back to the ref / unref member, and calls a callable result with the argument as receiver; null, undefined, primitives and non-callable members are no-ops.";
    }
    if (source === "compiler-feature:process.debugPort") {
      return "Starts at 9229; a write converts with ToInt32, accepts 0 or 1024 to 65535, and throws ERR_OUT_OF_RANGE while keeping the previous value otherwise.";
    }
    if (source === "compiler-feature:process.sourceMapsEnabled") {
      return "Reads as a boolean, false until setSourceMapsEnabled stores a validated boolean; other values throw ERR_INVALID_ARG_TYPE and leave the flag unchanged.";
    }
    if (/^compiler-feature:process\.std(?:in|out|err)$/.test(source)) {
      return "Stored JavaScript process streams support native input listeners, pause/resume and buffered reads, synchronous output writes, and output write replacement; other stream operations remain unsupported.";
    }
    if (
      /^compiler-feature:zlib\.(?:compress|decompress)(?:Brotli|Deflate|Gzip|Zstd)(?:Sync)?$/.test(
        source,
      )
    ) {
      return "Outside the static execution model: Node registers the node:zlib/iter module only under --experimental-stream-iter (without the flag the import throws ERR_UNKNOWN_BUILTIN_MODULE), the helpers return node:stream/iter duplexes, and a compiled scriptc binary takes no Node command-line flags.";
    }
    if (source === "compiler-feature:zlib.Options") {
      return "Options are validated with Node's rules for flush, finishFlush, chunkSize, windowBits, level, memLevel, strategy, dictionary, maxOutputLength and rejectGarbageAfterEnd, including the chunkSize output buffer's size limit and allocation-failure report; a literal info: true in a convenience method's options answers Node's { buffer, engine } result.";
    }
    if (
      /^compiler-feature:zlib\.(?:zlib\.(?:Deflate|Inflate|Gzip|Gunzip|DeflateRaw|InflateRaw|Unzip|ZlibBase|close|flush|params|reset)|bytesWritten)$/.test(
        source,
      )
    ) {
      return "Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, and Unzip are Transform streams with Node's output chunking, flush, params, reset, error codes, and option validation.";
    }
    if (
      /^compiler-feature:zlib\.zlib\.(?:deflate|deflateSync|inflate|inflateSync|deflateRaw|deflateRawSync|inflateRaw|inflateRawSync|gzip|gzipSync|gunzip|gunzipSync|unzip|unzipSync|crc32|create(?:Deflate|Inflate|DeflateRaw|InflateRaw|Gzip|Gunzip|Unzip))$/.test(
        source,
      )
    ) {
      return "The zlib one-shot compressors and decompressors take strings, Buffers, TypedArrays, DataViews and ArrayBuffers, validate options with Node's rules and return Buffers; a literal info: true answers Node's { buffer, engine } result in the sync, callback and promisified forms, the callback forms settle on the worker pool, and crc32 validates its uint32 seed.";
    }
    if (
      /^compiler-feature:zlib\.zlib\.(?:brotliCompress|brotliCompressSync|brotliDecompress|brotliDecompressSync|createBrotliCompress|createBrotliDecompress)$/.test(
        source,
      )
    ) {
      return "The Brotli one-shots take strings, Buffers, TypedArrays, DataViews and ArrayBuffers, apply every BROTLI_PARAM_* and BROTLI_DECODER_PARAM_* parameter with Node's errors and return Buffers; a literal info: true answers Node's { buffer, engine } result, and the callback forms settle on the worker pool.";
    }
    if (
      /^compiler-feature:zlib\.zlib\.(?:zstdCompress|zstdCompressSync|zstdDecompress|zstdDecompressSync|createZstdCompress|createZstdDecompress)$/.test(
        source,
      )
    ) {
      return "The zstd one-shots take strings, Buffers, TypedArrays, DataViews and ArrayBuffers, apply ZSTD_c_* and ZSTD_d_* parameters, dictionaries and pledged source sizes with Node's errors, and return Buffers; a literal info: true answers Node's { buffer, engine } result, and the callback forms settle on the worker pool.";
    }
    if (source === "compiler-feature:zlib.BrotliOptions") {
      return "Brotli options validate with Node's rules: chunkSize at least 64, flush and finishFlush from 0 to 3, maxOutputLength, a params object whose keys must name a parameter Brotli accepts with number or boolean values, and dictionary as any byte input; unknown option keys are ignored, and a literal info: true answers the one-shots' { buffer, engine }.";
    }
    if (source === "compiler-feature:zlib.ZstdOptions") {
      return "zstd options validate with Node's rules: chunkSize at least 64, flush and finishFlush from 0 to 2, maxOutputLength, a params object whose keys must name a parameter zstd accepts with number or boolean values, dictionary as any byte input, and pledgedSrcSize; unknown option keys are ignored, and a literal info: true answers the one-shots' { buffer, engine }.";
    }
    if (/^compiler-feature:zlib\.zlib\.(?:BrotliCompress|BrotliDecompress)$/.test(source)) {
      return "BrotliCompress and BrotliDecompress are Transform streams over the brotli version Node bundles, with Node's parameters, dictionaries, flush, reset, error codes, and option validation; like Node's, they have no params(), and their one-shots' literal info: true answers { buffer, engine }.";
    }
    if (/^compiler-feature:zlib\.zlib\.(?:ZstdCompress|ZstdDecompress)$/.test(source)) {
      return "ZstdCompress and ZstdDecompress are Transform streams over the zstd version Node bundles, with Node's parameters, dictionaries, pledged source sizes, flush kinds 0 to 2, reset, error codes, and option validation; like Node's, they have no params(), and their one-shots' literal info: true answers { buffer, engine }.";
    }
    if (source === "compiler-feature:zlib.zlib.constants") {
      return "Each zlib.constants member and its module-level copy reads as Node's value, and the constants object itself is one runtime value whose keys, key order and identity match Node's.";
    }
    if (source === "compiler-feature:crypto.constants") {
      return "Each crypto.constants member and its module-level copy reads as Node's value, and the constants object itself is one runtime value whose keys, key order and identity match Node's.";
    }
    if (
      /^compiler-feature:crypto\.(?:Certificate|certificate\.(?:exportChallenge|exportPublicKey|verifySpkac))$/.test(
        source,
      )
    ) {
      return "Reads the base64 SPKAC text a Netscape spkac file holds, as a string or its bytes, with leading space and tab and trailing whitespace and dashes trimmed; verifies RSA signatures, exports the challenge as UTF-8 and the public key as a PEM Buffer, and answers an empty Buffer (verifySpkac false) for text no spkac decoder accepts, where Node answers an empty string.";
    }
    if (source === "compiler-feature:url.URL") {
      return "Supports absolute inputs and relative inputs with string or URL bases; setters and some WHATWG parsing behavior remain unsupported.";
    }
    if (source === "compiler-feature:util.util.getSystemErrorMap") {
      return "Returns a fresh Map of platform-specific error codes, names, and messages; entry tuples support updates but retain their fixed size.";
    }
    if (source === "compiler-feature:util.util.stripVTControlCharacters") {
      return "Removes ANSI control sequences with the Node matcher and validates common non-string argument forms.";
    }
    if (source === "compiler-feature:util.util.toUSVString") {
      return "Converts native strings, primitives, and tested object conversion hooks to well-formed Unicode strings, replacing unpaired surrogates with U+FFFD.";
    }
    if (source.startsWith("compiler-feature:util.util.types.")) {
      return "Checks existing native runtime brands without inspecting public properties, with stored function values and tested predicate narrowing; unrepresented object forms retain compiler boundaries.";
    }
    if (source === "compiler-feature:util.util.styleText") {
      return "Applies standard styles and aliases, nested ANSI resets, explicit color enabling, and standard process streams; custom native streams and inspect color-table mutation remain unsupported.";
    }
    if (source === "compiler-feature:util.util.isDeepStrictEqual") {
      return "Compares primitives, ordinary records and arrays, cycles, enumerable properties, and byte views with optional prototype skipping; opaque native objects and accessor properties remain refused.";
    }
    if (/^compiler-feature:util\.util\.getSystemError(?:Name|Message)$/.test(source)) {
      return "Converts platform-specific negative error codes to names or messages, with Node-compatible validation for common argument forms.";
    }
    if (source === "compiler-feature:url.url.fileURLToPathBuffer") {
      return "Converts file URLs to raw path bytes with POSIX or Windows options, preserving invalid UTF-8 and malformed escapes; internationalized hostnames remain unsupported.";
    }
    if (/^compiler-feature:url\.url\.(?:fileURLToPath|pathToFileURL)$/.test(source)) {
      return "Supports file-path conversion with POSIX or Windows options for the tested string and URL forms; internationalized hostnames remain unsupported.";
    }
    if (
      /^compiler-feature:(?:globals\.Text(?:Encoder|Decoder)|util\.(?:util\.Text(?:Encoder|Decoder)|text(?:Encoder\.encode|Decoder\.decode)))$/.test(
        source,
      )
    ) {
      return "Native codec values support UTF-8 encoding and whole-buffer decoding with recognized literal labels and default options.";
    }
    if (/^compiler-feature:(?:globals|webstreams)\.Text(?:Encoder|Decoder)Stream$/.test(source)) {
      return "Implemented in JavaScript sources, where the class is a checked-dynamic constructor value; a typed TypeScript use is refused by name.";
    }
    if (source === "compiler-feature:globals.Headers") {
      return "Constructs from records, header pairs and copies, and supports append/delete/get/getSetCookie/has/set/forEach with Node's coercion and error shapes, including Response and Request headers; typed iteration and method extraction remain refused.";
    }
    if (source === "compiler-feature:util.debuglog") {
      return "The enabled getter tests the section on first read; the callback receives the section's implementation with its own enabled getter.";
    }
    if (
      source === "compiler-feature:process.process.emitWarning" ||
      source === "compiler-feature:process.'warning'"
    ) {
      return "Emits string and Error warnings with types, codes, and details on the next tick, reporting to stderr before the 'warning' listeners run.";
    }
    if (source === "compiler-feature:process.'exit'") {
      return "Runs the exit listeners in registration order when the program ends, passing the status it is leaving with; a listener that assigns process.exitCode selects the final status.";
    }
    if (
      source === "compiler-feature:process.'uncaughtExceptionMonitor'" ||
      source === "compiler-feature:process.'uncaughtException'"
    ) {
      return "An uncaught exception runs the monitor listeners first and then the uncaughtException listeners that keep the program alive; with no listener the error is reported and the program exits nonzero.";
    }
    if (source === "compiler-feature:process.'unhandledRejection'") {
      return "An unhandled promise rejection reaches the listeners with the rejection value and the promise once the microtask queue drains, before the program's remaining work continues.";
    }
    if (source === "compiler-feature:process.SIGINT, SIGHUP, etc.") {
      return "Signal listeners keep the event loop alive and receive the signal's name and number; process.kill sends by name or number, and an unknown name throws ERR_UNKNOWN_SIGNAL.";
    }
    if (
      source === "compiler-feature:process.process.send" ||
      source === "compiler-feature:process.process.disconnect" ||
      source === "compiler-feature:process.connected" ||
      source === "compiler-feature:process.'message'" ||
      source === "compiler-feature:process.'disconnect'"
    ) {
      return "A forked child's IPC channel answers process.send with its delivery result and callback error, reports process.connected around process.disconnect(), and delivers the 'message' and 'disconnect' events.";
    }
    if (source === "compiler-feature:process.getBuiltinModule") {
      return "Returns the same builtin namespace object as a node: import for a builtin name, undefined for a name that is not builtin, and ERR_INVALID_ARG_TYPE for a non-string id.";
    }
    if (source === "compiler-feature:process.loadEnvFile") {
      return "Parses a dotenv file into process.env with plain, quoted and export-prefixed assignments and no variable expansion; a missing file answers ENOENT and a non-string path ERR_INVALID_ARG_TYPE.";
    }
    if (source === "compiler-feature:process.'beforeExit'") {
      return "Runs the 'beforeExit' listeners each time the loop runs out of ref'd work, passing the code the process would exit with, and re-emits while a listener schedules ref'd work; an exit code set in a listener is the one a later emission and the process exit see.";
    }
    if (source === "compiler-feature:process.'multipleResolves'") {
      return "A promise settled a second time reports its type, promise and value to the 'multipleResolves' listeners on the nextTick queued at that settle, warning DEP0160 once per process when a delivery reaches a listener.";
    }
    if (source === "compiler-feature:process.'rejectionHandled'") {
      return "A promise whose rejection was already reported reaches the 'rejectionHandled' listeners once with the promise when a handler is attached afterward.";
    }
    if (
      source === "compiler-feature:process.channel" ||
      source === "compiler-feature:process.process.channel.ref" ||
      source === "compiler-feature:process.process.channel.unref"
    ) {
      return "A forked child's process.channel is the channel object while connected, undefined when the process never had one, and null after process.disconnect(); ref() and unref() return undefined, and unref() lets the child exit with the channel open.";
    }
    if (/^compiler-feature:process\.(?:no|throw)Deprecation$/.test(source)) {
      return "Program assignments silence or throw deprecation warnings; compiled binaries take no Node command-line flags.";
    }
    if (source === "compiler-feature:console.console.trace")
      return "Prints Node's Trace heading (Trace, or Trace: <formatted message>) and the frames below the call site; V8's module-loader frames have no native counterpart.";
    if (/^compiler-feature:console\.console\.(?:log|info|debug|error|warn)$/.test(source))
      return "Formats arguments with Node's util.format and writes them to stdout (log, info, debug) or stderr (error, warn), honoring a program's replacement of process.stdout.write or process.stderr.write.";
    if (source === "compiler-feature:console.console.assert")
      return "Writes Node's Assertion failed line to stderr only for a falsy value, with the remaining arguments formatted after it.";
    if (/^compiler-feature:console\.console\.(?:count|countReset)$/.test(source))
      return "Keeps per-label counters and prints Node's label: count lines, reporting a missing label with Node's warning text.";
    if (/^compiler-feature:console\.console\.(?:group|groupCollapsed|groupEnd)$/.test(source))
      return "Prints group labels like log and indents the following output by two spaces per open group, including after embedded newlines.";
    if (/^compiler-feature:console\.console\.(?:dir|dirxml)$/.test(source))
      return "dir inspects one value with its options resolved at compile time (custom inspection off by default); dirxml prints its arguments the way log does.";
    if (source === "compiler-feature:console.console.table")
      return "Renders arrays of records and plain objects as Node's bordered table, with the tested headers and index column.";
    if (/^compiler-feature:console\.console\.time(?:End|Log)?$/.test(source))
      return "Times each label on the native monotonic clock and prints Node's label: <duration> lines, with Node's warning for a duplicate or missing label.";
    if (/^compiler-feature:console\.console\.(?:profile|profileEnd|timeStamp)$/.test(source))
      return "Accepts the inspector-only calls and their arguments; without an inspector session they write nothing, as in Node.";
    if (source === "compiler-feature:console.console.clear")
      return "Clears a terminal stdout the way Node does and writes nothing to a pipe or a dumb terminal.";
    if (source === "compiler-feature:console.Console") {
      return "Instances over process.stdout, process.stderr, or stream writables support log, info, debug, error, and warn with Node's ignoreErrors handling; other options and methods remain refused.";
    }
    if (/^compiler-feature:process\.process\.(?:exit)$/.test(source))
      return "Ends the program with the exit status setter's conversions: integer strings parse, null and undefined clear the status, and an out-of-range or wrong-typed value throws Node's error catchably while the program keeps running.";
    if (source === "compiler-feature:process.exitCode")
      return "The setter converts with Node's rules (integer strings, wrapping, null and undefined clearing) and reports an out-of-range number or a non-convertible value with Node's catchable error; the getter reads the stored value.";
    if (source === "compiler-feature:process.env")
      return "The process.env proxy converts values and computed keys with Node's rules, reads a symbol key as undefined, and ignores a symbol key on writes and deletes.";
    if (source === "compiler-feature:process.title")
      return "The setter converts its value to a string with Node's ToString and the getter returns the title last written.";
    if (source === "compiler-feature:process.process.kill")
      return "Sends numeric and named signals with Node's loose pid check, its argument coercions, and ERR_UNKNOWN_SIGNAL for an unknown name.";
    if (source === "compiler-feature:process.process.umask")
      return "Reads the mask and sets it from integers or octal strings with Node's uint32, octal-string and type errors.";
    if (/^compiler-feature:process\.process\.(?:cpuUsage|threadCpuUsage)$/.test(source))
      return "Samples process or thread CPU time and subtracts a validated previous record, reading each field again after the clock sample the way Node's returned object literal does.";
    if (/^compiler-feature:process\.process\.(?:cwd|chdir)$/.test(source))
      return "Reads and changes the working directory, with chdir's string-only validation and the platform's ENOENT and ENOTDIR failures.";
    if (
      /^compiler-feature:process\.process\.(?:memoryUsage(?:\.rss)?|resourceUsage|uptime|availableMemory|constrainedMemory)$/.test(
        source,
      )
    )
      return "Reports process memory, resource use, uptime and memory limits with Node's field shapes and ignored surplus arguments.";
    if (/^compiler-feature:process\.process\.get(?:uid|euid|gid|egid|groups)$/.test(source))
      return "Reads the process's user, group and supplementary group ids, ignoring surplus arguments.";
    if (source === "compiler-feature:process.process.getActiveResourcesInfo")
      return "Lists the loop resources the native runtime models as live handles (armed and firing Timeout, Immediate and tick callbacks); resources it does not model as handles are absent, as SEMANTICS.md records.";
    if (source === "compiler-feature:process.process.nextTick")
      return "Queues the callback ahead of timers, forwards extra arguments, and reports a non-function callback with Node's synchronous type error.";
    if (source.startsWith("compiler-feature:webstreams.streamConsumers.")) {
      return "Collects a Node Readable stream's chunks for the tested forms; web ReadableStreams and other async iterables remain unsupported.";
    }
    if (tier.status === "not-applicable")
      return "Node configuration or documentation that does not map to a compiled program API.";
    // The compat-*.mjs programs exercise a member from a JavaScript source. A TypeScript source
    // reaches only the members the declarations in use list, so the claim says which source proved it.
    if (
      (tier.status === "supported" || tier.status === "partial") &&
      (tier.tests?.length ?? 0) > 0 &&
      tier.tests.every((path) => /^tests\/corpus\/compat-[a-z0-9-]+\.mjs$/.test(path))
    )
      return "Exercised by a differential program written as a JavaScript module; a TypeScript source reaches the member only when the declarations in use list it.";
    // A row that names a compat-*.mjs program and its compat-*.ts twin was exercised from both
    // source languages; the claim is the call shapes the two programs use.
    if (
      (tier.status === "supported" || tier.status === "partial") &&
      (tier.tests?.length ?? 0) > 1 &&
      tier.tests.every((path) => /^tests\/corpus\/compat-[a-z0-9-]+\.(?:mjs|ts)$/.test(path)) &&
      tier.tests.some((path) => path.endsWith(".mjs")) &&
      tier.tests.some((path) => path.endsWith(".ts"))
    )
      return "Exercised by differential programs written as a JavaScript module and as a TypeScript source; the claim covers the call shapes they use.";
    if (tier.status === "not-implemented" && (tier.tests?.length ?? 0) > 0)
      return "Not implemented: a test pins the refusal a program using this API gets.";
    if (tier.status === "not-implemented")
      return "Not implemented in scriptc's static module-loader subset yet.";
    if (
      /^compiler-feature:stream\.stream\.(?:isDestroyed|isErrored|isDisturbed|isReadable|isWritable|Readable\.isDisturbed)$/.test(
        source,
      )
    ) {
      return "Answers for the node:stream classes and their subclasses in every lifecycle state, for the web stream classes, their readers and writers and a Response body, and for any other value by the state members Node's duck typing reads.";
    }
    if (
      /^compiler-feature:stream\.readable\.(?:map|filter|forEach|toArray|some|find|every|flatMap|drop|take|reduce)$/.test(
        source,
      )
    ) {
      return "Runs the operator over a readable's chunks with Node's concurrency, highWaterMark, signal and AbortSignal options, written inline or passed as a value, settling, rejecting and cleaning up as Node does.";
    }
    if (
      source.startsWith("compiler-feature:stream.") ||
      source.startsWith("compiler-feature:webstreams.")
    ) {
      return "Implemented for the documented static async-iteration subset.";
    }
    if (source.startsWith("compiler-feature:dns.")) {
      return "Answers A, AAAA, CAA, CNAME, MX, NAPTR, NS, PTR, SOA, SRV, TLSA, TXT and ANY queries and reverse lookups over UDP with the TCP retry, and Resolver instances carry Node's servers, options, cancellation and error codes.";
    }
    if (source.startsWith("compiler-feature:http.http.validateHeader")) {
      return "Static header validation is implemented for the tested call shapes.";
    }
    if (
      source.startsWith("compiler-feature:http.request.getHeader") ||
      source.startsWith("compiler-feature:http.request.getRawHeaderNames") ||
      source.startsWith("compiler-feature:http.request.hasHeader") ||
      source.startsWith("compiler-feature:http.request.removeHeader") ||
      source.startsWith("compiler-feature:http.request.setHeader") ||
      source.startsWith("compiler-feature:http.response.getHeader")
    ) {
      return "Static outgoing header reads and mutations support the tested string-value shapes.";
    }
    if (
      /^compiler-feature:http\.(?:path|method|host|protocol|listening|headersSent|writableEnded|complete|httpVersion|url|statusCode)$/.test(
        source,
      )
    ) {
      return "Static HTTP request metadata and message state support the tested lifecycle.";
    }
    if (/^compiler-feature:http\.response\.write(?:Continue|Processing|EarlyHints)$/.test(source)) {
      return "Static HTTP/1.1 informational responses support the tested no-callback forms; Early Hints accepts string-valued fields.";
    }
    if (
      /^compiler-feature:http\.(?:response\.setTimeout|connection|req|sendDate|socket|statusMessage|strictContentLength|writableFinished)$/.test(
        source,
      )
    ) {
      return "Static ServerResponse state, socket access, timeouts, and strict body length checks support the tested HTTP/1.1 forms.";
    }
    if (
      /^compiler-feature:http\.(?:headersDistinct|rawHeaders|rawTrailers|trailers|trailersDistinct)$/.test(
        source,
      )
    ) {
      return "Static IncomingMessage header and trailer reads support the tested HTTP/1.1 forms.";
    }
    if (source === "compiler-feature:crypto.crypto.createECDH") {
      return "Supports prime192v1, secp224r1, prime256v1, secp384r1, secp521r1, secp192k1, secp224k1, secp256k1, brainpoolP256r1, brainpoolP384r1 and brainpoolP512r1 with Node's curve, key, point, format and encoding errors; other curves Node knows are refused.";
    }
    if (
      /^compiler-feature:crypto\.crypto\.(?:createDiffieHellman|createDiffieHellmanGroup|getDiffieHellman)$/.test(
        source,
      )
    ) {
      return "Supports the modp groups, explicit primes and generators, and generated safe primes up to 8192 bits with Node's argument, generator and modulus errors.";
    }
    if (source === "compiler-feature:crypto.crypto.diffieHellman") {
      return "Derives the shared secret a private KeyObject and a public KeyObject agree on for the supported curves and X25519, in its synchronous and callback forms, with Node's key-type, curve and key checks.";
    }
    if (
      source === "compiler-feature:os.os.availableParallelism" ||
      /^compiler-feature:os\.(?:os\.(?:arch|endianness|freemem|hostname|loadavg|machine|platform|release|totalmem|type|uptime|version)|EOL|devNull)$/.test(
        source,
      )
    ) {
      return "Reads the host's platform, CPU, memory, load and uname facts with Node's values on the same machine, and its documented invariants where the value changes between processes.";
    }
    if (source === "compiler-feature:os.os.networkInterfaces") {
      return "Enumerates the network interfaces with Node's row shape, including the per-family fields, the MAC, the netmask-derived cidr and the IPv6 scopeid.";
    }
    if (source === "compiler-feature:os.constants") {
      return "Answers Node's null-prototype constant groups with the platform's signal, errno, priority, dlopen and libuv values.";
    }
    if (source === "compiler-feature:os.os.cpus") {
      return "Enumerates the host's logical CPUs with Node's model, speed, and times fields; JavaScript reads them through an intermediate binding too.";
    }
    if (
      source === "compiler-feature:os.os.getPriority" ||
      source === "compiler-feature:os.os.setPriority"
    ) {
      return "Reads and sets process scheduling priorities with Node's default pid, one-argument shift, range checks, and argument errors.";
    }
    if (source === "compiler-feature:os.os.userInfo") {
      return "Reads the passwd entry with Node's encoding options (Buffer and string encodings); an argument that is not an object answers the utf8 record.";
    }
    if (source === "compiler-feature:os.os.homedir" || source === "compiler-feature:os.os.tmpdir") {
      return "Reads the environment first (HOME, or Node's TMPDIR/TMP/TEMP cascade with its single trailing-slash trim) and falls back to the passwd entry or the platform default.";
    }
    if (/^compiler-feature:process\.(?:arch|platform|version)$/.test(source)) {
      return "Answers the compiled binary's architecture and platform in Node's own spellings, and process.version as `v` plus process.versions.node (the pinned compatibility release).";
    }
    if (source === "compiler-feature:process.versions") {
      return "One stable object whose node entry is the pinned compatibility release and whose openssl entry says crypto is available; build components a compiled binary does not link (v8, uv, modules and the rest) are absent, and entries the program defines itself persist.";
    }
    if (source === "compiler-feature:process.pid" || source === "compiler-feature:process.ppid") {
      return "Reads the operating system's process id, or its parent's, as a positive integer.";
    }
    if (source === "compiler-feature:process.release") {
      return "One stable object with the compatibility target's name, LTS line and download URLs, built from the same release process.versions.node reports.";
    }
    if (/^compiler-feature:process\.(?:argv|argv0|execPath|execArgv)$/.test(source)) {
      return "Reads the compiled binary's argument surface: argv keeps Node's positions in one mutable array, argv0 is the name the binary was invoked as, execPath its resolved path, and execArgv the runtime flags (empty for a compiled binary).";
    }
    if (source === "compiler-feature:process.fd") {
      return "Reads a standard stream's descriptor number: 0 for stdin, 1 for stdout and 2 for stderr.";
    }
    if (
      /^compiler-feature:process\.(?:cached_builtins|debug|inspector|ipv6|require_module|tls|tls_alpn|tls_ocsp|tls_sni|typescript|uv)$/.test(
        source,
      )
    ) {
      return "Answers what the compiled binary itself provides: inspector, uv, cached_builtins and tls_ocsp are false because it links no V8 inspector, libuv, builtin code cache or OCSP request, typescript is false because it cannot load TypeScript at run time, and ipv6, tls, tls_alpn, tls_sni, require_module and debug keep their Node values.";
    }
    return "Implemented for the documented scriptc module-loader subset.";
  }
  if (source.startsWith("compiler-chapter-policy:")) {
    if (tier.status === "by-design")
      return "Intentionally outside the static native execution model.";
    if (tier.status === "not-applicable")
      return "This Node executable or embedding feature does not map to static native code.";
    return "No static implementation exists for this Node API family yet.";
  }
  if (source.startsWith("compiler-unmatched:"))
    return "No static compiler lowering is registered for this API yet.";
  if (source === "documentation") return "Documentation section; not a runtime API.";
  if (source === "configuration")
    return "Node command-line or configuration entry; not a runtime API.";
  if (tier.status === "not-applicable")
    return "This Node executable or embedding feature does not map to this scriptc tier.";
  if (tier.status === "refused") return "Explicitly rejected by this scriptc tier.";
  if (tier.status === "not-implemented")
    return "No implementation is registered for this scriptc tier yet.";
  if (tier.status === "by-design")
    return "Intentionally outside this scriptc tier's execution model.";
  return "Implemented for a documented subset of this API.";
}

const PUBLIC_VERIFICATION = {
  "test-backed": {
    label: "Test-backed mapping",
    detail:
      "Mapped to implementation and relevant repository tests; evidence may cover an API family rather than every documented overload.",
  },
  "island-test-backed": {
    label: "Island test-backed mapping",
    detail:
      "In an island build, a Node island answers this API, and differential tests execute it under Node and as a compiled island binary; a build without islands keeps the refusal. This is not native support.",
  },
  "explicit-refusal": {
    label: "Explicit refusal",
    detail: "Backed by a named compiler refusal.",
  },
  "verified-absence": {
    label: "Verified absence",
    detail: "A test confirms that this API is absent: a program using it is refused by name.",
  },
  "declared-gap": {
    label: "Declared gap",
    detail:
      "The implementation-owned compatibility manifest explicitly records this API family or feature as not implemented.",
  },
  "registry-gap": {
    label: "Registry gap",
    detail:
      "No implementation registry entry matched this Node API; verify the gap before starting implementation.",
  },
  "architectural-policy": {
    label: "Architectural policy",
    detail:
      "An implementation-owned policy intentionally excludes this API from the execution tier.",
  },
  unreviewed: {
    label: "Unreviewed",
    detail: "No compatibility subsystem owns a reliable classification yet.",
  },
  "not-applicable": {
    label: "Not applicable",
    detail:
      "This entry is documentation, configuration, or an execution model that does not map to the tier.",
  },
  derived: {
    label: "Derived summary",
    detail: "Computed from the exact descendant API rows rather than asserted independently.",
  },
};

function verificationBasis(tier) {
  const source = tier.evidence ?? "";
  let basis;
  if (source === "derived:descendants") basis = "derived";
  else if (tier.status === "island-served") basis = "island-test-backed";
  else if (tier.status === "supported" || tier.status === "partial") basis = "test-backed";
  else if (tier.status === "refused") basis = "explicit-refusal";
  else if (tier.status === "by-design") basis = "architectural-policy";
  else if (tier.status === "not-applicable") basis = "not-applicable";
  else if (tier.status === "unreviewed") basis = "unreviewed";
  // An implementation-owned entry that names the test pinning the absence
  // (the refusal a use of the API gets) is a verified gap; one without a
  // test only declares it.
  else if (
    tier.status === "not-implemented" &&
    source.startsWith("compiler-feature:") &&
    (tier.tests?.length ?? 0) > 0
  )
    basis = "verified-absence";
  else if (
    tier.status === "not-implemented" &&
    (source.startsWith("compiler-chapter-policy:") || source.startsWith("compiler-feature:"))
  )
    basis = "declared-gap";
  else if (tier.status === "not-implemented") basis = "registry-gap";
  else
    throw new Error(
      `cannot determine verification basis for ${tier.status}/${source || "no-source"}`,
    );
  if (!VERIFICATION_BASES.has(basis)) throw new Error(`unknown verification basis '${basis}'`);
  return basis;
}

function classificationConfidence(basis) {
  if (
    [
      "test-backed",
      "island-test-backed",
      "explicit-refusal",
      "verified-absence",
      "architectural-policy",
    ].includes(basis)
  )
    return "high";
  if (["declared-gap", "not-applicable"].includes(basis)) return "medium";
  if (["registry-gap", "unreviewed"].includes(basis)) return "low";
  return "derived";
}

function nodePriority(stability) {
  if (stability?.index === "2") return "high";
  if (
    stability?.index === "0" ||
    stability?.index === "3" ||
    (stability?.level === 1 && stability?.index !== "1.2")
  )
    return "low";
  return "normal";
}

function backlogAction(tier) {
  if (tier.status === "partial") return "audit-partial";
  // island-served is not native work: an island build already answers the
  // API, so it is neither an implementation ticket nor a refusal to replace.
  if (tier.status === "island-served") return null;
  if (tier.status === "refused") return "replace-refusal";
  if (tier.status === "unreviewed") return "classify";
  if (tier.status === "not-implemented") {
    return verificationBasis(tier) === "registry-gap" ? "verify-gap" : "implement";
  }
  return null;
}

export function buildBacklog(snapshot) {
  const tasks = [];
  const tierItems = { static: {} };
  const priorities = { high: 0, normal: 0, low: 0 };
  for (const row of snapshot.rows) {
    if (row.depth === 0 || row.scope !== "api") continue;
    const tiers = {};
    for (const key of ["static"]) {
      const action = backlogAction(row[key]);
      if (action === null) continue;
      tierItems[key][action] = (tierItems[key][action] ?? 0) + 1;
      tiers[key] = {
        status: row[key].status,
        action,
        verification: verificationBasis(row[key]),
        confidence: classificationConfidence(verificationBasis(row[key])),
        source: row[key].evidence ?? null,
        tests: row[key].tests ?? [],
      };
    }
    if (Object.keys(tiers).length === 0) continue;
    const priority = nodePriority(row.nodeStability);
    priorities[priority] += Object.keys(tiers).length;
    tasks.push({
      id: row.id,
      chapter: row.chapter,
      label: row.label,
      signature: row.signature,
      apiSymbol: row.apiSymbol,
      docsUrl: `https://nodejs.org/docs/v${snapshot.nodeVersion}/api/${row.chapter}.html${row.anchor ? `#${row.anchor}` : ""}`,
      nodeStability: row.nodeStability,
      priority,
      tiers,
    });
  }
  return {
    schemaVersion: 1,
    nodeVersion: snapshot.nodeVersion,
    nodeCommit: snapshot.nodeCommit,
    summary: {
      taskCount: tasks.length,
      tierItemCount: Object.values(tierItems.static).reduce((sum, count) => sum + count, 0),
      tiers: tierItems,
      priorities,
    },
    tasks,
  };
}

function publicExclusion(row) {
  if (row.scope === "documentation") return "documentation";
  if (row.scope === "metadata") return "metadata";
  if (row.scope === "configuration") return "configuration";
  if (row.scope !== "api") return "non-api";
  if (row.static.status === "not-applicable") return "not-applicable";
  return null;
}

function projectPublicMatrix(snapshot) {
  const chapters = [];
  const rows = [];
  const excluded = {
    documentation: 0,
    metadata: 0,
    configuration: 0,
    "non-api": 0,
    "not-applicable": 0,
    chapters: 0,
  };
  for (const chapter of snapshot.chapters) {
    const sourceRows = snapshot.rows.filter((row) => row.chapter === chapter.slug);
    const root = { ...sourceRows[0], depth: 0 };
    const chapterRows = [root];
    const ancestors = [root];
    for (const row of sourceRows.slice(1)) {
      ancestors.length = row.depth;
      const exclusion = publicExclusion(row);
      if (exclusion !== null) {
        excluded[exclusion] += 1;
        continue;
      }
      const parent = [...ancestors].reverse().find(Boolean) ?? root;
      const projected = { ...row, depth: parent.depth + 1 };
      chapterRows.push(projected);
      ancestors[row.depth] = projected;
    }
    if (chapterRows.length === 1) {
      excluded.chapters += 1;
      continue;
    }
    root.static = summarizeTier(chapterRows, "static");
    chapters.push({
      slug: chapter.slug,
      title: chapter.title,
      entries: chapterRows.length,
      apiEntries: chapterRows.length,
    });
    rows.push(...chapterRows);
  }
  return {
    chapters,
    rows,
    inventory: {
      sourceChapters: snapshot.chapters.length,
      sourceRows: snapshot.rows.length,
      matrixChapters: chapters.length,
      matrixRows: rows.length,
      excluded,
    },
  };
}

function publicSnapshot(snapshot) {
  const matrix = projectPublicMatrix(snapshot);
  return {
    schemaVersion: 4,
    nodeVersion: snapshot.nodeVersion,
    nodeTag: snapshot.nodeTag,
    nodeCommit: snapshot.nodeCommit,
    sources: snapshot.sources,
    verificationBases: PUBLIC_VERIFICATION,
    inventory: matrix.inventory,
    chapters: matrix.chapters,
    rows: matrix.rows.map((row) => ({
      id: row.id,
      chapter: row.chapter,
      kind: row.kind,
      name: row.name,
      signature: row.signature,
      label: row.label,
      apiSymbol: row.apiSymbol,
      depth: row.depth,
      scope: row.scope,
      anchor: row.anchor,
      nodeStability: row.nodeStability,
      static: {
        status: row.static.status,
        detail: publicDetail(row.static),
        verification: verificationBasis(row.static),
      },
    })),
  };
}

/** The committed ledger with every row's classification recomputed from
 * the current sources. The rows themselves come from the pinned Node docs,
 * so while the pin is unchanged this is what a fetching run writes. */
function reclassify(snapshot) {
  if (snapshot.nodeVersion !== pin.version || snapshot.nodeCommit !== pin.commit) {
    throw new Error(
      `the ledger targets Node ${snapshot.nodeVersion}, the pin ${pin.version}; run 'pnpm node-compat' to fetch the new docs`,
    );
  }
  const ctx = classificationContext();
  const ancestors = [];
  for (const row of snapshot.rows) {
    ancestors.length = row.depth;
    const parentSignature = ancestors[row.depth - 1]?.signature;
    row.static = classifyStatic(row, null, ctx, parentSignature);
    ancestors[row.depth] = row;
  }
  for (const chapter of snapshot.chapters) {
    const chapterRows = snapshot.rows.filter((row) => row.chapter === chapter.slug);
    chapterRows[0].static = summarizeTier(
      chapterRows,
      "static",
      ctx.compilerCompat.chapterPolicies[chapter.slug],
    );
  }
  assertGlobalTwinsAgree(snapshot);
  return snapshot;
}

function checkLocal() {
  for (const path of retiredOutputPaths) {
    if (existsSync(path))
      throw new Error(`${path.slice(root.length)} is no longer generated; delete it`);
  }
  const snapshot = JSON.parse(readFileSync(internalOutputPath, "utf8"));
  if (snapshot.nodeVersion !== pin.version || snapshot.nodeCommit !== pin.commit) {
    throw new Error(
      `snapshot targets Node ${snapshot.nodeVersion}/${snapshot.nodeCommit}, pin targets ${pin.version}/${pin.commit}`,
    );
  }
  const ctx = classificationContext();
  if (snapshot.chapters.length !== 63)
    throw new Error(`expected 63 pinned Node API chapters, found ${snapshot.chapters.length}`);
  const ancestors = [];
  for (const row of snapshot.rows) {
    if (row.depth === 0) {
      ancestors.length = 1;
      ancestors[0] = row;
      continue;
    }
    const chapter = snapshot.chapters.find((item) => item.slug === row.chapter);
    const parentSignature = ancestors[row.depth - 1]?.signature;
    const expectedStatic = classifyStatic(row, chapter, ctx, parentSignature);
    ancestors[row.depth] = row;
    if (JSON.stringify(row.static) !== JSON.stringify(expectedStatic)) {
      throw new Error(
        `generated classification is stale at ${row.id} (${row.signature}); run 'pnpm node-compat'`,
      );
    }
  }
  for (const row of snapshot.rows) {
    if (
      row.depth > 0 &&
      row.anchor !== "" &&
      row.anchorSource !== "exact" &&
      row.anchorSource !== "ancestor"
    ) {
      throw new Error(`${row.id} publishes an unverified Node HTML anchor`);
    }
  }
  if (readFileSync(publicOutputPath, "utf8") !== render(publicSnapshot(snapshot))) {
    throw new Error("the docs compatibility artifact is stale; run 'pnpm node-compat'");
  }
  const refusals = refusalsRendered(snapshot);
  for (const path of [refusalsOutputPath, publishedRefusalsPath]) {
    if (readFileSync(path, "utf8") !== refusals) {
      throw new Error(`${path.slice(root.length)} is stale; run 'pnpm node-compat'`);
    }
  }
  const publicRows = publicSnapshot(snapshot).rows;
  for (const row of publicRows) {
    if (row.depth > 0 && row.scope !== "api")
      throw new Error(`${row.id} exposes a non-API row in the public matrix`);
    if (row.depth > 0 && row.static.status === "not-applicable") {
      throw new Error(`${row.id} exposes a row that is not applicable to native compilation`);
    }
  }
  if (readFileSync(publicOutputPath, "utf8") !== render(publicSnapshot(snapshot))) {
    throw new Error("the docs compatibility artifact is stale; run 'pnpm node-compat'");
  }
  for (const row of snapshot.rows) {
    for (const key of ["static"]) {
      if (requiresEvidence(row[key].status) && (row[key].tests?.length ?? 0) === 0) {
        throw new Error(`${row.id} claims ${key} ${row[key].status} without test evidence`);
      }
      if (row[key].status === "refused") {
        const source = row[key].evidence ?? "";
        const explicit = source.startsWith("surface-manifest:unsupported:");
        if (!explicit && source !== "derived:descendants") {
          throw new Error(`${row.id} claims ${key} refused without an explicit refusal source`);
        }
      }
      if (row[key].status === "by-design") {
        const source = row[key].evidence ?? "";
        if (!source.includes("chapter-policy") && source !== "derived:descendants") {
          throw new Error(`${row.id} claims ${key} by-design without an explicit chapter policy`);
        }
      }
      verificationBasis(row[key]);
    }
  }
  assertGlobalTwinsAgree(snapshot);
  const matrix = projectPublicMatrix(snapshot);
  console.log(
    `Node compatibility snapshot is locally current (${snapshot.rows.length} source rows, ${matrix.rows.length} public matrix rows, Node ${snapshot.nodeVersion})`,
  );
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json,text/markdown,text/html" },
  });
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--check-local")) return checkLocal();
  if (args.has("--local")) {
    const snapshot = reclassify(JSON.parse(readFileSync(internalOutputPath, "utf8")));
    writeFileSync(internalOutputPath, render(snapshot));
    writeFileSync(publicOutputPath, render(publicSnapshot(snapshot)));
    writeRefusals(snapshot);
    console.log(
      `reclassified the compatibility ledger and public artifact (${snapshot.rows.length} source rows, ${projectPublicMatrix(snapshot).rows.length} public matrix rows, ${pin.tag})`,
    );
    return;
  }

  const [allText, indexMarkdown] = await Promise.all([
    fetchText(pin.allJsonUrl),
    fetchText(pin.indexMarkdownUrl),
  ]);
  const snapshot = buildSnapshot({
    allJson: JSON.parse(allText),
    indexMarkdown,
    allSha256: sha(allText),
    indexSha256: sha(indexMarkdown),
  });
  const htmlByChapter = new Map(
    await Promise.all(
      snapshot.chapters.map(async (chapter) => [
        chapter.slug,
        verifiedAnchorIds(await fetchText(`${NODE_BASE}${chapter.slug}.html`)),
      ]),
    ),
  );
  verifyAnchors(snapshot, htmlByChapter);
  const internalRendered = render(snapshot);
  const publicRendered = render(publicSnapshot(snapshot));

  if (args.has("--check")) {
    if (readFileSync(internalOutputPath, "utf8") !== internalRendered)
      throw new Error("internal Node compatibility snapshot is stale; run 'pnpm node-compat'");
    if (readFileSync(publicOutputPath, "utf8") !== publicRendered)
      throw new Error("public Node compatibility snapshot is stale; run 'pnpm node-compat'");
    const refusals = refusalsRendered(snapshot);
    for (const path of [refusalsOutputPath, publishedRefusalsPath]) {
      if (readFileSync(path, "utf8") !== refusals)
        throw new Error(`${path.slice(root.length)} is stale; run 'pnpm node-compat'`);
    }
    console.log(
      `Node compatibility snapshot matches ${pin.tag} (${snapshot.rows.length} API rows, commit ${pin.commit.slice(0, 12)})`,
    );
    return;
  }
  writeFileSync(internalOutputPath, internalRendered);
  writeFileSync(publicOutputPath, publicRendered);
  writeRefusals(snapshot);
  console.log(
    `wrote compatibility ledger and public artifact (${snapshot.rows.length} source rows, ${projectPublicMatrix(snapshot).rows.length} public matrix rows, ${pin.tag})`,
  );
}

// backlog.mjs imports buildBacklog; only running this file generates.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
