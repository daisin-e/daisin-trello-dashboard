# daisin-open.ps1
# daisin-open: プロトコルで渡された SharePoint/OneDrive の URL を、
# OneDrive 同期済みのローカルファイルに変換し、既定のアプリで開く。
# ダウンロードは行わない。見つからない場合はブラウザで開く。
#
# 2026-11-10 修正:
#  - ファイル名・フォルダ名の半角 # が URL のフラグメント扱いになり、
#    パスが途中で切れて手前のフォルダが開いてしまう不具合を修正
#  - 半角 [ ] を含む名前でファイルが見つからない不具合を修正（-LiteralPath 化）
#  - ファイルが見つからないときにフォルダを開いてしまう動きを修正

param([string]$Url)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$AppDir  = Join-Path $env:LOCALAPPDATA 'DaisinOpen'
$CfgPath = Join-Path $AppDir 'config.txt'
$LogPath = Join-Path $AppDir 'last.log'
$AllowedHosts = @('daisin2003.sharepoint.com', 'daisin2003-my.sharepoint.com')

function Log($m) {
  try { Add-Content -Path $LogPath -Value ("{0} {1}" -f (Get-Date -Format s), $m) -Encoding UTF8 } catch {}
}
function Msg($m) {
  Log $m
  [System.Windows.Forms.MessageBox]::Show($m, 'Daisin Open', 'OK', 'Information') | Out-Null
}

try {
  if (-not (Test-Path $AppDir)) { New-Item -ItemType Directory -Path $AppDir | Out-Null }
  if (Test-Path $LogPath) { Clear-Content $LogPath }

  Log "arg: $Url"

  # --- 1. URL を取り出す ---------------------------------------------------
  $raw = $Url -replace '^daisin-open:/*', ''
  $raw = [Uri]::UnescapeDataString($raw)
  if ($raw -notmatch '^https://') { $raw = [Uri]::UnescapeDataString($raw) }

  # [Uri] で解析すると # 以降がフラグメントとして切り捨てられるため、文字列のまま分解する
  if ($raw -notmatch '^https://([^/]+)(/.*)$') {
    Msg "URL を判定できませんでした:`n$raw"; exit 1
  }
  $hostName = $Matches[1].ToLower()
  $webPath  = $Matches[2]
  if ($AllowedHosts -notcontains $hostName) {
    Msg "許可されていない URL です:`n$hostName"; exit 1
  }
  # まだ %E5... のようなエンコードが残っていればもう一度戻す
  if ($webPath -match '%[0-9A-Fa-f]{2}') {
    try { $webPath = [Uri]::UnescapeDataString($webPath) } catch {}
  }
  # 末尾の ?web=1 などを除去（? はファイル名に使えないので安全）
  $webPath = $webPath -replace '\?.*$', ''
  Log "path: $webPath"

  # ブラウザで開くときの URL（各階層をエンコードし直す）
  $browserUrl = "https://$hostName" + (($webPath -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/')

  # --- 2. "Documents/" 以降を相対パスとして取り出す ------------------------
  $m = [regex]::Match($webPath, '/(?:Documents|Shared Documents)/(.+)$')
  if (-not $m.Success) { Msg "ファイルパスを判定できませんでした:`n$webPath"; exit 1 }
  $rel   = $m.Groups[1].Value.TrimEnd('/')
  $parts = $rel -split '/'

  $top   = $parts[0]
  $rest  = ($parts | Select-Object -Skip 1) -join '\'

  # --- 3. ローカルの同期フォルダを探す ------------------------------------
  $cfg = @{}
  if (Test-Path $CfgPath) {
    foreach ($line in (Get-Content $CfgPath -Encoding UTF8)) {
      $kv = $line -split "`t", 2
      if ($kv.Count -eq 2) { $cfg[$kv[0]] = $kv[1] }
    }
  }
  $root = $null
  if ($cfg.ContainsKey($top) -and (Test-Path -LiteralPath $cfg[$top])) { $root = $cfg[$top] }

  if (-not $root) {
    $bases = @($env:OneDriveCommercial, $env:OneDrive, $env:USERPROFILE) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
    $cands = @()
    foreach ($b in $bases) {
      $cands += Get-ChildItem -LiteralPath $b -Directory -Depth 2 -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq $top -or $_.Name -like "* - $top" }
    }
    foreach ($c in $cands) {
      if ($rest -eq '' -or (Test-Path -LiteralPath (Join-Path $c.FullName $rest))) { $root = $c.FullName; break }
    }
    if (-not $root -and $cands.Count -gt 0) { $root = $cands[0].FullName }
    if ($root) {
      $cfg[$top] = $root
      ($cfg.Keys | ForEach-Object { "$_`t$($cfg[$_])" }) | Set-Content -Path $CfgPath -Encoding UTF8
      Log "root detected: $root"
    }
  }


  # --- 4. 開く ---------------------------------------------------------------
  if ($root) {
    $local = if ($rest -eq '') { $root } else { Join-Path $root $rest }
    Log "local: $local"
    $isFileLink = ($parts[-1] -match '\.[A-Za-z0-9]{1,5}$')
    if ($isFileLink -and (Test-Path -LiteralPath $local -PathType Leaf)) {
      Invoke-Item -LiteralPath $local
      exit 0
    }
    if (-not $isFileLink -and (Test-Path -LiteralPath $local -PathType Container)) {
      Invoke-Item -LiteralPath $local
      exit 0
    }
  }

  # 見つからない → ブラウザで開く（フォールバック）
  Log "fallback to browser: $browserUrl"
  Start-Process $browserUrl
  Msg "OneDrive 同期フォルダ内にファイルが見つからなかったため、ブラウザで開きました。`n`n同期フォルダ「$top」が PC にあるか、ファイル名や場所が変わっていないか確認してください。"
  exit 0
}
catch {
  Msg "エラー: $($_.Exception.Message)"
  exit 1
}
