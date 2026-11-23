export function useContext(c) {
  return { field: { props: (input) => ({ ...input, ok: 1 }) } }
}
