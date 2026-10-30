// String.prototype.match and search with an untyped pattern: a RegExp is used as is,
// any other value builds new RegExp(value), as hono's matcher does.
const matchers = { GET: [/^\/a\/([^/]+)$()|^\/b$()/, [0, 1], {}] };
function match(method, path) {
  const matcher = matchers[method] || matchers["ALL"];
  const m = path.match(matcher[0]);
  if (!m) return null;
  return [m.indexOf("", 1), m.length, m[1], m.index];
}
console.log(JSON.stringify(match("GET", "/a/xy")));
console.log(JSON.stringify(match("GET", "/b")));
console.log(JSON.stringify(match("GET", "/c")));
const g = { re: /o/g, s: "o.", n: null };
function m2(s, k) { return s.match(g[k]); }
console.log(JSON.stringify(m2("foo boo", "re")), JSON.stringify(m2("go.o", "s")), JSON.stringify(m2("null", "n")));
