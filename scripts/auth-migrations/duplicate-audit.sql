-- Read-only aggregate. Contains no identity, email, token or owner values.
SELECT count(*)::integer AS duplicate_groups
FROM (
  SELECT 1 FROM public.account
  GROUP BY "providerId", "accountId"
  HAVING count(*) > 1
) duplicates;
