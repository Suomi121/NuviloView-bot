export const SECURITY_SCOPES = Object.freeze({
  view: "ViewSecurity",
  policy: "ManageSecurityPolicy",
  contain: "ContainActor",
  restore: "RestoreStructure",
});

export function isDiscordSnowflake(value) {
  return /^\d{16,22}$/.test(String(value ?? ""));
}
export function securityScopesForAccess({ managedGuild, guildOwner, platformDeveloper = false }) {
  if (platformDeveloper || (managedGuild && guildOwner)) return Object.values(SECURITY_SCOPES);
  // getManagedGuilds only returns Guilds where Discord grants ownership or
  // Manage Guild. Those administrators may manage the server's security mode.
  if (managedGuild) return Object.values(SECURITY_SCOPES);
  return [];
}

export function hasSecurityScope(scopes, requiredScope) {
  return Array.isArray(scopes) && scopes.includes(requiredScope);
}

export function normalizeResolutionReason(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return String(value).trim().slice(0, 500);
}

export function normalizeTrustedActorInput(input) {
  const actorId = isDiscordSnowflake(input?.actorId) ? String(input.actorId) : null;
  if (!actorId) return null;
  const actorType = ["user", "bot", "unknown"].includes(input?.actorType)
    ? input.actorType
    : "unknown";
  const label = typeof input?.label === "string" && input.label.trim()
    ? input.label.trim().slice(0, 100)
    : null;
  return { actorId, actorType, label };
}
