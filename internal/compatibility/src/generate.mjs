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
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const internalOutputPath = `${packageRoot}generated/node-v24-internal.json`;
const publicOutputPath = `${root}docs/src/generated/node-v24-compatibility.json`;
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
      source: `compiler-feature:${row.chapter}.${row.apiSymbol}`,
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

function publicDetail(tier) {
  const source = tier.evidence ?? "";
  if (source === "derived:descendants") return "Derived from the exact API rows in this chapter.";
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
    return "Supports aes-128/192/256 in cbc, ctr, and gcm modes and chacha20-poly1305 with Node's argument, IV, tag-length, and key-length errors; other OpenSSL ciphers and KeyObject keys are refused.";
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
    return "Matches Node's update() output lengths, padding, authentication tags, string encodings, and state errors for the supported ciphers, and its stream.Transform behavior: chunks written through update(), final() pushed at the end, and its errors reported through 'error'.";
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
    if (/^compiler-feature:process\.std(?:in|out|err)$/.test(source)) {
      return "Stored JavaScript process streams support native input listeners, pause/resume and buffered reads, synchronous output writes, and output write replacement; other stream operations remain unsupported.";
    }
    if (
      /^compiler-feature:zlib\.(?:zlib\.(?:Deflate|Inflate|Gzip|Gunzip|DeflateRaw|InflateRaw|Unzip|ZlibBase|close|flush|params|reset)|bytesWritten|Options)$/.test(
        source,
      )
    ) {
      return "Deflate, Inflate, Gzip, Gunzip, DeflateRaw, InflateRaw, and Unzip are Transform streams with Node's output chunking, flush, params, reset, error codes, and option validation; Zstd streams remain unsupported.";
    }
    if (
      /^compiler-feature:zlib\.(?:zlib\.(?:BrotliCompress|BrotliDecompress)|BrotliOptions)$/.test(
        source,
      )
    ) {
      return "BrotliCompress and BrotliDecompress are Transform streams over the brotli version Node bundles, with Node's parameters, dictionaries, flush, reset, error codes, and option validation; like Node's, they have no params().";
    }
    if (source === "compiler-feature:zlib.zlib.constants") {
      return "Each zlib.constants member and its module-level copy reads as Node's value; the constants object itself is not a runtime value.";
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
    if (source === "compiler-feature:util.debuglog") {
      return "The enabled getter tests the section on first read; the callback receives the section's implementation with its own enabled getter.";
    }
    if (
      source === "compiler-feature:process.process.emitWarning" ||
      source === "compiler-feature:process.'warning'"
    ) {
      return "Emits string and Error warnings with types, codes, and details on the next tick, reporting to stderr before the 'warning' listeners run.";
    }
    if (/^compiler-feature:process\.(?:no|throw)Deprecation$/.test(source)) {
      return "Program assignments silence or throw deprecation warnings; compiled binaries take no Node command-line flags.";
    }
    if (source === "compiler-feature:console.Console") {
      return "Instances over process.stdout, process.stderr, or stream writables support log, info, debug, error, and warn with Node's ignoreErrors handling; other options and methods remain refused.";
    }
    if (source.startsWith("compiler-feature:webstreams.streamConsumers.")) {
      return "Collects a Node Readable stream's chunks for the tested forms; web ReadableStreams and other async iterables remain unsupported.";
    }
    if (tier.status === "not-applicable")
      return "Node configuration or documentation that does not map to a compiled program API.";
    if (tier.status === "not-implemented")
      return "Not implemented in scriptc's static module-loader subset yet.";
    if (
      source.startsWith("compiler-feature:stream.") ||
      source.startsWith("compiler-feature:webstreams.")
    ) {
      return "Implemented for the documented static async-iteration subset.";
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
  "explicit-refusal": {
    label: "Explicit refusal",
    detail: "Backed by a named compiler refusal.",
  },
  "verified-absence": {
    label: "Verified absence",
    detail: "A runtime presence test confirms that this API is absent.",
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
  else if (tier.status === "supported" || tier.status === "partial") basis = "test-backed";
  else if (tier.status === "refused") basis = "explicit-refusal";
  else if (tier.status === "by-design") basis = "architectural-policy";
  else if (tier.status === "not-applicable") basis = "not-applicable";
  else if (tier.status === "unreviewed") basis = "unreviewed";
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
    ["test-backed", "explicit-refusal", "verified-absence", "architectural-policy"].includes(basis)
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
      if (
        (row[key].status === "supported" || row[key].status === "partial") &&
        (row[key].tests?.length ?? 0) === 0
      ) {
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
    console.log(
      `Node compatibility snapshot matches ${pin.tag} (${snapshot.rows.length} API rows, commit ${pin.commit.slice(0, 12)})`,
    );
    return;
  }
  writeFileSync(internalOutputPath, internalRendered);
  writeFileSync(publicOutputPath, publicRendered);
  console.log(
    `wrote compatibility ledger and public artifact (${snapshot.rows.length} source rows, ${projectPublicMatrix(snapshot).rows.length} public matrix rows, ${pin.tag})`,
  );
}

// backlog.mjs imports buildBacklog; only running this file generates.
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
