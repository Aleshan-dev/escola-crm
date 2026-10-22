# Backup da pasta-fonte do CRM Escola (v2.0)
# Fluxo do projeto: pasta local -> Vercel (sem Git). A pasta e a unica fonte de
# verdade; este script tira uma copia versionada dela para eliminar o ponto unico
# de falha. Rode quando quiser: powershell -ExecutionPolicy Bypass -File backup.ps1
#
# Ajuste aqui se quiser outro destino / versao:
$Projeto   = 'D:\Claude\Projects\CRM Escola'
$DestinoRaiz = 'D:\Backups\CRM Escola'
$Versao    = '2.0'

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmm'
$nome  = "CRM-Escola-v${Versao}_${stamp}"
$staging = Join-Path $env:TEMP $nome
$zip     = Join-Path $DestinoRaiz "$nome.zip"

Write-Host "Backup do CRM Escola  (versao $Versao)" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $DestinoRaiz | Out-Null

# Copia tudo, exceto o que e reconstruivel (node_modules, build, cache Vercel, .git).
robocopy $Projeto $staging /E `
  /XD node_modules .next .vercel .git `
  /XF *.log `
  /NFL /NDL /NJH /NJS /NP | Out-Null

# robocopy usa exit codes 0-7 para sucesso; >=8 e erro real.
if ($LASTEXITCODE -ge 8) { throw "robocopy falhou (exit $LASTEXITCODE)" }
$global:LASTEXITCODE = 0

Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
Remove-Item $staging -Recurse -Force

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "OK -> $zip  ($mb MB)" -ForegroundColor Green

# Mantem apenas os 10 backups mais recentes (evita encher o disco).
Get-ChildItem $DestinoRaiz -Filter 'CRM-Escola-v*.zip' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 10 |
  ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "removido antigo: $($_.Name)" -ForegroundColor DarkGray }
