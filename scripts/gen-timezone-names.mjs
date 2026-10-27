#!/usr/bin/env node
// Long time zone names for Date.prototype.toString, toTimeString and
// String(date), derived from the pinned Node release's ICU.
//
//   node scripts/gen-timezone-names.mjs [--tzdata <tzdata.zi>]          regenerate the table
//   node scripts/gen-timezone-names.mjs [--tzdata <tzdata.zi>] --check  verify only
//
// Node prints the zone's long English name for standard or daylight time
// after the GMT offset ("GMT-0500 (Central Daylight Time)"). The name
// depends only on the zone and on whether the instant is in daylight time
// (V8 maps instants outside 1970 to 2038-01-19 into that range), so each
// zone ID in the IANA tzdata (zones and links, read from tzdata.zi) is
// sampled once a day over that range with TZ set to it, and the two names
// Node prints are recorded. Where the name changes together with the UTC
// offset, the name at the larger offset is the daylight name. Zones
// without a CLDR name print Node's "GMT+hh:mm" fallback, which is recorded
// as is.
//
// The runtime takes daylight time from tm_isdst, except for two kinds of
// zones, which get the exact instants at which Node's name changes:
// zones whose tzdata rules use a negative daylight saving (Europe/Dublin's
// winter time, Morocco's Ramadan time), where ICU's data calls the larger
// offset daylight time, and zones that Node shows in daylight time through
// 2038 (British Columbia's permanent UTC-7, which tzdata names standard
// time).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "packages/runtime/src/scr_timezone_data.h");

// V8 names the zone of instants in [0, 2^31 - 1] seconds directly.
const FIRST_MS = 0;
const LAST_MS = 2147483647000;
const DAY_MS = 86400000;

const zoneName = (ms) => {
  const text = new Date(ms).toString();
  return text.slice(text.indexOf("(") + 1, -1);
};

if (process.argv.includes("--sample")) {
  // One zone, selected by TZ: the first name printed, then every change of
  // name with the exact instant (ms) and the UTC offsets (minutes) before
  // and after it.
  const changes = [];
  let previous = null;
  const visit = (ms) => {
    const name = zoneName(ms);
    const offset = -new Date(ms).getTimezoneOffset();
    if (previous === null) {
      changes.push({ at: ms, name, offset });
    } else if (previous.name !== name) {
      // The first second with the new name.
      let lo = previous.ms / 1000;
      let hi = ms / 1000;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (zoneName(mid * 1000) === name) hi = mid;
        else lo = mid;
      }
      changes.push({ at: hi * 1000, from: previous, name, offset });
    }
    previous = { ms, name, offset };
  };
  for (let ms = FIRST_MS; ms < LAST_MS; ms += DAY_MS) visit(ms);
  visit(LAST_MS);
  process.stdout.write(JSON.stringify(changes));
  process.exit(0);
}

const tzdataIndex = process.argv.indexOf("--tzdata");
const tzdata = tzdataIndex >= 0 ? process.argv[tzdataIndex + 1] : "/usr/share/zoneinfo/tzdata.zi";
const checkOnly = process.argv.includes("--check");

/** Zone and link names in tzdata.zi, and the zones that save a negative
 * amount at some time from 1970 on. Links name their target. */
function readTzdata(path) {
  const text = readFileSync(path, "utf8");
  const zones = new Map();
  const negativeRules = new Set();
  const negativeZones = new Set();
  const year = (field) => (field === undefined ? Infinity : Number.parseInt(field, 10));
  let zone = null;
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (line.startsWith("R ")) {
      // R NAME FROM TO - IN ON AT SAVE LETTER, TO "o" (only) or "ma" (max).
      zone = null;
      const to =
        fields[3] === "o" ? year(fields[2]) : fields[3] === "ma" ? Infinity : year(fields[3]);
      if (fields[8]?.startsWith("-") && to >= 1970) negativeRules.add(fields[1]);
      continue;
    }
    if (line.startsWith("L ")) {
      zone = null;
      zones.set(fields[2], fields[1]);
      continue;
    }
    // Z NAME STDOFF RULES FORMAT [UNTIL], continued by STDOFF RULES FORMAT [UNTIL].
    let rest;
    if (line.startsWith("Z ")) {
      zone = fields[1];
      zones.set(zone, zone);
      rest = fields.slice(2);
    } else if (zone && fields.length >= 3 && !line.startsWith("#")) {
      rest = fields;
    } else {
      zone = null;
      continue;
    }
    const [, rule, , until] = rest;
    if (year(until) >= 1970 && (negativeRules.has(rule) || /^-\d/.test(rule)))
      negativeZones.add(zone);
  }
  const version = /^# version (\S+)/.exec(text)?.[1] ?? "unknown";
  return { zones, negativeZones, version };
}

/** The zone's [standard, daylight] names as Node prints them: at a change
 * of name that also changes the UTC offset, the name printed at the larger
 * offset is the daylight name; the name chosen at most such changes wins. */
function classify(id, changes) {
  const names = new Set(changes.map((c) => c.name));
  if (names.size > 2) throw new Error(`${id}: more than two names`);
  if (names.size === 1) {
    const [name] = names;
    return [name, name];
  }
  // Zones that moved between offsets keep one daylight name, so the vote
  // can include a transition that only changed the standard offset.
  const votes = new Map();
  for (const c of changes) {
    if (!c.from || c.from.offset === c.offset) continue;
    const name = c.offset > c.from.offset ? c.name : c.from.name;
    votes.set(name, (votes.get(name) ?? 0) + 1);
  }
  const ranked = [...votes].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || (ranked.length === 2 && ranked[0][1] === ranked[1][1]))
    throw new Error(`${id}: no daylight name`);
  const daylight = ranked[0][0];
  const standard = [...names].find((n) => n !== daylight);
  return [standard, daylight];
}

function sample(id) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, TZ: id, LANG: "en_US.UTF-8" };
    delete env.LC_ALL;
    delete env.LC_MESSAGES;
    const child = spawn(process.execPath, [self, "--sample"], { env });
    let text = "";
    child.stdout.on("data", (chunk) => (text += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(JSON.parse(text)) : reject(new Error(`${id}: sampler exited ${code}`)),
    );
  });
}

const { zones, negativeZones, version } = readTzdata(tzdata);
const ids = [...zones.keys()]
  .filter((id) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: id });
      return true;
    } catch {
      return false;
    }
  })
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const samples = new Map();
let next = 0;
await Promise.all(
  Array.from({ length: availableParallelism() }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      samples.set(id, await sample(id));
    }
  }),
);

// Pools of NUL-terminated strings, addressed by byte offset.
function pool() {
  const offsets = new Map();
  let text = "";
  return {
    add(s) {
      if (!offsets.has(s)) {
        offsets.set(s, Buffer.byteLength(text));
        text += s + "\0";
      }
      return offsets.get(s);
    },
    get text() {
      return text;
    },
  };
}
const idPool = pool();
const namePool = pool();
const changeSeconds = [];
const rows = ids.map((id) => {
  const changes = samples.get(id);
  const [standard, daylight] = classify(id, changes);
  // Exact daylight-time changes, as epoch seconds at which daylight time
  // starts or ends; INT32_MIN first when 1970 starts in daylight time.
  let first = 0;
  let count = 0;
  // Daylight time with no change in the last year sampled.
  const last = changes.at(-1);
  const permanent = last.name === daylight && LAST_MS - last.at > 366 * DAY_MS;
  if (standard !== daylight && (negativeZones.has(zones.get(id)) || permanent)) {
    first = changeSeconds.length;
    if (changes[0].name === daylight) changeSeconds.push("INT32_MIN");
    for (const c of changes.slice(1)) changeSeconds.push(String(c.at / 1000));
    count = changeSeconds.length - first;
  }
  return `  { ${idPool.add(id)}, ${namePool.add(standard)}, ${namePool.add(daylight)}, ${first}, ${count} },`;
});
// The runtime formats into a fixed buffer.
for (const [standard, daylight] of ids.map((id) => classify(id, samples.get(id)))) {
  if (Buffer.byteLength(standard) > 64 || Buffer.byteLength(daylight) > 64)
    throw new Error(`zone name longer than 64 bytes: ${standard} / ${daylight}`);
}
for (const p of [idPool, namePool]) {
  if (Buffer.byteLength(p.text) > 0xffff) throw new Error("string pool exceeds 16-bit offsets");
}

const cString = (text) =>
  text
    .split("\0")
    .slice(0, -1)
    .map((s) => `  "${s.replace(/[\\"]/g, "\\$&")}\\0"`)
    .join("\n");

const wrap = (items) => {
  const lines = [];
  let line = " ";
  for (const item of items) {
    if (line.length + item.length + 2 > 100) {
      lines.push(line);
      line = " ";
    }
    line += ` ${item},`;
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
};

const header = `/* Generated by scripts/gen-timezone-names.mjs from Node ${process.version}
 * (ICU ${process.versions.icu}, CLDR ${process.versions.cldr}) and tzdata ${version}. Do not edit.
 * Each IANA zone or link ID maps to the long English names Node prints for
 * its standard and daylight time. A row with change_count > 0 takes
 * daylight time from scr_tz_daylight_changes[first_change ...]: the epoch
 * seconds at which daylight time starts or ends between 1970 and
 * 2038-01-19 (INT32_MIN first when 1970 starts in daylight time). Rows are
 * sorted by ID. */
#ifndef SCR_TIMEZONE_DATA_H
#define SCR_TIMEZONE_DATA_H
#include <stdint.h>
typedef struct { uint16_t id, standard, daylight, first_change, change_count; } ScrTzNames;
static const char scr_tz_ids[] =
${cString(idPool.text)};
static const char scr_tz_name_text[] =
${cString(namePool.text)};
static const int32_t scr_tz_daylight_changes[] = {
${wrap(changeSeconds)}
};
static const ScrTzNames scr_tz_names[] = {
${rows.join("\n")}
};
#endif
`;

if (checkOnly) {
  const current = readFileSync(out, "utf8");
  if (current !== header) {
    process.stderr.write(`${out} is out of date; run node scripts/gen-timezone-names.mjs\n`);
    process.exit(1);
  }
  process.stdout.write(`${out} is up to date (${ids.length} zones)\n`);
} else {
  await writeFile(out, header);
  process.stdout.write(`wrote ${out} (${ids.length} zones)\n`);
}
