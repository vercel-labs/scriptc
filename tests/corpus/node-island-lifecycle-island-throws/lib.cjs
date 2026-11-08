"use strict";
class IslandError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = "IslandError";
    this.extra = extra;
  }
  describe() {
    return `IslandError(${this.message})`;
  }
}
class Deep extends IslandError {}
function make(kind) {
  switch (kind) {
    case "Error": return new Error("plain");
    case "TypeError": return new TypeError("type");
    case "RangeError": return new RangeError("range");
    case "SyntaxError": return new SyntaxError("syntax");
    case "ReferenceError": return new ReferenceError("reference");
    case "EvalError": return new EvalError("eval");
    case "URIError": return new URIError("uri");
    case "custom": return new IslandError("custom", { k: 1 });
    case "deep": return new Deep("deep", [1, 2]);
    case "code": return Object.assign(new Error("with code"), { code: "E_ISLAND", errno: -2, syscall: "open", path: "/x" });
    case "cause": return new Error("outer", { cause: new TypeError("inner", { cause: "root string" }) });
    case "aggregate": return new AggregateError([new Error("a"), new TypeError("b"), "c"], "many");
    case "renamed": { const e = new Error("renamed"); e.name = "Whatever"; return e; }
    case "nomessage": return new Error();
    case "node": try { require("node:fs").readFileSync("/nonexistent/x"); } catch (e) { return e; } break;
    case "assert": try { require("node:assert").strictEqual(1, 2); } catch (e) { return e; } break;
    case "abort": return new DOMException("aborted", "AbortError");
    case "string": return "a string";
    case "number": return 42;
    case "null": return null;
    case "undefined": return undefined;
    case "object": return { message: "not an error", code: 7 };
    case "bigint": return 10n;
    case "boolean": return false;
    case "array": return [1, "two"];
  }
  throw new Error(`unknown kind ${kind}`);
}
exports.kinds = ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "custom", "deep", "code", "cause", "aggregate", "renamed", "nomessage", "node", "assert", "abort", "string", "number", "null", "undefined", "object", "bigint", "boolean", "array"];
exports.throwSync = (kind) => { throw make(kind); };
exports.reject = (kind) => Promise.reject(make(kind));
exports.rejectLater = (kind) => new Promise((_, r) => setTimeout(() => r(make(kind)), 1));
exports.asyncThrow = async (kind) => { await null; throw make(kind); };
exports.IslandError = IslandError;
exports.Deep = Deep;
