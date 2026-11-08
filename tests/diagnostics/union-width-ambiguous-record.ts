// A record whose members are all optional, passed where a union of records
// with only optional members is expected. The checker accepts it: the record
// is assignable to every arm it shares a member with. A union value is one
// arm at run time, though, and this record declares members of several arms
// (`supportsStore` is one arm's, `allowEmptySignature` another's) and one
// member no arm declares, so no arm can hold it and nothing in the value
// says which arm it is. The refusal names that cause; the repair is to type
// the slot with the record itself or to give the arms a discriminant.
type CompletionsCompat = { supportsStore?: boolean; maxTokensField?: string; supportsMidConvo?: boolean };
type MinimalCompat = { supportsMidConvo?: boolean };
type MessagesCompat = { allowEmptySignature?: boolean; supportsMidConvo?: boolean; affinity?: string };
type Compat = CompletionsCompat | MinimalCompat | MessagesCompat;

type ProviderCompat = {
  supportsStore?: boolean;
  maxTokensField?: string;
  supportsMidConvo?: boolean;
  allowEmptySignature?: boolean;
  affinity?: string;
  imageInput?: string;
};

function describe(compat: Compat | undefined): string {
  return compat === undefined ? "none" : JSON.stringify(compat);
}

function compose(provider: { compat?: ProviderCompat }): string {
  return describe(provider.compat);
}

// A record that is exactly one of the arms enters that arm and compiles.
function shared(value: { supportsMidConvo?: boolean }): string {
  const held: Compat = value;
  return describe(held);
}

console.log(compose({ compat: { supportsStore: true, allowEmptySignature: true } }), shared({}));
