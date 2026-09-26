// @dynamic
// A signal in an options record must not turn an injected static dependency into an island value.
interface Source { read(): number }
interface Options { source: Source; signal?: AbortSignal; controller?: AbortController }

const source: Source = { read: (): number => 7 };
const report = (options: Options): string =>
  `${options.source.read()}:${options.signal?.aborted}:${options.controller?.signal.aborted}`;

console.log(report({ source }));
const controller = new AbortController();
const options: Options = { source, signal: controller.signal, controller };
console.log(report(options));
controller.abort();
const copied: Options = { ...options };
console.log(report(copied));
