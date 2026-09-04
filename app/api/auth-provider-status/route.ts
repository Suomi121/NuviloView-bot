import { getAuthProviderAvailability } from '@/lib/auth-provider-config'

export async function GET() {
  return Response.json(getAuthProviderAvailability(), {
    headers: {
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=300',
    },
  })
}
