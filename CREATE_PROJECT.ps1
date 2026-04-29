# XRPL Meme Bot - Project Creator Script
# Run this in PowerShell to create the entire project

$projectDir = "xrpl-meme-bot"
New-Item -ItemType Directory -Force -Path $projectDir | Out-Null
Set-Location $projectDir

Write-Host "Creating XRPL Meme Bot project..." -ForegroundColor Green

# Create directory structure
New-Item -ItemType Directory -Force -Path "src/xrpl" | Out-Null
New-Item -ItemType Directory -Force -Path "src/scanner" | Out-Null
New-Item -ItemType Directory -Force -Path "src/market" | Out-Null
New-Item -ItemType Directory -Force -Path "src/scoring" | Out-Null
New-Item -ItemType Directory -Force -Path "src/risk" | Out-Null
New-Item -ItemType Directory -Force -Path "src/paper" | Out-Null
New-Item -ItemType Directory -Force -Path "src/telegram" | Out-Null
New-Item -ItemType Directory -Force -Path "src/db" | Out-Null
New-Item -ItemType Directory -Force -Path "src/utils" | Out-Null
New-Item -ItemType Directory -Force -Path "data" | Out-Null
New-Item -ItemType Directory -Force -Path "logs" | Out-Null

Write-Host "Directory structure created." -ForegroundColor Yellow
Write-Host "Next: Copy source files from the bundle." -ForegroundColor Cyan
