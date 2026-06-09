<#
.SYNOPSIS
  Records one demo clip using ffmpeg gdigrab.
  Usage: .\record-clip.ps1 -Clip 1 -Script "clip-01-failure.mjs" -Duration 18

.NOTES
  Starts ffmpeg before running the script.
  Sends 'q' via stdin to ffmpeg after script completes for clean shutdown.
  Output goes to clips\clip_01.mp4 etc.
#>
param(
  [Parameter(Mandatory)][int]    $Clip,
  [Parameter(Mandatory)][string] $Script,
  [int]    $ExtraEnd   = 3,     # extra seconds to record after script finishes
  [int]    $LeadIn     = 2,     # seconds to record before script starts
  [string] $Resolution = '1920x1080',
  [int]    $Framerate  = 30,
  [string] $Preset     = 'medium'
)

$ROOT   = Resolve-Path "$PSScriptRoot\..\.."
$CLIPS  = "$ROOT\clips"
$OUT    = "$CLIPS\clip_{0:D2}.mp4" -f $Clip
$SCRIPT = "$PSScriptRoot\$Script"

if (!(Test-Path $CLIPS)) { New-Item -ItemType Directory -Path $CLIPS | Out-Null }

Write-Host ""
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host "  Recording Clip $Clip → $OUT"                         -ForegroundColor White
Write-Host "  Script: $Script"                                      -ForegroundColor Gray
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
Write-Host ""
Write-Host "  → Maximize the demo terminal window NOW" -ForegroundColor Yellow
Write-Host "  → Set font size to 16pt"                 -ForegroundColor Yellow
Write-Host "  → Press ENTER when ready..."             -ForegroundColor Green
Read-Host | Out-Null

# ── Start ffmpeg recording ────────────────────────────────────────────────────
$w, $h = $Resolution -split 'x'
$ffmpegArgs = @(
  '-y',
  '-f', 'gdigrab',
  '-framerate', "$Framerate",
  '-offset_x', '0', '-offset_y', '0',
  '-video_size', $Resolution,
  '-i', 'desktop',
  '-c:v', 'libx264',
  '-preset', $Preset,
  '-pix_fmt', 'yuv420p',
  '-crf', '18',
  $OUT
)

Write-Host "  Starting ffmpeg..." -ForegroundColor Gray

$psi = New-Object System.Diagnostics.ProcessStartInfo('ffmpeg')
$psi.Arguments = $ffmpegArgs -join ' '
$psi.RedirectStandardInput  = $true
$psi.RedirectStandardOutput = $false
$psi.RedirectStandardError  = $false
$psi.UseShellExecute        = $false
$psi.CreateNoWindow         = $false

$ffmpeg = [System.Diagnostics.Process]::Start($psi)
Start-Sleep $LeadIn   # brief lead-in before script starts

# ── Run the demo script ───────────────────────────────────────────────────────
Write-Host "  ▶ Running: node $Script" -ForegroundColor Green
Set-Location $ROOT
& node $SCRIPT
$nodeExit = $LASTEXITCODE

# ── Pad end, then stop ffmpeg ─────────────────────────────────────────────────
Write-Host "  Script finished (exit $nodeExit). Waiting ${ExtraEnd}s pad..." -ForegroundColor Gray
Start-Sleep $ExtraEnd

Write-Host "  Stopping ffmpeg..." -ForegroundColor Gray
try {
  $ffmpeg.StandardInput.Write('q')
  $ffmpeg.StandardInput.Flush()
  $null = $ffmpeg.WaitForExit(8000)
} catch {
  # If stdin close fails, force kill (may produce slightly truncated file)
  $ffmpeg.Kill()
  $ffmpeg.WaitForExit(3000)
}

if (Test-Path $OUT) {
  $sz = [math]::Round((Get-Item $OUT).Length / 1MB, 1)
  Write-Host "  ✅ Clip $Clip saved: $OUT ($sz MB)" -ForegroundColor Green
} else {
  Write-Host "  ❌ Output file not found: $OUT" -ForegroundColor Red
}
Write-Host ""
