// A record field holding a function adapts when the slot's function type is a
// structural width of the field's: a parameter record whose `unknown` members
// gain shapes (the checked-dynamic extraction), a callback parameter whose
// record widens the same way one level down, and a promise payload that widens.
//
// `wrapToolDefinition` states the definition's state and details parameters as
// `any`/default `unknown`, so passing a concrete definition crosses the
// `execute` and `renderCall` fields of the record.

interface Truncation {
  content: string;
  truncated: boolean;
}

interface ToolResult<D> {
  content: { type: string; text: string }[];
  details: D;
  isError: boolean | undefined;
}

type UpdateCallback<D> = (partial: ToolResult<D>) => void;

interface ToolDefinition<S, D> {
  name: string;
  execute(id: string, onUpdate: UpdateCallback<D> | undefined): Promise<ToolResult<D>>;
  renderCall(context: { state: S; label: string }): string;
}

interface BashState {
  startedAt: number;
  executionStarted: boolean;
}

interface BashDetails {
  truncation: Truncation | undefined;
  fullOutputPath: string | undefined;
}

function wrapToolDefinition<D = unknown>(
  definition: ToolDefinition<any, D>,
): ToolDefinition<any, D> {
  return {
    name: definition.name,
    execute: definition.execute,
    renderCall: definition.renderCall,
  };
}

function bashDefinition(name: string): ToolDefinition<BashState, BashDetails> {
  return {
    name,
    execute: (id, onUpdate) => {
      const result: ToolResult<BashDetails> = {
        content: [{ type: "text", text: `ran ${id}` }],
        details: { truncation: { content: "tail", truncated: true }, fullOutputPath: undefined },
        isError: undefined,
      };
      onUpdate?.(result);
      return Promise.resolve(result);
    },
    renderCall: (context) => `${context.label} after ${context.state.startedAt}ms`,
  };
}

// The `execute` field: the slot's update callback takes `details: unknown`
// where the value's takes the concrete record, and the result promise payload
// widens the same way.
function widenDetails(): ToolDefinition<any, unknown> {
  return wrapToolDefinition<unknown>(bashDefinition("bash"));
}

// The `renderCall` field: the slot's context record has `state: unknown`
// where the value's has the concrete state record.
function widenState(definition: ToolDefinition<BashState, BashDetails>): ToolDefinition<any, BashDetails> {
  return wrapToolDefinition<BashDetails>(definition);
}

// The same crossing when the argument is an object literal carrying optional
// members the slot's shape also declares.
interface WithHints {
  annotations: { readOnlyHint: boolean | undefined } | undefined;
  defaultActive: boolean | undefined;
}

function widenLiteral(): ToolDefinition<any, BashDetails> {
  const hints: WithHints = { annotations: { readOnlyHint: true }, defaultActive: undefined };
  const definition: ToolDefinition<BashState, BashDetails> & WithHints = {
    ...bashDefinition("literal"),
    ...hints,
  };
  console.log("hints:", definition.annotations?.readOnlyHint, definition.defaultActive);
  return wrapToolDefinition<BashDetails>(definition);
}

const widened = widenDetails();
widened
  .execute("ls", (partial) => {
    console.log("update:", partial.content[0]?.text, partial.isError);
  })
  .then((result) => {
    console.log("result:", result.details, result.isError);
  });

const rendered = widenState(bashDefinition("grep"));
console.log("render:", rendered.renderCall({ state: { startedAt: 12, executionStarted: true }, label: "grep" }));

const literal = widenLiteral();
console.log("literal render:", literal.renderCall({ state: { startedAt: 3, executionStarted: false }, label: "ls" }));
console.log("name:", literal.name);
