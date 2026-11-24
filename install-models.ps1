# Windows, Python 3.11-3.12. Reuse an installed Torch/Torchvision pair
# (CPU or CUDA), then install SAM 2 and the selection, removal, depth, placement and
# harmonization weights.
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    python -c "import sys,torch,torchvision; from packaging.version import Version; assert (3,11)<=sys.version_info[:2]<=(3,12); assert Version(torch.__version__)>=Version('2.5.1') and Version(torchvision.__version__)>=Version('0.20.1')"
    if ($LASTEXITCODE) { throw 'Select a Python 3.11-3.12 environment with torch >= 2.5.1 and matching torchvision >= 0.20.1.' }
    $runner = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $runner)) {
        python -m venv --system-site-packages .venv
        if ($LASTEXITCODE) { throw 'Could not create the project environment.' }
    }
    # The OpenBLAS wheel avoids competing OpenMP DLLs with Conda on Windows.
    & $runner -m pip install --only-binary=:all: --ignore-installed --no-deps 'numpy==1.26.4'
    if ($LASTEXITCODE) { throw 'Could not install the isolated NumPy wheel.' }
    & $runner -m pip install -r requirements.txt 'numpy==1.26.4' 'opencv-python-headless>=4.10,<4.12' 'hydra-core==1.3.2' 'iopath==0.1.10'
    if ($LASTEXITCODE) { throw 'Could not install the runtime dependencies.' }
    $previous = $env:SAM2_BUILD_CUDA
    try {
        $env:SAM2_BUILD_CUDA = '0'
        & $runner -m pip install --no-deps --no-build-isolation 'https://github.com/facebookresearch/sam2/archive/2b90b9f5ceec907a1c18123530e92e794ad901a4.zip'
        if ($LASTEXITCODE) { throw 'Could not install SAM 2.' }
    } finally {
        $env:SAM2_BUILD_CUDA = $previous
    }
    & $runner -m server.weights
    if ($LASTEXITCODE) { throw 'Could not install the model weights.' }
    Write-Output 'Ready. Start the studio with .\launch.ps1'
} finally {
    Pop-Location
}
