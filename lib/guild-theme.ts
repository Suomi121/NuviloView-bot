import type { CSSProperties } from 'react'

export type GuildTheme = {
  mode: 'dark' | 'light'
  primaryColor: string
  accentColor: string
  backgroundColor: string
  cardColor: string
  radius: 'compact' | 'default' | 'rounded'
  brandName: string
  logoUrl: string | null
}

export const defaultGuildTheme: GuildTheme = {
  mode: 'dark', primaryColor: '#6677ff', accentColor: '#9b8cff',
  backgroundColor: '#111116', cardColor: '#1c1c24', radius: 'default',
  brandName: 'NuviloView:OEM', logoUrl: null,
}

const defaultDarkBackground = '#111116'
const defaultDarkCard = '#1c1c24'
export function guildThemeStyle(theme: GuildTheme): CSSProperties {
  const background = theme.backgroundColor.toLowerCase() === '#f5f5f8' ? defaultDarkBackground : theme.backgroundColor
  const card = theme.cardColor.toLowerCase() === '#ffffff' ? defaultDarkCard : theme.cardColor
  const radius = theme.radius === 'compact' ? '0.45rem' : theme.radius === 'rounded' ? '1.15rem' : '0.75rem'
  return {
    colorScheme: 'dark',
    '--background': background,
    '--foreground': '#f7f7fa',
    '--card': card,
    '--card-foreground': '#f7f7fa',
    '--popover': card,
    '--popover-foreground': '#f7f7fa',
    '--primary': theme.primaryColor,
    '--primary-foreground': '#ffffff',
    '--secondary': '#282831',
    '--secondary-foreground': '#f7f7fa',
    '--muted': '#282831',
    '--muted-foreground': '#a5a4b1',
    '--accent': theme.accentColor,
    '--accent-foreground': '#ffffff',
    '--border': '#ffffff16',
    '--input': '#ffffff22',
    '--ring': theme.primaryColor,
    '--chart-1': theme.primaryColor,
    '--chart-2': theme.accentColor,
    '--chart-3': theme.primaryColor,
    '--sidebar': card,
    '--sidebar-foreground': '#f7f7fa',
    '--sidebar-primary': theme.primaryColor,
    '--sidebar-primary-foreground': '#ffffff',
    '--sidebar-accent': '#282831',
    '--sidebar-accent-foreground': '#f7f7fa',
    '--sidebar-border': '#ffffff16',
    '--sidebar-ring': theme.primaryColor,
    '--radius': radius,
  } as CSSProperties
}
