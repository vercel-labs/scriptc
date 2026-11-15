// A variadic untyped function observes how many arguments it receives. A
// slot whose last parameter may be omitted would hand it an explicit
// undefined where the JavaScript call passes nothing, and a function type
// does not record which parameters are optional, so a last parameter that
// can hold undefined is refused.
function make(): (...args: any[]) => any {
  return (...args: any[]): any => args.length;
}

// (1) An optional parameter: `optional()` passes nothing under Node.
const optional: (x?: number) => void = make();
optional();

// (2) A required parameter typed `unknown` has the same slot type.
const required: (error: unknown) => void = make();
required("x");

// (3) No parameters, or a last parameter that cannot be undefined: converts.
const none: () => void = make();
const one: (x: number) => void = make();
none();
one(1);
