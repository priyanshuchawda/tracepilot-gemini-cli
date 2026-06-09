<#
.SYNOPSIS
  Combines all clips into final-demo.mp4 using ffmpeg concat.
  Usage: .\combine-all.ps1
  Output: final-demo.mp4 in project root.
#>
param(
  [string]$Output = "final-demo.mp4",
  [switch]$AddTimestamps   # optionally burns scene timestamps
)

$ROOT  = Resolve-Path "$PSScriptRoot\..\.."
$CLIPS = "$ROOT\clips"
$LIST  = "$CLIPS\filelist.txt"
$OUT   = "$ROOT\$Output"

Write-Host ""
Write-Host "TracePilot — Combining Clips" -ForegroundColor Cyan
Write-Host ""

# Build filelist
$order = @(1, 2, 3, 4, 5, 6, 7)
$lines = @()
$missing = @()

foreach ($n in $order) {
  $f = "$CLIPS\clip_{0:D2}.mp4" -f $n
  if (Test-Path $f) {
    $lines += "file '$f'"
    $sz = [math]::Round((Get-Item $f).Length / 1MB, 1)
    Write-Host ("  ✅ clip_{0:D2}.mp4  ({1} MB)" -f $n, $sz) -ForegroundColor Green
  } else {
    Write-Host ("  ❌ clip_{0:D2}.mp4  MISSING — skipping" -f $n) -ForegroundColor Red
    $missing += $n
  }
}

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "  WARNING: $($missing.Count) clip(s) missing. Output may be incomplete." -ForegroundColor Yellow
}

$lines | Set-Content $LIST -Encoding UTF8
Write-Host ""
Write-Host "  Running ffmpeg concat..." -ForegroundColor Gray

# Concatenate without re-encoding (fast, lossless join if all clips match codec)
& ffmpeg -y -f concat -safe 0 -i $LIST -c copy $OUT

if (Test-Path $OUT) {
  $sz  = [math]::Round((Get-Item $OUT).Length / 1MB, 1)
  $dur = & ffprobe -v quiet -show_entries format=duration -of csv=p=0 $OUT 2>&1
  $min = [math]::Floor([double]$dur / 60)
  $sec = [math]::Round([double]$dur % 60)
  Write-Host ""
  Write-Host "  ✅ final-demo.mp4 → $OUT" -ForegroundColor Green
  Write-Host "  Size: $sz MB  Duration: ${min}m ${sec}s" -ForegroundColor Green
} else {
  Write-Host "  ❌ Combine failed. Check ffmpeg output above." -ForegroundColor Red
}

Write-Host ""
Write-Host "Editing tips (optional post-processing):" -ForegroundColor Cyan
Write-Host "  Trim silence from start of clip 1:"
Write-Host "    ffmpeg -i clips\clip_01.mp4 -ss 0.5 -c copy clips\clip_01_trim.mp4"
Write-Host ""
Write-Host "  Speed up a clip 1.5x (cut waiting periods):"
Write-Host "    ffmpeg -i clips\clip_02.mp4 -vf setpts=0.67*PTS clips\clip_02_fast.mp4"
Write-Host ""
Write-Host "  Add simple text overlay to clip 5 (the diff):"
Write-Host "    ffmpeg -i clips\clip_05.mp4 -vf `"drawtext=text='WITH MEMORY':x=10:y=10:fontsize=32:fontcolor=white`" clips\clip_05_labeled.mp4"
