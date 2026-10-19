export type DateValueDescription = {
  raw: unknown;
  type: string;
  parsesAsDate: boolean;
};

// Describes a date-ish value for logs without changing what gets stored.
// `raw` is kept as-is when it survives JSON.stringify; bigint, symbol and
// function values are stringified so a log write cannot throw.
export function describeDateValue(value: unknown): DateValueDescription {
  let parsesAsDate = false;
  try {
    parsesAsDate = !Number.isNaN(new Date(value as string | number).getTime());
  } catch {
    // Symbols and objects with throwing valueOf cannot be converted to a date.
    parsesAsDate = false;
  }

  const jsonSafe =
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    typeof value === "function";

  return {
    raw: value === undefined ? null : jsonSafe ? String(value) : value,
    type: typeof value,
    parsesAsDate,
  };
}
