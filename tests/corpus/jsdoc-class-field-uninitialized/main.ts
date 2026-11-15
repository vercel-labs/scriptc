// A JavaScript class that declares a field for its JSDoc type alone holds
// `undefined` there until the constructor assigns it, exactly what Node
// runs; the checker's strict "has no initializer" demand is not a runtime
// rule. The module compiles and the values answer Node's.
import { Widget, snapshot } from "./widget.js";

const widget = new Widget("a");
console.log(snapshot(widget));
console.log(widget.label(), widget.props_def, "props_def" in widget);
