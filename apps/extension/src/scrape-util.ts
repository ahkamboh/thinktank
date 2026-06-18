/**
 * Extract clean visible text from a message element.
 *
 * We clone the node so we can strip UI chrome that both ChatGPT and Claude
 * interleave inside message bubbles - copy-code buttons, "Edit"/"Regenerate"
 * controls, screen-reader-only labels - none of which is real conversation
 * content. Then we read `innerText` (respects line breaks / hidden elements).
 */
export function cleanText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  const junk = clone.querySelectorAll(
    'button, [role="button"], .sr-only, [aria-hidden="true"], svg, [data-state]',
  );
  junk.forEach((n) => n.remove());
  const text = (clone.innerText ?? clone.textContent ?? '').trim();
  // Collapse the runs of blank lines that stripping leaves behind.
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** Deduplicate a list of hrefs while preserving order. */
export function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
