"use client";

import { useEffect, useId, useRef, useState } from 'react'
import { Menu, X } from 'lucide-react'
import { DashboardNavigation } from './dashboard-navigation'
import type { DashboardView, NavigationItem } from '@/lib/dashboard-navigation'

export function MobileNavigation({ activeView, en, onNavigate }: { activeView: DashboardView; en: boolean; onNavigate: (item: NavigationItem) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const media = window.matchMedia('(min-width: 1024px)')
    const closeOnDesktop = () => { if (media.matches) dialog.current?.close() }
    media.addEventListener('change', closeOnDesktop)
    closeOnDesktop()
    return () => { document.body.style.overflow = previousOverflow; media.removeEventListener('change', closeOnDesktop) }
  }, [open])
  const navigate = (item: NavigationItem) => { dialog.current?.close(); onNavigate(item) }
  return <>
    <button ref={trigger} type="button" aria-label={en ? 'Open navigation' : 'ナビゲーションを開く'} aria-controls={id} aria-expanded={open} aria-haspopup="dialog" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary lg:hidden" onClick={() => { dialog.current?.showModal(); setOpen(true); closeButton.current?.focus() }}><Menu className="h-5 w-5" aria-hidden="true" /></button>
    <dialog ref={dialog} id={id} aria-labelledby={`${id}-title`} className="fixed inset-y-0 left-0 right-auto m-0 h-dvh max-h-dvh w-[min(320px,calc(100vw-32px))] max-w-none overflow-y-auto border-r border-border bg-background p-4 text-foreground backdrop:bg-black/60" onClose={() => { setOpen(false); trigger.current?.focus() }} onKeyDown={event => {
      if (event.key !== 'Tab') return
      const targets = event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]')
      const first = targets[0]
      const last = targets[targets.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }} onClick={event => {
      if (event.target !== event.currentTarget) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close()
    }}>
      <div className="mb-4 flex items-center justify-between gap-2"><h2 id={`${id}-title`} className="text-sm font-bold">{en ? 'Navigation' : 'ナビゲーション'}</h2><button ref={closeButton} type="button" className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary" aria-label={en ? 'Close navigation' : 'ナビゲーションを閉じる'} onClick={() => dialog.current?.close()}><X className="h-5 w-5" aria-hidden="true" /></button></div>
      <DashboardNavigation activeView={activeView} en={en} onNavigate={navigate} />
    </dialog>
  </>
}
