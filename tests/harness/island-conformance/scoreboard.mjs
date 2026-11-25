#!/usr/bin/env node
// Prints the size of known-failures.json by way and category: the scoreboard
// of the island conformance lane (../island-conformance.test.ts).
//
// Usage: node tests/harness/island-conformance/scoreboard.mjs [--markdown]
//
// Every entry is an island failure: a forced island build that differs from
// Node where the default build does not (`forced`), or a default build that
// differs from Node while it runs one of the program's packages in a Node
// island by itself (`automatic`).
import { readFileSync } from "node:fs";

const known = JSON.parse(readFileSync(new URL("./known-failures.json", import.meta.url), "utf8"));
const categories = ["build", "not-islanded", "crash", "exit", "stdout", "stderr"];
const sides = ["forced", "automatic"];
const rows = { forced: {}, automatic: {} };
const programs = { forced: new Set(), automatic: new Set() };
const all = new Set();
for (const [program, ways] of Object.entries(known)) {
  for (const [way, failure] of Object.entries(ways)) {
    const side = way === "default" ? "automatic" : "forced";
    rows[side][failure.category] = (rows[side][failure.category] ?? 0) + 1;
    programs[side].add(program);
    all.add(program);
  }
}
const total = (side) => categories.reduce((n, c) => n + (rows[side][c] ?? 0), 0);
if (process.argv.includes("--markdown")) {
  console.log(`| | ${categories.join(" | ")} | total | programs |`);
  console.log(`| --- | ${categories.map(() => "---:").join(" | ")} | ---: | ---: |`);
  for (const side of sides)
    console.log(
      `| ${side} | ${categories.map((c) => rows[side][c] ?? 0).join(" | ")} | ${total(side)} | ${programs[side].size} |`,
    );
} else {
  for (const side of sides) {
    const parts = categories.map((c) => `${c} ${rows[side][c] ?? 0}`).join(", ");
    console.log(`${side}: ${total(side)} in ${programs[side].size} programs (${parts})`);
  }
}
console.log(
  `${process.argv.includes("--markdown") ? "\n" : ""}total: ${total("forced") + total("automatic")} island failures in ${all.size} programs`,
);
