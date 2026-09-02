#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const backlog = JSON.parse(readFileSync(`${packageRoot}generated/node-v24-backlog.json`, "utf8"));
const args = process.argv.slice(2);

function option(name) {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function integerOption(name, fallback) {
  const value = option(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative integer`);
  return parsed;
}

const tierFilter = option("tier");
const actionFilter = option("action");
const priorityFilter = option("priority");
const chapterFilter = option("chapter");
const statusFilter = option("status");
const format = option("format") ?? "summary";
const limit = integerOption("limit", format === "summary" ? 20 : Number.MAX_SAFE_INTEGER);

for (const [name, value, allowed] of [
  ["tier", tierFilter, ["static", "dynamic"]],
  ["action", actionFilter, ["verify-gap", "implement", "replace-refusal", "audit-partial", "classify"]],
  ["priority", priorityFilter, ["high", "normal", "low"]],
  ["format", format, ["summary", "json", "tsv"]],
]) {
  if (value !== null && !allowed.includes(value)) throw new Error(`--${name} must be one of: ${allowed.join(", ")}`);
}

const items = [];
for (const task of backlog.tasks) {
  if (priorityFilter && task.priority !== priorityFilter) continue;
  if (chapterFilter && task.chapter !== chapterFilter) continue;
  for (const [tier, work] of Object.entries(task.tiers)) {
    if (tierFilter && tier !== tierFilter) continue;
    if (actionFilter && work.action !== actionFilter) continue;
    if (statusFilter && work.status !== statusFilter) continue;
    items.push({
      id: task.id,
      chapter: task.chapter,
      label: task.label,
      apiSymbol: task.apiSymbol,
      docsUrl: task.docsUrl,
      nodeStability: task.nodeStability,
      priority: task.priority,
      tier,
      ...work,
    });
  }
}

const priorityRank = { high: 0, normal: 1, low: 2 };
const actionRank = { implement: 0, "replace-refusal": 1, "audit-partial": 2, "verify-gap": 3, classify: 4 };
items.sort((a, b) =>
  priorityRank[a.priority] - priorityRank[b.priority] ||
  actionRank[a.action] - actionRank[b.action] ||
  a.chapter.localeCompare(b.chapter) ||
  a.label.localeCompare(b.label) ||
  a.tier.localeCompare(b.tier)
);

const selected = items.slice(0, limit);
if (format === "json") {
  console.log(JSON.stringify({ nodeVersion: backlog.nodeVersion, matched: items.length, items: selected }, null, 2));
} else if (format === "tsv") {
  console.log("priority\taction\ttier\tstatus\tverification\tchapter\tlabel\tdocsUrl");
  for (const item of selected) {
    console.log([item.priority, item.action, item.tier, item.status, item.verification, item.chapter, item.label, item.docsUrl]
      .map((value) => String(value).replaceAll("\t", " ").replaceAll("\n", " "))
      .join("\t"));
  }
} else {
  const filters = [tierFilter && `tier=${tierFilter}`, actionFilter && `action=${actionFilter}`, priorityFilter && `priority=${priorityFilter}`, chapterFilter && `chapter=${chapterFilter}`, statusFilter && `status=${statusFilter}`].filter(Boolean);
  console.log(`Node ${backlog.nodeVersion} compatibility backlog: ${items.length} tier items${filters.length ? ` (${filters.join(", ")})` : ""}`);
  const counts = {};
  for (const item of items) counts[`${item.priority}/${item.action}`] = (counts[`${item.priority}/${item.action}`] ?? 0) + 1;
  for (const [key, count] of Object.entries(counts).sort()) console.log(`${String(count).padStart(5)}  ${key}`);
  if (selected.length > 0) console.log("");
  for (const item of selected) console.log(`${item.priority.padEnd(6)} ${item.action.padEnd(15)} ${item.tier.padEnd(7)} ${item.chapter.padEnd(24)} ${item.label}`);
  if (selected.length < items.length) console.log(`\nShowing ${selected.length} of ${items.length}; use --limit=<n> or --format=json|tsv.`);
}
