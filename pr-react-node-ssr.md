# Fix JavaScript gaps in conditionals, bindings, builtin prototypes, RegExp calls, and promise properties

## Summary

Compiling a real-world JavaScript server renderer exposed a set of independent gaps in scriptc. Some refused valid code; others compiled and then gave a wrong result or threw where Node does not. Each fix here is general, has its own corpus program, and keeps a refusal wherever the correct behavior can't be guaranteed.

React's Node server renderer (`react-dom/server.node`) is the example that found them: with these fixes and `--define='process.env.NODE_ENV="production"'`, a `renderToPipeableStream` server compiles to a native executable whose output matches Node byte for byte. That includes hooks, context, `useId`, Suspense with `use(promise)`, streamed boundaries, and a component that throws inside a boundary.

## Changes

**Discarded `&&`/`||` ending in a void conditional.** `d && (w(a), c ? f() : g())` as a statement, where both arms return nothing, crashed with SC9001 ("ternary must not be void"), even though coverage didn't report it. The statement now lowers as the `if` it is, as a discarded conditional statement already did.

**`RegExp(pattern, flags)` without `new`.** The call form threw "calling the RegExp constructor through a stored value is not supported yet" at run time. With a string or `undefined` pattern it now builds the same regex `new RegExp` does. With a regex or untyped pattern, Node may return the same object, so that form stays refused.

**JavaScript bindings typed as a union by their initializer.** `var match = re.exec(text)` followed by `match = "&lt;"` compiled as fully static, then every write threw "a 'string' value is not representable in the target union". The open-writes rule that already gives such bindings checked-dynamic storage skipped union declarations; it now counts a write that fits none of the union's arms. Every program this changes threw at that write before.

**`ArrayBuffer` and typed-array prototypes.** In JavaScript, `ArrayBuffer.prototype`, `Uint8Array.prototype`, and other members these constructor values don't model read silently as `undefined` (`typeof ArrayBuffer.prototype` printed `"undefined"`). They now refuse, as `Map.prototype` already did. Feature checks of a literal key against those prototypes answer as in Node 24:

```js
var hasOwnProperty = Object.prototype.hasOwnProperty,
  supportsDetached = hasOwnProperty.call(ArrayBuffer.prototype, "detached"); // true
```

The direct spelling, a variable holding `hasOwnProperty` that is never reassigned, and `Object.hasOwn` all fold. No write, delete, or redefinition through these prototypes succeeds, so the answer can't go stale.

**`new` on a class read from a builtin module binding.** `new util.TextEncoder()`, `new async_hooks.AsyncLocalStorage()`, and `new url.URL(...)` over `import * as`, default imports, and `var m = require("m")` were refused with "constructing values other than classes declared in the program". They now construct the class a named import does. Reassigning a `require` binding is already a compile error, so the binding can't name another value.

**Own properties on promises.** Node lets a program add properties to a promise. React's `use()` records a thenable's state in `status`, `value`, and `reason` on the promise itself, and the runtime threw "Cannot create property 'status' on Promise". The runtime now keeps a promise's own properties on its shared identity cell, so every box and adapted twin of one promise sees them.
- Supported: reads, writes, `in`, `delete`, `Object.keys`/`values`/`entries`, `for...in`, spread and `Object.assign`, `JSON.stringify`, own names and descriptors, `defineProperty`, and preventExtensions, seal, freeze, and their queries.
- Still refused: defining `then`, `catch`, `finally`, `constructor`, `toString`, `valueOf`, `toLocaleString`, or `toJSON`, since adoption and the conversions read those from the prototype, and symbol-keyed properties.
- The table is not traced by the cycle collector, as the box-to-promise edge already isn't, so a cycle through a promise's own property leaks rather than being freed early.

**JavaScript objects extended by `Object.defineProperty`.** In JavaScript files TypeScript declares a property that `Object.defineProperty` adds as a required field, even when the call runs only on some paths:

```js
var errorInfo = {};
node && Object.defineProperty(errorInfo, "componentStack", { get() { … } });
return errorInfo;
```

The `{}` initializer then failed its conversion to that record. `defineProperty` and `defineProperties` on a binding now keep it checked-dynamic, as `setPrototypeOf` already did. A function returning such a binding returns its actual value.

**Closures in a destructuring declaration's own initializer.** `const { pipe } = render(app, { onShellReady() { pipe(out); } })` inside a function was refused with "the reference to 'pipe' (a binding form with no lowering)". The plain `const x = f(() => x)` form already pre-declared a TDZ box. Destructured names now get the same box, and the pattern initializes it. A read before the destructuring completes throws Node's `ReferenceError`. A destructuring form that binds without initializing the box is refused rather than leaving it empty.

## Limitations

- Statically typed promises (`const p = new Promise(...)` in a file the checker types) still refuse member reads, writes, and `in` at compile time. Promises reached through untyped values, as thenables reach `use()`, support own properties.
- A value read from a checked-dynamic binding through an expression the checker types (`typeof x === "number" ? x : x[0]`, or `info.componentStack` typed `string`) is still checked against the checker's type, so an unexpected value throws a `TypeError` rather than flowing through.
- `ArrayBuffer[Symbol.species]`, `buffer.constructor.prototype`, and `buffer.__proto__` still read wrong values through other paths. `Reflect.get` doesn't see a typed array's own named properties.

## Tests

Corpus programs, each run under Node and as a compiled binary:

- `discarded-logical-void-conditional.cjs`
- `regexp-call-without-new.cjs`
- `js-union-binding-later-writes.cjs`
- `builtin-prototype-feature-checks.cjs`
- `new-builtin-module-member/` (ESM namespace and default imports, and CommonJS `require` bindings)
- `promise-own-properties.cjs`
- `js-object-define-property-binding.cjs`
- `destructuring-capture-in-initializer.cjs`

The PR also includes their order baselines and cost estimates, and limitations updates for regular expressions, typed-array prototypes, and promise own properties.
