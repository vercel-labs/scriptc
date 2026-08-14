# Plan: Native MIDI messaging support for scriptc

Status: proposed · Owner: compiler+runtime · Target branch: `claude/midi-native-port-plan-1mmmsq`

## 1. Goal

MIDI messaging is available to JavaScript today in two shapes:

- **Web** — the [Web MIDI API](https://www.w3.org/TR/webmidi/): `navigator.requestMIDIAccess()`
  yields a `MIDIAccess` with `inputs`/`outputs` maps of `MIDIInput`/`MIDIOutput`
  ports; you receive with `input.onmidimessage` (a `MIDIMessageEvent` carrying a
  `Uint8Array` `data`) and transmit with `output.send(data, timestamp?)`.
- **Server (Node)** — native addons over the platform MIDI stacks, the de-facto
  standard being [`node-midi`](https://github.com/justinlatimer/node-midi) and its
  maintained fork [`@julusian/midi`](https://github.com/Julusian/node-midi)
  (RtMidi under the hood), plus the ergonomic wrapper
  [`easymidi`](https://github.com/dinchak/node-easymidi). Core surface:
  `new midi.Input()` / `new midi.Output()`, `getPortCount()`, `getPortName(i)`,
  `openPort(i)`, `openVirtualPort(name)`, `input.on('message', (dt, msg) => …)`,
  `output.sendMessage([status, d1, d2])`, `closePort()`, `ignoreTypes(...)`.

scriptc compiles TS/JS to **native executables** (macOS/Linux/Windows) and to
**WASI** wasm. There is no MIDI surface today. This plan ports **MIDI messaging
core features** — enumerate ports, open input/output (incl. virtual ports),
receive time-stamped messages via an event, and send raw messages — to
scriptc's native runtime, exposed through a Node-shaped `node:midi` module
surface that is differential-testable against a real Node baseline.

### Scope

**In scope (core messaging):**
- Port enumeration: `getPortCount()`, `getPortName(index)`.
- Input: `new Input()`, `openPort(i)`, `openVirtualPort(name)`, `closePort()`,
  `on('message', cb)` / `once('message', cb)`, `ignoreTypes(sysex, timing, sense)`.
- Output: `new Output()`, `openPort(i)`, `openVirtualPort(name)`, `closePort()`,
  `sendMessage(number[] | Uint8Array)`.
- Message payloads carry raw bytes (Note On/Off, CC, Program Change, Pitch Bend,
  channel pressure, and SysEx as a byte run) — the runtime is byte-transparent;
  it does not parse or validate message semantics. A thin optional decode helper
  (note/CC accessors) may follow but is **not** core.
- Delta-time (seconds since the previous message on that input), matching
  node-midi's `message` callback first argument.

**Out of scope (this port):**
- Browser Web MIDI in the WASI target (WASI Preview 1 has no MIDI capability — it
  fences, see §6). The *API shape* is modeled to stay portable, but the wasm
  target refuses MIDI at compile time like it does sockets.
- MIDI file (SMF) parsing, sequencing/clock scheduling, SysEx device protocols,
  MIDI 2.0 / UMP, virtual-MIDI on Windows (WinMM has no user-space virtual ports).
- `easymidi`-style semantic event names (`noteon`, `cc`, …). Those can be a
  pure-TS layer on top later; the native core stays raw-byte.

### Why a Node-module shape (not a Web-MIDI global)

The corpus is **differential against Node**: every program runs under Node and as
a native binary and must match stdout/stderr/exit byte-for-byte (AGENTS.md). Node
has no built-in MIDI, but `@julusian/midi` provides one under the same
`import midi from "midi"` name we target, **and** it supports `openVirtualPort`,
which gives us a hardware-free deterministic loopback for tests (open a virtual
output, open an input on that virtual port, send, receive, compare). Modeling on
the Web MIDI global would have no Node baseline to diff against. So: `node:midi`
module surface, API-compatible with node-midi/@julusian/midi.

## 2. How scriptc adds a native module surface (the dgram template)

`node:dgram` is the closest existing analog: an event-driven, message-oriented
device/socket handle whose reads feed the event loop. A MIDI input is
structurally the same (a pollable source delivering discrete messages), and a
MIDI output is like a connected UDP socket (`sendMessage` ≈ `send`). Every
touchpoint below is mirrored from dgram.

| Concern | dgram implementation | MIDI equivalent to build |
| --- | --- | --- |
| Ambient types | `declare module "dgram"` / `"node:dgram"` in `ambient/scriptc-node-fallback.d.ts` | `declare module "midi"` / `"node:midi"` |
| IR handle type | `dgramSocket` in `ir/nodes.ts` (kind union, `HANDLE_KINDS`, `DGRAMSOCK_T`, refcount predicate, `moduleUsesDgram`) | `midiInput`, `midiOutput` kinds + `moduleUsesMidi` |
| Type mapping | `types.ts` maps ambient `Socket` (declared in `dgram`) → `{kind:"dgramSocket"}` | ambient `Input`/`Output` → `midiInput`/`midiOutput` |
| Lowering spoke | `lowering/lower-dgram.ts` (module fns + method calls + event listeners), dispatched from `lowerer.ts` & `lower-calls.ts` | new `lowering/lower-midi.ts`, dispatched the same way |
| Module registry | `SUPPORTED_BUILTIN_MODULES` in `frontend/shared.ts`; builtin set in `frontend/npm.ts`; keys in `surfaces.ts` | add `"midi"` to all three |
| Runtime C | `runtime/src/scr_dgram.c` over the `scr_platform.h` poller seam | new `runtime/src/scr_midi.c` (+ platform backends) |
| Build inclusion | conditional TU behind `moduleUsesDgram`/`net` in `backend/cc.ts`, flagged from `index.ts` | conditional TU behind `moduleUsesMidi` |
| WASI fence | `index.ts` refuses `dgram.`/`dgramSocket` on WASI with SC3002 | refuse `midi`/`midiInput`/`midiOutput` on WASI |
| Tests | `tests/fixtures/dgram/cases/*`, `tests/corpus/*dgram*`, `tests/harness/dgram.test.ts` | `tests/fixtures/midi/*`, corpus, `tests/harness/midi.test.ts` |
| Docs | platforms / limitations / dependencies pages under `docs/` | same pages + a MIDI note |
| Manifest | projected into `surface-manifest.json` via `pnpm manifest` | regenerate |

## 3. Proposed API surface (ambient `.d.ts`)

Mirrors node-midi/@julusian/midi so the Node differential baseline is a real,
installable package.

```ts
declare module "midi" {
  export class Input {
    getPortCount(): number;
    getPortName(port: number): string;
    openPort(port: number): void;
    openVirtualPort(name: string): void;   // POSIX only; fences on Windows
    closePort(): void;
    isPortOpen(): boolean;
    // sysex, timing (clock), activeSensing — each true = ignore (node-midi default true,true,true)
    ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
    on(event: "message", listener: (deltaTime: number, message: number[]) => void): void;
    once(event: "message", listener: (deltaTime: number, message: number[]) => void): void;
  }
  export class Output {
    getPortCount(): number;
    getPortName(port: number): string;
    openPort(port: number): void;
    openVirtualPort(name: string): void;   // POSIX only; fences on Windows
    closePort(): void;
    isPortOpen(): boolean;
    sendMessage(message: number[] | Uint8Array): void;
  }
}
declare module "node:midi" { export * from "midi"; }
```

Constrained call forms (the surfaces.ts stance): `sendMessage` takes an array
literal or a `Uint8Array`; `on`/`once` accept only the `"message"` event with a
`(deltaTime, message)` void arrow/function of ≤2 params (the
`lowerCallbackArg` pattern from lower-dgram). Anything else fences
member-qualified with a named hint (never a silent drop).

## 4. Runtime design (`scr_midi.c` + platform backends)

### Handle model
`ScrMidiInput` and `ScrMidiOutput` are refcounted handles like `ScrDgramSocket`.
An **open input** holds the loop alive (a live source, like a bound socket);
an output does not (send is fire-and-forget). Both are freed on `closePort()`
+ last ref drop; the unit forgets any registered fd before closing it.

### Event-loop integration (the `scr_platform.h` seam)
The runtime already exposes a readiness poller: `scrp_poller_new`,
`scrp_watch_read(fd,…)`, `scrp_forget(fd)`, `scrp_drain(...)` (kqueue/epoll/wsapoll).
The loop (`scr_async.c`) will call a new `scr_midi_dispatch()` each turn, exactly
as it calls `scr_dgram_dispatch()`.

- **Linux — ALSA sequencer (`libasound`).** `snd_seq_open`, create a port,
  subscribe. ALSA exposes pollable fds via `snd_seq_poll_descriptors()` →
  register each with `scrp_watch_read`; on readiness `snd_seq_event_input()` and
  translate seq events to raw MIDI bytes (`snd_midi_event_decode`). Virtual ports
  are native (an ALSA port other clients connect to). **Container note:** ALSA
  dev headers are absent here (`/usr/include/alsa/asoundlib.h` missing) and CI has
  no sound stack — the Linux backend is written behind the seam and validated on a
  host with ALSA; loopback tests use the virtual-port pair so no hardware is needed.
- **macOS — CoreMIDI (`-framework CoreMIDI`).** `MIDIClientCreate`,
  `MIDIInputPortCreate` with a read callback that fires **on a CoreMIDI thread**.
  Bridge to the loop with a self-pipe/`eventfd`: the callback enqueues the packet
  on a mutex-guarded ring and writes one byte; the pipe read-end is registered
  with `scrp_watch_read`, so `scr_midi_dispatch` drains the ring on the loop
  thread and fires JS listeners there (never call into the runtime from the
  CoreMIDI thread). `MIDISourceCreate`/`MIDIDestinationCreate` back virtual ports.
- **Windows — WinMM (`winmm.lib`).** `midiInOpen` with a callback (also
  off-thread → same self-pipe bridge over `scr_loop_wsapoll.c`), `midiInAddBuffer`
  for SysEx, `midiOutShortMsg`/`midiOutLongMsg` to send. **No virtual ports** on
  WinMM → `openVirtualPort` fences at runtime with a clear error (documented
  divergence; WinRT MIDI is a later option).

### Delta-time
Each input tracks the timestamp of its previous delivered message and reports
`deltaTime` in **seconds** (node-midi's unit). First message after open reports
`0`. Use the platform timestamp where available (CoreMIDI packet time, ALSA
tick/real-time), else the loop clock.

### ABI contract (lowering ⇄ runtime) — keep parallel prototypes integrable
The lowering emits `IrLibFn` calls; the runtime implements these exact symbols.
Draft (finalize in the front-matter task, then freeze for the runtime task):

| lib fn id | C symbol | signature (conceptual) |
| --- | --- | --- |
| `midi.newInput` | `scr_midi_input_new` | `() -> ScrMidiInput*` |
| `midi.newOutput` | `scr_midi_output_new` | `() -> ScrMidiOutput*` |
| `midi.portCount` | `scr_midi_port_count` | `(handle, isInput) -> f64` |
| `midi.portName` | `scr_midi_port_name` | `(handle, idx) -> ScrString*` |
| `midi.openPort` | `scr_midi_open_port` | `(handle, idx) -> void` |
| `midi.openVirtual` | `scr_midi_open_virtual` | `(handle, ScrString* name) -> void` |
| `midi.closePort` | `scr_midi_close_port` | `(handle) -> void` |
| `midi.isOpen` | `scr_midi_is_open` | `(handle) -> bool` |
| `midi.ignoreTypes` | `scr_midi_ignore_types` | `(input, b,b,b) -> void` |
| `midi.send` (array) | `scr_midi_send_array` | `(output, ScrArr* number[]) -> void` |
| `midi.send` (bytes) | `scr_midi_send_bytes` | `(output, ScrBytes* Uint8Array) -> void` |
| `midi.onMessage` | `scr_midi_on_message` | `(input, closure, ScrMidiMsgFn fn, once) -> void` |
| `midi.dispatch` | `scr_midi_dispatch` | loop hook (internal, static) |

Message bytes are delivered to the JS closure as a `number[]` (the node-midi
shape) built by the runtime, with `deltaTime` as the first f64 argument.

**Reconciled during prototyping (both mirror the dgram spoke exactly):**
- `sendMessage` lowers to two marshalers picked by argument type —
  `scr_midi_send_array` for a `number[]` and `scr_midi_send_bytes` for a
  `Uint8Array` — over a raw `scr_midi_send(out, bytes*, len)` primitive
  (parallel to dgram's `send_str`/`send_bytes`).
- `on/once('message')` passes an adapter-thunk pointer selected by the
  listener's declared param count (`scr_midi_msg_thunk0/1/2`), because a user
  closure's compiled C arity (0/1/2 params) can't be invoked through one fixed
  signature — exactly dgram's `msg_thunk0/1` mechanism.
- The runtime registers its loop hook via `scr_loop_set_midi(...)` from
  `scr_midi_install()`; generated `main` must call `scr_midi_install()` under
  `moduleUsesMidi`, like `scr_dgram_install()`.
- Refcount symbols the C-emission layer calls: `scr_midi_input_retain/release`,
  `scr_midi_output_retain/release`, and their `_v` void* variants.

## 5. Testing strategy (hardware-free, differential)

The blocker for MIDI tests is "no hardware, must match Node byte-for-byte."
Solved by **virtual-port loopback**, supported by both `@julusian/midi` (Node
baseline) and the POSIX runtime backends:

1. Node baseline fixture uses `import midi from "midi"` (dev-dep `@julusian/midi`).
2. Program opens a virtual **Output** named e.g. `scriptc-test`, opens an
   **Input** and connects it to that virtual port, sends a deterministic
   sequence, prints each received message (and a fixed/synthetic deltaTime so
   output is stable), then closes.
3. Harness runs it under Node and native; stdout must match.

Determinism guards: print `message` bytes only (not wall-clock deltaTime — round
or replace with a monotonic counter in the test program); enumerate ports by a
name filter, not index, since index ordering varies. Gate the corpus case on
platform capability (POSIX virtual ports) like other capability-gated cases.
Windows and CI-without-ALSA lanes get compile-coverage + fence tests only.

Also: fence/diagnostics snapshot tests (unsupported event names, bad
`sendMessage` args, `openVirtualPort` on Windows, any MIDI use on WASI → SC3002).

## 6. WASI / web boundary
WASI Preview 1 has no MIDI capability. Follow the socket precedent in
`index.ts`: refuse `midi`/`midiInput`/`midiOutput` at compile time for the wasm
target with SC3002 and a message pointing at the platform-support page. Document
that Web MIDI (browser) is a separate runtime not covered by the WASI target.

## 7. Risks & open questions
- **ALSA/CoreMIDI/WinMM link flags** must be added conditionally only when a
  program uses MIDI (don't burden every binary). Mirror the fetch/curl
  conditional-link precedent in `cc.ts`.
- **Off-thread callbacks** (CoreMIDI/WinMM) must never touch the runtime heap;
  the self-pipe bridge is mandatory. Reference-count audit (the sanitized lane)
  will catch violations.
- **CI has no ALSA/sound** → Linux native MIDI validated on a real host; CI keeps
  fence + compile tests. Flag this to maintainers.
- **deltaTime nondeterminism** → tests must not print raw timing.
- Decide whether `getPortCount`/`getPortName` also work on a fresh handle before
  `openPort` (node-midi allows it — enumerate then open). Plan: yes.

---

## TODO checklist

### Phase 0 — Design freeze
- [ ] Confirm API shape against installed `@julusian/midi@3.8.1` (method names, arg order, defaults).
- [ ] Freeze the lowering⇄runtime ABI table (§4) so parallel work integrates.

### Phase 1 — Compiler front (ambient + IR + types)
- [ ] Add `declare module "midi"` and `"node:midi"` to `ambient/scriptc-node-fallback.d.ts`.
- [ ] Add IR handle kinds `midiInput`/`midiOutput` in `ir/nodes.ts`: kind union, `HANDLE_KINDS`, `*_T` consts, refcount predicate, `moduleUsesMidi`, type-name mapping.
- [ ] Map ambient `Input`/`Output` (declared in `midi`) → handle kinds in `frontend/types.ts`.
- [ ] Register `"midi"` in `SUPPORTED_BUILTIN_MODULES` (`frontend/shared.ts`) and the builtin set in `frontend/npm.ts`.

### Phase 2 — Lowering spoke
- [ ] Create `lowering/lower-midi.ts`: constructors (`new Input()`/`new Output()`), methods (`getPortCount`/`getPortName`/`openPort`/`openVirtualPort`/`closePort`/`isPortOpen`/`ignoreTypes`/`sendMessage`), and the `on`/`once` `"message"` listener (reuse the `lowerCallbackArg` shape).
- [ ] Add `midi: {}` key + fence hint in `lowering/surfaces.ts`.
- [ ] Dispatch the spoke from `lowerer.ts` and `lower-calls.ts` (module calls + method calls on the handle receivers), mirroring `lowerDgramDnsModuleCall`.
- [ ] Statement-position + arg-shape fences with named hints (no silent drops).

### Phase 3 — Runtime C
- [ ] `runtime/src/scr_midi.c`: handle structs, refcount, loop liveness, `scr_midi_dispatch`, the ABI symbols from §4.
- [ ] Linux ALSA-seq backend (`snd_seq_*`, poll descriptors → poller, virtual ports).
- [ ] macOS CoreMIDI backend (client/ports, self-pipe bridge from the CoreMIDI thread, virtual sources/destinations).
- [ ] Windows WinMM backend (`midiIn*`/`midiOut*`, self-pipe bridge, `openVirtualPort` runtime fence).
- [ ] Wire `scr_midi_dispatch()` into the loop in `scr_async.c`.

### Phase 4 — Build wiring
- [ ] `moduleUsesMidi` flag threaded from `index.ts` into the backend options.
- [ ] Conditional TU compilation of `scr_midi.c` in `backend/cc.ts`, with conditional platform link flags (`-lasound` / `-framework CoreMIDI` / `winmm.lib`).
- [ ] WASI fence (SC3002) for any MIDI surface in `index.ts`.

### Phase 5 — Tests & docs
- [ ] `tests/fixtures/midi/cases/*`: virtual-port loopback differential program(s); add `@julusian/midi` dev-dep for the Node baseline.
- [ ] `tests/harness/midi.test.ts` + a `tests/corpus/*` case (capability-gated).
- [ ] Diagnostics snapshots: unsupported event, bad `sendMessage`, `openVirtualPort` on Windows, MIDI on WASI.
- [ ] Docs: platform-support, limitations, dependencies pages; CHANGELOG entry.
- [ ] Regenerate `surface-manifest.json` (`pnpm manifest`).

### Phase 6 — Validation
- [ ] `pnpm -r build` clean; `pnpm lint` clean.
- [ ] `pnpm test:sandbox` (plain + sanitized) green; native MIDI loopback validated on a host with ALSA/CoreMIDI.
