export function createModerationRepository(securityRepository) {
  function recordAction(input) {
    return securityRepository.appendAudit({
      ...input,
      category: input?.category ?? "moderation",
    });
  }

  return Object.freeze({ recordAction });
}
