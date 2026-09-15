export function foldRankedSlices<T extends { slice: number; label: string; value: string }>(
  items: T[],
  options: {
    maxNamed?: number;
    minRatio?: number;
    otherLabel?: string;
  } = {},
): { rows: T[]; hidden: T[] } {
  const maxNamed = options.maxNamed ?? 8;
  const minRatio = options.minRatio ?? 0;
  const otherLabel = options.otherLabel ?? 'Other';
  if (items.length <= 1) return { rows: items, hidden: [] };

  const total = items.reduce((sum, item) => sum + Number(item.slice || 0), 0);
  const floor = total * minRatio;
  const minHead = Math.min(6, maxNamed, items.length);

  let named = 0;
  while (named < items.length && named < maxNamed) {
    const slice = Number(items[named]?.slice || 0);
    if (named < minHead || slice >= floor) {
      named += 1;
      continue;
    }
    break;
  }

  while (named < items.length && named < maxNamed) {
    const other = items.slice(named).reduce((sum, item) => sum + Number(item.slice || 0), 0);
    const last = Number(items[named - 1]?.slice || 0);
    const next = Number(items[named]?.slice || 0);
    if (other > last && next >= floor * 0.5) {
      named += 1;
      continue;
    }
    break;
  }

  if (named >= items.length) return { rows: items, hidden: [] };

  const head = items.slice(0, named);
  const hidden = items.slice(named);
  const otherSlice = hidden.reduce((sum, item) => sum + Number(item.slice || 0), 0);
  const other = { ...hidden[0], value: 'other', label: otherLabel, slice: otherSlice };
  return { rows: [...head, other], hidden };
}
