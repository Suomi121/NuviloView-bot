import { createPostgresProviderAdapter } from "./postgres.mjs";

export function createSupabaseProviderAdapter({
  enabled = false,
  execute,
  close,
} = {}) {
  return createPostgresProviderAdapter({
    id: "supabase",
    required: true,
    enabled,
    execute,
    close,
  });
}
