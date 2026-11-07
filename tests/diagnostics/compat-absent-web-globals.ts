// Web-platform globals Node 24 defines and scriptc does not implement:
// each use below is refused by name, which is the evidence the
// compatibility ledger cites for marking these rows a verified absence
// rather than an unverified registry gap.
const channel = new BroadcastChannel("updates");
channel.close();

const events = new EventSource("http://localhost:1/stream");
events.close();

const socket = new WebSocket("ws://localhost:1");
socket.close();

const pattern = new URLPattern({ pathname: "/books/:id" });
console.log(pattern.test("http://localhost/books/1"));

const gzip = new CompressionStream("gzip");
const gunzip = new DecompressionStream("gzip");
console.log(typeof gzip.readable, typeof gunzip.writable);

// The performance entry classes as global bindings. The entries that
// performance.mark() and performance.measure() return are implemented (the
// perf_hooks rows); the three global classes are not.
const mark = new PerformanceMark("m");
console.log(mark instanceof PerformanceEntry, mark instanceof PerformanceMeasure);
