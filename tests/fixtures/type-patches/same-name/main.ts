// panectx and gridctx each declare an OutputContext of the same shape:
// each failing check's TypeError names its own package's declaration
// (native only; Node never checks).
import { Terminal as PaneTerminal } from "panectx";
import { Terminal as GridTerminal } from "gridctx";

const pane = new PaneTerminal(false);
const grid = new GridTerminal(false);
for (const read of [() => pane.outputContext(false).width, () => grid.outputContext(false).width]) {
  try {
    console.log(read());
  } catch (e) {
    console.log((e as Error).message);
  }
}
