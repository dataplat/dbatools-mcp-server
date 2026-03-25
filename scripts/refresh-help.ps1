<#
.SYNOPSIS
    Generates generated/dbatools-help.json by extracting comment-based help from
    every command in the locally installed dbatools module.

.DESCRIPTION
    Run this script whenever dbatools is installed or updated.
    Output is consumed by the MCP server at startup and cached for the session.

    Usage: npm run refresh-help
           pwsh -File scripts/refresh-help.ps1

.PARAMETER OutputPath
    Override the output file path (default: <repo-root>/generated/dbatools-help.json)

.PARAMETER MaxCommands
    Limit to N commands for quick development iterations (0 = all commands)
#>
[CmdletBinding()]
param(
    [string]$OutputPath = "",
    [int]$MaxCommands = 0
)

$ErrorActionPreference = 'Stop'
$InformationPreference = 'Continue'

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
$ScriptDir   = Split-Path -Parent $PSCommandPath
$RepoRoot    = Split-Path -Parent $ScriptDir
$OutputDir   = Join-Path $RepoRoot 'generated'
$DefaultOut  = Join-Path $OutputDir 'dbatools-help.json'

if ($OutputPath -eq "") { $OutputPath = $DefaultOut }

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
    Write-Information "Created directory: $OutputDir"
}

# ---------------------------------------------------------------------------
# Verify dbatools
# ---------------------------------------------------------------------------
$module = Get-Module -ListAvailable -Name dbatools |
          Sort-Object Version -Descending |
          Select-Object -First 1

if (-not $module) {
    Write-Error "dbatools is not installed.`nRun: Install-Module dbatools -Scope CurrentUser"
    exit 1
}

Write-Information "Found dbatools $($module.Version) at $($module.ModuleBase)"
Write-Information "Importing module..."
Import-Module dbatools -ErrorAction Stop

# ---------------------------------------------------------------------------
# Enumerate commands
# ---------------------------------------------------------------------------
$commands = Get-Command -Module dbatools | Sort-Object Name

if ($MaxCommands -gt 0) {
    $commands = $commands | Select-Object -First $MaxCommands
    Write-Warning "MaxCommands=$MaxCommands — indexing a subset only."
}

$total = $commands.Count
Write-Information "Indexing $total commands..."

# ---------------------------------------------------------------------------
# Risk classification helpers
# ---------------------------------------------------------------------------
$ReadonlyVerbs    = @('Get','Test','Find','Measure','Select','Show','Watch','Compare','Search','Resolve')
$DestructiveVerbs = @('Remove','Drop','Delete','Uninstall','Revoke','Disable','Reset')

function Get-RiskLevel([string]$verb) {
    if ($ReadonlyVerbs    -contains $verb) { return 'readonly' }
    if ($DestructiveVerbs -contains $verb) { return 'destructive' }
    return 'change'
}

# ---------------------------------------------------------------------------
# Help extraction loop
# ---------------------------------------------------------------------------
$index     = [System.Collections.Specialized.OrderedDictionary]::new()
$failures  = 0
$counter   = 0

foreach ($cmd in $commands) {
    $counter++
    if ($counter % 100 -eq 0) {
        Write-Information "  $counter / $total  ($([Math]::Round($counter/$total*100))%)"
    }

    try {
        $help = Get-Help $cmd.Name -Full -ErrorAction SilentlyContinue

        # --- Parameters ---------------------------------------------------
        $params = [System.Collections.Generic.List[hashtable]]::new()
        if ($help.parameters -and $help.parameters.parameter) {
            foreach ($p in $help.parameters.parameter) {
                $desc = if ($p.description) {
                    ($p.description | ForEach-Object { $_.Text }) -join ' '
                } else { '' }

                $aliasArr = if ($p.aliases -and $p.aliases -ne 'None') {
                    @($p.aliases -split ',\s*' | Where-Object { $_ -ne '' })
                } else { @() }

                $params.Add([ordered]@{
                    name          = [string]$p.name
                    type          = if ($p.type -and $p.type.name) { [string]$p.type.name } else { 'Object' }
                    required      = ($p.required -eq 'true')
                    aliases       = $aliasArr
                    pipelineInput = ($p.pipelineInput -and $p.pipelineInput -ne 'false')
                    description   = $desc.Trim()
                    defaultValue  = if ($p.defaultValue) { [string]$p.defaultValue } else { $null }
                })
            }
        }

        # --- Examples -----------------------------------------------------
        $examples = [System.Collections.Generic.List[hashtable]]::new()
        if ($help.examples -and $help.examples.example) {
            foreach ($ex in $help.examples.example) {
                $remarks = if ($ex.remarks) {
                    ($ex.remarks | ForEach-Object { $_.Text }) -join ' '
                } else { '' }

                $examples.Add([ordered]@{
                    title   = ([string]($ex.title ?? '')).TrimStart('-').Trim()
                    code    = ([string]($ex.code ?? '')).Trim()
                    remarks = $remarks.Trim()
                })
            }
        }

        # --- Related links ------------------------------------------------
        $links = @()
        if ($help.relatedLinks -and $help.relatedLinks.navigationLink) {
            $links = @(
                $help.relatedLinks.navigationLink |
                ForEach-Object { if ($_.uri) { $_.uri } elseif ($_.linkText) { $_.linkText } } |
                Where-Object { $_ -and $_ -ne '' }
            )
        }

        # --- Synopsis / Description ---------------------------------------
        $synopsis = if ($help.Synopsis) { $help.Synopsis.Trim() } else { '' }

        $description = if ($help.description) {
            ($help.description | ForEach-Object { $_.Text }) -join ' '
        } else { '' }

        $index[$cmd.Name] = [ordered]@{
            name         = $cmd.Name
            verb         = $cmd.Verb
            noun         = $cmd.Noun
            synopsis     = $synopsis
            description  = $description.Trim()
            parameters   = $params.ToArray()
            examples     = $examples.ToArray()
            relatedLinks = $links
            tags         = @()
            riskLevel    = Get-RiskLevel $cmd.Verb
        }
    }
    catch {
        $failures++
        Write-Warning "[$counter/$total] Failed to get help for $($cmd.Name): $_"
    }
}

# ---------------------------------------------------------------------------
# Write manifest
# ---------------------------------------------------------------------------
$manifest = [ordered]@{
    generatedAt      = (Get-Date -Format 'o')
    dbatoolsVersion  = $module.Version.ToString()
    commandCount     = $index.Count
    commands         = $index
}

$manifest | ConvertTo-Json -Depth 12 | Set-Content -Path $OutputPath -Encoding UTF8

Write-Information ""
Write-Information "Done! Indexed $($index.Count) commands -> $OutputPath"
if ($failures -gt 0) {
    Write-Warning "$failures command(s) failed to index (see warnings above)."
}
