// The real @opentelemetry/api (1.9.0, its CommonJS build) with no SDK
// registered: the metrics and trace entry points answer their no-op
// implementations. The package's tsc output opens each module with an
// `exports.X = void 0` preamble and builds its enums through
// `exports.E || (exports.E = {})`, and its index adds a default-export
// object next to the named re-exports.
import { metrics, trace, DiagLogLevel, SpanKind, type Counter } from "@opentelemetry/api";

let counter: Counter | undefined;
function getCounter(): Counter {
  if (!counter) {
    counter = metrics.getMeter("example-meter").createCounter("example.count", {
      description: "counts examples",
    });
  }
  return counter;
}

getCounter().add(1, { reason: "first" });
getCounter().add(2);
console.log("meter provider", typeof metrics.getMeterProvider().getMeter);
console.log("levels", DiagLogLevel.ERROR, DiagLogLevel.DEBUG, DiagLogLevel[DiagLogLevel.WARN]);
console.log("span kinds", SpanKind.SERVER, SpanKind[SpanKind.CLIENT]);
const span = trace.getTracer("example-tracer").startSpan("work");
console.log("span recording", span.isRecording());
span.end();
