// new DOMException(message, options) converts options.name to a string.
// When the name is a Proxy that only the options object holds, the Proxy's
// traps can delete options.name while the conversion is still running, and
// the conversion keeps going as in Node: the next trap still runs, and the
// result is the name.
function attempt(label: string, run: () => unknown): void {
  try {
    console.log(label, run());
  } catch (e) {
    console.log(label, String(e));
  }
}

function proxyName(
  options: any,
  log: string[],
  answer: (key: string | symbol) => unknown,
): void {
  const target: any = JSON.parse('{"kind": "target"}');
  options.name = new Proxy(target, {
    get(t: any, key: string | symbol): any {
      log.push(typeof key === "symbol" ? key.toString() : key);
      delete options.name;
      return answer(key);
    },
  });
}

attempt("toString", () => {
  const options: any = {};
  const log: string[] = [];
  proxyName(options, log, (key) => (key === "toString" ? () => "FromToString" : undefined));
  const error = new DOMException("message", options);
  return [error.name, error.message, "name" in options, log.join(" ")].join(" | ");
});

attempt("toPrimitive", () => {
  const options: any = {};
  const log: string[] = [];
  proxyName(options, log, (key) =>
    key === Symbol.toPrimitive ? (hint: string) => "Primitive:" + hint : undefined,
  );
  const error = new DOMException("message", options);
  return [error.name, log.join(" ")].join(" | ");
});

attempt("valueOf after an object toString", () => {
  const options: any = {};
  const log: string[] = [];
  proxyName(options, log, (key) =>
    key === "toString" ? () => ({}) : key === "valueOf" ? () => "FromValueOf" : undefined,
  );
  return [new DOMException("m", options).name, log.join(" ")].join(" | ");
});

attempt("no conversion", () => {
  const options: any = {};
  const log: string[] = [];
  proxyName(options, log, () => undefined);
  return new DOMException("m", options).name;
});

attempt("throwing trap", () => {
  const options: any = {};
  const target: any = JSON.parse("{}");
  options.name = new Proxy(target, {
    get(t: any, key: string | symbol): any {
      delete options.name;
      throw new Error("trap threw");
    },
  });
  return new DOMException("m", options).name;
});

attempt("with cause", () => {
  const options: any = { cause: "why" };
  const log: string[] = [];
  proxyName(options, log, (key) => (key === "toString" ? () => "Caused" : undefined));
  const error = new DOMException("m", options);
  return [error.name, String(error.cause), log.length].join(" | ");
});
