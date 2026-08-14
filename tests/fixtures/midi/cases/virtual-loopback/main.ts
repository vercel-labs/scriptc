// The hardware-free MIDI differential: a virtual-port loopback. An open
// virtual Output and an Input connected to it live in one process, so no
// real device is needed — but the pair still requires a POSIX MIDI backend
// with virtual ports (ALSA sequencer / CoreMIDI), which CI here does not
// have, so tests/harness/midi.test.ts GATES this case and skips it when no
// backend is present. On a host that has one it runs under both Node (the
// @julusian/midi dev-dep aliased to "midi") and the native binary, and the
// two stdouts must match byte-for-byte.
//
// Determinism: deltaTime is wall-clock time between messages and is NEVER
// printed; only the received message bytes are, one line per message. Ports
// are located by NAME, not index, since index ordering varies across hosts.
import { Input, Output } from "midi";

const PORT_NAME = "scriptc-loopback";

const output = new Output();
output.openVirtualPort(PORT_NAME);

const input = new Input();

// Locate the virtual output by name (index ordering is host-dependent).
let portIndex = -1;
const portCount = input.getPortCount();
for (let i = 0; i < portCount; i++) {
  if (input.getPortName(i).includes(PORT_NAME)) {
    portIndex = i;
    break;
  }
}

// Deliver everything (do not drop SysEx/timing/sense) so the byte stream is
// exactly what was sent.
input.ignoreTypes(false, false, false);

const messages: number[][] = [
  [0x90, 60, 100], // note on,  channel 1
  [0xb0, 7, 64], //   control change (volume)
  [0x80, 60, 0], //   note off, channel 1
];

let received = 0;
input.on("message", (_deltaTime, message) => {
  // Print only the bytes — never the nondeterministic deltaTime.
  console.log(message.join(" "));
  received += 1;
  if (received === messages.length) {
    // The open input holds the loop alive; closing both drains it and exits.
    input.closePort();
    output.closePort();
  }
});

input.openPort(portIndex);
for (const m of messages) {
  output.sendMessage(m);
}
