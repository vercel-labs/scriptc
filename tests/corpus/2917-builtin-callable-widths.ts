// Optional and variadic builtin functions materialize as ordinary static
// closures. Their native ABI remains fixed-width: optional arguments arrive
// as undefined-armed slots and typed rest arguments arrive as one packed
// array. The same typed-rest ABI serves program function values.
import { basename, join, resolve } from "node:path";
import * as path from "node:path";
import * as posix from "node:path/posix";
import * as win32 from "node:path/win32";
import { platform } from "node:os";
import * as os from "node:os";
import { escape, unescape } from "node:querystring";
import * as querystring from "node:querystring";

const base = basename;
console.log(base("/one/two/file.ts"));
console.log(base("/one/two/file.test.ts", ".ts"));
console.log(base("/one/two/file.ts", undefined));
console.log(base === path.basename, typeof base);

const joiner = join;
const parts = ["one", "two", "file.ts"];
console.log(joiner());
console.log(joiner("one", "two", "file.ts"));
console.log(joiner(...parts));
console.log(joiner === path.join, typeof joiner);

const resolver = resolve;
console.log(resolver() === process.cwd());
console.log(basename(resolver("one", "..", "two", "file.ts")));

type PathJoin = (...parts: string[]) => string;
const joins: PathJoin[] = [path.join, posix.join, win32.join];
for (const fn of joins) console.log(fn("alpha", "beta", "gamma"));

function chooseJoin(windows: boolean): PathJoin {
  return windows ? win32.join : posix.join;
}
console.log(chooseJoin(false)("left", "right"));
console.log(chooseJoin(true)("left", "right"));
console.log(path.posix.join === posix.join, path.win32.join === win32.join);

function gather(head: string, ...tail: string[]): string {
  return `${head}:${tail.join(",")}`;
}
const gatherValue: (head: string, ...tail: string[]) => string = gather;
const gatherers = [gatherValue];
for (const fn of gatherers) console.log(fn("head", "a", "b", "c"));

const platformFn = platform;
console.log(platformFn() === process.platform, platformFn === os.platform);
const esc = escape;
const unesc = unescape;
console.log(unesc(esc("a b&c")), esc === querystring.escape, unesc === querystring.unescape);
