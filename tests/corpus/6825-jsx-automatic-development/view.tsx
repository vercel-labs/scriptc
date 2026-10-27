function Leaf() {
  return "leaf";
}

export class Panel {
  title = "panel";
  render() {
    return <div title={this.title}>{1}{2}</div>;
  }
}

export function views(): string[] {
  return [
    <p key="k">one</p>,
      <Leaf />,
    <>
      <i />
    </>,
    new Panel().render(),
  ];
}
