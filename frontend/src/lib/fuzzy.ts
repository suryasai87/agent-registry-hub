// Small fuzzy matcher for the command palette: the query must appear as an ordered subsequence of the text.
// Scores reward consecutive characters, word starts, early and tight matches, so "hiw" ranks "How It Works" first.

export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    const wordStart = at === 0 || /[\s\-_/.·]/.test(t[at - 1]);
    score += 1;
    if (at === prev + 1) score += 3;
    if (wordStart) score += 4;
    score -= Math.min(at - ti, 10) * 0.1;
    prev = at;
    ti = at + 1;
  }
  if (t.startsWith(q)) score += 6;
  else if (t.includes(q)) score += 3;
  return score - Math.min(t.length - q.length, 50) * 0.01; // tighter matches win ties
}

/**
 * Items matching the query, best first (stable for equal scores); all items when the query is empty.
 * ``text`` may return several fields: the first (the label) counts fully, the others (hints, keywords) at 0.7.
 */
export function fuzzyFilter<T>(items: T[], query: string, text: (item: T) => string | (string | null | undefined)[]): T[] {
  if (!query.trim()) return items;
  const best = (item: T): number | null => {
    const raw = text(item);
    const fields = Array.isArray(raw) ? raw : [raw];
    let top: number | null = null;
    fields.forEach((field, i) => {
      if (!field) return;
      const s = fuzzyScore(query, field);
      if (s === null) return;
      const weighted = i === 0 ? s : s * 0.7;
      if (top === null || weighted > top) top = weighted;
    });
    return top;
  };
  return items
    .map((item, index) => ({ item, index, score: best(item) }))
    .filter((r): r is { item: T; index: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.item);
}
