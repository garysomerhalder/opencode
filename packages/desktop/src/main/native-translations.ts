import {
  DESKTOP_NATIVE_ENGLISH,
  DESKTOP_NATIVE_KEYS,
  formatDesktopNativeMessage,
  type DesktopNativeBundle,
  type DesktopNativeKey,
} from "@opencode-ai/app/i18n/desktop-native"
import { activeBrand, brandDictionary } from "@opencode-ai/app/brand"

// The renderer sends an already-branded bundle; this only covers menus/dialogs shown before it arrives.
let bundle: DesktopNativeBundle = {
  locale: "en",
  messages: brandDictionary({ ...DESKTOP_NATIVE_ENGLISH }, activeBrand()),
}

export function setNativeTranslations(next: DesktopNativeBundle) {
  if (
    next.locale === bundle.locale &&
    DESKTOP_NATIVE_KEYS.every((key) => next.messages[key] === bundle.messages[key])
  ) {
    return false
  }
  bundle = next
  return true
}

export function nativeT(key: DesktopNativeKey, params?: Record<string, string | number>) {
  return formatDesktopNativeMessage(bundle.messages[key], params)
}
