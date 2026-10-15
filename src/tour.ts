/**
 * A tour: a walk through linked notes for a presentation. From the start note it always moves to a linked note it has not
 * visited, preferring the better connected one (so the tour passes through the hubs), and stops when it has nowhere new to go.
 */
export function planTour(adj: readonly (readonly number[])[], start: number, maxStops = 12): number[] {
  if (!(start >= 0 && start < adj.length)) return [];
  const seen = new Set<number>([start]), out = [start];
  let at = start;
  while (out.length < maxStops) {
    let best = -1, bestDeg = -1;
    for (const nb of adj[at] ?? []) {
      if (seen.has(nb) || nb < 0 || nb >= adj.length) continue;
      const d = adj[nb]?.length ?? 0;
      if (d > bestDeg || (d === bestDeg && nb < best)) { best = nb; bestDeg = d; }
    }
    if (best < 0) break;
    seen.add(best); out.push(best); at = best;
  }
  return out;
}

/** The note a tour should begin from when nothing is selected: the one with the most links. */
export function busiestNote(adj: readonly (readonly number[])[]): number {
  let best = -1, bd = -1;
  for (let i = 0; i < adj.length; i++) { const d = adj[i]?.length ?? 0; if (d > bd) { bd = d; best = i; } }
  return best;
}
