/** A unified diff, line-coloured, read-only. Text only: nothing in it is ever interpreted as HTML. */
export function Diff({ text, label }: { text: string; label: string }) {
  const lines = text.split("\n");

  if (lines[lines.length - 1] === "") lines.pop();

  return (
    <pre className="rp-diff" aria-label={label} tabIndex={0}>
      {lines.map((line, index) => {
        const kind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";

        return (
          <span key={index} className={`rp-diff__line rp-diff__line--${kind}`}>
            {line === "" ? " " : line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}
