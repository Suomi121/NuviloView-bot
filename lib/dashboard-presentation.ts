export type DashboardAccessState = 'auth_loading' | 'auth_error' | 'signed_out' | 'guild_loading' | 'guild_error' | 'no_guilds' | 'choose_guild' | 'ready'
export function dashboardAccessState(input: { pending: boolean; authError: boolean; signedIn: boolean; guildLoading: boolean; guildError: boolean; guildCount: number; selected: boolean }): DashboardAccessState {
  if (input.pending) return 'auth_loading'
  if (input.authError) return 'auth_error'
  if (!input.signedIn) return 'signed_out'
  if (input.guildLoading) return 'guild_loading'
  if (input.guildError) return 'guild_error'
  if (!input.guildCount) return 'no_guilds'
  if (!input.selected) return 'choose_guild'
  return 'ready'
}

export function canDisplayDashboardData(input: { access: DashboardAccessState; authorized: boolean; state: string; available: boolean; lastKnownGood: boolean; statsDays: number }) {
  return input.access === 'ready' && input.authorized && input.state !== 'loading' && (input.available || input.lastKnownGood) && input.statsDays > 0
}

export const accessMessages: Record<DashboardAccessState, [string, string]> = {
  auth_loading: ['ログイン状態を確認しています', 'Checking your session'],
  auth_error: ['ログイン状態を確認できませんでした。再読み込みしてください。', 'Could not check your session. Please reload.'],
  signed_out: ['ログインして、管理するサーバーを選択してください。', 'Sign in to choose a server you manage.'],
  guild_loading: ['管理できるサーバーを読み込んでいます', 'Loading your servers'],
  guild_error: ['サーバー一覧を取得できませんでした。再試行してください。', 'Could not load your servers. Please retry.'],
  no_guilds: ['管理できるサーバーがありません。Discordの接続とサーバー管理権限を確認してください。', 'No manageable servers. Check your Discord connection and server permissions.'],
  choose_guild: ['サーバーを選択するとデータを表示します。', 'Choose a server to view its data.'],
  ready: ['', ''],
}
