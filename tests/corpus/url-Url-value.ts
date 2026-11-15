// url.Url reached from TypeScript: @types/node declares Url as a type, so a
// typed program holds the constructor through an untyped module value
// (`const url: any = require("node:url")`) and constructs through it. The
// same constructor backs the typed parse() results, so an instanceof check
// through the untyped binding recognizes them.
process.noDeprecation = true;
import { createRequire } from "node:module";
import { parse, format } from "node:url";

const log = (line: string): void => console.log(line);

const require = createRequire(import.meta.url);
const url: any = require("node:url");
const Url = url.Url;
log(`typeof ${typeof Url} ${Url.name} ${Url.length}`);
log(`own ${Object.getOwnPropertyNames(Url).join(",")}`);

const built: any = new Url();
log(`fields ${JSON.stringify(built)}`);
log(`instance ${built instanceof Url} ${Object.getPrototypeOf(built) === Url.prototype}`);

const parsed = parse("http://user:pw@example.com:8080/a/b?x=1#h");
log(`parsed ${parsed instanceof Url} ${parsed.href}`);
log(`prototype ${Object.getPrototypeOf(parsed) === Url.prototype}`);

const plain = parse("/just/a/path");
log(`plain ${plain instanceof Url} ${JSON.stringify(plain)}`);

built.path = parsed.path;
built.href = parsed.href;
log(`format ${JSON.stringify(format(built))}`);
log(`keys ${Object.keys(built).join(",")}`);

function attempt(label: string, fn: () => unknown): void {
  try {
    fn();
    log(`${label} no throw`);
  } catch (error) {
    log(`${label} ${(error as Error).name}: ${(error as Error).message}`);
  }
}
attempt("call number", () => Url.call(5));
attempt("plain call", () => Url());
const receiver: Record<string, unknown> = {};
attempt("call object", () => Url.call(receiver));
log(`receiver ${JSON.stringify(receiver)}`);

const isInstance = (value: unknown, ctor: any): boolean => value instanceof ctor;
log(`guarded ${isInstance(built, Url)} ${isInstance(parsed, Url)} ${isInstance({}, Url)}`);
log(`identity ${Url === url.Url} ${Url.prototype.constructor === Url}`);
