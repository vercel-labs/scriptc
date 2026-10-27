import { Fragment, h, type Child, type Props } from "./html.js";

const Ui = {
  Badge(props: Props, children: Child[]) {
    return <b class={typeof props.tone === "string" ? props.tone : "plain"}>{...children}</b>;
  },
};

function Row(props: Props) {
  const name = typeof props.name === "string" ? props.name : "?";
  const done = props.done === true;
  return (
    <li class={done ? "done" : "open"} data-id={props.id} hidden={false}>
      {name}
      {done && <span aria-label="done">&#10003;</span>}
    </li>
  );
}

export function Page(title: string, items: { id: number; name: string; done: boolean }[]) {
  const extra = { lang: "en", dir: "ltr" };
  return (
    <>
      <h1 {...extra} title="Tasks &amp; notes">{title}</h1>
      <ul>
        {items.map((item) => (
          <Row id={item.id} name={item.name} done={item.done} />
        ))}
      </ul>
      <p>
        {items.filter((item) => item.done).length} of {items.length} done
        <Ui.Badge tone="info">  multi   word
          badge  </Ui.Badge>
      </p>
      <input type="checkbox" checked disabled={items.length === 0} />
      <ns:tag a:b="c" {...{ x: 1 }} />
      <>nested {"fragment"}</>
    </>
  );
}
