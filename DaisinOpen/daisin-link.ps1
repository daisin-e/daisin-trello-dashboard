# daisin-link.ps1 (v2: フォルダ対応版)
# エクスプローラーの右クリック「Trello 用リンクをコピー」から呼ばれる。
# OneDrive 同期フォルダ内のローカルファイル／フォルダを、open.html 用のリンクに変換してクリップボードへ。

param([string]$Path, [string]$Format = 'md')  # md = [名前](URL) / url = URL のみ

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$OpenPage = 'https://daisin-e.github.io/daisin-trello-dashboard/open.html'
$WebRoot  = 'https://daisin2003-my.sharepoint.com/personal/ochi_daisin2003_onmicrosoft_com/Documents'
# OneDrive 上で「Documents 直下」にある共有フォルダ名
$KnownTops = @('大真フォルダ', '事務フォルダ')
$AppByExt = @{
  '.xlsx'='excel'; '.xlsm'='excel'; '.xls'='excel'; '.csv'='excel'
  '.docx'='word';  '.doc'='word'
  '.pptx'='powerpoint'; '.ppt'='powerpoint'
  '.vsdx'='visio'; '.vsd'='visio'
  '.pdf'='pdf'
}

$AppDir  = Join-Path $env:LOCALAPPDATA 'DaisinOpen'
$LogPath = Join-Path $AppDir 'link.log'
function Log($m) { try { Add-Content -Path $LogPath -Value ("{0} {1}" -f (Get-Date -Format s), $m) -Encoding UTF8 } catch {} }
function Msg($m, $icon = 'Information') {
  Log $m
  [System.Windows.Forms.MessageBox]::Show($m, 'Trello 用リンク', 'OK', $icon) | Out-Null
}

try {
  if (-not (Test-Path $AppDir)) { New-Item -ItemType Directory -Path $AppDir | Out-Null }
  if (Test-Path $LogPath) { Clear-Content $LogPath }
  Log "arg: $Path"

  if (-not (Test-Path $Path)) { Msg "見つかりません:`n$Path" 'Warning'; exit 1 }

  # ★ v2 変更点: フォルダかファイルかを判定
  $isFolder = Test-Path -LiteralPath $Path -PathType Container
  $full = (Resolve-Path $Path).Path

  if ($isFolder) {
    # フォルダの場合
    $app = 'explorer'
    Log "type: folder"
  } else {
    # ファイルの場合（従来通り拡張子チェック）
    $ext  = [IO.Path]::GetExtension($full).ToLower()
    if (-not $AppByExt.ContainsKey($ext)) {
      Msg "この種類のファイルは対象外です（$ext）。`n対応: Excel / Word / PowerPoint / Visio / PDF`nまたはフォルダ" 'Warning'; exit 1
    }
    $app = $AppByExt[$ext]
    Log "type: file ($ext)"
  }

  # パスを \ 区切りに分解し、既知のトップフォルダ名（例: 大真フォルダ）以降を取り出す
  $parts = $full -split '[\\/]'
  $idx = -1
  $topName = $null
  for ($i = 0; $i -lt $parts.Count; $i++) {
    foreach ($t in $KnownTops) {
      if ($parts[$i] -eq $t -or $parts[$i] -like "* - $t") { $idx = $i; $topName = $t; break }
    }
    if ($idx -ge 0) { break }
  }
  if ($idx -lt 0) {
    Msg "OneDrive の共有フォルダ（$($KnownTops -join ' / ')）の中のものだけリンクにできます。`n`n$full" 'Warning'; exit 1
  }
  $rel = @($topName) + $parts[($idx + 1)..($parts.Count - 1)]
  $encoded = ($rel | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'

  # ★ v2 変更点: フォルダは末尾にスラッシュを付けて SharePoint URL のフォルダ表現に
  if ($isFolder) {
    $spUrl = "$WebRoot/$encoded/"
  } else {
    $spUrl = "$WebRoot/$encoded"
  }

  $link = "$OpenPage`?app=$app&u=$spUrl"
  Log "link: $link"

  $name = if ($isFolder) {
    # フォルダ名の末尾に 📁 マークを付けて視認性向上
    "📁 " + [IO.Path]::GetFileName($full.TrimEnd('\','/'))
  } else {
    [IO.Path]::GetFileName($full)
  }

  if ($Format -eq 'url') {
    $out = $link
  } else {
    # Trello の説明・コメントは Markdown 対応: [表示名](URL) で名前付きリンクになる
    $safeName = $name -replace '[\[\]]', ' '
    $out = "[$safeName]($link)"
  }
  Set-Clipboard -Value $out
  Msg "コピーしました。Trello に貼り付けてください。`n`n$out"
  exit 0
}
catch {
  Msg "エラー: $($_.Exception.Message)" 'Error'
  exit 1
}
