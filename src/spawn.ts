/** Where to come back after being destroyed: of the places around your constellation, the one farthest from every other pilot. */
export function chooseSpawn(candidates: readonly [number, number, number][], threats: readonly { x: number; y: number; z: number }[]): number {
  if (!threats.length) return 0; // nobody around: the usual place
  let best = 0, bestGap = -1;
  candidates.forEach((c, i) => {
    let gap = Infinity;
    for (const t of threats) gap = Math.min(gap, Math.hypot(c[0] - t.x, c[1] - t.y, c[2] - t.z));
    if (gap > bestGap) { bestGap = gap; best = i; }
  });
  return best;
}
