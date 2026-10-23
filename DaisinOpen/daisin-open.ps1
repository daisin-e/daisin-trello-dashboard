# daisin-open.ps1 (v2: フォルダ対応版)
# daisin-open: プロトコルで渡された SharePoint/OneDrive の URL を、
# OneDrive 同期済みのローカルファイル／フォルダに変換し、
# ファイルは既定アプリ、フォルダはエクスプローラーで開く。
# ダウンロードは行わない。見つからない場合はブラウザで開く。

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
  $uri = [Uri]$raw
  if ($AllowedHosts -notcontains $uri.Host.ToLower()) {
    Msg "許可されていない URL です:`n$($uri.Host)"; exit 1
  }
  $webPath = [Uri]::UnescapeDataString($uri.AbsolutePath)   # /personal/xxx/Documents/大真フォルダ/...
  Log "path: $webPath"

  # --- 2. "Documents/" 以降を相対パスとして取り出す ------------------------
  $m = [regex]::Match($webPath, '/(?:Documents|Shared Documents)/(.+)$')
  if (-not $m.Success) { Msg "パスを判定できませんでした:`n$webPath"; exit 1 }
  $rel   = $m.Groups[1].Value                 # 大真フォルダ/2）工事.../file.pdf または .../案件フォルダ/...
  $rel   = $rel.TrimEnd('/')                   # 末尾スラッシュ除去（フォルダURL対策）
  $parts = $rel -split '/'
  $top   = $parts[0]                          # 大真フォルダ
  $rest  = ($parts | Select-Object -Skip 1) -join '\'

  # --- 3. ローカルの同期フォルダを探す ------------------------------------
  # 設定ファイル（1行 = フォルダ名<TAB>ローカルパス）
  $cfg = @{}
  if (Test-Path $CfgPath) {
    foreach ($line in (Get-Content $CfgPath -Encoding UTF8)) {
      $kv = $line -split "`t", 2
      if ($kv.Count -eq 2) { $cfg[$kv[0]] = $kv[1] }
    }
  }
  $root = $null
  if ($cfg.ContainsKey($top) -and (Test-Path $cfg[$top])) { $root = $cfg[$top] }

  if (-not $root) {
    # OneDrive 配下から "<top>" または "xxx - <top>" という名前のフォルダを探す
    $bases = @($env:OneDriveCommercial, $env:OneDrive, $env:USERPROFILE) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
    $cands = @()
    foreach ($b in $bases) {
      $cands += Get-ChildItem -Path $b -Directory -Depth 2 -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -eq $top -or $_.Name -like "* - $top" }
    }
    foreach ($c in $cands) {
      if ($rest -eq '' -or (Test-Path (Join-Path $c.FullName $rest))) { $root = $c.FullName; break }
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
    $local = Join-Path $root $rest
    Log "local: $local"
    if (Test-Path $local) {
      # ★ v2 変更点: フォルダ or ファイルを判定して処理分岐
      if (Test-Path -LiteralPath $local -PathType Container) {
        # フォルダ → エクスプローラーで開く
        Log "open as folder (explorer): $local"
        Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$local`""
      } else {
        # ファイル → 既定アプリで開く
        Log "open as file (default app): $local"
        Start-Process -FilePath $local
      }
      exit 0
    }
  }

  # 見つからない → ブラウザで開く（フォールバック）
  Log "fallback to browser"
  Start-Process $uri.AbsoluteUri
  Msg "OneDrive 同期フォルダ内にパスが見つからなかったため、ブラウザで開きました。`n`n同期フォルダ「$top」が PC にあるか確認してください。"
  exit 0
}
catch {
  Msg "エラー: $($_.Exception.Message)"
  exit 1
}
