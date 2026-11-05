type JsonSchema = Record<string, unknown>;

/**
 * `{anyOf: [X, {type: null}]}` becomes `X` with a nullable type, the form Google documents. Enums stay
 * as `anyOf`: with a nullable type their value list would still forbid null, so null could never be returned.
 */
export function simplifyNullable(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplifyNullable);
  if (typeof node !== 'object' || node === null) return node;
  const out: JsonSchema = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, simplifyNullable(v)]));
  const options = out.anyOf as JsonSchema[] | undefined;
  if (Array.isArray(options) && options.length === 2 && options[1]?.type === 'null' && typeof options[0]?.type === 'string' && options[0].type !== 'object' && !options[0].enum) {
    const { anyOf: _anyOf, ...rest } = out;
    return { ...options[0], ...rest, type: [options[0].type, 'null'] };
  }
  return out;
}

/** A JSON Schema (zod's draft-7 output, or one from a prompt file) in the form Gemini's `responseJsonSchema` takes. */
export function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const { $schema: _dialect, ...rest } = simplifyNullable(schema) as JsonSchema;
  return rest;
}
