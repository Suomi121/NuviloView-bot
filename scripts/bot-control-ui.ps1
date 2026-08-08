$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$projectRoot = Split-Path -Parent $PSScriptRoot
$controlScript = Join-Path $PSScriptRoot 'bot-control.ps1'
$logDirectory = Join-Path $projectRoot 'logs'

function New-UiFont {
  param([float]$Size, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular)
  return New-Object System.Drawing.Font('Yu Gothic UI', $Size, $Style)
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'NuviloView Bot Control'
$form.ClientSize = New-Object System.Drawing.Size(430, 360)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 29)
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-UiFont 10

$title = New-Object System.Windows.Forms.Label
$title.Text = 'NuviloView Bot'
$title.Font = New-UiFont 20 ([System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(28, 25)
$title.AutoSize = $true
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'PCホスト コントロール'
$subtitle.ForeColor = [System.Drawing.Color]::FromArgb(151, 147, 174)
$subtitle.Location = New-Object System.Drawing.Point(31, 63)
$subtitle.AutoSize = $true
$form.Controls.Add($subtitle)

$statusPanel = New-Object System.Windows.Forms.Panel
$statusPanel.Location = New-Object System.Drawing.Point(28, 98)
$statusPanel.Size = New-Object System.Drawing.Size(374, 100)
$statusPanel.BackColor = [System.Drawing.Color]::FromArgb(34, 34, 41)
$form.Controls.Add($statusPanel)

$statusDot = New-Object System.Windows.Forms.Label
$statusDot.Text = '●'
$statusDot.Font = New-UiFont 15 ([System.Drawing.FontStyle]::Bold)
$statusDot.Location = New-Object System.Drawing.Point(20, 17)
$statusDot.AutoSize = $true
$statusPanel.Controls.Add($statusDot)

$statusText = New-Object System.Windows.Forms.Label
$statusText.Text = '確認中…'
$statusText.Font = New-UiFont 14 ([System.Drawing.FontStyle]::Bold)
$statusText.Location = New-Object System.Drawing.Point(51, 17)
$statusText.AutoSize = $true
$statusPanel.Controls.Add($statusText)

$statusDetail = New-Object System.Windows.Forms.Label
$statusDetail.Text = 'Botの状態を取得しています。'
$statusDetail.ForeColor = [System.Drawing.Color]::FromArgb(170, 168, 187)
$statusDetail.Location = New-Object System.Drawing.Point(23, 58)
$statusDetail.Size = New-Object System.Drawing.Size(330, 31)
$statusPanel.Controls.Add($statusDetail)

function New-ControlButton {
  param([string]$Text, [int]$X, [int]$Width, [System.Drawing.Color]$Color)
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Location = New-Object System.Drawing.Point($X, 219)
  $button.Size = New-Object System.Drawing.Size($Width, 43)
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderSize = 0
  $button.BackColor = $Color
  $button.ForeColor = [System.Drawing.Color]::White
  $button.Font = New-UiFont 10 ([System.Drawing.FontStyle]::Bold)
  $button.Cursor = [System.Windows.Forms.Cursors]::Hand
  $form.Controls.Add($button)
  return $button
}

$startButton = New-ControlButton 'オン' 28 112 ([System.Drawing.Color]::FromArgb(67, 157, 112))
$stopButton = New-ControlButton 'オフ' 149 112 ([System.Drawing.Color]::FromArgb(194, 65, 78))
$restartButton = New-ControlButton '再起動' 270 132 ([System.Drawing.Color]::FromArgb(104, 96, 224))

$refreshButton = New-Object System.Windows.Forms.Button
$refreshButton.Text = '状態を更新'
$refreshButton.Location = New-Object System.Drawing.Point(28, 279)
$refreshButton.Size = New-Object System.Drawing.Size(180, 35)
$refreshButton.FlatStyle = 'Flat'
$refreshButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(72, 70, 83)
$refreshButton.BackColor = [System.Drawing.Color]::FromArgb(31, 31, 37)
$refreshButton.ForeColor = [System.Drawing.Color]::FromArgb(218, 216, 230)
$form.Controls.Add($refreshButton)

$logsButton = New-Object System.Windows.Forms.Button
$logsButton.Text = 'ログを開く'
$logsButton.Location = New-Object System.Drawing.Point(222, 279)
$logsButton.Size = New-Object System.Drawing.Size(180, 35)
$logsButton.FlatStyle = 'Flat'
$logsButton.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(72, 70, 83)
$logsButton.BackColor = [System.Drawing.Color]::FromArgb(31, 31, 37)
$logsButton.ForeColor = [System.Drawing.Color]::FromArgb(218, 216, 230)
$form.Controls.Add($logsButton)

$notice = New-Object System.Windows.Forms.Label
$notice.Text = 'この画面を閉じてもBotは動作し続けます。トークンは表示しません。'
$notice.ForeColor = [System.Drawing.Color]::FromArgb(127, 124, 143)
$notice.Font = New-UiFont 8.5
$notice.Location = New-Object System.Drawing.Point(30, 329)
$notice.AutoSize = $true
$form.Controls.Add($notice)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000

function Set-ControlsBusy {
  param([bool]$Busy)
  $startButton.Enabled = -not $Busy
  $stopButton.Enabled = -not $Busy
  $restartButton.Enabled = -not $Busy
  $refreshButton.Enabled = -not $Busy
}

function Invoke-BotControl {
  param([ValidateSet('Status', 'Start', 'Stop', 'Restart')][string]$RequestedAction)
  $lines = @(& $controlScript -Action $RequestedAction -Json)
  $json = ($lines -join "`n").Trim()
  if (-not $json) { throw 'Botコントローラーから応答がありません。' }
  return $json | ConvertFrom-Json
}

function Show-ControlStatus {
  param($Result)
  $isRunning = [bool]$Result.running
  $statusDot.ForeColor = if ($isRunning) {
    [System.Drawing.Color]::FromArgb(92, 210, 145)
  } else {
    [System.Drawing.Color]::FromArgb(224, 101, 111)
  }
  $statusText.Text = if ($isRunning) { 'オン' } else { 'オフ' }
  $details = New-Object System.Collections.Generic.List[string]
  if ($isRunning -and $Result.pid) { $details.Add("自動再起動 ON / PC起動時 ON / PID $($Result.pid)") }
  if (-not $isRunning -and -not $Result.startupEnabled) { $details.Add('PC再起動後もオフを維持します') }
  if (-not $isRunning -and $Result.startupEnabled) { $details.Add('停止中ですがPC起動時はオンになります') }
  $messageProperty = $Result.PSObject.Properties['message']
  if ($messageProperty -and $messageProperty.Value) { $details.Add($messageProperty.Value) }
  elseif ($Result.lastEvent) { $details.Add($Result.lastEvent) }
  $statusDetail.Text = ($details -join '  •  ')
  $startButton.Enabled = -not $isRunning
  $stopButton.Enabled = $isRunning
  $restartButton.Enabled = $isRunning
}

function Refresh-ControlStatus {
  try {
    Show-ControlStatus (Invoke-BotControl -RequestedAction 'Status')
  } catch {
    $statusDot.ForeColor = [System.Drawing.Color]::FromArgb(231, 171, 73)
    $statusText.Text = '確認エラー'
    $statusDetail.Text = $_.Exception.Message
  }
}

function Run-ControlAction {
  param([ValidateSet('Start', 'Stop', 'Restart')][string]$RequestedAction)
  $timer.Stop()
  Set-ControlsBusy $true
  $statusText.Text = switch ($RequestedAction) {
    'Start' { '起動中…' }
    'Stop' { '停止中…' }
    default { '再起動中…' }
  }
  $statusDetail.Text = '処理が完了するまでお待ちください。'
  [System.Windows.Forms.Application]::DoEvents()
  try {
    Show-ControlStatus (Invoke-BotControl -RequestedAction $RequestedAction)
  } catch {
    $statusDot.ForeColor = [System.Drawing.Color]::FromArgb(231, 171, 73)
    $statusText.Text = '操作エラー'
    $statusDetail.Text = $_.Exception.Message
  } finally {
    $timer.Start()
  }
}

$startButton.Add_Click({ Run-ControlAction -RequestedAction 'Start' })
$stopButton.Add_Click({ Run-ControlAction -RequestedAction 'Stop' })
$restartButton.Add_Click({ Run-ControlAction -RequestedAction 'Restart' })
$refreshButton.Add_Click({ Refresh-ControlStatus })
$logsButton.Add_Click({
  New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $logDirectory) | Out-Null
})
$timer.Add_Tick({ Refresh-ControlStatus })
$form.Add_Shown({ Refresh-ControlStatus; $timer.Start() })
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })

[void]$form.ShowDialog()
