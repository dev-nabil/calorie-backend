/** Canonical lines: everything without {placeholders} (lines.v1.json `prerender`), plus conversation turn lines. */
export function canonicalLines(lines: unknown, conversation: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, v] of Object.entries(((lines as { lines?: Record<string, Record<string, unknown>> })?.lines) ?? {})) {
    for (const [field, text] of Object.entries(v)) {
      if (typeof text !== 'string' || text.includes('{')) continue;
      out[field === 'text' ? id : `${id}.${field}`] = text;
    }
  }
  for (const t of ((conversation as { turns?: { turn: number; miloLine?: string; askOne?: Record<string, string> }[] })?.turns) ?? []) {
    if (t.miloLine && !t.miloLine.includes('{')) out[`conversation.turn${t.turn}`] = t.miloLine;
    for (const [q, text] of Object.entries(t.askOne ?? {})) if (!text.includes('{')) out[`conversation.turn${t.turn}.${q}`] = text;
  }
  return out;
}
