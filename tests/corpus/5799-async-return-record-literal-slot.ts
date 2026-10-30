// A tool definition whose `execute` is an unannotated async method inside a
// contextually typed object literal. tsc checks the method against the
// contextual signature's result (`AgentToolResult<Loaded>`) but INFERS its
// own return type from the returned literal (`{ content: { type, text }[];
// details: { loaded } }`). The fresh literal must construct at the declared
// result slot, not at the contextual type it was checked against: the
// contextual type's `content` is the wider content-part union array, which
// no copy narrows back into the inferred element record.
interface TextContent {
  type: string;
  text: string;
  textSignature?: string;
}
interface ImageContent {
  type: string;
  data: string;
  mimeType: string;
}
interface Candidate {
  name: string;
  score: number;
}
interface Definition<D> {
  name: string;
  search(query: string): Promise<D>;
  execute(id: string, query: string): Promise<Result<D>>;
}
interface Result<D> {
  content: (TextContent | ImageContent)[];
  details: D;
  structuredContent?: unknown;
  isError?: boolean;
}
interface Loaded {
  loaded: string[];
}

function rank(query: string, names: string[]): Candidate[] {
  return names.filter((name) => name.includes(query)).map((name) => ({ name, score: name.length }));
}

function makeDefinition(names: string[]): Definition<Loaded> {
  return {
    name: "search",
    async search(query: string) {
      return { loaded: rank(query, names).map((candidate) => candidate.name) };
    },
    async execute(_id: string, query: string) {
      return {
        content: [{ type: "text", text: rank(query, names).map((c) => c.name).join(",") }],
        details: { loaded: rank(query, names).map((c) => c.name) },
      };
    },
  };
}

// The same shape through a record of definitions, each with its own details.
type AnyDefinition = Definition<any>;
function makeNamed(names: string[]): Record<"search", AnyDefinition> {
  return { search: makeDefinition(names) };
}

const definition = makeDefinition(["find-file", "grep-tree", "read-file"]);
definition
  .search("file")
  .then((loaded) => {
    console.log("search:", loaded.loaded.join(","));
    return definition.execute("call-1", "file");
  })
  .then((result) => {
    console.log("execute:", result.content.length, result.content[0]!.type, result.details.loaded.join(","));
    return makeNamed(["read-file"]).search.execute("call-2", "file");
  })
  .then((second) => {
    console.log("second:", second.content.length, second.details.loaded.join(","));
  });
