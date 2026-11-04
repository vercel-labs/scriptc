// A Script's top level does not admit a `using` declaration (the spec's
// UsingDeclaration early error names every scope that does, and ScriptBody is
// not one of them); a Module's top level does.
class Resource {
  [Symbol.dispose]() {}
}
using resource = new Resource();
