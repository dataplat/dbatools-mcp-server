<#
.SYNOPSIS
    Generates generated/dbatools-help.json by extracting help from
    every command in the locally installed dbatools module.

.DESCRIPTION
    Run this script whenever dbatools is installed or updated.
    Output is consumed by the MCP server at startup and cached for the session.

    The script uses a fast path that parses MAML XML help files directly (seconds),
    falling back to Get-Help with parallel processing if MAML files are unavailable.

    Usage: npm run refresh-help
           pwsh -File scripts/refresh-help.ps1

.PARAMETER OutputPath
    Override the output file path (default: <repo-root>/generated/dbatools-help.json)

.PARAMETER MaxCommands
    Limit to N commands for quick development iterations (0 = all commands)

.PARAMETER ThrottleLimit
    Number of parallel workers for the Get-Help fallback path (default 5, range 1-20).
    Only used when MAML XML help files are not available.
#>
[CmdletBinding()]
param(
    [string]$OutputPath = "",
    [int]$MaxCommands = 0,
    [ValidateRange(1, 20)]
    [int]$ThrottleLimit = 5
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
# Risk classification constants
# ---------------------------------------------------------------------------
$ReadonlyVerbs    = @('Get','Test','Find','Measure','Select','Show','Watch','Compare','Search','Resolve')
$DestructiveVerbs = @('Remove','Drop','Delete','Uninstall','Revoke','Disable','Reset')

function Get-RiskLevel([string]$verb) {
    if ($ReadonlyVerbs    -contains $verb) { return 'readonly' }
    if ($DestructiveVerbs -contains $verb) { return 'destructive' }
    return 'change'
}

# ---------------------------------------------------------------------------
# Help extraction — MAML XML fast path or Get-Help fallback
# ---------------------------------------------------------------------------
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$index     = [System.Collections.Specialized.OrderedDictionary]::new()
$failures  = 0

# Check for MAML XML help files (dbatools 2.x ships these)
$helpDir      = Join-Path $module.ModuleBase 'en-us'
$helpXmlFiles = @(Get-ChildItem $helpDir -Filter '*.xml' -ErrorAction SilentlyContinue)

# Try parsing MAML XML first
$helpLookup = @{}
if ($helpXmlFiles.Count -gt 0) {
    Write-Information "Found $($helpXmlFiles.Count) MAML help file(s) — trying fast XML parser..."
    foreach ($helpFile in $helpXmlFiles) {
        try {
            [xml]$xml = Get-Content $helpFile.FullName -Raw
            foreach ($cmdHelp in $xml.helpItems.command) {
                $name = $cmdHelp.details.name.Trim()
                if ($name) { $helpLookup[$name] = $cmdHelp }
            }
        }
        catch {
            Write-Warning "Failed to parse MAML file $($helpFile.Name): $_"
        }
    }
    Write-Information "Parsed $($helpLookup.Count) help entries from MAML XML"
    if ($helpLookup.Count -eq 0) {
        Write-Warning "MAML XML files contained no usable help entries — falling back to parallel Get-Help."
    }
}

if ($helpLookup.Count -gt 0) {
    # ------------------------------------------------------------------
    # FAST PATH: Use parsed MAML data (seconds, not minutes)
    # ------------------------------------------------------------------

    foreach ($cmd in $commands) {
        try {
            $help = $helpLookup[$cmd.Name]

            if ($help) {
                # --- Parameters ---
                $params = @()
                if ($help.parameters -and $help.parameters.parameter) {
                    $params = @(foreach ($p in $help.parameters.parameter) {
                        $desc = if ($p.description -and $p.description.para) {
                            (@($p.description.para) | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.InnerText } } | Where-Object { $_ }) -join ' '
                        } else { '' }

                        $aliasStr = if ($p.aliases) { [string]$p.aliases } else { '' }
                        $aliasArr = if ($aliasStr.Trim() -ne '' -and $aliasStr -ne 'None') {
                            @($aliasStr -split ',\s*' | Where-Object { $_ -ne '' })
                        } else { @() }

                        [ordered]@{
                            name          = [string]$p.name
                            type          = if ($p.type -and $p.type.name) { [string]$p.type.name } else { 'Object' }
                            required      = ($p.required -eq 'true')
                            aliases       = $aliasArr
                            pipelineInput = ($p.pipelineInput -and $p.pipelineInput -ne 'false' -and $p.pipelineInput -ne 'False')
                            description   = $desc.Trim()
                            defaultValue  = if ($p.defaultValue) { [string]$p.defaultValue } else { $null }
                        }
                    })
                }

                # --- Examples ---
                $examples = @()
                if ($help.examples -and $help.examples.example) {
                    $examples = @(foreach ($ex in $help.examples.example) {
                        $remarks = if ($ex.remarks -and $ex.remarks.para) {
                            (@($ex.remarks.para) | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.InnerText } } | Where-Object { $_ }) -join ' '
                        } else { '' }

                        [ordered]@{
                            title   = ([string]($ex.title ?? '')).TrimStart('-').Trim()
                            code    = ([string]($ex.code ?? '')).Trim()
                            remarks = $remarks.Trim()
                        }
                    })
                }

                # --- Related links ---
                $links = @()
                if ($help.relatedLinks -and $help.relatedLinks.navigationLink) {
                    $links = @(
                        $help.relatedLinks.navigationLink |
                        ForEach-Object { if ($_.uri) { $_.uri } elseif ($_.linkText) { $_.linkText } } |
                        Where-Object { $_ -and $_ -ne '' }
                    )
                }

                # --- Synopsis / Description ---
                $synopsis = if ($help.details.description -and $help.details.description.para) {
                    (@($help.details.description.para) | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.InnerText } } | Where-Object { $_ }) -join ' '
                } else { '' }

                $description = if ($help.description -and $help.description.para) {
                    (@($help.description.para) | ForEach-Object { if ($_ -is [string]) { $_ } else { $_.InnerText } } | Where-Object { $_ }) -join ' '
                } else { '' }
            } else {
                # Command exists but has no MAML help entry
                $params      = @()
                $examples    = @()
                $links       = @()
                $synopsis    = ''
                $description = ''
            }

            $index[$cmd.Name] = [ordered]@{
                name         = $cmd.Name
                verb         = $cmd.Verb
                noun         = $cmd.Noun
                synopsis     = $synopsis.Trim()
                description  = $description.Trim()
                parameters   = $params
                examples     = $examples
                relatedLinks = $links
                tags         = @()
                riskLevel    = Get-RiskLevel $cmd.Verb
            }
        }
        catch {
            $failures++
            Write-Warning "Failed to process $($cmd.Name): $_"
        }
    }

    # ------------------------------------------------------------------
    # Fill in commands that had no MAML help entry via Get-Help
    # ------------------------------------------------------------------
    $missingHelp = @($index.Values | Where-Object {
        -not $_.synopsis -and -not $_.description -and $_.parameters.Count -eq 0
    })

    if ($missingHelp.Count -gt 0) {
        Write-Information "Filling $($missingHelp.Count) commands with no MAML entry via Get-Help..."
        foreach ($entry in $missingHelp) {
            try {
                $help = Get-Help $entry.name -Full -ErrorAction SilentlyContinue
                if (-not $help -or $help.Synopsis -like 'Get-Help*') { continue }

                $params = @()
                if ($help.parameters -and $help.parameters.parameter) {
                    $params = @($help.parameters.parameter | ForEach-Object {
                        $p = $_
                        [ordered]@{
                            name         = $p.name
                            type         = if ($p.type) { $p.type.name } else { 'Object' }
                            description  = ($p.description | ForEach-Object { $_.Text }) -join ' '
                            required     = ($p.required -eq 'true')
                            pipelineInput = ($p.pipelineInput -and $p.pipelineInput -ne 'false')
                            defaultValue = if ($p.defaultValue) { $p.defaultValue } else { $null }
                            aliases      = if ($p.aliases -and $p.aliases -ne 'None') {
                                @($p.aliases -split ',\s*')
                            } else { @() }
                        }
                    })
                }

                $examples = @()
                if ($help.examples -and $help.examples.example) {
                    $examples = @($help.examples.example | ForEach-Object {
                        [ordered]@{
                            title   = ($_.title -replace '-+', '').Trim()
                            code    = if ($_.code) { $_.code.Trim() } else { '' }
                            remarks = ($_.remarks | ForEach-Object { $_.Text }) -join ' '
                        }
                    })
                }

                $links = @()
                if ($help.relatedLinks -and $help.relatedLinks.navigationLink) {
                    $links = @(
                        $help.relatedLinks.navigationLink |
                        ForEach-Object { if ($_.uri) { $_.uri } elseif ($_.linkText) { $_.linkText } } |
                        Where-Object { $_ -and $_ -ne '' }
                    )
                }

                $synopsis    = if ($help.Synopsis) { $help.Synopsis.Trim() } else { '' }
                $description = ($help.description | ForEach-Object { $_.Text }) -join ' '

                $index[$entry.name] = [ordered]@{
                    name         = $entry.name
                    verb         = $entry.verb
                    noun         = $entry.noun
                    synopsis     = $synopsis
                    description  = $description.Trim()
                    parameters   = $params
                    examples     = $examples
                    relatedLinks = $links
                    tags         = @()
                    riskLevel    = $entry.riskLevel
                }

                Write-Information "  Filled: $($entry.name)"
            }
            catch {
                $failures++
                Write-Warning "  Failed to fill $($entry.name) via Get-Help: $_"
            }
        }
    }
} else {
    # ------------------------------------------------------------------
    # SLOW PATH: Get-Help with parallel processing (fallback)
    # ------------------------------------------------------------------
    Write-Information "Falling back to Get-Help with parallel processing (slower)..."

    $commandNames  = @($commands.Name)
    if ($commandNames.Count -eq 0) {
        Write-Warning "No commands to index."
    } else {
        $actualWorkers = [Math]::Min($ThrottleLimit, $commandNames.Count)
        $chunkSize     = [Math]::Ceiling($commandNames.Count / $actualWorkers)
        $chunks        = [System.Collections.Generic.List[string[]]]::new()
        for ($i = 0; $i -lt $commandNames.Count; $i += $chunkSize) {
            $end = [Math]::Min($i + $chunkSize - 1, $commandNames.Count - 1)
            $chunks.Add([string[]]$commandNames[$i..$end])
        }

        Write-Information "Processing $total commands in $($chunks.Count) parallel batches (ThrottleLimit=$ThrottleLimit)..."

        $modulePath = $module.Path
        $allResults = $chunks | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {
        $chunkCmds = $_

        Import-Module $using:modulePath -ErrorAction Stop

        $RoVerbs = $using:ReadonlyVerbs
        $DVerbs  = $using:DestructiveVerbs

        $results   = [System.Collections.Generic.List[object]]::new()
        $failCount = 0

        foreach ($cmdName in $chunkCmds) {
            try {
                $cmd  = Get-Command $cmdName -ErrorAction Stop
                $help = Get-Help $cmdName -Full -ErrorAction SilentlyContinue

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

                $links = @()
                if ($help.relatedLinks -and $help.relatedLinks.navigationLink) {
                    $links = @(
                        $help.relatedLinks.navigationLink |
                        ForEach-Object { if ($_.uri) { $_.uri } elseif ($_.linkText) { $_.linkText } } |
                        Where-Object { $_ -and $_ -ne '' }
                    )
                }

                $synopsis = if ($help.Synopsis) { $help.Synopsis.Trim() } else { '' }
                $description = if ($help.description) {
                    ($help.description | ForEach-Object { $_.Text }) -join ' '
                } else { '' }

                $riskLevel = if ($RoVerbs -contains $cmd.Verb) { 'readonly' }
                            elseif ($DVerbs -contains $cmd.Verb) { 'destructive' }
                            else { 'change' }

                $results.Add([ordered]@{
                    name         = $cmd.Name
                    verb         = $cmd.Verb
                    noun         = $cmd.Noun
                    synopsis     = $synopsis
                    description  = $description.Trim()
                    parameters   = $params.ToArray()
                    examples     = $examples.ToArray()
                    relatedLinks = $links
                    tags         = @()
                    riskLevel    = $riskLevel
                })
            }
            catch {
                $failCount++
                Write-Warning "Failed to get help for ${cmdName}: $_"
            }
        }

        [PSCustomObject]@{
            Results  = $results.ToArray()
            Failures = $failCount
        }
    }

        $batchNum = 0
        foreach ($batch in $allResults) {
            $batchNum++

            if ($batch.Results) {
                foreach ($entry in $batch.Results) {
                    $index[$entry.name] = $entry
                }
            }
            $failures += $batch.Failures

            Write-Information "  Batch $batchNum/$($chunks.Count) complete - $($index.Count) commands indexed so far"
        }

    } # end else ($commandNames.Count -gt 0)

    # Sort results by command name (parallel results arrive in batch order)
    $sortedIndex = [System.Collections.Specialized.OrderedDictionary]::new()
    foreach ($key in ($index.Keys | Sort-Object)) {
        $sortedIndex[$key] = $index[$key]
    }
    $index = $sortedIndex
}

$stopwatch.Stop()
Write-Information "Help extraction completed in $([Math]::Round($stopwatch.Elapsed.TotalSeconds, 1))s"

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
