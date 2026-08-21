CREATE TABLE IF NOT EXISTS "branding" (
  "userId" text PRIMARY KEY,
  "brandName" text NOT NULL DEFAULT 'NuviloView:OEM',
  "logoUrl" text,
  "accentColor" text NOT NULL DEFAULT '#5865F2',
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
