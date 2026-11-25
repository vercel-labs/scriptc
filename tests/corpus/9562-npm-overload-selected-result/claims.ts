// The declarations of the packages beside main.ts are wrong for a text
// their JavaScript cannot read: it answers undefined where the selected
// signature says number, an array or a record. Node goes on with the
// undefined; the compiled program throws where the value enters typed code,
// and the error names the declaration. tests/harness/decl-boundary.test.ts
// pins the output.
import weigh from "weigh";
import { measured, read, ruler, spans } from "gauge";

function attempt(label: string, run: () => string): void {
  try {
    console.log(label, run());
  } catch (error) {
    console.log(label, "threw", error instanceof TypeError, String((error as Error).message));
  }
}

attempt("stored", () => {
  const grams = weigh("heavy");
  return String(grams);
});
attempt("arithmetic", () => String(1 + read("far")));
attempt("method", () => String(ruler.read("far") * 2));
attempt("array", () => String(spans("far").length));
attempt("record", () => String(measured("far").mm));
attempt("honest", () => String(weigh("2kg") + read("1cm")));
