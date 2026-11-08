// A rest tuple with an optional position has no tuple value of its own:
// its length varies per call. Forwarded into a program function its
// positions pass straight through; spread into a call that takes its
// arguments as a list (a method the program replaces on an instance), it
// would need that value, so the read is refused by name.
class Printer {
  print(label: string, count?: number): string {
    return `${label}=${count ?? 0}`;
  }
}

const quiet = new Printer();
quiet.print = (label: string, count?: number): string => `(${label}:${count ?? -1})`;

function emit(target: Printer, ...args: [label: string, count?: number]): string {
  return target.print(...args);
}

console.log(emit(quiet, "a"), emit(quiet, "b", 2));
