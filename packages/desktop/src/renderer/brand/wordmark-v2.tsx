import { createUniqueId, type ComponentProps } from "solid-js"
import lockupSvg from "./legatus-lockup.svg?raw"
import { parseBrandSvg } from "./svg"

// Legatus stand-in for `@opencode-ai/ui/v2/wordmark-v2`. electron.vite.config.ts aliases that
// module here while the Legatus brand is on, so this file must keep the same export and props.
//
// This is the hero on the new-session screen. Upstream draws the word "opencode" in letterform
// paths, which no i18n or string switch can reach — which is why the brand layer missed it and the
// window said Legatus while the first screen said opencode.
//
// The artwork is the official Legatus lockup: the icon mark plus the LEGATUS letterforms, from the
// Brand API asset `logo-full-white-svg`. (The API publishes that logo stacked, mark above word,
// with rules and the "AI" tagline; the flat horizontal arrangement in legatus-lockup.svg is the
// same paths laid out for a wide slot. The upstream wordmark it replaces is 5.6:1; this is 5.2:1.)
//
// The watermark treatment is upstream's, unchanged: the same nested opacities and the same
// top-to-bottom fade mask, so only the letterforms differ and the screen keeps its design.

const lockup = parseBrandSvg(lockupSvg)
const [, , WIDTH, HEIGHT] = lockup.viewBox.split(/\s+/).map(Number) as [number, number, number, number]
// Upstream fades from 0.7 at 68/129 of the height to 0 at the bottom. Same proportion here.
const FADE_START = Math.round(HEIGHT * (68 / 129))

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={lockup.viewBox}
      fill="none"
      data-component="wordmark-legatus"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16">
            <g opacity="0.7" innerHTML={lockup.inner} />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width={WIDTH} height={HEIGHT}>
          <rect width={WIDTH} height={HEIGHT} fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient
          id={maskGradient}
          x1={WIDTH / 2}
          y1={FADE_START}
          x2={WIDTH / 2}
          y2={HEIGHT}
          gradientUnits="userSpaceOnUse"
        >
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
