// An override may declare extra trailing optional or defaulted parameters.
// The inherited ABI stops at the base arity, so a call through the base type
// passes only the base arguments and the override's own defaults still apply —
// and a default expression runs only when the argument is missing or
// undefined, exactly as in Node.
let defaultEvals = 0;

function nextTag(): string {
	defaultEvals++;
	return `t${defaultEvals}`;
}

function fallbackOptions(): { width: number; label: string } {
	defaultEvals++;
	return { width: 80, label: "wide" };
}

class BaseNode {
	parts: string[] = [];
	run(id: number): void {
		this.parts.push(`base ${id}`);
	}
	report(): string {
		return this.parts.join(" | ");
	}
}

class TaggingNode extends BaseNode {
	run(id: number, tag: string = nextTag(), note?: string): void {
		super.run(id);
		this.parts.push(`tag ${id} ${tag} ${String(note)}`);
	}
}

const tagging = new TaggingNode();
// Omitted: the default runs.
tagging.run(1);
// Supplied: the default does not run.
tagging.run(2, "explicit");
// Explicit undefined takes the default too (JS's call-time rule).
tagging.run(3, undefined, "traced");
console.log(tagging.report());
console.log("evals", defaultEvals);

// Through the inherited type: the slot carries the base arity only.
const asBase: BaseNode = tagging;
asBase.run(4);
console.log(tagging.report());
console.log("evals", defaultEvals);

class LayoutNode extends BaseNode {
	run(id: number, options: { width: number; label: string } = fallbackOptions()): void {
		super.run(id);
		this.parts.push(`layout ${id} ${options.width} ${options.label}`);
	}
}

// A third level adds its own trailing default over the adapted slot above.
class DeepLayoutNode extends LayoutNode {
	run(id: number, options: { width: number; label: string } = fallbackOptions(), depth = 1): void {
		super.run(id, options);
		this.parts.push(`deep ${id} ${options.width} ${depth}`);
	}
}

const layout = new LayoutNode();
// Only the inherited arity here: a class with an override below dispatches
// through the inherited slot, which cannot carry extra arguments.
layout.run(1);
console.log(layout.report());

const deep = new DeepLayoutNode();
deep.run(1);
deep.run(2, { width: 10, label: "tiny" }, 5);
deep.run(3, undefined, 7);
console.log(deep.report());
console.log("evals", defaultEvals);

// Virtual dispatch over a heterogeneous base-typed array.
const nodes: BaseNode[] = [tagging, new BaseNode(), layout, deep];
for (const node of nodes) node.run(9);
console.log(tagging.report());
console.log(layout.report());
console.log(deep.report());
console.log("evals", defaultEvals);
