import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  buildTree,
  expandableIds,
  filterTree,
  flattenTree,
  nodeCount,
  rowMatcher,
  searchTexts,
  statusCounts,
} from "../src/lib/compatibility-tree.ts";

const row = (id, depth, label, status, detail = "") => ({
  id,
  chapter: "zlib",
  kind: depth === 0 ? "module" : "method",
  name: label,
  signature: label,
  label,
  apiSymbol: label,
  depth,
  scope: "api",
  anchor: "",
  nodeStability: null,
  static: { status, detail, verification: "test-backed" },
});
const rows = [
  row("root", 0, "zlib", "partial"),
  row("a", 1, "zlib.gzipSync()", "supported", "Lowered with Node's options"),
  row("b", 1, "zlib.Gzip", "partial"),
  row("b1", 2, "gzip.flush()", "supported"),
  row("c", 1, "zlib.zstdCompress()", "not-implemented"),
];
const titles = new Map([["zlib", "Zlib"]]);

test("the tree follows the rows' heading depths", () => {
  const tree = buildTree(rows);
  assert.equal(tree.length, 1);
  assert.deepEqual(tree[0].children.map((node) => node.row.id), ["a", "b", "c"]);
  assert.deepEqual(tree[0].children[1].children.map((node) => node.row.id), ["b1"]);
  assert.equal(nodeCount(tree), 5);
  assert.deepEqual([...expandableIds(tree)].sort(), ["b", "root"]);
});

test("filtering keeps matching rows with their ancestors and counts the matches once", () => {
  const tree = buildTree(rows);
  const texts = searchTexts(rows, titles);
  const byText = filterTree(tree, rowMatcher(texts, "flush", "all"));
  assert.equal(byText.matched, 1);
  assert.deepEqual(flattenTree(byText.nodes, new Set(), true).map(({ node, level }) => `${node.row.id}@${level}`), ["root@1", "b@2", "b1@3"]);
  const byDetail = filterTree(tree, rowMatcher(texts, "node's options", "all"));
  assert.deepEqual(flattenTree(byDetail.nodes, new Set(), true).map(({ node }) => node.row.id), ["root", "a"]);
  const byStatus = filterTree(tree, rowMatcher(texts, "", "supported"));
  assert.equal(byStatus.matched, 2);
  const both = filterTree(tree, rowMatcher(texts, "gzip", "partial"));
  assert.equal(both.matched, 1);
  assert.equal(filterTree(tree, rowMatcher(texts, "brotli", "all")).nodes.length, 0);
});

test("collapsed rows hide their children until expanded", () => {
  const tree = buildTree(rows);
  assert.deepEqual(flattenTree(tree, new Set(), false).map(({ node }) => node.row.id), ["root"]);
  assert.deepEqual(flattenTree(tree, new Set(["root"]), false).map(({ node }) => node.row.id), ["root", "a", "b", "c"]);
  assert.deepEqual(flattenTree(tree, new Set(["root", "b"]), false).map(({ node }) => node.row.id), ["root", "a", "b", "b1", "c"]);
});

test("status counts cover API rows below the chapters", () => {
  const counts = statusCounts(rows);
  assert.equal(counts.supported, 2);
  assert.equal(counts.partial, 1);
  assert.equal(counts["not-implemented"], 1);
});

/** The matrix component, compiled for Node from its TSX source. */
async function loadMatrix() {
  const docs = new URL("../", import.meta.url);
  const source = await readFile(new URL("src/components/node-compatibility-matrix.tsx", docs), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const lib = pathToFileURL(fileURLToPath(new URL("src/lib/compatibility-tree.ts", docs))).href;
  const dir = new URL("node_modules/.cache/compatibility-matrix-test/", docs);
  await mkdir(dir, { recursive: true });
  const file = new URL("node-compatibility-matrix.mjs", dir);
  await writeFile(file, outputText.replace('"@/lib/compatibility-tree"', JSON.stringify(lib)));
  return import(file.href);
}

test("badges render without their tooltips until hovered or focused", async () => {
  const { StatusBadge, StabilityBadge } = await loadMatrix();
  const status = renderToStaticMarkup(
    createElement(StatusBadge, {
      status: "partial",
      detail: "Lowered with Node's options",
      verification: { label: "Test-backed", detail: "Corpus programs cover it." },
    }),
  );
  assert.ok(status.includes('tabindex="0"'), status);
  assert.ok(status.includes('title="Lowered with Node&#x27;s options'), status);
  assert.ok(!status.includes('role="tooltip"'), status);
  assert.ok(!status.includes("aria-describedby"), status);
  const stability = renderToStaticMarkup(
    createElement(StabilityBadge, { stability: { index: "2", level: 2, text: "Stable", inherited: false } }),
  );
  assert.ok(stability.includes('tabindex="0"'), stability);
  assert.ok(!stability.includes('role="tooltip"'), stability);
  const legend = renderToStaticMarkup(createElement(StatusBadge, { status: "supported" }));
  assert.ok(!legend.includes("tabindex"), legend);
});
