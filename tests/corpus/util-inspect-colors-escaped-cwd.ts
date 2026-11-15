// util.inspect with colors over an error frame that names the working
// directory through its file:// href: formatError's markCwd retry needs
// pathToFileURL(cwd).href, whose percent-encoding of a space, '#', '%', '~'
// and brackets the raw "file://" + cwd spelling does not carry. The
// directory below holds each of them, so the raw directory never matches
// the frame and only the encoded href does. The parenthesis that opens the
// frame takes the dim span, a line ending on the directory keeps its
// closing one, a nested error keeps its indentation, and a frame naming the
// raw directory still dims.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as util from "node:util";

const dir = join(tmpdir(), "scriptc inspect cwd #1 100%~[]");
mkdirSync(dir, { recursive: true });
process.chdir(dir);
const cwd = process.cwd();
const href = pathToFileURL(join(cwd, "corpus.ts")).href;

const show = (label: string, value: unknown, options: object = {}): void => {
  console.log(`${label}: ${util.inspect(value, { colors: true, ...options })}`);
};

console.log("href differs from the raw path:", href !== `file://${join(cwd, "corpus.ts")}`);

const framed = new Error("framed");
framed.stack = `Error: framed\n    at load (${href}:1:2)`;
show("href frame", framed);

const bare = new Error("bare");
bare.stack = `Error: bare\n    at ${href}:3:4`;
show("bare href frame", bare);

const closing = new Error("closing");
closing.stack = `Error: closing\n    at close (${href})`;
show("href line ending on the directory", closing);

const raw = new Error("raw");
raw.stack = `Error: raw\n    at raw (${cwd}/corpus.ts:5:6)`;
show("raw frame", raw);

const nested = new Error("nested");
nested.stack = `Error: nested\n    at deep (${href}:7:8)`;
show("nested href frame", { outer: { inner: [nested] } }, { depth: 4 });

const builtin = new Error("builtin");
builtin.stack = `Error: builtin\n    at readFileSync (node:fs:9:10)\n    at own (${href}:11:12)`;
show("builtin then href frame", builtin);

console.log(`format o: ${util.formatWithOptions({ colors: true }, "%o", framed)}`);
