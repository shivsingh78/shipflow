// A tiny serializer for previewing shipflow.yml. It only needs to handle what a
// validated ProjectConfig contains: nested objects, arrays of scalars, strings,
// numbers and booleans. Output is for display and download-by-copy only.

const PLAIN = /^[A-Za-z0-9_./][A-Za-z0-9_./@+:-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|[-+]?\d[\d_.]*([eE][-+]?\d+)?|0x[0-9a-fA-F]+)$/i;

function scalar(value: unknown): string {
  if (typeof value === "string") {
    return value !== "" && PLAIN.test(value) && !value.endsWith(":") && !RESERVED.test(value) ? value : JSON.stringify(value);
  }

  return String(value);
}

function lines(value: unknown, indent: number): string[] {
  const pad = "  ".repeat(indent);

  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "object" && item !== null ? [`${pad}-`, ...lines(item, indent + 1)] : [`${pad}- ${scalar(item)}`]));
  }

  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : JSON.stringify(key);

      if (Array.isArray(child)) return child.length === 0 ? [`${pad}${name}: []`] : [`${pad}${name}:`, ...lines(child, indent + 1)];
      if (typeof child === "object" && child !== null) {
        return Object.keys(child).length === 0 ? [`${pad}${name}: {}`] : [`${pad}${name}:`, ...lines(child, indent + 1)];
      }

      return [`${pad}${name}: ${scalar(child)}`];
    });
  }

  return [`${pad}${scalar(value)}`];
}

export function toYaml(value: unknown): string {
  return `${lines(value, 0).join("\n")}\n`;
}
