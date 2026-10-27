import ts5 from "typescript5";
import { afterAll, describe, expect, it } from "vitest";
import { jsxEmitPlan, decodeEntities, jsxPragmas, jsxTextValue, lowerJsx } from "./jsx-source.js";
import { closeSourceParser, parseSourceFile } from "./ts7/source-parser-node.js";

afterAll(() => closeSourceParser());

/** Evaluates a program whose last statement is `result = ...`, with `h` and
 * `Fragment` recording the calls the JSX makes. */
function evaluate(code: string): unknown {
  const run = new Function(
    "h",
    "Fragment",
    "React",
    `"use strict"; let result; ${code}; return result;`,
  ) as (...args: unknown[]) => unknown;
  const h = (tag: unknown, props: unknown, ...children: unknown[]): unknown => ({
    tag: typeof tag === "function" ? `fn:${tag.name}` : tag === Fragment ? "#fragment" : tag,
    props,
    children,
  });
  const Fragment = { fragment: true };
  return run(h, Fragment, { createElement: h, Fragment });
}

/** TypeScript's own classic-runtime emit of the snippet. */
function typescriptEmit(source: string, factory?: string): string {
  return ts5.transpileModule(source, {
    fileName: "case.tsx",
    compilerOptions: {
      target: ts5.ScriptTarget.ES2022,
      module: ts5.ModuleKind.ESNext,
      jsx: ts5.JsxEmit.React,
      ...(factory === undefined ? {} : { jsxFactory: factory, jsxFragmentFactory: "Fragment" }),
    },
  }).outputText;
}

function rewrite(source: string, factory?: string): string {
  const sf = parseSourceFile("/case.tsx", source, "tsx");
  const plan = jsxEmitPlan(
    {
      jsx: "react",
      ...(factory === undefined ? {} : { jsxFactory: factory, jsxFragmentFactory: "Fragment" }),
    },
    jsxPragmas(source),
  );
  return lowerJsx(sf, plan).text;
}

const cases: Record<string, string> = {
  "attributes and text": `const name = "w"; const p = { id: 1 };
result = <div class="hello" data-x='1' disabled {...p} title={name}>Hello {name}  &amp; &#x41; &copy;
   second   line
  {/* comment */}
  {name}{" "}<b>bold</b>
</div>;`,
  fragments: `function Foo() {} Foo.Bar = function Bar() {};
result = <><i /><Foo.Bar x={1} /></>;`,
  namespaced: `result = <ns:tag a:b="c" />;`,
  "keys and nested maps": `const p = { id: 1 };
result = <div key="k" {...p}>{[1, 2].map((n) => <span key={n}>{n}</span>)}</div>;`,
  "white space only": `result = [<div>   </div>, <div>
</div>, <div>   a   {"b"}   c   </div>];`,
  "spreads": `const p = { id: 1 }; const kids = [1, 2];
result = [<div {...p} />, <div {...p} {...p} />, <div>{...kids}</div>, <div {...{ a: 1, b: 2 }} c={3} />, <div {...{ __proto__: null, a: 1 }} />];`,
  "attribute strings": `result = <div title="a &amp; b &unknown; &#65; &#x1F600;" alt="line
two" empty="" />;`,
  "attribute values": `result = <div a={} b=<i /> c={<b>{1}</b>} d={[<p />]} />;`,
  "member and this tags": `class X { Tag = function Tag() {}; render() { return <this.Tag x="1" />; } }
result = new X().render();`,
  "dashed and capitalized names": `function Comp() {}
result = [<a-b />, <Comp $x="1" _y="2" z-w="3" />];`,
  "nested JSX in expressions": `const items = ["a", "b"];
result = <ul>
  {items.length > 1 ? <li>{items[0]}</li> : null}
  {items.map((item) =>
    <li
      key={item}
      title={item}
    >
      {item}
    </li>)}
</ul>;`,
};

describe("lowerJsx", () => {
  for (const [name, source] of Object.entries(cases)) {
    it(`matches TypeScript's emit: ${name}`, () => {
      const lowered = rewrite(source);
      expect(evaluate(lowered)).toEqual(evaluate(typescriptEmit(source)));
      expect(lowered.split("\n").length).toBe(source.split("\n").length);
    });
  }

  it("uses jsxFactory and the pragmas", () => {
    const source = `result = <><x a="1" /></>;`;
    expect(evaluate(rewrite(source, "h"))).toEqual(evaluate(typescriptEmit(source, "h")));
    const pragma = `/** @jsx h */\n/** @jsxFrag Fragment */\nresult = <><x /></>;`;
    expect(rewrite(pragma)).toContain(`h(Fragment, null`);
    expect(evaluate(rewrite(pragma))).toEqual(evaluate(typescriptEmit(pragma)));
  });

  it("keeps every byte outside JSX", () => {
    const source = `const a = 1; // <not jsx>\nconst b = "<div>";\nresult = [a, b, <i />];\n`;
    const lowered = rewrite(source);
    expect(
      lowered.startsWith(`const a = 1; // <not jsx>\nconst b = "<div>";\nresult = [a, b, `),
    ).toBe(true);
  });

  it("maps rewritten positions back to the source", () => {
    const source = `const x = 1;\nresult = <div a={x}>{x}</div>;\nconst y = 2;\n`;
    const sf = parseSourceFile("/case.tsx", source, "tsx");
    const lowered = lowerJsx(sf, { runtime: "classic", factory: "h", fragment: "Fragment" });
    const after = lowered.text.indexOf("const y");
    expect(lowered.originalPosition(after)).toBe(source.indexOf("const y"));
    const copied = lowered.text.indexOf("{ a: x }") + "{ a: ".length;
    expect(lowered.originalPosition(copied)).toBe(source.indexOf("{x}>") + 1);
    expect(lowered.originalPosition(lowered.text.indexOf("h("))).toBe(source.indexOf("<div"));
  });
});

/** Evaluates automatic-runtime output: each runtime import becomes a
 * binding of a recording function (`jsx`, `jsxs`, `jsxDEV`, `createElement`)
 * or of the fragment marker, under the local name the output chose. */
function evaluateAutomatic(code: string): unknown {
  const body = code
    .replace(/import \{([^}]*)\} from "[^"]*";/g, (_match, list: string) =>
      list
        .split(",")
        .map((item) => {
          const [name, local] = item.trim().split(/\s+as\s+/);
          return `const ${local} = runtime.${name};`;
        })
        .join(" "),
    )
    .replace(/(^|\s)export /gm, "$1");
  const record =
    (kind: string) =>
    (...args: unknown[]): unknown => ({ kind, args: args.map(named) });
  const runtime = {
    jsx: record("jsx"),
    jsxs: record("jsxs"),
    jsxDEV: record("jsxDEV"),
    createElement: record("createElement"),
    Fragment: "#fragment",
  };
  const run = new Function("runtime", `"use strict"; let result; ${body}; return result;`) as (
    runtime: unknown,
  ) => unknown;
  return run(runtime);
}

/** Functions compare by name: each evaluation declares its own. */
function named(value: unknown): unknown {
  if (typeof value === "function") return `fn:${value.name}`;
  if (Array.isArray(value)) return value.map(named);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, named(item)]));
  return value;
}

function typescriptAutomatic(source: string, development: boolean): string {
  return ts5.transpileModule(source, {
    fileName: "/case.tsx",
    compilerOptions: {
      target: ts5.ScriptTarget.ES2022,
      module: ts5.ModuleKind.ESNext,
      jsx: development ? ts5.JsxEmit.ReactJSXDev : ts5.JsxEmit.ReactJSX,
    },
  }).outputText;
}

function rewriteAutomatic(source: string, development: boolean): string {
  const sf = parseSourceFile("/case.tsx", source, "tsx");
  const plan = jsxEmitPlan({ jsx: development ? "react-jsxdev" : "react-jsx" }, jsxPragmas(source));
  return lowerJsx(sf, plan).text;
}

const automaticCases: Record<string, string> = {
  ...cases,
  "keys": `const p = { id: 1 };
result = [<li key="a">x</li>, <li {...p} key="b" />, <li key="c" {...p} />, <li {...{ a: 1 }} key="d" />, <li {...{ ...p }} key="e" />];`,
  "children shapes": `const kids = [1, 2];
result = [<p />, <p>{}</p>, <p>
</p>, <p>one</p>, <p>{1}{2}</p>, <p>{...kids}</p>, <p>  </p>, <><b /></>, <></>];`,
  "names in use": `const _jsx = "taken"; const _jsxs = 1;
result = [<p>{_jsx}</p>, <p>{_jsxs}{_jsx}</p>];`,
};

describe("lowerJsx with the automatic runtime", () => {
  for (const [name, source] of Object.entries(automaticCases)) {
    for (const development of [false, true]) {
      it(`matches TypeScript's ${development ? "react-jsxdev" : "react-jsx"} emit: ${name}`, () => {
        const lowered = rewriteAutomatic(`export {};\n${source}`, development);
        const expected = typescriptAutomatic(`export {};\n${source}`, development);
        expect(evaluateAutomatic(lowered)).toEqual(evaluateAutomatic(expected));
        expect(lowered.split("\n").length).toBe(source.split("\n").length + 1);
      });
    }
  }

  it("imports the runtime functions on the first statement's line", () => {
    const lowered = rewriteAutomatic(
      `"use strict";\nexport const a = <><b key="k" /></>;\n`,
      false,
    );
    expect(lowered).toBe(
      `"use strict";import { jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime"; \nexport const a = _jsx(_Fragment, { children: _jsx("b", {}, "k") });\n`,
    );
  });

  it("reads @jsxImportSource and @jsxRuntime", () => {
    const pragma = `/** @jsxImportSource preact */\nexport const a = <b />;\n`;
    expect(rewriteAutomatic(pragma, false)).toContain(`from "preact/jsx-runtime"`);
    const classic = `/** @jsxRuntime classic */\n/** @jsx h */\nexport const a = <b />;\n`;
    expect(rewriteAutomatic(classic, false)).toContain(`h("b", null)`);
  });
});

describe("JSX text", () => {
  it("trims lines as TypeScript does", () => {
    expect(jsxTextValue("  a  \n   b  \n  ")).toBe("  a b");
    expect(jsxTextValue("\n   \n")).toBeUndefined();
    expect(jsxTextValue("   ")).toBe("   ");
  });

  it("decodes entities", () => {
    expect(decodeEntities("&lt;&gt;&amp;&nbsp;&#65;&#x42;&bogus;&#x110000;")).toBe(
      "<>& AB&bogus;&#x110000;",
    );
  });
});

describe("jsxPragmas", () => {
  it("reads leading multi-line comments, first @jsx and last @jsxImportSource", () => {
    expect(
      jsxPragmas(
        "#!/usr/bin/env node\n/** @jsx h\n * @jsx g */\n// @jsxFrag F\n/* @jsxImportSource a */ /* @jsxImportSource b */\nconst x = 1; /** @jsx late */",
      ),
    ).toEqual({ jsx: "h", jsxImportSource: "b" });
  });
});
