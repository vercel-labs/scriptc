#!/usr/bin/env node
// Lists the runtime's refusal sites: places where the C runtime raises an
// error Node would not, because scriptc does not implement the operation.
// A refusal the compiler could not make at compile time should at least
// name a diagnostic code (the `code` property scr_throw_error_msg_code
// stamps, which the uncaught printer appends as "[SCxxxx]").
//
//   node scripts/runtime-refusals.mjs            report (always exits 0)
//   node scripts/runtime-refusals.mjs --json     the site list as JSON
//   node scripts/runtime-refusals.mjs --write    rewrite the baseline
//   node scripts/runtime-refusals.mjs --strict   exit 1 on a finding
//   node scripts/runtime-refusals.mjs --source=<dir>   scan another directory
//                                                of C sources, without a baseline
//
// A finding is a site that has no code, or a site the baseline
// (packages/runtime/refusal-sites.json) does not list.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_FLAG = "--source=";
const sourceFlag = process.argv.slice(2).find((arg) => arg.startsWith(SOURCE_FLAG));
const sourceDir =
  sourceFlag === undefined
    ? join(root, "packages/runtime/src")
    : resolve(sourceFlag.slice(SOURCE_FLAG.length));
/** The runtime's own baseline; another directory has none. */
const baselinePath =
  sourceFlag === undefined ? join(root, "packages/runtime/refusal-sites.json") : null;

/** Wording that marks a message as scriptc's refusal, not Node's error. */
const REFUSAL =
  /\b(?:is|are) not supported\b|\bnot supported (?:yet|by|in|through|here)\b|\bno (?:native |scriptc |static |compiled )?lowering\b|\b(?:is|are) not implemented\b|\bnot implemented yet\b|\bcannot be represented\b|\bis not modeled\b|\bare not modeled\b|\bcannot cross into a Node island\b|\bneeds a Node island value\b/;

/** Messages Node itself prints with the same wording: errors to keep byte
 * for byte, not refusals. Each pattern names the Node error it mirrors. */
const NODE_WORDING = [
  /^Protocol "/, // ERR_INVALID_PROTOCOL
  /operation not supported/, // OpenSSL and uv messages
  /^Digest method not supported$/, // crypto.createHash
  /^" encoding is not supported$/, // ERR_ENCODING_NOT_SUPPORTED's tail
  /^ is not supported$/, // ERR_CRYPTO_* tails assembled around a name
  /^Digest options are not supported$/,
  /^Zero-length key is not supported$/, // WebCrypto DataError
  /key export is not supported$/, // WebCrypto NotSupportedError
  /is not supported in workers$/, // ERR_WORKER_UNSUPPORTED_OPERATION
  /^(?:address family|ai_family|socket type|protocol) not supported$/,
  /not supported on socket$/,
  /^The .* method is not implemented$/, // ERR_METHOD_NOT_IMPLEMENTED
  /^is not supported$/, // ERR_INVALID_ARG_VALUE's reason, raised with Node's code
];

/** Messages the runtime prints before it ends the process: a trap or a
 * start-up failure, which has no Error to carry a code. They end in a
 * newline; a thrown message does not. */
const FATAL = /^scriptc: .*\n$/s;

/** Calls that carry a message without raising it. */
const CARRIERS =
  /^(?:snprintf|sprintf|strlen|sizeof|memcmp|memcpy|strcmp|scr_jb_puts|scr_jb_put[a-z_0-9]*|ib_cstr|ib_[a-z_0-9]+|scr_str_[a-z_0-9]+|fputs|fprintf|printf|if|while|for|switch|return)$/;

/** Calls that raise. A helper outside this pattern that raises a message
 * it is handed is found through its body (helperCodes). */
const SINK =
  /\b(scr_throw_[a-z_0-9]+|scr_trap|[a-z_0-9]*(?:unsupported|refus[a-z]*|throw|type_error|_fail|fence)[a-z_0-9]*)\s*\(/g;

function stripComments(text) {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const start = i++;
      while (i < text.length && text[i] !== c) i += text[i] === "\\" ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function unescape(body) {
  return body.replace(/\\(n|t|"|\\|'|x[0-9a-fA-F]{2}|[0-7]{1,3})/g, (_, e) => {
    if (e === "n") return "\n";
    if (e === "t") return "\t";
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return e;
  });
}

/** String literals with adjacent ones joined, as the C compiler does. */
function literals(text) {
  const found = [];
  const pattern = /"(?:[^"\\\n]|\\.)*"/g;
  let last = null;
  for (let m; (m = pattern.exec(text));) {
    const before = last === null ? null : text.slice(last.end, m.index);
    if (last !== null && /^\s*$/.test(before)) {
      last.value += unescape(m[0].slice(1, -1));
      last.end = m.index + m[0].length;
    } else {
      last = { start: m.index, end: m.index + m[0].length, value: unescape(m[0].slice(1, -1)) };
      found.push(last);
    }
  }
  return found;
}

/** Function bodies: a definition starts in column 0 and its closing brace
 * is the next one in column 0. */
function functions(text) {
  const found = [];
  const pattern = /^[A-Za-z_][^\n;{}]*?\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)[^;{}]*\{/gm;
  for (let m; (m = pattern.exec(text));) {
    const end = text.indexOf("\n}", m.index);
    if (end < 0) break;
    found.push({ name: m[1], start: m.index, end: end + 2 });
    pattern.lastIndex = end + 2;
  }
  return found;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) line++;
  return line;
}

/** The innermost call whose argument list holds `index`: its name and the
 * position of its opening parenthesis. */
function enclosingCallSite(text, from, index) {
  let depth = 0;
  for (let i = index - 1; i >= from; i--) {
    const c = text[i];
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth > 0) depth--;
      else {
        const name = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(text.slice(Math.max(from, i - 80), i));
        return name === null ? null : { name: name[1], open: i };
      }
    } else if (c === ";" || c === "{" || c === "}") return null;
  }
  return null;
}

/** The name of the innermost call whose argument list holds `index`. */
function enclosingCall(text, from, index) {
  return enclosingCallSite(text, from, index)?.name ?? null;
}

function callEnd(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    } else if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

const CODE = /"(SC\d{4})"/;

/** The code a raising call stamps: a literal, or a file constant holding one. */
function stampedCode(call, constants) {
  const literal = CODE.exec(call);
  if (literal !== null) return literal[1];
  for (const [name, code] of constants) if (new RegExp(`\\b${name}\\b`).test(call)) return code;
  return null;
}

function scan() {
  const files = readdirSync(sourceDir)
    .filter((name) => /\.[ch]$/.test(name))
    .sort();
  const sources = new Map();
  for (const file of files) {
    const text = stripComments(readFileSync(join(sourceDir, file), "utf8"));
    const constants = new Map();
    for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*\][^=;]*=\s*"(SC\d{4})"\s*;/g))
      constants.set(m[1], m[2]);
    sources.set(file, { text, functions: functions(text), literals: literals(text), constants });
  }
  // Helpers that raise a message they are handed, and the code they stamp:
  // directly, or through another helper that does.
  const helperCodes = new Map([["scr_throw_lowering_fence", "SC2020"]]);
  const bodies = [];
  for (const [file, source] of sources)
    for (const fn of source.functions) {
      const body = source.text.slice(fn.start, fn.end);
      if (!/\bconst char \*|ScrStr \*/.test(body.slice(0, body.indexOf("{")))) continue;
      bodies.push({ file, name: fn.name, body });
    }
  for (let changed = true; changed;) {
    changed = false;
    for (const { file, name, body } of bodies) {
      if (helperCodes.has(`${file}:${name}`)) continue;
      let code = /scr_throw_error_msg_code\([^;]*?"(SC\d{4})"\s*\)/s.exec(body)?.[1] ?? null;
      if (code === null)
        for (const call of body.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
          if (call[1] === name) continue;
          code = helperCodes.get(`${file}:${call[1]}`) ?? helperCodes.get(call[1]) ?? null;
          if (code !== null) break;
        }
      if (code === null) continue;
      helperCodes.set(`${file}:${name}`, code);
      if (!helperCodes.has(name)) helperCodes.set(name, code);
      changed = true;
    }
  }
  const helperCode = (file, name) =>
    helperCodes.get(`${file}:${name}`) ?? helperCodes.get(name) ?? null;
  /** The code the raising call `name`, whose argument list opens at `open`,
   * stamps. */
  const sinkAt = (file, text, name, open) => {
    const stamped = stampedCode(text.slice(open, callEnd(text, open)), sources.get(file).constants);
    if (stamped !== null) return { name, code: stamped };
    return { name, code: name.startsWith("scr_throw_error") ? null : helperCode(file, name) };
  };
  /** The raising call that follows `from` (before `to`) and its code. */
  const sinkAfter = (file, text, from, to) => {
    SINK.lastIndex = 0;
    const next = SINK.exec(text.slice(from, to));
    if (next === null) return null;
    return sinkAt(file, text, next[1], from + next.index + next[0].length - 1);
  };
  /** The raising call a use at `index` is an argument of, directly or
   * through calls that only carry the message (`raise(format(NAME))`). */
  const sinkAround = (file, text, from, index) => {
    for (let at = index; ;) {
      const call = enclosingCallSite(text, from, at);
      if (call === null) return null;
      SINK.lastIndex = 0;
      if (SINK.test(`${call.name}(`)) return sinkAt(file, text, call.name, call.open);
      if (!CARRIERS.test(call.name)) return null;
      at = call.open;
    }
  };
  /** Where a message that leaves its function by name is raised: the
   * raising call a use of `name` elsewhere in the file is handed to, or
   * else the first one after that use (the message went into a local). The
   * call around the use comes first: scanning from the use onward starts
   * inside that call's argument list, so it would pass over the raise that
   * holds the name and answer with a later one and that one's code. */
  const sinkOfUses = (file, source, name, skip) => {
    const use = new RegExp(`\\b${name}\\b`, "g");
    for (let m; (m = use.exec(source.text));) {
      if (skip !== undefined && m.index >= skip.start && m.index < skip.end) continue;
      const fn = source.functions.find((f) => f.start <= m.index && m.index < f.end);
      if (fn === undefined) continue;
      const found =
        sinkAround(file, source.text, fn.start, m.index) ??
        sinkAfter(file, source.text, m.index, Math.min(fn.end, m.index + 1500));
      if (found !== null) return found;
    }
    return null;
  };

  const sites = [];
  for (const [file, source] of sources) {
    const { text } = source;
    for (const literal of source.literals) {
      if (!REFUSAL.test(literal.value)) continue;
      const fn = source.functions.find((f) => f.start <= literal.start && literal.end <= f.end);
      const scopeStart = fn?.start ?? Math.max(0, literal.start - 400);
      const scopeEnd = fn?.end ?? Math.min(text.length, literal.end + 1200);
      const inText = /\[(SC\d{4})/.exec(literal.value);
      let sink = enclosingCall(text, scopeStart, literal.start);
      let code = inText === null ? null : inText[1];
      let how = inText === null ? null : "text";
      let property = null;
      if (sink !== null && CARRIERS.test(sink)) sink = null;
      if (sink !== null) {
        const open = text.lastIndexOf("(", literal.start);
        const stamped = stampedCode(text.slice(open, callEnd(text, open)), source.constants);
        property = stamped ?? helperCode(file, sink);
      } else {
        const table = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*\]\s*(?:[A-Z_]+\s*)?=\s*$/.exec(
          text.slice(Math.max(0, literal.start - 160), literal.start),
        );
        let found =
          fn === undefined
            ? null
            : sinkAfter(file, text, literal.end, Math.min(scopeEnd, literal.end + 1500));
        // A message table at file scope, or a function that returns the
        // message: the raise is where the name is used.
        if (found === null && fn === undefined && table !== null)
          found = sinkOfUses(file, source, table[1], undefined);
        if (found === null && fn !== undefined) {
          found = sinkOfUses(file, source, fn.name, fn);
          if (found !== null) found = { name: `${found.name} via ${fn.name}`, code: found.code };
        }
        if (found !== null) {
          sink = found.name;
          property = found.code;
        }
        // A code set beside the message (scr_error_set_code, an out
        // parameter), or written into the text the message becomes part of.
        if (property === null && fn !== undefined) {
          const rest = text.slice(literal.end, Math.min(fn.end, literal.end + 1500));
          property = CODE.exec(rest.slice(0, 300))?.[1] ?? null;
          if (property === null) {
            const suffix = /"[^"\n]*\[(SC\d{4})[ \]]/.exec(rest);
            if (suffix !== null) {
              code = suffix[1];
              how = "text";
            }
          }
        }
      }
      if (property !== null) {
        code ??= property;
        how = how === null ? "property" : "text+property";
      }
      sites.push({
        file,
        line: lineOf(text, literal.start),
        function: fn?.name ?? null,
        message: literal.value,
        sink,
        code,
        how,
        nodeWording: NODE_WORDING.some((p) => p.test(literal.value)),
        ...(FATAL.test(literal.value) ? { fatal: true } : {}),
      });
    }
  }
  // Raises that stamp a scriptc code around a message with other wording.
  for (const [file, source] of sources) {
    const { text } = source;
    const mine = sites.filter((site) => site.file === file);
    for (const m of text.matchAll(/"SC\d{4}"/g)) {
      const fn = source.functions.find((f) => f.start <= m.index && m.index < f.end);
      if (fn === undefined) continue;
      const sink = enclosingCall(text, fn.start, m.index);
      if (sink === null || CARRIERS.test(sink)) continue;
      const line = lineOf(text, m.index);
      if (
        mine.some(
          (site) => site.function === fn.name && line - site.line >= 0 && line - site.line < 40,
        )
      )
        continue;
      const before = source.literals.filter(
        (literal) =>
          literal.start >= fn.start && literal.end <= m.index && !/^SC\d{4}$/.test(literal.value),
      );
      const message = before.length === 0 ? "" : before[before.length - 1].value;
      const site = {
        file,
        line,
        function: fn.name,
        message,
        sink,
        code: m[0].slice(1, -1),
        how: "property",
        nodeWording: false,
        otherWording: true,
      };
      mine.push(site);
      sites.push(site);
    }
  }
  return sites;
}

function keyOf(site) {
  return `${site.file}\t${site.function ?? ""}\t${site.message}`;
}

const args = new Set(process.argv.slice(2));

/** Prints what the arguments ask for and answers the exit status. The
 * process ends by itself once its output is written: the site list is
 * larger than a pipe's buffer, and process.exit() would drop what a slow
 * reader had not taken yet and still report success. */
function main() {
  const all = scan();
  const sites = all.filter((site) => !site.nodeWording && site.fatal !== true);

  if (args.has("--json")) {
    process.stdout.write(JSON.stringify(all, null, 1) + "\n");
    return 0;
  }

  if (args.has("--write") && baselinePath !== null) {
    const entries = sites.map((site) => ({
      file: site.file,
      function: site.function,
      message: site.message,
      code: site.code,
    }));
    writeFileSync(baselinePath, JSON.stringify(entries, null, 1) + "\n");
    process.stdout.write(`wrote ${entries.length} sites to ${baselinePath}\n`);
    return 0;
  }

  let baseline = null;
  if (baselinePath !== null)
    try {
      baseline = new Set(JSON.parse(readFileSync(baselinePath, "utf8")).map(keyOf));
    } catch {
      baseline = null;
    }

  const uncoded = sites.filter((site) => site.code === null);
  const unlisted = baseline === null ? [] : sites.filter((site) => !baseline.has(keyOf(site)));
  const fileCount = new Set(sites.map((site) => site.file)).size;
  process.stdout.write(
    `runtime refusal sites: ${sites.length} in ${fileCount} files; ` +
      `${sites.length - uncoded.length} name a diagnostic code, ${uncoded.length} do not` +
      (baseline === null ? "" : `; ${unlisted.length} are not in the baseline`) +
      "\n",
  );
  for (const site of uncoded)
    process.stdout.write(
      `  no code: packages/runtime/src/${site.file}:${site.line} ${JSON.stringify(site.message)}\n`,
    );
  for (const site of unlisted)
    process.stdout.write(
      `  not in baseline: packages/runtime/src/${site.file}:${site.line} ${JSON.stringify(site.message)}\n`,
    );
  if (uncoded.length + unlisted.length > 0)
    process.stdout.write(
      "Raise a refusal with scr_throw_error_msg_code and the code of the nearest compile-time diagnostic, " +
        "then run `node scripts/runtime-refusals.mjs --write`.\n",
    );
  return args.has("--strict") && uncoded.length + unlisted.length > 0 ? 1 : 0;
}

process.exitCode = main();
