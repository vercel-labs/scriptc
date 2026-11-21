// util.inspect(object, options): the option record applies per call — a
// literal (colors included) and a record held in a variable read the same
// knobs, and a knob the record omits keeps Node's default.
import util from "node:util";
const value = { a: 1, b: { c: 2 }, arr: [1, 2, 3, 4], s: "hello", [Symbol("sym")]: 1 };
const asOptions = (options) => options;
const show = (label, options) => console.log(label, JSON.stringify(util.inspect(value, options)));
show("defaults", asOptions({}));
show("colors literal", { colors: true });
show("colors record", asOptions({ colors: true }));
show("depth0", asOptions({ depth: 0 }));
show("depthNull", asOptions({ depth: null }));
show("showHidden", asOptions({ showHidden: true }));
show("compactFalse", asOptions({ compact: false, breakLength: 20 }));
show("compactNum", asOptions({ compact: 5 }));
show("sorted", asOptions({ sorted: true }));
show("maxArrayLength", asOptions({ maxArrayLength: 2 }));
show("maxArrayLengthNull", asOptions({ maxArrayLength: null }));
show("maxStringLength", asOptions({ maxStringLength: 2 }));
show("numericSeparator", asOptions({ numericSeparator: true }));
show("getters", asOptions({ getters: true }));
show("customInspectFalse", asOptions({ customInspect: false }));
show("unknownKnob", asOptions({ nope: 1 }));
