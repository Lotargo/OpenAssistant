param(
    [Parameter(Mandatory = $true)][string]$SourceResources,
    [string]$AssetDir = (Join-Path $env:LOCALAPPDATA 'OpenAssistant\models\vosk-speakers'),
    [string]$SpeakerArchive
)
# Explicit, one-time setup; no models are downloaded or discovered at application startup.
$ErrorActionPreference = 'Stop'
$expectedHash = 'A74D8F51144484813E16AF689BB0F916B7A111E2347F467C4933C1166097B5A7'
$speakerUrl = 'https://alphacephei.com/vosk/models/vosk-model-spk-0.4.zip'
$source = (Resolve-Path -LiteralPath $SourceResources).ProviderPath
$destination = [IO.Path]::GetFullPath($AssetDir)
$dlls = @('libvosk.dll', 'libgcc_s_seh-1.dll', 'libstdc++-6.dll', 'libwinpthread-1.dll')
$notices = @('Local-ASR-NOTICE.txt', 'Voice-Input-LICENSE.txt')
$acousticName = 'vosk-model-small-ru-0.22'
$acoustic = Join-Path $source ('models\' + $acousticName)
foreach ($name in ($dlls + $notices)) {
    if (!(Test-Path -LiteralPath (Join-Path $source $name) -PathType Leaf)) {
        throw "Required source asset is missing: $name"
    }
}
if (!(Test-Path -LiteralPath (Join-Path $acoustic 'am\final.mdl') -PathType Leaf)) {
    throw 'The trusted acoustic model is missing.'
}
if (Test-Path -LiteralPath $destination) {
    if (Test-Path -LiteralPath (Join-Path $destination 'model-provenance.json') -PathType Leaf) {
        $manifest = Get-Content -LiteralPath (Join-Path $destination 'model-provenance.json') -Raw | ConvertFrom-Json
        if ($manifest.speaker_archive_sha256 -ne $expectedHash -or !$manifest.files.Count) {
            throw 'Existing model manifest is not the reviewed version; inspect it before replacing.'
        }
        foreach ($file in $manifest.files) {
            $path = [IO.Path]::GetFullPath((Join-Path $destination $file.path))
            if (!$path.StartsWith(($destination.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
                throw 'Existing manifest contains a path outside the model directory.'
            }
            if (!(Test-Path -LiteralPath $path -PathType Leaf) -or
                (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $file.sha256) {
                throw "Existing asset is missing or modified; inspect it before replacing: $path"
            }
        }
        Write-Output "Verified existing model directory: $destination"
        exit 0
    }
    throw "Destination already exists without a setup manifest; inspect it before replacing: $destination"
}
$parent = Split-Path -Parent $destination
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$stage = Join-Path $parent ('.vosk-speakers-setup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    foreach ($name in ($dlls + $notices)) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $stage $name)
    }
    Copy-Item -LiteralPath $acoustic -Destination (Join-Path $stage $acousticName) -Recurse
    $archive = $SpeakerArchive
    if (!$archive) {
        $archive = Join-Path $stage 'vosk-model-spk-0.4.zip'
        Invoke-WebRequest -Uri $speakerUrl -OutFile $archive -UseBasicParsing
    } else {
        $archive = (Resolve-Path -LiteralPath $archive).ProviderPath
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedHash) {
        throw 'Speaker model archive hash differs from the reviewed official model.'
    }
    $unpack = Join-Path $stage 'unpack'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpack
    $speaker = Join-Path $unpack 'vosk-model-spk-0.4'
    foreach ($name in @('final.ext.raw', 'mean.vec', 'transform.mat', 'mfcc.conf', 'README.txt')) {
        if (!(Test-Path -LiteralPath (Join-Path $speaker $name) -PathType Leaf)) {
            throw "Speaker model archive is incomplete: $name"
        }
    }
    Move-Item -LiteralPath $speaker -Destination (Join-Path $stage 'vosk-model-spk-0.4')
    Remove-Item -LiteralPath $unpack -Recurse -Force
    if (!$SpeakerArchive) { Remove-Item -LiteralPath $archive -Force }
    $provenance = [ordered]@{
        acoustic_model = $acousticName
        acoustic_source = 'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip'
        speaker_model = 'vosk-model-spk-0.4'
        speaker_source = $speakerUrl
        speaker_archive_sha256 = $expectedHash
        vosk_runtime = '0.3.45'
        runtime_source = 'https://github.com/alphacep/vosk-api/releases/download/v0.3.45/vosk-win64-0.3.45.zip'
        licenses = @('Local-ASR-NOTICE.txt', 'Voice-Input-LICENSE.txt', 'vosk-model-spk-0.4/README.txt')
        files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
            [ordered]@{
                path = $_.FullName.Substring($stage.Length + 1)
                bytes = $_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            }
        })
    }
    $provenance | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage 'model-provenance.json') -Encoding UTF8
    Move-Item -LiteralPath $stage -Destination $destination
    $bytes = (Get-ChildItem -LiteralPath $destination -Recurse -File | Measure-Object Length -Sum).Sum
    Write-Output "Installed local speaker assets: $destination"
    Write-Output "Total bytes: $bytes"
    Write-Output 'No microphone, meeting, or speech recording was opened.'
} finally {
    # Only this invocation's uniquely named staging directory is eligible for cleanup.
    if (Test-Path -LiteralPath $stage -PathType Container) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
