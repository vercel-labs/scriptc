import { expect, test } from "vitest";
import {
  embeddedModulesUsingGlobalFetch,
  type EmbeddedModule,
} from "../src/frontend/npm.js";

function js(key: string, source: string): EmbeddedModule {
  return { key: `/${key}.js`, source, format: "cjs" };
}

test("embedded fetch capability analysis ignores text and local bindings", () => {
  const modules = [
    js("comment", "// fetch(url)\nmodule.exports = 1;"),
    js("string", "module.exports = 'fetch(url)';"),
    js("property", "const value = { fetch: 1 }; module.exports = value.fetch;"),
    js("local", "const fetch = (x) => x; module.exports = fetch('local');"),
    js("parameter", "module.exports = function (fetch) { return fetch('local'); };"),
    js("import", "import fetch from 'a-local-package'; export default fetch('local');"),
    js("named-import", "import { fetch as request } from 'pure-local'; export default request('local');"),
    js("named-reexport", "export { fetch as request } from 'pure-local';"),
    js("shadow-global", "module.exports = function (globalThis) { return globalThis.fetch('local'); };"),
    js("object-destructure", "const source = { fetch: 1 }; const { fetch: request } = source; module.exports = request;"),
    js("local-alias", "const source = { fetch: 1 }; const root = source; module.exports = root.fetch;"),
    js("shadowed-alias", "const root = globalThis; module.exports = function (root) { return root.fetch; };"),
    js("label", "fetch: for (;;) { break fetch; } module.exports = 1;"),
  ];

  expect([...embeddedModulesUsingGlobalFetch(modules)]).toEqual([]);
});

test("embedded fetch capability analysis finds global reads", () => {
  const modules = [
    js("bare", "module.exports = fetch('https://example.com');"),
    js("shorthand-property", "module.exports = { fetch };"),
    js("global-this", "module.exports = globalThis.fetch('https://example.com');"),
    js("global", "module.exports = global['fetch']('https://example.com');"),
    js("destructure", "const { fetch } = globalThis; module.exports = fetch;"),
    js("destructure-alias", "const { fetch: request } = global; module.exports = request;"),
    js("destructure-computed", "const { ['fetch']: request } = globalThis; module.exports = request;"),
    js("destructure-assign", "let request; ({ fetch: request } = globalThis); module.exports = request;"),
    js("global-alias", "const root = globalThis; module.exports = root.fetch;"),
    js("global-logical-alias", "const root = globalThis || global; module.exports = root.fetch;"),
    js("global-nullish-alias", "const root = globalThis ?? global; module.exports = root.fetch;"),
    js("global-conditional-alias", "const root = typeof globalThis === 'undefined' ? global : globalThis; module.exports = root.fetch;"),
    js("global-mutable-alias", "let root = globalThis; module.exports = root.fetch;"),
    js("global-alias-chain", "const root = global; const platform = root; module.exports = platform['fetch'];"),
    js("global-alias-destructure", "const root = globalThis; const { fetch: request } = root; module.exports = request;"),
    {
      ...js("windows-path", "module.exports = fetch('https://example.com');"),
      key: "C:\\pkg\\index.js",
    },
  ];

  expect([...embeddedModulesUsingGlobalFetch(modules)]).toEqual([
    "/bare.js",
    "/shorthand-property.js",
    "/global-this.js",
    "/global.js",
    "/destructure.js",
    "/destructure-alias.js",
    "/destructure-computed.js",
    "/destructure-assign.js",
    "/global-alias.js",
    "/global-logical-alias.js",
    "/global-nullish-alias.js",
    "/global-conditional-alias.js",
    "/global-mutable-alias.js",
    "/global-alias-chain.js",
    "/global-alias-destructure.js",
    "C:\\pkg\\index.js",
  ]);
});
