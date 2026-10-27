// tsc's numeric enums in a package (the @opentelemetry/api DiagLogLevel and
// SpanKind shape): reverse-mapping reads by a runtime value answer the
// member name, or undefined for a value no member has.
import { Kind, Level } from "tscenumreverse";

console.log(Level.WARN, Level[Level.WARN], Level[Level.DEBUG], Kind[Kind.CLIENT]);
for (const value of [0, 30, 60, 99]) console.log(value, Level[value]);
