// console flowing into a record type a program declares: the default
// logger of a function or a class, with other loggers flowing into the
// same type. Each member the type declares is console's own function.
interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function run(label: string, logger: Logger = console): void {
  logger.log("via logger", label, 1);
  logger.error("error via logger", label);
}
run("default");
run("custom", {
  log: (...args) => console.log("custom", ...args),
  error: (...args) => console.error("custom", ...args),
});
run("passed", console);

interface Options {
  logger?: Logger;
  name: string;
}

class Service {
  private readonly logger: Logger;
  private readonly name: string;
  constructor(options: Options) {
    this.logger = options.logger ?? console;
    this.name = options.name;
  }
  start(): void {
    this.logger.log("started %s", this.name);
    this.logger.error("%s has %d warnings", this.name, 2);
  }
}
new Service({ name: "one" }).start();
new Service({ name: "two", logger: { log: () => console.log("quiet log"), error: () => {} } }).start();
new Service({ name: "three", logger: console }).start();

const direct: Logger = console;
direct.log("direct", { a: [1, 2] });

// A narrower and a wider view of the same console.
interface Warner {
  warn(message: string, ...rest: unknown[]): void;
  debug?(message: string): void;
  trail?: string;
}
const warner: Warner = console;
warner.warn("narrow", 3);
warner.debug?.("optional member");
console.log(warner.trail === undefined);

// A typed sink in an options literal, a conditional, and a return value.
const options: Options = { name: "four", logger: console };
options.logger?.log("in a literal");
function choose(quiet: boolean): Logger {
  return quiet ? { log: () => {}, error: (...args) => console.error("only errors", ...args) } : console;
}
choose(false).log("chosen console");
choose(true).log("dropped");
choose(true).error("kept");

// An asserted flow, and a binding that holds console.
const asserted = console as unknown as Logger;
asserted.log("asserted");
const held = console;
const fromBinding: Logger = held;
fromBinding.error("from a binding");

// A const binding of console is console, so it flows on like console; a
// reassigned binding holds the record.
run("alias", direct);
let current: Logger = { log: () => console.log("replaced later"), error: () => {} };
current.log();
current = console;
current.log("reassigned");
run("reassigned", current);

// Loggers kept in collections.
const loggers: Logger[] = [console, { log: (...args) => console.log("listed", ...args), error: () => {} }];
for (const logger of loggers) logger.log("each");
const named = new Map<string, Logger>([["default", console]]);
named.get("default")!.log("from a map");

// The record's members are console's own functions.
const first: Logger = console;
const second: Logger = console;
console.log(first.log === second.log, first.log === first.error);

// An optional logger defaulted with `||` and `??` in an inferred position.
const orDefault = (logger?: Logger) => logger || console;
const nullishDefault = (logger?: Logger) => logger ?? console;
orDefault().log("or default");
nullishDefault().error("nullish default");
orDefault({ log: () => console.log("given"), error: () => {} }).log();
