// A console method used as a value formats the arguments it is called
// with as Node's method does: util.format over the whole list, whatever
// their types, one line to stdout or stderr.
const { log, error } = console;

log("%s is %d years, %i whole, %f exact, %j, %o, %O, 100%%, %cdone", "Bob", 42.5, 42.9, 1.5, { a: 1 }, [1], { b: { c: {} } }, "css");
log("%s", "only", "extra", 1, { trailing: true });
log("no specifier", "%s", "kept");
log(1, "%s", "not a format");
log("%d %d", 1);
log("%s %s", "one");
log("%%s %s", "escaped");
log("a%");
log("%x %s", "unknown specifier");
error("%s failed with code %d", "step", 3);
error("warn %o", { nested: [1, { deep: true }] });

log("text", 7, true, null, undefined, -0, 0, NaN, 1e21, 10n, Symbol("tag"));
log({ x: 1, y: [1, 2, { z: 3 }] }, [1, "s", [2, [3, [4]]]]);
log(new Map([[1, { a: 1 }]]), new Set(["a", 2]));
log({ a: { b: { c: { d: { e: 1 } } } } });
log(["quoted", "strings"], "bare string");
log(() => 1, function named() {}, class Widget {});
log([undefined, null], { u: undefined, n: null });
log(new Date(0), [new Date(86400000)]);
log("");
log();
log("multi\nline", ["multi\nline"]);
log("%s %s %s", 1n, Symbol("s"), null);
log("%d %d %d %d", "42", "x", 1n, {});
log("%i %f", "42.9px", "1.5e3");
log("%j", { a: [1, { b: 2 }] });

// The three positions an array iteration method passes.
["x", "y"].forEach(log);
[{ id: 1 }, { id: 2 }].forEach(error);
new Map([["k", 1]]).forEach(log);
new Set([true]).forEach(log);

// Group indentation applies to a stored method as to a direct call.
console.group("group");
log("inside", 1);
error("inside error");
console.group();
log("%s deep", "two");
console.groupEnd();
console.groupEnd();
log("outside");
