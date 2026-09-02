#!/usr/bin/env node

/* Generate the website's complete Node.js v24 parity inventory.
 *
 * Node owns the denominator: the pinned index.md names every API chapter and all.json
 * supplies the structured API tree (classes, methods, properties, events,
 * globals, overloads, and conceptual sections). scriptc owns the projection:
 * the compiler surface/dedicated manifests and the runtime island manifest.
 * Anything those sources do not prove is either "not-implemented" (when a
 * known implementation surface has no matching implementation) or
 * "unreviewed" (when no compatibility subsystem owns the classification).
 * Neither state is optimistically treated as support or an explicit refusal.
 *
 *   pnpm node-compat                fetch latest-v24.x and rewrite the snapshot
 *   pnpm node-compat --check        fetch and fail if the snapshot would change
 *   pnpm node-compat:check          offline implementation/profile drift check
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const internalOutputPath = `${packageRoot}generated/node-v24-internal.json`;
const backlogOutputPath = `${packageRoot}generated/node-v24-backlog.json`;
const publicOutputPath = `${root}docs/src/generated/node-v24-compatibility.json`;
const publicMetaOutputPath = `${root}docs/src/generated/node-v24-compatibility-meta.json`;
const compilerManifestPath = `${root}packages/compiler/surface-manifest.json`;
const compilerCompatPath = `${packageRoot}static-support.json`;
const islandManifestPath = `${packageRoot}dynamic-support.json`;
const pinPath = `${packageRoot}node-v24.json`;
const pin = JSON.parse(readFileSync(pinPath, "utf8"));
const NODE_BASE = pin.markdownBaseUrl;
const CHILD_FIELDS = ["modules", "classes", "methods", "properties", "events", "globals", "miscs"];
const NON_FUNCTIONAL_CHAPTERS = new Set(["documentation", "synopsis"]);
const STATUSES = [
  "supported",
  "partial",
  "refused",
  "not-implemented",
  "by-design",
  "unreviewed",
  "not-applicable",
];
const STATUS_SET = new Set(STATUSES);
const VERIFICATION_BASES = new Set([
  "test-backed",
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
  let out = value.replaceAll("`", "").replace(/^new\s+/, "").trim();
  out = out.replace(/\s+Type:\s*.*$/, "").replace(/\s*\{[^}]*\}\s*$/, "");
  const call = out.indexOf("(");
  if (call >= 0) out = out.slice(0, call);
  out = out.replace(/\[.*$/, "").replace(/\s*=.*$/, "").replace(/^Class:\s*/, "");
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

function dedicatedIndex(compat) {
  const out = new Map();
  for (const entry of compat.dedicated) {
    validateStatus(entry.status, `dedicated symbols ${entry.symbols.join(", ")}`);
    if (entry.status === "supported" || entry.status === "partial") {
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
    if (entry.status === "supported" || entry.status === "partial") {
      validateEvidence(entry.evidence, `${entry.chapter} compatibility features`);
    }
  }
  return compat.features ?? [];
}

function featureOf(row, entries) {
  return entries.find((entry) =>
    entry.chapter === row.chapter &&
    ((entry.symbols ?? []).includes(row.apiSymbol) || (entry.signatures ?? []).includes(row.signature))
  );
}

function symbolCandidates(row) {
  const result = new Set([row.apiSymbol]);
  const aliases = [
    ["fsPromises.", "fs/promises."],
    ["timersPromises.", "timers/promises."],
    ["streamPromises.", "stream/promises."],
    ["streamConsumers.", "stream/consumers."],
  ];
  for (const value of [...result]) {
    for (const [from, to] of aliases) if (value.startsWith(from)) result.add(to + value.slice(from.length));
  }
  return [...result].filter(Boolean);
}

function directExportName(row, module) {
  const symbol = row.apiSymbol;
  const subpathAliases = {
    "fs/promises": "fsPromises",
    "stream/promises": "streamPromises",
    "stream/consumers": "streamConsumers",
    "timers/promises": "timersPromises",
  };
  const alias = subpathAliases[module];
  if (alias && symbol.startsWith(`${alias}.`)) {
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
  if (row.depth === 1 && ["class", "method", "property", "global"].includes(row.kind)) return row.name;
  return null;
}

function manifestSymbolCandidates(row) {
  const modules = pin.chapterModules[row.chapter] ?? [];
  const result = new Set(
    symbolCandidates(row).filter((candidate) => candidate.includes(".")),
  );
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
    row.chapter === "environment_variables" && row.apiSymbol === "export"
  ) return "configuration";
  if (row.chapter === "deprecations") return "metadata";
  if (row.chapter === "intl" && row.kind === "module") return "metadata";
  return row.depth > 0 && (row.kind === "module" || row.kind === "misc") && !row.signature.includes("`")
    ? "documentation"
    : "api";
}

function classificationContext() {
  const compilerCompat = JSON.parse(readFileSync(compilerCompatPath, "utf8"));
  const island = JSON.parse(readFileSync(islandManifestPath, "utf8"));
  for (const [chapter, status] of Object.entries(compilerCompat.chapterPolicies)) {
    validateStatus(status, `static chapter policy '${chapter}'`);
  }
  for (const [chapter, status] of Object.entries(island.chapterPolicies)) {
    validateStatus(status, `dynamic chapter policy '${chapter}'`);
  }
  for (const [module, entry] of Object.entries(island.modules)) {
    const exports = new Set(entry.exports);
    for (const name of entry.refused ?? []) {
      if (!exports.has(name)) throw new Error(`island module '${module}' marks non-export '${name}' refused`);
    }
    const members = new Set(entry.members ?? []);
    for (const name of entry.refusedMembers ?? []) {
      if (members.has(name)) throw new Error(`island module '${module}' marks member '${name}' both supported and refused`);
    }
    validateEvidence(entry.evidence, `island module '${module}'`);
  }
  const supportedGlobals = new Set(island.globals.supported);
  const npmSupportedGlobals = new Set(island.globals.npmSupported ?? []);
  for (const name of npmSupportedGlobals) {
    if (supportedGlobals.has(name)) throw new Error(`island global '${name}' is both always-supported and npm-supported`);
  }
  for (const name of island.globals.absent) {
    if (supportedGlobals.has(name) || npmSupportedGlobals.has(name)) throw new Error(`island global '${name}' is both supported and absent`);
  }
  validateEvidence(island.globals.evidence, "island globals");
  return {
    manifest: manifestIndex(),
    compilerCompat,
    dedicated: dedicatedIndex(compilerCompat),
    staticFeatures: featureEntries(compilerCompat),
    dynamicFeatures: featureEntries(island),
    island,
  };
}

function classifyStatic(row, chapter, ctx) {
  if (row.depth === 0) return tier("unreviewed", "", { source: "chapter-summary" });
  if (row.scope === "documentation" || row.scope === "configuration") return tier("not-applicable", "", { source: row.scope });
  const feature = featureOf(row, ctx.staticFeatures);
  if (feature) return tier(feature.status, "", { source: `compiler-feature:${row.chapter}.${row.apiSymbol}`, tests: feature.evidence });
  for (const candidate of symbolCandidates(row)) {
    // Dedicated lowering paths are authoritative when an older generic
    // fence row shares the same API name (the surface manifest documents
    // its omissions explicitly; this overlay closes them with evidence).
    const dedicated = ctx.dedicated.get(candidate);
    if (dedicated) return tier(dedicated.status, "", { source: `compiler-dedicated:${candidate}`, tests: dedicated.evidence });
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
  if ((pin.chapterModules[row.chapter] ?? []).length > 0 || row.chapter === "globals" || row.chapter === "errors") {
    return tier("not-implemented", "", { source: `compiler-unmatched:${row.chapter}` });
  }
  return tier("unreviewed", "");
}

function classifyDynamic(row, chapter, ctx) {
  if (row.depth === 0) return tier("unreviewed", "", { source: "chapter-summary" });
  if (row.scope === "documentation" || row.scope === "configuration") return tier("not-applicable", "", { source: row.scope });
  const feature = featureOf(row, ctx.dynamicFeatures);
  if (feature) return tier(feature.status, "", { source: `island-feature:${row.chapter}.${row.apiSymbol}`, tests: feature.evidence });

  if (row.chapter === "globals") {
    if (ctx.island.globals.supported.includes(row.name)) {
      return tier("partial", "", { source: `island-global:${row.name}`, tests: ctx.island.globals.evidence });
    }
    if (ctx.island.globals.npmSupported?.includes(row.name)) {
      return tier("partial", "", { source: `island-npm-global:${row.name}`, tests: ctx.island.globals.evidence });
    }
    if (ctx.island.globals.absent.includes(row.name)) {
      return tier("not-implemented", "", { source: `island-global-absent:${row.name}`, tests: ctx.island.globals.evidence });
    }
  }

  const modules = pin.chapterModules[row.chapter] ?? [];
  for (const module of modules) {
    const moduleEntry = ctx.island.modules[module];
    const direct = directExportName(row, module);
    if (!moduleEntry) continue;
    if (moduleEntry.refusedMembers?.includes(row.apiSymbol)) {
      return tier("refused", "", { source: `island-member-stub:node:${module}.${row.apiSymbol}` });
    }
    if (moduleEntry.members?.includes(row.apiSymbol)) {
      return tier("partial", "", { source: `island-member:node:${module}.${row.apiSymbol}`, tests: moduleEntry.evidence });
    }
    if (direct && moduleEntry.refused?.includes(direct)) {
      return tier("refused", "", { source: `island-stub:node:${module}.${direct}` });
    }
    if (direct && moduleEntry.exports.includes(direct)) {
      return tier("partial", "", { source: `island-export:node:${module}.${direct}`, tests: moduleEntry.evidence });
    }
  }

  const policy = ctx.island.chapterPolicies[row.chapter];
  if (policy && policy !== "unreviewed") {
    return tier(policy, "", { source: `island-chapter-policy:${row.chapter}` });
  }
  if (modules.length > 0 && modules.every((module) => ctx.island.modules[module] === undefined)) {
    return tier("not-implemented", "", { source: `unshimmed:${modules.map((module) => `node:${module}`).join(",")}` });
  }
  if (modules.length > 0 || row.chapter === "globals" || row.chapter === "errors") {
    return tier("not-implemented", "", { source: `island-unmatched:${row.chapter}` });
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
    row.static = classifyStatic(row, chapter, ctx);
    row.dynamic = classifyDynamic(row, chapter, ctx);
    rows.push(row);
    for (const field of CHILD_FIELDS) {
      for (const child of node[field] ?? []) walk(child, [...parents, node], depth + 1, stability);
    }
  };
  walk(rootNode, [], 0, null);
  return rows;
}

function apiChapterLinks(indexMarkdown) {
  const links = [...indexMarkdown.matchAll(/^\* \[(.+?)\]\(([^)]+\.md)\)$/gm)]
    .map((match) => ({ title: match[1].replaceAll("`", ""), file: match[2], slug: match[2].slice(0, -3) }));
  return links.filter((link) => !NON_FUNCTIONAL_CHAPTERS.has(link.slug));
}

function summarizeTier(rows, key, chapterPolicy) {
  const descendants = rows.slice(1).filter((row) => row.scope === "api").map((row) => row[key]);
  const statuses = new Set(descendants.map((tier) => tier.status));
  const tests = [...new Set(descendants.flatMap((tier) => tier.tests ?? []))].sort();
  if (statuses.size === 0 && chapterPolicy) {
    return tier(chapterPolicy, "", { source: `${key === "static" ? "compiler" : "island"}-chapter-policy:${rows[0].chapter}` });
  }
  if (statuses.size === 1) return tier([...statuses][0], "", { source: "derived:descendants", tests });
  if (statuses.has("supported") || statuses.has("partial")) {
    return tier("partial", "", { source: "derived:descendants", tests });
  }
  if (statuses.has("unreviewed")) return tier("unreviewed", "", { source: "derived:descendants" });
  if (statuses.has("not-implemented")) return tier("not-implemented", "", { source: "derived:descendants" });
  if (statuses.has("refused")) return tier("refused", "", { source: "derived:descendants" });
  if (statuses.has("by-design")) return tier("by-design", "", { source: "derived:descendants" });
  return tier("unreviewed", "", { source: "derived:descendants" });
}

function statusCounts(rows, key) {
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  for (const row of rows) if (row.scope === "api") counts[row[key].status] += 1;
  return counts;
}

function verifiedAnchorIds(html) {
  return new Set(
    [...html.matchAll(/<a class="mark" href="#[^"]+" id="([^"]+)">#/g)]
      .map((match) => match[1]),
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
      const ancestor = [...ancestors].reverse().find((candidate) => candidate?.anchorSource === "exact" && candidate.anchor !== "");
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

function buildSnapshot({ allJson, indexMarkdown, allSha256, indexSha256 }) {
  const chapterLinks = apiChapterLinks(indexMarkdown);
  const top = topLevelNodes(allJson);
  const ctx = classificationContext();
  const chapters = [];
  const rows = [];

  if (chapterLinks.length === 0) throw new Error("the pinned Node index contains no functional API chapters");

  for (const link of chapterLinks) {
    const source = `doc/api/${link.file}`;
    const candidates = top.filter((node) => node.source === source).sort((a, b) => treeSize(b) - treeSize(a));
    if (candidates.length === 0) throw new Error(`all.json has no root for ${source}`);
    const chapter = { slug: link.slug, title: link.title };
    const chapterRows = flattenChapter(candidates[0], chapter, ctx);
    chapterRows[0].static = summarizeTier(chapterRows, "static", ctx.compilerCompat.chapterPolicies[link.slug]);
    chapterRows[0].dynamic = summarizeTier(chapterRows, "dynamic", ctx.island.chapterPolicies[link.slug]);
    chapters.push({
      slug: link.slug,
      title: link.title,
      entries: chapterRows.length,
      apiEntries: chapterRows.filter((row) => row.scope === "api").length,
      static: statusCounts(chapterRows, "static"),
      dynamic: statusCounts(chapterRows, "dynamic"),
    });
    rows.push(...chapterRows);
  }

  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`duplicate generated row id ${row.id}`);
    ids.add(row.id);
  }
  return {
    schemaVersion: 4,
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
      dynamicIsland: "internal/compatibility/dynamic-support.json",
    },
    chapters,
    rows,
  };
}

function render(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

function publicDetail(tier) {
  const source = tier.evidence ?? "";
  if (source === "derived:descendants") return "Derived from the exact API rows in this chapter.";
  if (tier.status === "unreviewed") return "Not yet classified; tracked as open parity work.";
  if (source.startsWith("surface-manifest:unsupported:")) return "Explicitly rejected by a named compiler diagnostic.";
  if (source.startsWith("surface-manifest:dynamic-only:")) return "Explicitly refused in static code; this form requires the dynamic island.";
  if (source.startsWith("surface-manifest:")) return "Implemented for the call shapes accepted by the compiler lowering.";
  if (source.startsWith("compiler-dedicated:")) return "Implemented by a dedicated static compiler/runtime path.";
  if (source.startsWith("compiler-feature:")) {
    if (tier.status === "not-applicable") return "Node configuration or documentation that does not map to a compiled program API.";
    if (tier.status === "not-implemented") return "Not implemented in scriptc's static module-loader subset yet.";
    return "Implemented for the documented scriptc module-loader subset.";
  }
  if (source.startsWith("compiler-chapter-policy:")) {
    if (tier.status === "by-design") return "Intentionally outside the static native execution model.";
    if (tier.status === "not-applicable") return "This Node executable or embedding feature does not map to static native code.";
    return "No static implementation exists for this Node API family yet.";
  }
  if (source.startsWith("compiler-unmatched:")) return "No static compiler lowering is registered for this API yet.";
  if (source.startsWith("island-export:")) return "Available through the embedded Node compatibility shim; exact member and overload coverage may be narrower.";
  if (source.startsWith("island-member:")) return "Implemented by the embedded Node compatibility shim.";
  if (source.startsWith("island-member-stub:")) return "Exposed only as an explicit throwing or rejecting compatibility stub.";
  if (source.startsWith("island-stub:")) return "Exposed only as an explicit throwing or rejecting compatibility stub.";
  if (source.startsWith("island-global:")) return "Provided by the embedded engine's web/global compatibility layer.";
  if (source.startsWith("island-npm-global:")) return "Provided when the embedded npm module bootstrap runs; absent from standalone dynamic islands.";
  if (source.startsWith("island-global-absent:")) return "Verified absent from the embedded engine's web/global compatibility layer.";
  if (source.startsWith("unshimmed:")) return "No dynamic-island shim exists for this Node module yet.";
  if (source.startsWith("island-chapter-policy:")) {
    if (tier.status === "by-design") return "Intentionally outside the dynamic-island execution model.";
    if (tier.status === "not-applicable") return "This Node executable or embedding feature does not map to dynamic-island code.";
    return "No dynamic-island implementation exists for this Node API family yet.";
  }
  if (source.startsWith("island-feature:")) {
    if (tier.status === "not-applicable") return "Node configuration or documentation that does not map to an island runtime API.";
    if (tier.status === "not-implemented") return "Not implemented in the embedded module-loader subset yet.";
    return "Implemented for the documented embedded module-loader subset.";
  }
  if (source.startsWith("island-unmatched:")) return "This API is not implemented by the dynamic-island shim.";
  if (source === "documentation") return "Documentation section; not a runtime API.";
  if (source === "configuration") return "Node command-line or configuration entry; not a runtime API.";
  if (tier.status === "not-applicable") return "This Node executable or embedding feature does not map to this scriptc tier.";
  if (tier.status === "refused") return "Explicitly rejected by this scriptc tier.";
  if (tier.status === "not-implemented") return "No implementation is registered for this scriptc tier yet.";
  if (tier.status === "by-design") return "Intentionally outside this scriptc tier's execution model.";
  return "Implemented for a documented subset of this API.";
}

const PUBLIC_VERIFICATION = {
  "test-backed": {
    label: "Test-backed mapping",
    detail: "Mapped to implementation and relevant repository tests; evidence may cover an API family rather than every documented overload.",
  },
  "explicit-refusal": {
    label: "Explicit refusal",
    detail: "Backed by a named compiler refusal or an explicit dynamic throwing or rejecting stub.",
  },
  "verified-absence": {
    label: "Verified absence",
    detail: "A runtime presence test confirms that this API is absent.",
  },
  "declared-gap": {
    label: "Declared gap",
    detail: "The implementation-owned compatibility manifest explicitly records this API family or feature as not implemented.",
  },
  "registry-gap": {
    label: "Registry gap",
    detail: "No implementation registry entry matched this Node API; verify the gap before starting implementation.",
  },
  "architectural-policy": {
    label: "Architectural policy",
    detail: "An implementation-owned policy intentionally excludes this API from the execution tier.",
  },
  unreviewed: {
    label: "Unreviewed",
    detail: "No compatibility subsystem owns a reliable classification yet.",
  },
  "not-applicable": {
    label: "Not applicable",
    detail: "This entry is documentation, configuration, or an execution model that does not map to the tier.",
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
  else if (tier.status === "supported" || tier.status === "partial") basis = "test-backed";
  else if (tier.status === "refused") basis = "explicit-refusal";
  else if (source.startsWith("island-global-absent:")) basis = "verified-absence";
  else if (tier.status === "by-design") basis = "architectural-policy";
  else if (tier.status === "not-applicable") basis = "not-applicable";
  else if (tier.status === "unreviewed") basis = "unreviewed";
  else if (
    tier.status === "not-implemented" &&
    (source.startsWith("compiler-chapter-policy:") ||
      source.startsWith("compiler-feature:") ||
      source.startsWith("island-chapter-policy:") ||
      source.startsWith("island-feature:"))
  ) basis = "declared-gap";
  else if (tier.status === "not-implemented") basis = "registry-gap";
  else throw new Error(`cannot determine verification basis for ${tier.status}/${source || "no-source"}`);
  if (!VERIFICATION_BASES.has(basis)) throw new Error(`unknown verification basis '${basis}'`);
  return basis;
}

function classificationConfidence(basis) {
  if (["test-backed", "explicit-refusal", "verified-absence", "architectural-policy"].includes(basis)) return "high";
  if (["declared-gap", "not-applicable"].includes(basis)) return "medium";
  if (["registry-gap", "unreviewed"].includes(basis)) return "low";
  return "derived";
}

function nodePriority(stability) {
  if (stability?.index === "2") return "high";
  if (stability?.index === "0" || stability?.index === "3" || stability?.level === 1 && stability?.index !== "1.2") return "low";
  return "normal";
}

function backlogAction(tier) {
  if (tier.status === "partial") return "audit-partial";
  if (tier.status === "refused") return "replace-refusal";
  if (tier.status === "unreviewed") return "classify";
  if (tier.status === "not-implemented") {
    return verificationBasis(tier) === "registry-gap" ? "verify-gap" : "implement";
  }
  return null;
}

function buildBacklog(snapshot) {
  const tasks = [];
  const tierItems = { static: {}, dynamic: {} };
  const priorities = { high: 0, normal: 0, low: 0 };
  for (const row of snapshot.rows) {
    if (row.depth === 0 || row.scope !== "api") continue;
    const tiers = {};
    for (const key of ["static", "dynamic"]) {
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
      tierItemCount: Object.values(tierItems.static).reduce((sum, count) => sum + count, 0) +
        Object.values(tierItems.dynamic).reduce((sum, count) => sum + count, 0),
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
  if (row.static.status === "not-applicable" && row.dynamic.status === "not-applicable") return "not-applicable";
  return null;
}

function projectPublicMatrix(snapshot) {
  const chapters = [];
  const rows = [];
  const excluded = { documentation: 0, metadata: 0, configuration: 0, "non-api": 0, "not-applicable": 0, chapters: 0 };
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
    root.dynamic = summarizeTier(chapterRows, "dynamic");
    chapters.push({
      slug: chapter.slug,
      title: chapter.title,
      entries: chapterRows.length,
      apiEntries: chapterRows.length,
      static: statusCounts(chapterRows, "static"),
      dynamic: statusCounts(chapterRows, "dynamic"),
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
      static: { status: row.static.status, detail: publicDetail(row.static), verification: verificationBasis(row.static) },
      dynamic: { status: row.dynamic.status, detail: publicDetail(row.dynamic), verification: verificationBasis(row.dynamic) },
    })),
  };
}

function publicMetadata(publicRendered, snapshot) {
  const matrix = projectPublicMatrix(snapshot);
  return {
    schemaVersion: 3,
    nodeVersion: snapshot.nodeVersion,
    nodeCommit: snapshot.nodeCommit,
    artifactVersion: sha(publicRendered).slice(0, 20),
    rowCount: matrix.rows.length,
  };
}

function checkLocal() {
  const snapshot = JSON.parse(readFileSync(internalOutputPath, "utf8"));
  if (snapshot.nodeVersion !== pin.version || snapshot.nodeCommit !== pin.commit) {
    throw new Error(`snapshot targets Node ${snapshot.nodeVersion}/${snapshot.nodeCommit}, pin targets ${pin.version}/${pin.commit}`);
  }
  const ctx = classificationContext();
  if (snapshot.chapters.length !== 62) throw new Error(`expected 62 pinned Node API chapters, found ${snapshot.chapters.length}`);
  for (const row of snapshot.rows) {
    if (row.depth === 0) continue;
    const chapter = snapshot.chapters.find((item) => item.slug === row.chapter);
    const expectedStatic = classifyStatic(row, chapter, ctx);
    const expectedDynamic = classifyDynamic(row, chapter, ctx);
    if (JSON.stringify(row.static) !== JSON.stringify(expectedStatic) || JSON.stringify(row.dynamic) !== JSON.stringify(expectedDynamic)) {
      throw new Error(`generated classification is stale at ${row.id} (${row.signature}); run 'pnpm node-compat'`);
    }
  }
  for (const row of snapshot.rows) {
    if (row.depth > 0 && row.anchor !== "" && row.anchorSource !== "exact" && row.anchorSource !== "ancestor") {
      throw new Error(`${row.id} publishes an unverified Node HTML anchor`);
    }
  }
  if (readFileSync(publicOutputPath, "utf8") !== render(publicSnapshot(snapshot))) {
    throw new Error("the docs compatibility artifact is stale; run 'pnpm node-compat'");
  }
  const publicRows = publicSnapshot(snapshot).rows;
  for (const row of publicRows) {
    if (row.depth > 0 && row.scope !== "api") throw new Error(`${row.id} exposes a non-API row in the public matrix`);
    if (row.depth > 0 && row.static.status === "not-applicable" && row.dynamic.status === "not-applicable") {
      throw new Error(`${row.id} exposes a row that is not applicable to either compiler tier`);
    }
  }
  if (readFileSync(backlogOutputPath, "utf8") !== render(buildBacklog(snapshot))) {
    throw new Error("the Node compatibility backlog is stale; run 'pnpm node-compat'");
  }
  const publicRendered = render(publicSnapshot(snapshot));
  if (readFileSync(publicMetaOutputPath, "utf8") !== render(publicMetadata(publicRendered, snapshot))) {
    throw new Error("the docs compatibility metadata is stale; run 'pnpm node-compat'");
  }
  for (const row of snapshot.rows) {
    for (const key of ["static", "dynamic"]) {
      if ((row[key].status === "supported" || row[key].status === "partial") && (row[key].tests?.length ?? 0) === 0) {
        throw new Error(`${row.id} claims ${key} ${row[key].status} without test evidence`);
      }
      if (row[key].status === "refused") {
        const source = row[key].evidence ?? "";
        const explicit = key === "static"
          ? source.startsWith("surface-manifest:unsupported:") || source.startsWith("surface-manifest:dynamic-only:")
          : source.startsWith("island-stub:") || source.startsWith("island-member-stub:");
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
  const matrix = projectPublicMatrix(snapshot);
  console.log(`Node compatibility snapshot is locally current (${snapshot.rows.length} source rows, ${matrix.rows.length} public matrix rows, Node ${snapshot.nodeVersion})`);
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { accept: "application/json,text/markdown,text/html" } });
  if (!response.ok) throw new Error(`fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--check-local")) return checkLocal();

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
    await Promise.all(snapshot.chapters.map(async (chapter) => [
      chapter.slug,
      verifiedAnchorIds(await fetchText(`${NODE_BASE}${chapter.slug}.html`)),
    ])),
  );
  verifyAnchors(snapshot, htmlByChapter);
  const internalRendered = render(snapshot);
  const backlogRendered = render(buildBacklog(snapshot));
  const publicRendered = render(publicSnapshot(snapshot));
  const publicMetaRendered = render(publicMetadata(publicRendered, snapshot));

  if (args.has("--check")) {
    if (readFileSync(internalOutputPath, "utf8") !== internalRendered) throw new Error("internal Node compatibility snapshot is stale; run 'pnpm node-compat'");
    if (readFileSync(backlogOutputPath, "utf8") !== backlogRendered) throw new Error("Node compatibility backlog is stale; run 'pnpm node-compat'");
    if (readFileSync(publicOutputPath, "utf8") !== publicRendered) throw new Error("public Node compatibility snapshot is stale; run 'pnpm node-compat'");
    if (readFileSync(publicMetaOutputPath, "utf8") !== publicMetaRendered) throw new Error("public Node compatibility metadata is stale; run 'pnpm node-compat'");
    console.log(`Node compatibility snapshot matches ${pin.tag} (${snapshot.rows.length} API rows, commit ${pin.commit.slice(0, 12)})`);
    return;
  }
  writeFileSync(internalOutputPath, internalRendered);
  writeFileSync(backlogOutputPath, backlogRendered);
  writeFileSync(publicOutputPath, publicRendered);
  writeFileSync(publicMetaOutputPath, publicMetaRendered);
  console.log(`wrote compatibility ledger, backlog, and public artifact (${snapshot.rows.length} source rows, ${projectPublicMatrix(snapshot).rows.length} public matrix rows, ${pin.tag})`);
}

await main();
