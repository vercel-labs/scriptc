// The `arguments` of a function expression asserted to a signature with an
// optional parameter has no tuple value of its own: its length varies per
// call, and the native signature always passes every position. Forwarded
// into a program function the positions pass straight through; spread into
// a call that takes its arguments as a list (a method the program replaces
// on an instance), or handed to `apply` there, it would need that value and
// would pass an omitted argument as an extra undefined, so the read is
// refused by name.
class Printer {
  print(label: string, count?: number): string {
    return `${label}=${count ?? 0}`;
  }
}

const quiet = new Printer();
quiet.print = (...all: unknown[]): string => `(${all.length}:${all.join("/")})`;

type Print = (label: string, count?: number) => string;

function spread(target: Printer): Print {
  return function () {
    return target.print(...(arguments as unknown as Parameters<Print>));
  } as Print;
}

function applied(target: Printer): Print {
  return function () {
    return target.print.apply(target, arguments as unknown as Parameters<Print>);
  } as Print;
}

console.log(spread(quiet)("a"), spread(quiet)("b", 2), applied(quiet)("c"));
