// An accessor installed over an Error's own `message` and `name` by
// helpers whose target parameter is typed `object`, `{}` or generic:
// typed reads, writes and String() go through the accessors.
class ValidationError extends Error {}

function defineLazyMessage(target: object, compute: () => string): void {
  let cached: string | undefined;
  Object.defineProperty(target, "message", {
    get() {
      cached ??= compute();
      return cached;
    },
    set(value: string) {
      cached = `set:${value}`;
    },
    enumerable: true,
    configurable: true,
  });
}

function defineName(target: {}, name: string): void {
  Object.defineProperty(target, "name", { get: () => name, configurable: true });
}

function defineFixedMessage<T extends object>(target: T, message: string): T {
  Object.defineProperty(target, "message", { get: () => message, configurable: true });
  return target;
}

let computed = 0;
const e = new ValidationError("orig");
defineLazyMessage(e, () => {
  computed++;
  return "too small";
});
console.log(e.message, computed);
console.log(String(e), computed);
e.message = "typed";
console.log(e.message, Object.keys(e).join());

const named = new ValidationError("bad input");
defineName(named, "ZodError");
console.log(named.name, String(named));
const fixed = defineFixedMessage(new ValidationError("orig"), "fixed");
console.log(fixed.message, String(fixed));

const plain = new Error("start");
defineLazyMessage(plain, () => "computed");
console.log(plain.message, `${plain}`);
try {
  throw plain;
} catch (caught) {
  console.log(caught instanceof Error && caught.message);
}
