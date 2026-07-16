'use client'

import { createContext, useContext, useEffect, useState } from 'react'

export type Locale = 'ja' | 'en'

const LocaleContext = createContext<{ locale: Locale; setLocale: (locale: Locale) => void }>({ locale: 'ja', setLocale: () => undefined })

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('ja')
  useEffect(() => {
    const stored = window.localStorage.getItem('nuviloview-locale')
    if (stored === 'ja' || stored === 'en') setLocaleState(stored)
    fetch('/api/settings/timezone').then((response) => response.ok ? response.json() : null).then((data) => {
      if (data?.language === 'ja' || data?.language === 'en') setLocaleState(data.language)
    }).catch(() => undefined)
  }, [])
  const setLocale = (nextLocale: Locale) => {
    window.localStorage.setItem('nuviloview-locale', nextLocale)
    document.documentElement.lang = nextLocale
    setLocaleState(nextLocale)
  }
  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>
}

export function useLocale() { return useContext(LocaleContext) }
