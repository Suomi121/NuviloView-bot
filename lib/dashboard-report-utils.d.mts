export type DashboardReportRow = {
  date: string
  messages: number
  members: number
}

export type DashboardPrintReportInput = {
  documentTitle: string
  guildName: string
  periodLabel: string
  memberLabel: string
  messageLabel: string
  voiceLabel: string
  memberCount: number
  messageCount: number
  voiceDuration: string
  dateLabel: string
  rows: DashboardReportRow[]
}

export function escapeReportHtml(value: unknown): string
export function buildDashboardPrintReportHtml(input: DashboardPrintReportInput): string
