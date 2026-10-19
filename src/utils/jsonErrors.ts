// Parses JSON from an external source and, when it is malformed, says where.
// JSON.parse in Bun reports only "Unexpected identifier" with no position, so
// a small validator walks the text to find the first bad character and the
// JSON path that was being read when it hit it.

export type JsonErrorLocation = {
  reason: string;
  offset: number;
  line: number;
  column: number;
  // e.g. $.formats[12].url, the value being read when parsing stopped
  path: string;
  // text around the error with <<HERE>> at the failing offset
  context: string;
  outputLength: number;
};

const CONTEXT_CHARS = 40;

class StopParse {
  constructor(
    readonly reason: string,
    readonly offset: number,
    readonly path: string,
  ) {}
}

function pathString(segments: (string | number)[]) {
  return (
    "$" +
    segments
      .map((segment) =>
        typeof segment === "number"
          ? `[${segment}]`
          : /^[A-Za-z_$][\w$]*$/.test(segment)
            ? `.${segment}`
            : `[${JSON.stringify(segment)}]`,
      )
      .join("")
  );
}

// Returns the first syntax error in text, or undefined when text is valid JSON.
function findFirstError(
  text: string,
): { reason: string; offset: number; path: string } | undefined {
  let i = 0;
  const path: (string | number)[] = [];

  const fail = (reason: string, at = i): never => {
    throw new StopParse(reason, at, pathString(path));
  };
  const unexpected = (expected: string): never =>
    i >= text.length
      ? fail(`unexpected end of input, expected ${expected}`)
      : fail(`unexpected character ${JSON.stringify(text[i])}, expected ${expected}`);
  const skipWhitespace = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++;
  };

  const readString = (): string => {
    const start = i;
    i++;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        return JSON.parse(text.slice(start, i));
      }
      if (c === "\\") {
        const escape = text[i + 1];
        if (escape === undefined) break;
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            fail("invalid \\u escape in string");
          }
          i += 6;
        } else if ('"\\/bfnrt'.includes(escape)) {
          i += 2;
        } else {
          fail(`invalid escape \\${escape} in string`);
        }
      } else if (c < " ") {
        fail("unescaped control character in string");
      } else {
        i++;
      }
    }
    return fail(
      `unterminated string, input ends before the string that starts at offset ${start} is closed`,
      text.length,
    );
  };

  const readNumber = () => {
    const pattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    pattern.lastIndex = i;
    const match = pattern.exec(text);
    if (!match || match[0] === "-") fail("invalid number");
    i += match![0].length;
  };

  const readValue = (): void => {
    skipWhitespace();
    const c = text[i];
    if (c === "{") return readObject();
    if (c === "[") return readArray();
    if (c === '"') {
      readString();
      return;
    }
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      return readNumber();
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, i)) {
        i += literal.length;
        return;
      }
    }
    unexpected("a value");
  };

  const readObject = () => {
    i++;
    skipWhitespace();
    if (text[i] === "}") {
      i++;
      return;
    }
    while (true) {
      skipWhitespace();
      if (text[i] !== '"') unexpected("a quoted key");
      const key = readString();
      skipWhitespace();
      if (text[i] !== ":") unexpected(`':' after key ${JSON.stringify(key)}`);
      i++;
      path.push(key);
      readValue();
      path.pop();
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return;
      }
      unexpected("',' or '}'");
    }
  };

  const readArray = () => {
    i++;
    skipWhitespace();
    if (text[i] === "]") {
      i++;
      return;
    }
    for (let index = 0; ; index++) {
      path.push(index);
      readValue();
      path.pop();
      skipWhitespace();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return;
      }
      unexpected("',' or ']'");
    }
  };

  try {
    skipWhitespace();
    if (i >= text.length) fail("empty output");
    readValue();
    skipWhitespace();
    if (i < text.length) fail("trailing content after the JSON value");
    return undefined;
  } catch (stop) {
    if (stop instanceof StopParse) {
      return { reason: stop.reason, offset: stop.offset, path: stop.path };
    }
    throw stop;
  }
}

export function locateJsonError(text: string): JsonErrorLocation | undefined {
  const found = findFirstError(text);
  if (!found) return undefined;

  const before = text.slice(0, found.offset);
  const line = before.split("\n").length;
  const column = found.offset - before.lastIndexOf("\n");
  const context =
    text.slice(Math.max(0, found.offset - CONTEXT_CHARS), found.offset) +
    "<<HERE>>" +
    text.slice(found.offset, found.offset + CONTEXT_CHARS);

  return { ...found, line, column, context, outputLength: text.length };
}

export class MalformedJsonError extends Error {
  readonly errorKind = "malformed_json";
  readonly json: JsonErrorLocation | { reason: string; outputLength: number };

  constructor(source: string, text: string, cause: unknown) {
    // Fall back to the engine's message if the validator accepts the text.
    const location = locateJsonError(text);
    const where = location
      ? `${location.reason} at line ${location.line}, column ${location.column} (${location.path})`
      : String(cause instanceof Error ? cause.message : cause);
    super(`Malformed JSON from ${source}: ${where}`, { cause });
    this.name = "MalformedJsonError";
    this.json = location ?? { reason: where, outputLength: text.length };
  }
}

// JSON.parse that throws MalformedJsonError with the error's location.
export function parseJson(text: string, source: string): any {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new MalformedJsonError(source, text, error);
  }
}
