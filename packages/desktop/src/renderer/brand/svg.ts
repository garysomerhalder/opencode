/** Splits a flat single-color SVG into its viewBox and its inner markup, with white fills turned into currentColor. */
export function parseBrandSvg(svg: string) {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "0 0 1 1"
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/fill="#FFFFFF"/gi, 'fill="currentColor"')
  return { viewBox, inner }
}
