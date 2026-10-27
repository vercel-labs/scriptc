import type { Props } from "#jsx/jsx-runtime";

function Card(props: Props) {
  return (
    <section class="card">
      <h2>{typeof props.title === "string" ? props.title : "?"}</h2>
      {props.children}
    </section>
  );
}

export function page(names: string[]) {
  const extra = { id: "list", role: "list" };
  return (
    <>
      <Card title="Names">
        <ul {...extra}>
          {names.map((name, index) => (
            <li key={name} data-index={index}>
              {name}
            </li>
          ))}
        </ul>
      </Card>
      <p {...extra} key="after-spread">fallback</p>
      <p key="before" {...extra}>
        two {"children"}
      </p>
      <div>{...names}</div>
      <br />
    </>
  );
}
