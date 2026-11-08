// A fixed-tuple rest parameter that is only forwarded (`target.method(...args)`), where the method is one
// the program replaces on an instance. A call of such a method looks for the replacement first and takes
// its arguments as a list, so the tuple that is otherwise never built has to exist for that call.
class Printer {
  lines: string[] = [];
  print(label: string, count: number): string {
    const line = `${label}=${count}`;
    this.lines.push(line);
    return line;
  }
  flag(label: string, count: number, on: boolean): string {
    const line = `${label}:${count}:${on ? "on" : "off"}`;
    this.lines.push(line);
    return line;
  }
}

const plain = new Printer();
const quiet = new Printer();
// The replacements: what a test double or a wrapper does to a shared object.
quiet.print = (label: string, count: number): string => `(${label}/${count})`;
quiet.flag = function (label: string, count: number, on: boolean): string {
  return `[${label}/${count}/${on}/${arguments.length}]`;
};

function emit(target: Printer, ...args: [label: string, count: number]): string {
  return target.print(...args);
}

// Three positions of three types, and the tuple's length read beside the forward.
function emitFlag(target: Printer, ...args: [string, number, boolean]): string {
  return `${args.length} ${target.flag(...args)}`;
}

// A const alias of the tuple is forwarded the same way.
function emitAlias(target: Printer, ...args: [string, number]): string {
  const forwarded = args;
  return target.print(...forwarded);
}

// The same tuple forwarded twice, and into an ordinary function between the two.
function join(label: string, count: number): string {
  return `${label}+${count}`;
}
function emitTwice(target: Printer, ...args: [string, number]): string {
  return [target.print(...args), join(...args), target.print(...args)].join(" ");
}

// A wrapper method that forwards its own rest tuple, typed from the method it wraps, to `this`.
class Tracker extends Printer {
  track(...args: Parameters<Printer["print"]>): string {
    return this.print(...args);
  }
}
const tracker = new Tracker();
const silenced = new Tracker();
silenced.print = (label: string, count: number): string => `<${label}|${count}>`;

// Arguments are evaluated once, in order, before the call.
let order = "";
function next(tag: string, value: number): number {
  order += tag;
  return value;
}

console.log(emit(plain, "a", 1));
console.log(emit(quiet, "b", 2));
console.log(emitFlag(plain, "c", 3, true));
console.log(emitFlag(quiet, "d", 4, false));
console.log(emitAlias(plain, "e", 5));
console.log(emitAlias(quiet, "f", 6));
console.log(emitTwice(plain, "g", 7));
console.log(emitTwice(quiet, "h", 8));
console.log(tracker.track("j", 10), silenced.track("k", 11), tracker.lines.join(","));
console.log(emit(quiet, "i" + next("x", 0), next("y", 9)), order);
console.log(plain.lines.join(","), quiet.lines.length);
