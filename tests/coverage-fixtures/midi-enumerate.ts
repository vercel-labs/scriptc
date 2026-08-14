// A fully static node:midi enumerate program: construct the port handles,
// read the port counts (node-midi allows enumeration on a fresh handle
// before openPort), print them, and close. No dynamic remainder — every
// statement lowers, so coverage must pin it at 100% static.
import { Input, Output } from "midi";

const input = new Input();
const output = new Output();

const inputPorts = input.getPortCount();
const outputPorts = output.getPortCount();

console.log("inputs", inputPorts);
console.log("outputs", outputPorts);

for (let i = 0; i < inputPorts; i++) {
  console.log("input", i, input.getPortName(i));
}
for (let i = 0; i < outputPorts; i++) {
  console.log("output", i, output.getPortName(i));
}

input.closePort();
output.closePort();
