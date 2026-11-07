// console as a value has named boundaries, all reported at build time.
// Only log, info, debug, warn and error are function values: keeping
// another member as a value is refused at the read, and so is console
// flowing into a record type that declares one. A record console flowed
// into holds console's members, so comparing it with console is refused.
const table = console.table;
const { time } = console;
function watch(onError: (error: unknown) => void = console.trace): void {
  onError(1);
}

interface Wide {
  log(...args: unknown[]): void;
  table(data: unknown): void;
}
function useWide(wide: Wide): void {
  wide.log("wide");
}
useWide(console);

// Reachable only through an assertion: tsc rejects the plain flows.
const panics = console as unknown as {
  log(...args: unknown[]): void;
  panic(message: string): void;
};
const leveled = console as unknown as { log(...args: unknown[]): void; level: string };

interface Logger {
  log(...args: unknown[]): void;
}
function isDefault(logger: Logger): boolean {
  return logger === console;
}
function isCustom(logger: Logger | undefined): boolean {
  return console !== logger;
}
console.log(table, time, watch, panics, leveled, isDefault, isCustom);

// Replacing a console member cannot take effect: direct calls never read
// the member.
console.log = (...args: unknown[]): void => {
  process.stdout.write(`${args.length}\n`);
};
