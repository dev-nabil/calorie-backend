/** A catalog value: plain text, or a function that builds it from parameters (plurals, word order). */
export type Msg = string | ((p: Record<string, string | number>) => string);
/** Error messages may read the error's `details`. */
export type ErrMsg = string | ((details: Record<string, unknown>) => string);
