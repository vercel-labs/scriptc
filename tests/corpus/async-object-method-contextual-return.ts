type Text = { type: "text"; text: string; textSignature?: string };
type Image = { type: "image"; data: string; mimeType: string };
interface ToolResult<D> { content: (Text | Image)[]; details: D; isError?: boolean }
interface ToolDefinition<D> { name: string; execute(id: string, q: string): Promise<ToolResult<D>> }
function define(): ToolDefinition<{ loaded: string[] }> {
	return {
		name: "search",
		async execute(_id, q) {
			const text = `found ${q}`;
			return { content: [{ type: "text", text }], details: { loaded: [q] } };
		},
	};
}
define().execute("1", "x").then((r) => console.log(JSON.stringify(r)));

// Slots whose return is not a promise: an async method there still returns
// its own promise, and a union slot contributes only its promise arm.
interface Hooks {
	start(): void;
	stop(): Promise<void> | void;
	load(q: string): Promise<{ n: number; q: string }> | undefined;
}
const hooks: Hooks = {
	async start() {
		console.log("start");
	},
	async stop() {
		console.log("stop");
	},
	async load(q) {
		return { n: q.length, q };
	},
};
async function run(): Promise<void> {
	await hooks.start();
	await hooks.stop();
	const loaded = await hooks.load("abc");
	console.log(loaded?.n, loaded?.q);
}
run();
