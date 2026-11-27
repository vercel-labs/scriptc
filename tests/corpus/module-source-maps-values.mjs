// node:module's source-map support in JavaScript: the record's shape, the
// argument ladders of setSourceMapsSupport (Node's validateObject and
// validateBoolean, the option members read before either is validated), the
// coupling with process.sourceMapsEnabled, and findSourceMap's never-throwing
// answers. A compiled program registers no source map, so findSourceMap
// answers undefined exactly where Node has no parsed map for the file.
import * as nodeModule from "node:module";
import defaultModule from "node:module";

const show = (label, call) => {
  try {
    console.log(label, call());
  } catch (error) {
    console.log(
      label,
      "throws",
      error.name,
      error.code,
      JSON.stringify(error.message),
      error instanceof TypeError,
    );
  }
};

const support = nodeModule.getSourceMapsSupport();
console.log(support);
console.log(JSON.stringify(support));
console.log(
  Object.isFrozen(support),
  Object.getPrototypeOf(support) === null,
  Object.keys(support),
  Object.getOwnPropertyNames(support),
);
console.log(nodeModule.getSourceMapsSupport() === support, support === defaultModule.getSourceMapsSupport());
try {
  support.enabled = true;
  console.log("write", support.enabled);
} catch (error) {
  console.log("write throws", error.name, error instanceof TypeError, support.enabled);
}

// The functions are values.
const { setSourceMapsSupport, findSourceMap } = nodeModule;
console.log(
  typeof nodeModule.getSourceMapsSupport,
  nodeModule.getSourceMapsSupport.name,
  nodeModule.getSourceMapsSupport.length,
  setSourceMapsSupport.name,
  setSourceMapsSupport.length,
  findSourceMap.name,
  findSourceMap.length,
);
const held = { set: setSourceMapsSupport, find: findSourceMap };
console.log(held.set(true), held.find("/tmp/none.js"), nodeModule.getSourceMapsSupport().enabled);
console.log(setSourceMapsSupport.call(null, false), defaultModule.findSourceMap?.("node:test"));

// Node's validation ladder.
show("no args", () => setSourceMapsSupport());
show("undefined", () => setSourceMapsSupport(undefined));
show("null", () => setSourceMapsSupport(null));
show("number", () => setSourceMapsSupport(1));
show("string", () => setSourceMapsSupport("true"));
show("number option", () => setSourceMapsSupport(true, 5));
show("null option", () => setSourceMapsSupport(true, null));
show("string option", () => setSourceMapsSupport(true, "x"));
show("nodeModules number", () => setSourceMapsSupport(true, { nodeModules: 1 }));
show("generatedCode number", () => setSourceMapsSupport(true, { generatedCode: "1" }));
show("generatedCode null", () => setSourceMapsSupport(true, { generatedCode: null }));
show("unknown option", () => setSourceMapsSupport(true, { nope: 1 }));
show("array option", () => setSourceMapsSupport(true, []));
show("extra argument", () => setSourceMapsSupport(true, {}, 3));

// The option members are read in Node's order before either is validated.
const log = [];
const note = (value) => {
  log.push(value);
  return value;
};
try {
  setSourceMapsSupport(
    true,
    {
      get nodeModules() {
        log.push("nodeModules read");
        return note(1);
      },
      get generatedCode() {
        log.push("generatedCode read");
        return note("x");
      },
    },
  );
} catch (error) {
  log.push(error.code);
}
console.log(log);

// process.setSourceMapsEnabled and the module record are one state.
nodeModule.setSourceMapsSupport(true, { nodeModules: true, generatedCode: true });
console.log("shared", process.sourceMapsEnabled, JSON.stringify(nodeModule.getSourceMapsSupport()));
process.setSourceMapsEnabled(false);
console.log("shared off", process.sourceMapsEnabled, JSON.stringify(nodeModule.getSourceMapsSupport()));

// findSourceMap never throws.
show("find none", () => findSourceMap("/tmp/module-source-maps-none.js"));
show("find non-string", () => findSourceMap(5));
show("find no args", () => findSourceMap());
show("find node:", () => findSourceMap("node:fs"));
show("find under node_modules", () => findSourceMap("/tmp/node_modules/x/index.js"));
show("find data:", () => findSourceMap("data:text/javascript,1"));
show("find file url", () => findSourceMap("file:///tmp/module-source-maps-none.js"));
