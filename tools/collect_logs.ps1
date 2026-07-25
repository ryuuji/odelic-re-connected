<#
.SYNOPSIS
    HCI スヌープログと logcat をまとめて回収する（フェーズ 3 用）。

.DESCRIPTION
    照明のそばで操作した後、開発機に戻ってから実行する。
    HCI スヌープログは端末内に溜まるので、PC を持ち歩く必要はない。

    prepare : 採取前の準備（logcat バッファ拡大・状態確認・logcat クリア）
    collect : 採取後の回収（bugreport から btsnoop 抽出 + logcat ダンプ）

.EXAMPLE
    # 照明のそばへ行く前に
    pwsh tools/collect_logs.ps1 prepare

    # 操作を終えて戻ってきたら
    pwsh tools/collect_logs.ps1 collect

.NOTES
    HCI スヌープログの有効化（開発者オプション）は adb からできないため、
    端末の画面で手動操作すること。詳細は docs/04-analysis-procedure.md の 3-1。
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('prepare', 'collect')]
    [string]$Mode = 'collect',

    [string]$OutDir = "$PSScriptRoot\..\artifacts"
)

$ErrorActionPreference = 'Stop'
$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'

# --- adb の場所を解決 -------------------------------------------------------
function Resolve-Adb {
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $winget = Join-Path $env:LOCALAPPDATA `
        'Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe'
    if (Test-Path $winget) { return $winget }
    throw "adb が見つかりません。docs/04-analysis-procedure.md の 0-1 を参照してください。"
}

$adb = Resolve-Adb
$pkg = 'jp.co.odelic.smt.remote10'

# --- 端末の接続確認 ---------------------------------------------------------
$devices = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match '\S' }
if (-not $devices) {
    throw "端末が接続されていません。USB を接続してください。"
}
if ($devices -match 'unauthorized') {
    throw "端末が unauthorized です。画面の「USB デバッグを許可」をタップしてください。"
}
Write-Host "端末: $($devices -join ', ')" -ForegroundColor Cyan

New-Item -ItemType Directory -Force $OutDir | Out-Null
$stamp = & $adb shell "date +%Y%m%d-%H%M%S"
$stamp = $stamp.Trim()

# ---------------------------------------------------------------- prepare
if ($Mode -eq 'prepare') {
    Write-Host "`n=== 採取前の準備 ===" -ForegroundColor Green

    Write-Host "`n[1] logcat バッファを 16 MiB に拡大"
    & $adb shell "logcat -G 16M" | Out-Null
    & $adb shell "logcat -g" | Select-Object -First 2 | ForEach-Object { "    $_" }

    Write-Host "`n[2] HCI スヌープログの状態"
    $snoop = (& $adb shell "getprop persist.bluetooth.btsnooplogmode").Trim()
    if ($snoop) {
        Write-Host "    persist.bluetooth.btsnooplogmode = $snoop" -ForegroundColor Green
    } else {
        Write-Host "    未設定（無効）" -ForegroundColor Yellow
        Write-Host "    → 端末の開発者オプションで" -ForegroundColor Yellow
        Write-Host "      「Bluetooth HCI スヌープログを有効にする」を ON にし、" -ForegroundColor Yellow
        Write-Host "      Bluetooth を OFF → ON してから再実行してください。" -ForegroundColor Yellow
    }

    Write-Host "`n[3] アプリのバージョン"
    & $adb shell "dumpsys package $pkg" |
        Select-String -Pattern 'versionName|versionCode' |
        Select-Object -First 2 | ForEach-Object { "    $($_.ToString().Trim())" }

    Write-Host "`n[4] logcat をクリア"
    & $adb logcat -c 2>&1 | Out-Null
    Write-Host "    完了"

    Write-Host @"

=== 次にやること ===
  1. 端末を照明のそばへ持っていく（PC は不要）
  2. アプリを起動し、docs/04-analysis-procedure.md の 3-2 のシナリオを
     1 操作ずつ、間に数秒空けて実施する
     ⚠️ グループ設定の変更・器具登録の初期化はやらない
  3. 開発機に戻って USB を接続し、次を実行

       pwsh tools/collect_logs.ps1 collect
"@ -ForegroundColor Cyan
    exit 0
}

# ---------------------------------------------------------------- collect
Write-Host "`n=== ログの回収 ===" -ForegroundColor Green

# [1] logcat（バッファが生きているうちに先に取る）
$logcatPath = Join-Path $OutDir "logcat-$stamp.txt"
Write-Host "`n[1] logcat をダンプ"
& $adb logcat -d | Out-File -FilePath $logcatPath
$lines = (Get-Content $logcatPath | Measure-Object -Line).Lines
Write-Host "    $logcatPath  ($lines 行)"
if ($lines -lt 100) {
    Write-Host "    [注意] 行数が少なすぎます。バッファがクリアされた可能性があります。" -ForegroundColor Yellow
}

# [2] Bluetooth スタックの状態
$dumpPath = Join-Path $OutDir "bluetooth_manager-$stamp.txt"
Write-Host "`n[2] dumpsys bluetooth_manager"
& $adb shell "dumpsys bluetooth_manager" | Out-File -FilePath $dumpPath
Write-Host "    $dumpPath"

# [3] bugreport から btsnoop を抽出
$bugreportPath = Join-Path $OutDir "bugreport-$stamp.zip"
Write-Host "`n[3] bugreport を取得（数分かかります）"
& $adb bugreport $bugreportPath
if (-not (Test-Path $bugreportPath)) {
    throw "bugreport の取得に失敗しました。"
}
Write-Host "    $bugreportPath  ($([math]::Round((Get-Item $bugreportPath).Length / 1MB, 1)) MB)"

Write-Host "`n[4] btsnoop を抽出"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($bugreportPath)
try {
    $entries = $zip.Entries | Where-Object { $_.Name -match 'btsnoo[pz].*\.log$' }
    if (-not $entries) {
        Write-Host "    [警告] btsnoop が見つかりません。" -ForegroundColor Yellow
        Write-Host "    HCI スヌープログが有効になっていなかった可能性があります。" -ForegroundColor Yellow
        Write-Host "    ZIP 内の候補:" -ForegroundColor Yellow
        $zip.Entries | Where-Object { $_.FullName -match 'bluetooth' } |
            Select-Object -First 10 | ForEach-Object { "      $($_.FullName)" }
    }
    foreach ($e in $entries) {
        $dest = Join-Path $OutDir "$($e.Name -replace '\.log$', '')-$stamp.log"
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
        $kb = [math]::Round((Get-Item $dest).Length / 1KB, 1)
        Write-Host "    $dest  ($kb KB)" -ForegroundColor Green
        Write-Host "`n=== 解析 ===" -ForegroundColor Green
        Write-Host "  python tools/btsnoop.py summary  `"$dest`""
        Write-Host "  python tools/btsnoop.py timeline `"$dest`""
        Write-Host "  python tools/btsnoop.py recv     `"$dest`" --mfg-only"
    }
} finally {
    $zip.Dispose()
}
