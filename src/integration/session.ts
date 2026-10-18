/**
 * Session identity and restricted-role detection.
 *
 * WAICC binds a chat as a handoff recipient by recording a "waicc-session" custom
 * entry with role "recipient" (and narrowing the active tools). The advisor reads
 * that marker (read-only) and fails closed so a restricted recipient cannot use it
 * to regain tools or spawn a second investigator. Unknown roles also fail closed.
 */
interface EntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface SessionManagerLike {
  getSessionId(): string;
  getBranch(): EntryLike[];
}

export function chatIdOf(sessionManager: SessionManagerLike): string {
  try {
    return sessionManager.getSessionId() || "unknown-session";
  } catch {
    return "unknown-session";
  }
}

export function restrictedRoleOf(sessionManager: SessionManagerLike): string | null {
  let branch: EntryLike[];
  try {
    branch = sessionManager.getBranch();
  } catch {
    return "unknown (session state unavailable)";
  }
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "custom" || entry.customType !== "waicc-session") continue;
    const role = (entry.data as { role?: unknown } | undefined)?.role;
    if (role === "coordinator") return null;
    if (role === "recipient") return "WAICC handoff recipient";
    return "unrecognized WAICC role";
  }
  return null;
}
