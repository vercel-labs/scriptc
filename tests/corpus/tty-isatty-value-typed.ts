// A typed alias of tty.isatty works as a callback with its declared
// signature.
import * as tty from "node:tty";

const isTerminal: (fd: number) => boolean = tty.isatty;
function describe(fds: number[], test: (fd: number) => boolean): string[] {
  return fds.map((fd) => `${fd}:${test(fd)}`);
}
console.log(describe([-1, 0.5, 2 ** 40], isTerminal).join(" "));
console.log(isTerminal === tty.isatty, [-1].map(isTerminal));
