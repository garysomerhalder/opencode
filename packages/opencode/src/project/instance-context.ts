import { LocalContext } from "@/util/local-context"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CanonicalPath } from "@/util/canonical-path"
import type * as Project from "./project"

export interface InstanceContext {
  directory: string
  worktree: string
  project: Project.Info
}

export const context = LocalContext.create<InstanceContext>("instance")

/**
 * Check if a path is within the project boundary.
 * Returns true if path is inside ctx.directory OR ctx.worktree.
 * Paths within the worktree but outside the working directory should not trigger external_directory permission.
 */
export function containsPath(filepath: string, ctx: InstanceContext): boolean {
  // Both sides as the system resolves them: a link inside the workspace that
  // leads outside it is outside, and a workspace opened through a link (macOS
  // /tmp is /private/tmp) contains the files under its real directory.
  const file = CanonicalPath.resolve(filepath)
  if (FSUtil.contains(CanonicalPath.resolve(ctx.directory), file)) return true
  // Non-git projects set worktree to "/" which would match ANY absolute path.
  // Skip worktree check in this case to preserve external_directory permissions.
  if (ctx.worktree === "/") return false
  return FSUtil.contains(CanonicalPath.resolve(ctx.worktree), file)
}
