/**
 * Canonical Permission Model (ADR-07)
 *
 * Defines the canonical permission mode ids:
 * - plan: read-only, no modifications or arbitrary executions
 * - acceptEdits: allowed to modify vault files
 * - bypassPermissions: full access without per-action approvals
 */

export type CanonicalPermissionMode = "plan" | "acceptEdits" | "bypassPermissions";

export interface PermissionModeDescriptor {
  id: CanonicalPermissionMode;
  label: string;
  description: string;
}

export const CANONICAL_PERMISSION_MODES: Record<CanonicalPermissionMode, PermissionModeDescriptor> = {
  plan: {
    id: "plan",
    label: "Plan only",
    description: "Read-only. Inspects notes and artifacts without editing files or running arbitrary commands.",
  },
  acceptEdits: {
    id: "acceptEdits",
    label: "Accept edits",
    description: "Allows modifying notes and creating artifacts inside the vault.",
  },
  bypassPermissions: {
    id: "bypassPermissions",
    label: "Bypass permissions",
    description: "Bypasses approvals. Full access to write files and execute tools.",
  },
};

export const DEFAULT_PERMISSION_MODE: CanonicalPermissionMode = "plan";

/**
 * Mapping from canonical permission modes to CLI command-line arguments.
 */
export function getCliPermissionArgs(
  agentKey: string,
  mode: CanonicalPermissionMode
): string[] {
  const normKey = agentKey.toLowerCase();
  if (normKey.includes("claude")) {
    switch (mode) {
      case "plan":
        return ["--permission-mode", "plan"];
      case "acceptEdits":
        return ["--permission-mode", "acceptEdits"];
      case "bypassPermissions":
        return ["--permission-mode", "bypassPermissions"];
      default:
        return ["--permission-mode", "plan"];
    }
  }

  if (normKey.includes("agy")) {
    switch (mode) {
      case "plan":
        return ["--mode", "plan"];
      case "acceptEdits":
        return ["--mode", "accept-edits"];
      case "bypassPermissions":
        return ["--dangerously-skip-permissions"];
      default:
        return ["--mode", "plan"];
    }
  }

  return [];
}

/**
 * Validates and clamps a requested permission mode to the agent's supported list.
 * Defaults to 'plan' (the most restrictive mode).
 */
export function clampToSupported(
  requestedMode: string | undefined | null,
  supportedModes?: Array<{ id: string } | string>
): CanonicalPermissionMode {
  const supportedIds = (supportedModes || []).map((m) =>
    typeof m === "string" ? m : m.id
  );

  // Validate canonical id
  const canonicalCandidate: CanonicalPermissionMode =
    requestedMode === "bypassPermissions"
      ? "bypassPermissions"
      : requestedMode === "acceptEdits"
      ? "acceptEdits"
      : "plan";

  if (supportedIds.length === 0) {
    return canonicalCandidate;
  }

  if (supportedIds.includes(canonicalCandidate)) {
    return canonicalCandidate;
  }

  // If requested mode is not supported by the agent, fall back to the most restrictive mode available
  if (supportedIds.includes("plan")) {
    return "plan";
  }
  if (supportedIds.includes("acceptEdits")) {
    return "acceptEdits";
  }

  return "plan";
}

/**
 * Normalizes legacy permission strings to canonical modes.
 */
export function normalizeLegacyPermissionMode(legacyMode: string | undefined | null): CanonicalPermissionMode {
  if (!legacyMode) return "plan";
  if (legacyMode === "bypassPermissions") return "bypassPermissions";
  if (legacyMode === "acceptEdits") return "acceptEdits";
  return "plan";
}

