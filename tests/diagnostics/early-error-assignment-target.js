// AssignmentTargetType: the left operand of `=`, of a compound assignment, of
// `++`/`--`, and a for-in/of head must be a simple assignment target. An
// import call is none of those, and TypeScript reports the case as an
// operator diagnostic whose message reads "'any'", which JavaScript sources
// relax — so the grammar check is the compiler's own early error.
import("./mod.js") -= 1;
