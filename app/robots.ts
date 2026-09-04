import type { MetadataRoute } from 'next'

const SITE_URL = 'https://nuviloview-oem.vercel.app'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/backend/', '/account', '/dashboard', '/developer', '/pro', '/settings'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}
