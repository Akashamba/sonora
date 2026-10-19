export type NetworkErrorKind =
  | "timeout"
  | "dns"
  | "unreachable"
  | "connection_reset"
  | "http_403"
  | "http_429"
  | "http_5xx";

// Fields of one error in the cause chain that the classifier looks at.
type ErrorNode = {
  name?: string;
  text: string; // lowercased message, stderr and code, for substring matching
  code?: string;
  status?: number;
};

const MAX_CAUSE_DEPTH = 4;

const KIND_ORDER: readonly NetworkErrorKind[] = [
  "timeout",
  "dns",
  "unreachable",
  "connection_reset",
  "http_403",
  "http_429",
  "http_5xx",
];

const PATTERNS: Record<
  Exclude<NetworkErrorKind, "http_403" | "http_429" | "http_5xx">,
  readonly string[]
> = {
  timeout: ["timed out"],
  dns: [
    "failed to resolve",
    "temporary failure in name resolution",
    "getaddrinfo",
    "enotfound",
    "name or service not known",
  ],
  unreachable: [
    "network is unreachable",
    "enetunreach",
    "connectionrefused",
    "econnrefused",
    "unable to connect",
  ],
  connection_reset: [
    "econnreset",
    "socket connection was closed",
    "connection reset",
  ],
};

function toStatus(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
}

function describe(value: unknown): ErrorNode {
  if (typeof value !== "object" || value === null) {
    return { text: String(value).toLowerCase() };
  }

  const fields = value as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    stderr?: unknown;
    status?: unknown;
  };
  const parts = [fields.message, fields.stderr, fields.code]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part));

  return {
    name: typeof fields.name === "string" ? fields.name : undefined,
    text: parts.join("\n").toLowerCase(),
    code:
      fields.code === undefined || fields.code === null
        ? undefined
        : String(fields.code),
    status: toStatus(fields.status),
  };
}

// The error, then its cause, then the cause's cause, up to a small depth.
function errorChain(error: unknown): ErrorNode[] {
  const nodes: ErrorNode[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    if (nodes.length >= MAX_CAUSE_DEPTH) break;
    nodes.push(describe(current));
    current =
      typeof current === "object"
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return nodes;
}

function matchesKind(kind: NetworkErrorKind, node: ErrorNode): boolean {
  switch (kind) {
    case "timeout":
      return (
        node.name === "TimeoutError" ||
        node.name === "AbortError" ||
        PATTERNS.timeout.some((p) => node.text.includes(p))
      );
    case "dns":
    case "unreachable":
    case "connection_reset":
      return PATTERNS[kind].some((p) => node.text.includes(p));
    case "http_403":
      return node.status === 403 || node.text.includes("http error 403");
    case "http_429":
      return node.status === 429 || node.text.includes("http error 429");
    case "http_5xx":
      return (
        node.status !== undefined && node.status >= 500 && node.status <= 599
      );
  }
}

// Returns the network failure kind for an error, or undefined when it is not a
// network failure (404s, SQLite errors, parse errors, plain Errors).
export function classifyNetworkError(
  error: unknown,
): NetworkErrorKind | undefined {
  const nodes = errorChain(error);
  for (const kind of KIND_ORDER) {
    if (nodes.some((node) => matchesKind(kind, node))) return kind;
  }
  return undefined;
}

// Kinds that an error declares itself through an errorKind property.
export type ErrorKind = NetworkErrorKind | "malformed_json";

// Spread into a log record. Yields no errorKind key at all when unclassified.
// An errorKind the error carries itself, such as malformed_json, wins over
// network classification.
export function errorKindFields(error: unknown): {
  errorKind?: ErrorKind;
} {
  const own =
    typeof error === "object" && error !== null
      ? (error as { errorKind?: unknown }).errorKind
      : undefined;
  const errorKind =
    typeof own === "string" ? (own as ErrorKind) : classifyNetworkError(error);
  return errorKind === undefined ? {} : { errorKind };
}
