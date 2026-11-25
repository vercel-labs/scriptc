// console and its output methods as values under @types/node, whose
// `Console` declares `log(message?: any, ...optionalParams: any[])`: the
// method is one checked-dynamic function in every slot, and console
// flows into a program's logger type as a record of those functions.
["a", "b"].forEach(console.log);
[1, 2].forEach(console.error);

const { log, error, warn } = console;
log("destructured", 1, { a: 1 });
error("to stderr", [1, 2]);
warn("format %s %d", "string", 3);

const alias = console.log;
alias("alias %j", { ok: true });
const bound = console.log.bind(console);
bound("bound", 2);
const tagged = console.error.bind(console, "[tag]");
tagged("bound with an argument");
const typed: (...args: unknown[]) => void = console.warn;
typed("typed slot");
const pick = (failed: boolean) => (failed ? console.error : console.log);
pick(false)("picked log");
pick(true)("picked error");
console.log(console.log === alias, alias === log, typeof alias, alias.name);

interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
function run(label: string, logger: Logger = console): void {
  logger.log("via logger", label);
  logger.error("error via logger %s", label);
}
run("default");
run("custom", { log: (...args) => console.log("custom", ...args), error: () => {} });

class Service {
  private readonly logger: Logger;
  constructor(logger?: Logger) {
    this.logger = logger ?? console;
  }
  start(): void {
    this.logger.log("started");
  }
}
new Service().start();
new Service({ log: () => console.log("quiet"), error: () => {} }).start();
const asserted = console as unknown as Logger;
asserted.log("asserted");

function narrow(target: Pick<Console, "log" | "warn">): void {
  target.log("picked members");
  target.warn("picked warn");
}
narrow(console);
function whole(target: Console): void {
  target.log("console parameter", target === console);
}
whole(console);

const quiet = { ...console, log: (..._args: unknown[]): void => {} };
quiet.log("hidden");
quiet.error("copied member");
console.log(typeof quiet.warn, Object.keys({ ...console }).length);
