import { ShieldCheck } from 'lucide-react'

export function SecurityNavigationLink({ en = false }: { en?: boolean }) {
  return (
    <a
      href="/dashboard/security/spam"
      className="flex min-h-11 w-full items-center gap-3 rounded-lg bg-gradient-to-r from-blue-700 to-violet-700 px-3 py-2.5 text-sm font-bold text-white shadow-sm shadow-violet-950/20 transition-shadow hover:shadow-md hover:shadow-violet-950/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{en ? 'Security' : 'セキュリティー'}</span>
    </a>
  )
}
