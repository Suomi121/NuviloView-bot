import type { MetadataRoute } from 'next'

const SITE_URL = 'https://nuviloview-oem.vercel.app'

const publicRoutes = [
  { path: '/', changeFrequency: 'weekly', priority: 1 },
  { path: '/features', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/demo', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/docs', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/guides', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/support', changeFrequency: 'yearly', priority: 0.5 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
] as const

export default function sitemap(): MetadataRoute.Sitemap {
  return publicRoutes.map(({ path, changeFrequency, priority }) => ({
    url: `${SITE_URL}${path}`,
    changeFrequency,
    priority,
  }))
}
