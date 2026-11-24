$ErrorActionPreference = 'Stop'
$runtime = Join-Path $PSScriptRoot '.venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $runtime)) {
    python -m venv --system-site-packages (Join-Path $PSScriptRoot '.venv')
    if ($LASTEXITCODE) { throw 'Could not create the pose-generation environment.' }
}
$checkTorch = @'
import sys
try:
    import torch
    available = torch.cuda.is_available()
except (ImportError, OSError):
    available = False
sys.exit(0 if available else 1)
'@
& $runtime -c $checkTorch
if ($LASTEXITCODE) {
    & $runtime -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121
    if ($LASTEXITCODE) { throw 'Install CUDA-enabled PyTorch before running local pose generation.' }
}
& $runtime -m pip install -r (Join-Path $PSScriptRoot 'requirements.txt')
if ($LASTEXITCODE) { throw 'Could not install the local pose-generation packages.' }
& $runtime -c "import torch; from diffusers import StableDiffusionControlNetImg2ImgPipeline; assert torch.cuda.is_available(), 'CUDA GPU unavailable'"
if ($LASTEXITCODE) { throw 'The pose renderer needs a working CUDA GPU and drivers compatible with PyTorch.' }
& $runtime (Join-Path $PSScriptRoot 'fetch_models.py') --appearance
if ($LASTEXITCODE) { throw 'The model download did not finish. Run this installer to resume.' }
