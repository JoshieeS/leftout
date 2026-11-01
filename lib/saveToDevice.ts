export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) // iPad in desktop mode
  );
}

export function canShareFiles(files: File[]): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function' || !files.length) return false;
  try {
    return navigator.canShare({ files });
  } catch {
    return false;
  }
}

// Small batches are more reliable in the share sheet. Tune these after testing on your phones.
export function makeBatches<T extends { file: File }>(items: T[], maxCount = 10, maxBytes = 250 * 1024 * 1024): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= maxCount || bytes + it.file.size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += it.file.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Android / desktop: plain downloads, one after another.
export async function downloadAll(items: { file: File; url: string }[]) {
  for (const i of items) {
    const a = document.createElement('a');
    a.href = i.url;
    a.download = i.file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 400));
  }
}