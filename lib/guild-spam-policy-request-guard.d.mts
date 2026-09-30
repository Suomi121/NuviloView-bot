export type GuildSpamPolicyRequestKind = "load" | "mutation";

export type GuildSpamPolicyRequestToken = Readonly<{
  guildId: string;
  generation: number;
  isCurrent: () => boolean;
}>;

export type GuildSpamPolicyRequestGuard = Readonly<{
  mount: () => void;
  selectGuild: (guildId: string | null | undefined) => void;
  begin: (kind: GuildSpamPolicyRequestKind, guildId?: string | null) => GuildSpamPolicyRequestToken;
  unmount: () => void;
}>;

export declare function createGuildSpamPolicyRequestGuard(): GuildSpamPolicyRequestGuard;
