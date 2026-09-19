import { type ComponentProps } from "solid-js"
import iconSvg from "./legatus-icon.svg?raw"
import lockupSvg from "./legatus-lockup.svg?raw"
import { parseBrandSvg } from "./svg"

// Legatus stand-in for `@opencode-ai/ui/logo`. electron.vite.config.ts aliases that module here
// while the Legatus brand is on, so this file must keep the same exports and props (Mark, Splash, Logo).
//
// The artwork is the official Legatus icon mark (Brand API asset `logo-icon-svg`, translated to a
// 0-origin viewBox) and the flat horizontal lockup. It is not altered. The white fill becomes
// currentColor, so the theme's icon color picks the official white or black mono variant.

const icon = parseBrandSvg(iconSvg)
const lockup = parseBrandSvg(lockupSvg)

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox={icon.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: "var(--icon-strong-base)" }}
      innerHTML={icon.inner}
    />
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox={icon.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: "var(--icon-strong-base)" }}
      innerHTML={icon.inner}
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-wordmark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox={lockup.viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: "var(--icon-strong-base)" }}
      innerHTML={lockup.inner}
    />
  )
}
