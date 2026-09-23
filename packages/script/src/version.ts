import semver from "semver"

// Version stamps for preview (non-release) builds. Pure, so the rules are tested.
//
// A preview used to be "0.0.0-<channel>-<timestamp>". Providers that gate on
// the client version ("OpenCode 1.18.0 or newer is required") refused every dev
// build, because 0.0.0-anything is older than any release. A preview now
// carries the package version with a prerelease suffix,
// "<base>-<channel>.<yyyymmddhhmm>", which is valid semver and sorts with the
// release it was built from.

export function previewVersion(input: { base: string; channel: string; now: Date }) {
  const channel = input.channel.replace(/[^0-9A-Za-z-]+/g, "-").replace(/^-+|-+$/g, "") || "dev"
  const stamp = input.now.toISOString().slice(0, 16).replace(/[-:T]/g, "")
  return `${input.base}-${channel}.${stamp}`
}

/** A prerelease version is a preview build, whatever its base. */
export function isPreviewVersion(version: string) {
  return semver.prerelease(version) !== null
}
