export type ChannelEntityMetadata = string | { name?: string | null; deleted?: boolean };

export function unknownChannelLabel(channelId: string | null | undefined, locale?: "ja" | "en"): string;
export function resolveChannelDisplayName(input?: {
  channelId?: string | null;
  projectedName?: string | null;
  channelNames?: ReadonlyMap<string, ChannelEntityMetadata> | Readonly<Record<string, ChannelEntityMetadata>> | null;
  locale?: "ja" | "en";
}): string;
export function formatVoiceDuration(seconds: unknown, locale?: "ja" | "en"): string;
export function formatInsightPresentation(insight: any, options?: {
  locale?: "ja" | "en";
  channelNames?: ReadonlyMap<string, ChannelEntityMetadata> | Readonly<Record<string, ChannelEntityMetadata>> | null;
}): {
  title: string;
  detail: string;
  recommendation: string;
  categoryLabel: string;
  severityLabel: string;
};
