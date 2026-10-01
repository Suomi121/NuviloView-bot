const requestKinds = Object.freeze(["load", "mutation"]);

export function createGuildSpamPolicyRequestGuard() {
  let mounted = true;
  let selectedGuildId = "";
  const generations = new Map(requestKinds.map((kind) => [kind, 0]));

  function invalidate(kind) {
    generations.set(kind, (generations.get(kind) ?? 0) + 1);
  }

  return Object.freeze({
    mount() {
      mounted = true;
    },
    selectGuild(guildId) {
      selectedGuildId = String(guildId ?? "");
      for (const kind of requestKinds) invalidate(kind);
    },
    begin(kind, guildId = selectedGuildId) {
      if (!generations.has(kind)) throw new TypeError("Unknown Guild policy request kind.");
      const targetGuildId = String(guildId ?? "");
      const generation = (generations.get(kind) ?? 0) + 1;
      generations.set(kind, generation);
      return Object.freeze({
        guildId: targetGuildId,
        generation,
        isCurrent() {
          return mounted && selectedGuildId === targetGuildId && generations.get(kind) === generation;
        },
      });
    },
    unmount() {
      mounted = false;
      for (const kind of requestKinds) invalidate(kind);
    },
  });
}
