/** Shuffle once per session, keeping unheard demos ahead of previously heard ones. */
export function shuffledListenOrder<T>(tracks: readonly T[], listens: (track:T) => number, random = Math.random): T[] {
  const shuffled = [...tracks];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return [...shuffled.filter(track => listens(track) === 0), ...shuffled.filter(track => listens(track) !== 0)];
}
