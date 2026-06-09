<#
.SYNOPSIS
  Records ALL 7 TracePilot demo clips in sequence using ffmpeg.
  Usage: .\record-all-clips.ps1

  Clip sequence:
    01 — Failure         (clip-01-failure.mjs)       ~15s
    02 — Project A       (run-repair-memory-demo.mjs) ~60s  (memory demo with --skip-agent)
    03 — Phoenix         (clip-03-phoenix.mjs)        ~40s
    04 — Project B       (run-repair-memory-demo.mjs) ~30s  (abbreviated, B only)
    05 — THE DIFF        (clip-05-diff.mjs)           ~50s  ← THE CENTERPIECE
    06 — Benchmark       (open HTML in browser)       ~30s  (manual browser)
    07 — Results         (clip-07-results.mjs)        ~25s
#>

$ROOT       = Resolve-Path "$PSScriptRoot\..\.."
$CLIPS      = "$ROOT\clips"
$SCRIPT_DIR = "$PSScriptRoot"
$VIDEO_DIR  = "$PSScriptRoot"

if (!(Test-Path $CLIPS)) { New-Item -ItemType Directory $CLIPS | Out-Null }

Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  TracePilot — Hackathon Video Recording Session"        -ForegroundColor White
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""
Write-Host "  BEFORE STARTING:" -ForegroundColor Yellow
Write-Host "  1. Open Windows Terminal (dark theme, full screen)"    -ForegroundColor Gray
Write-Host "  2. Set font size to 16pt (Ctrl+Scroll or Settings)"   -ForegroundColor Gray
Write-Host "  3. Set terminal width: ~120 chars, height: ~40 lines"  -ForegroundColor Gray
Write-Host "  4. Close all other windows (clean desktop)"            -ForegroundColor Gray
Write-Host "  5. This script handles ffmpeg start/stop per clip"     -ForegroundColor Gray
Write-Host ""
Write-Host "  Press ENTER to begin recording..." -ForegroundColor Green
Read-Host | Out-Null

# ── Helper ──────────────────────────────────────────────────────────────────
function Record-Clip {
  param([int]$n, [string]$script, [int]$extraEnd = 3, [int]$leadIn = 2)
  & "$SCRIPT_DIR\record-clip.ps1" -Clip $n -Script $script -ExtraEnd $extraEnd -LeadIn $leadIn
}

# ── Restore Project B to broken state ────────────────────────────────────────
Write-Host "  Restoring Project B to broken state..." -ForegroundColor Gray
$BROKEN = @'
// Project B: Inventory management service
// BUG: Same failure class as Project A — TS2322 strict null check violations

interface Product {
  id: number;
  title?: string;
  price: number;
}

function getProductTitle(product: Product): string | undefined {
  return product.title;
}

function generateInvoice(productId: number): string {
  const product: Product = { id: productId, price: 29.99 };
  // BUG: getProductTitle returns string | undefined but productTitle expects string
  const productTitle: string = getProductTitle(product);
  return `Invoice for product: ${productTitle} (ID: ${productId})`;
}

function calculateDiscount(price: number, percent: number): string {
  // BUG: toFixed returns string but discountedPrice expects number
  const discountedPrice: number = (price * (1 - percent / 100)).toFixed(2);
  return `Discounted price: ${discountedPrice}`;
}

export { generateInvoice, calculateDiscount };
'@
$BROKEN | Set-Content "$ROOT\.ai-logs\tracepilot-independent-eval\repair-memory-demo\project-b\src\inventory.ts" -Encoding UTF8
Write-Host "  ✅ Project B restored" -ForegroundColor Green
Write-Host ""

# ══════════════════════════════════════════════════════════════════════════════
# CLIP 1 — The Failure (15s)
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "━━ CLIP 1/7: TypeScript Failure ━━" -ForegroundColor Cyan
Write-Host "  Shows: real tsc --noEmit failure on Project B"
Write-Host "  Target: 12-18 seconds"
Write-Host ""
Record-Clip -n 1 -script "clip-01-failure.mjs" -extraEnd 3 -leadIn 2

# ══════════════════════════════════════════════════════════════════════════════
# CLIP 2 — Project A repair + repair_report → Phoenix (memory demo)
# ══════════════════════════════════════════════════════════════════════════════
Write-Host "━━ CLIP 2/7: Project A Repair + Phoenix Span ━━" -ForegroundColor Cyan
Write-Host "  Shows: TracePilot repairs Project A, emits repair_report to Phoenix"
Write-Host "  Target: 45-60 seconds"
Write-Host "  Command: node scripts/run-repair-memory-demo.mjs --skip-project-b"
Write-Host ""
Write-Host "  NOTE: --skip-project-b flag runs only the A side of the loop" -ForegroundColor Yellow
Write-Host "  Press ENTER to record this clip..." -ForegroundColor Green
Read-Host | Out-Null

# Record clip 2 manually (it runs the full demo up to B)
$OUT2 = "$CLIPS\clip_02.mp4"
$psi  = New-Object System.Diagnostics.ProcessStartInfo('ffmpeg')
$psi.Arguments = "-y -f gdigrab -framerate 30 -offset_x 0 -offset_y 0 -video_size 1920x1080 -i desktop -c:v libx264 -preset medium -pix_fmt yuv420p -crf 18 `"$OUT2`""
$psi.RedirectStandardInput = $true
$psi.UseShellExecute       = $false
$ffmpeg2 = [System.Diagnostics.Process]::Start($psi)
Start-Sleep 2

Set-Location $ROOT
& node scripts/run-repair-memory-demo.mjs --skip-project-b 2>&1

Start-Sleep 4
$ffmpeg2.StandardInput.Write('q'); $ffmpeg2.StandardInput.Flush()
$null = $ffmpeg2.WaitForExit(8000)
if (Test-Path $OUT2) { Write-Host "  ✅ Clip 2 saved" -ForegroundColor Green }

# ══════════════════════════════════════════════════════════════════════════════
# CLIP 3 — Phoenix evidence via MCP (real span query)
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "━━ CLIP 3/7: Phoenix Span Evidence ━━" -ForegroundColor Cyan
Write-Host "  Shows: MCP query for repair_report, repair_memory_retrieve, repair_plan"
Write-Host "  Target: 35-45 seconds"
Write-Host ""
Record-Clip -n 3 -script "clip-03-phoenix.mjs" -extraEnd 3 -leadIn 2

# ══════════════════════════════════════════════════════════════════════════════
# CLIP 4 — Project B repair (with memory active)
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "━━ CLIP 4/7: Project B Repair (with historical memory) ━━" -ForegroundColor Cyan
Write-Host "  Shows: TracePilot on Project B — retrieves Project A history"
Write-Host "  Target: 30-45 seconds"
Write-Host ""
# Restore B first
$BROKEN | Set-Content "$ROOT\.ai-logs\tracepilot-independent-eval\repair-memory-demo\project-b\src\inventory.ts" -Encoding UTF8
Write-Host "  Project B restored → starting clip 4..." -ForegroundColor Gray

$OUT4 = "$CLIPS\clip_04.mp4"
$psi4 = New-Object System.Diagnostics.ProcessStartInfo('ffmpeg')
$psi4.Arguments = "-y -f gdigrab -framerate 30 -offset_x 0 -offset_y 0 -video_size 1920x1080 -i desktop -c:v libx264 -preset medium -pix_fmt yuv420p -crf 18 `"$OUT4`""
$psi4.RedirectStandardInput = $true
$psi4.UseShellExecute       = $false
$ffmpeg4 = [System.Diagnostics.Process]::Start($psi4)
Start-Sleep 2

# Run only Project B portion (phases 5-7 of the demo)
Set-Location $ROOT
Write-Host ""
& node scripts/run-repair-memory-demo.mjs --skip-project-a 2>&1

Start-Sleep 4
$ffmpeg4.StandardInput.Write('q'); $ffmpeg4.StandardInput.Flush()
$null = $ffmpeg4.WaitForExit(8000)
if (Test-Path $OUT4) { Write-Host "  ✅ Clip 4 saved" -ForegroundColor Green }

# ══════════════════════════════════════════════════════════════════════════════
# CLIP 5 — THE DIFF (THE CENTERPIECE)
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "━━ CLIP 5/7: THE DIFF — Centerpiece ━━" -ForegroundColor Cyan
Write-Host "  WITHOUT MEMORY → string type (relaxes contract)"
Write-Host "  WITH MEMORY    → parseFloat (preserves contract)"
Write-Host "  Target: 45-55 seconds. STAY HERE LONGEST."
Write-Host ""
Record-Clip -n 5 -script "clip-05-diff.mjs" -extraEnd 5 -leadIn 2

# ══════════════════════════════════════════════════════════════════════════════
# CLIP 6 — Next.js Benchmark (open HTML dashboard)
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "━━ CLIP 6/7: Next.js Benchmark Dashboard ━━" -ForegroundColor Cyan
Write-Host "  Opens the HTML benchmark report in browser"
Write-Host "  Record manually: show the dashboard for 30-40s"
Write-Host ""
$HTML_REPORT = "$ROOT\.ai-logs\tracepilot-independent-eval\repair-memory-demo\evidence\causal-differential-report.html"
$HTML_MEM    = "$ROOT\.ai-logs\tracepilot-independent-eval\repair-memory-demo\evidence\repair-memory-demo-report.html"

Write-Host "  Press ENTER to open dashboard in browser and start recording..." -ForegroundColor Green
Read-Host | Out-Null

$OUT6 = "$CLIPS\clip_06.mp4"
$psi6 = New-Object System.Diagnostics.ProcessStartInfo('ffmpeg')
$psi6.Arguments = "-y -f gdigrab -framerate 30 -offset_x 0 -offset_y 0 -video_size 1920x1080 -i desktop -c:v libx264 -preset medium -pix_fmt yuv420p -crf 18 `"$OUT6`""
$psi6.RedirectStandardInput = $true
$psi6.UseShellExecute       = $false
$ffmpeg6 = [System.Diagnostics.Process]::Start($psi6)
Start-Sleep 2

Start-Process $HTML_REPORT
Start-Sleep 3
Start-Process $HTML_MEM
Write-Host "  Both dashboards opened. Browse them for 30-40s then press ENTER..." -ForegroundColor Yellow
Read-Host | Out-Null

Start-Sleep 3
$ffmpeg6.StandardInput.Write('q'); $ffmpeg6.StandardInput.Flush()
$null = $ffmpeg6.WaitForExit(8000)
if (Test-Path $OUT6) { Write-Host "  ✅ Clip 6 saved" -ForegroundColor Green }

# ══════════════════════════════════════════════════════════════════════════════
# CLIP 7 — Final results scorecard
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "━━ CLIP 7/7: Final Results ━━" -ForegroundColor Cyan
Write-Host "  Target: 20-25 seconds"
Write-Host ""
Record-Clip -n 7 -script "clip-07-results.mjs" -extraEnd 4 -leadIn 2

# ══════════════════════════════════════════════════════════════════════════════
# DONE — check all clips
# ══════════════════════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Recording complete. Clip inventory:"                   -ForegroundColor White
Write-Host "════════════════════════════════════════════════════════" -ForegroundColor Cyan
$clips = @(1,2,3,4,5,6,7)
$allOk = $true
foreach ($n in $clips) {
  $f = "$CLIPS\clip_{0:D2}.mp4" -f $n
  if (Test-Path $f) {
    $sz = [math]::Round((Get-Item $f).Length / 1MB, 1)
    Write-Host ("  ✅ clip_{0:D2}.mp4  ({1} MB)" -f $n, $sz) -ForegroundColor Green
  } else {
    Write-Host ("  ❌ clip_{0:D2}.mp4  MISSING" -f $n) -ForegroundColor Red
    $allOk = $false
  }
}
Write-Host ""
if ($allOk) {
  Write-Host "  All clips present. Run .\combine-all.ps1 to produce final-demo.mp4" -ForegroundColor Green
} else {
  Write-Host "  Re-record missing clips individually using record-clip.ps1" -ForegroundColor Yellow
}
