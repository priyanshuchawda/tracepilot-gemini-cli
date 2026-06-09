#!/usr/bin/env pwsh
# open-demo.ps1 — TracePilot demo launcher
# 1. Starts the live dashboard server (http://localhost:3456)
# 2. Opens it in the browser
# 3. Prints the scorecard from the latest comparison-report.json

$ROOT = $PSScriptRoot
$PHASE_DIR = Join-Path $ROOT ".ai-logs\tracepilot-independent-eval\phase2-nextjs"
$POINTER   = Join-Path $PHASE_DIR "latest-agent-comparison.txt"

Write-Host ""
Write-Host "  TracePilot Hackathon Demo" -ForegroundColor Cyan
Write-Host "  ══════════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host ""

# ── Print scorecard from latest report ────────────────────────────────────
function Show-Scorecard {
    $reportPath = $null
    if (Test-Path $POINTER) {
        $reportPath = (Get-Content $POINTER -Raw).Trim()
    }
    if (-not $reportPath -or -not (Test-Path $reportPath)) {
        # Scan agent-runs for latest
        $runsDir = Join-Path $PHASE_DIR "agent-runs"
        if (Test-Path $runsDir) {
            $latest = Get-ChildItem $runsDir -Directory | Sort-Object Name -Descending | Select-Object -First 1
            if ($latest) {
                $candidate = Join-Path $latest.FullName "comparison-report.json"
                if (Test-Path $candidate) { $reportPath = $candidate }
            }
        }
    }

    if (-not $reportPath -or -not (Test-Path $reportPath)) {
        Write-Host "  No benchmark results yet." -ForegroundColor Yellow
        Write-Host "  Run the benchmark first:" -ForegroundColor Yellow
        Write-Host "  node .ai-logs\tracepilot-independent-eval\phase2-nextjs\run-agent-comparison.mjs" -ForegroundColor Cyan
        Write-Host ""
        return
    }

    $report = Get-Content $reportPath -Raw | ConvertFrom-Json
    $results = $report.results

    Write-Host "  BENCHMARK RESULTS (from $([System.IO.Path]::GetFileName($reportPath)))" -ForegroundColor Green
    Write-Host "  Generated: $($report.generatedAt)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host ("  {0,-16} {1,-26} {2}" -f "Issue", "Blind CLI", "TracePilot") -ForegroundColor White
    Write-Host "  ─────────────────────────────────────────────────────────────" -ForegroundColor DarkGray

    $ids = $results | Select-Object -ExpandProperty benchmarkId -Unique
    foreach ($id in $ids) {
        $blind = $results | Where-Object { $_.benchmarkId -eq $id -and $_.arm -eq "blind" } | Select-Object -First 1
        $tp    = $results | Where-Object { $_.benchmarkId -eq $id -and $_.arm -eq "tracepilot" } | Select-Object -First 1

        $bIcon = if ($blind -and $blind.fixed) { "✅" } elseif ($blind) { "❌" } else { "⏳" }
        $tIcon = if ($tp -and $tp.fixed) { "✅" } elseif ($tp) { "❌" } else { "⏳" }

        $bTime = if ($blind -and $blind.metrics.repairTimeMs) { "$([math]::Round($blind.metrics.repairTimeMs/1000))s" } else { "—" }
        $tTime = if ($tp -and $tp.metrics.repairTimeMs) { "$([math]::Round($tp.metrics.repairTimeMs/1000))s" } else { "—" }

        $timeout_b = if ($blind -and $blind.agent.timedOut) { " [timeout]" } else { "" }
        $timeout_t = if ($tp -and $tp.agent.timedOut) { " [timeout]" } else { "" }

        Write-Host ("  {0,-16} {1} ({2}{3,-12}) {4} ({5}{6})" -f $id, $bIcon, $bTime, $timeout_b, $tIcon, $tTime, $timeout_t)
    }

    Write-Host ""
    $blindTotal = ($results | Where-Object { $_.arm -eq "blind" -and $_.fixed }).Count
    $tpTotal    = ($results | Where-Object { $_.arm -eq "tracepilot" -and $_.fixed }).Count
    $total      = $ids.Count
    Write-Host ("  SCORE:   Blind CLI {0}/{1}    TracePilot {2}/{1}" -f $blindTotal, $total, $tpTotal) -ForegroundColor White
    Write-Host ""
}

Show-Scorecard

# ── Start live dashboard server ────────────────────────────────────────────
$serverRunning = $false
try {
    $existing = netstat -ano 2>$null | Select-String ":3456 "
    if ($existing) { $serverRunning = $true }
} catch {}

if ($serverRunning) {
    Write-Host "  Dashboard server already running at http://localhost:3456" -ForegroundColor Green
    Start-Process "http://localhost:3456"
} else {
    Write-Host "  Starting dashboard server..." -ForegroundColor DarkGray
    $serverScript = Join-Path $ROOT "serve-dashboard.js"
    Start-Process -FilePath "node" -ArgumentList "`"$serverScript`"" -WorkingDirectory $ROOT -WindowStyle Normal
    Start-Sleep 2
    Write-Host "  Dashboard live at http://localhost:3456" -ForegroundColor Green
    Write-Host "  (auto-refreshes every 5 seconds — no reload needed)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  ══════════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host "  NEXT: Start screen recording, then run:" -ForegroundColor Yellow
Write-Host "  node .ai-logs\tracepilot-independent-eval\phase2-nextjs\run-agent-comparison.mjs" -ForegroundColor Cyan
Write-Host "  Watch the dashboard update live as results come in." -ForegroundColor Yellow
Write-Host ""
