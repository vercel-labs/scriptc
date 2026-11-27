// A literal import("pkg") of a package nothing imports statically: the
// specifier is known at build time, so the package joins the compiled module
// graph, and the site evaluates it at the call, on the microtask Node
// evaluates it on. Two imports of the same package answer one namespace.
const first = await import("lazypkg");
console.log(first.greet(3), first.count, first.default);
console.log(Object.keys(first).sort().join(","));

const second = await import("lazypkg");
console.log(second === first, second.greet(4));
const third = await import("lazypkg");
console.log(third.greet(5));
