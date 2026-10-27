/** @jsx tag */
// JSX in a JavaScript module, with a JavaScript factory that builds strings.
function tag(name, props, ...children) {
  const attributes = Object.entries(props ?? {})
    .map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
    .join("");
  return `<${name}${attributes}>${children.flat().join("")}</${name}>`;
}

const names = ["a", "b"];

export function List() {
  return (
    <ol start="3">
      {names.map((name, index) => (
        <li key={name} data-index={index}>
          {name.toUpperCase()}
        </li>
      ))}
    </ol>
  );
}
