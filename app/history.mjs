function findArrayEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function currencyBefore(html, position) {
  const window = html.slice(Math.max(0, position - 800), position);
  const re = /\\"e[cC]urrency\\":(\d+)/g;
  let match;
  let last = null;
  while ((match = re.exec(window))) last = match;
  return last ? Number(last[1]) : 0;
}

export function parsePriceHistoryHtml(html) {
  if (typeof html !== 'string' || html.length === 0) return null;
  const marker = '\\"prices\\":[';
  let position = 0;

  while ((position = html.indexOf(marker, position)) !== -1) {
    const start = position + marker.length - 1;
    const end = findArrayEnd(html, start);
    if (end === -1) return null;

    const raw = html.slice(start, end + 1);
    let rows;
    try {
      rows = JSON.parse(raw.replace(/\\"/g, '"'));
    } catch {
      rows = null;
    }

    if (Array.isArray(rows) && rows.some((row) => row && row.price_median !== undefined)) {
      const byTime = new Map();
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const time = Number(row.time);
        const price = Number(row.price_median);
        if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(price) || price <= 0) continue;
        byTime.set(time, {
          time,
          price,
          volume: Number.isFinite(Number(row.purchases)) && Number(row.purchases) > 0
            ? Math.trunc(Number(row.purchases)) : 0,
        });
      }
      const points = [...byTime.values()].sort((a, b) => a.time - b.time);
      if (points.length === 0) return null;
      return {
        points,
        currency: currencyBefore(html, position),
      };
    }

    position = end + 1;
  }

  return null;
}