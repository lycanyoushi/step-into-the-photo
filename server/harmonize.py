"""Learn how this photograph would render the visitor, as a reusable colour table.

PCT-Net (Guerreiro et al., CVPR 2023) predicts a colour transform for every
foreground pixel of a composite. A live visitor moves between requests, so the
per-pixel field is summarised by colour instead of by position: one affine fit
plus a smoothed residual on a 17-cube lattice. The browser interpolates that
table for every later frame.
"""

import importlib.util
import math
from threading import Lock

import cv2
import numpy as np

from .weights import HARMONIZER, weight_path


GRID = 17
SIDE = 256


def build_network():
    import torch
    from torch import nn

    class Patches(nn.Module):
        def forward(self, x):
            b, c, h, w = x.shape
            x = x.view(b, c, h // 4, 4, w // 4, 4).permute(0, 2, 4, 3, 5, 1)
            return x.reshape(b, (h // 4) * (w // 4), 16 * c)

    class Encoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.patch_to_embedding = nn.Sequential(Patches(), nn.Linear(64, 256))
            layer = nn.TransformerEncoderLayer(256, nhead=2, dim_feedforward=512, activation="gelu")
            self.transformer_enc = nn.TransformerEncoder(layer, num_layers=9, enable_nested_tensor=False)
            self.dec = nn.Sequential(nn.ConvTranspose2d(256, 12, kernel_size=4, stride=4), nn.Tanh())

        def forward(self, x):
            tokens = self.patch_to_embedding(x)
            content = self.transformer_enc(tokens.permute(1, 0, 2))
            b, count, channels = tokens.shape
            side = math.isqrt(count)
            return self.dec(content.permute(1, 2, 0).reshape(b, channels, side, side))

    class PCTNet(nn.Module):
        def __init__(self):
            super().__init__()
            self.encoder = Encoder()
            self.get_params = nn.Conv2d(12, 12, kernel_size=1)

        def forward(self, image, mask):
            return self.get_params(self.encoder(torch.cat((image, mask), 1)))

    return PCTNet()


def colour_table(source, target, weight):
    """Summarise weighted source -> target colours (N x 3, 0..1) on a GRID cube, r outermost."""
    weight = weight.astype(np.float64)
    design = np.concatenate((source, np.ones((len(source), 1))), axis=1).astype(np.float64)
    scaled = design * weight[:, None]
    # A light pull toward identity keeps a one-colour garment from defining
    # an arbitrary transform for colours the visitor has not shown yet.
    ridge = 0.02 * weight.sum() * np.eye(4)
    ridge[3, 3] = 0
    prior = np.concatenate((np.eye(3), np.zeros((1, 3)))) * (0.02 * weight.sum())
    prior[3] = 0
    affine = np.linalg.solve(design.T @ scaled + ridge, scaled.T @ target + prior)
    residual = target - design @ affine

    position = np.clip(source, 0, 1) * (GRID - 1)
    base = np.minimum(position.astype(np.int64), GRID - 2)
    frac = position - base
    total = np.zeros((GRID, GRID, GRID, 3))
    mass = np.zeros((GRID, GRID, GRID))
    for corner in range(8):
        offset = np.array([(corner >> 2) & 1, (corner >> 1) & 1, corner & 1])
        share = weight * np.prod(np.where(offset, frac, 1 - frac), axis=1)
        index = base + offset
        np.add.at(mass, (index[:, 0], index[:, 1], index[:, 2]), share)
        np.add.at(total, (index[:, 0], index[:, 1], index[:, 2]), share[:, None] * residual)
    # Normalised convolution: observed colours inform their neighbours, and
    # empty lattice cells fall back to the affine fit.
    kernel = cv2.getGaussianKernel(7, 1.25).ravel()
    for axis in range(3):
        mass = np.apply_along_axis(np.convolve, axis, mass, kernel, mode="same")
        total = np.apply_along_axis(np.convolve, axis, total, kernel, mode="same")
    correction = total / (mass[..., None] + 0.004 * weight.sum() + 1e-9)

    axis = np.linspace(0, 1, GRID)
    lattice = np.stack(np.meshgrid(axis, axis, axis, indexing="ij"), axis=-1)
    table = lattice @ affine[:3] + affine[3] + correction
    return np.clip(table, 0, 1), affine


class Harmonizer:
    method = "PCT-Net"

    def __init__(self):
        self.model = None
        self.device = "cpu"
        self.lock = Lock()

    @property
    def available(self):
        return weight_path(HARMONIZER).is_file() and importlib.util.find_spec("torch") is not None

    def load(self):
        import torch

        model = build_network()
        model.load_state_dict(torch.load(weight_path(HARMONIZER), map_location="cpu", weights_only=True))
        self.model = model.eval()
        if torch.cuda.is_available():
            try:
                self.model = self.model.to("cuda")
                self.device = "cuda"
            except RuntimeError:
                self.model = self.model.to("cpu")

    def table(self, composite, mask):
        """composite: H x W x 3 uint8 with the untreated visitor. mask: H x W uint8 coverage."""
        if not self.available:
            raise FileNotFoundError("Install PyTorch and run python -m server.weights --model harmonize.")
        import torch

        image = cv2.resize(composite, (SIDE, SIDE), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
        alpha = cv2.resize(mask, (SIDE, SIDE), interpolation=cv2.INTER_AREA).astype(np.float32) / 255
        if (alpha > 0.5).sum() < 24:
            raise ValueError("The visitor is too small in this view to measure.")
        with self.lock:
            if self.model is None:
                self.load()
            pixels = torch.from_numpy(image).permute(2, 0, 1)[None]
            cover = torch.from_numpy(alpha)[None, None]
            with torch.inference_mode():
                try:
                    params = self.model(pixels.to(self.device), cover.to(self.device))
                except RuntimeError:
                    if self.device == "cpu":
                        raise
                    # Another local model may hold the laptop's graphics memory.
                    self.model = self.model.to("cpu")
                    self.device = "cpu"
                    params = self.model(pixels, cover)
            params = params[0].float().cpu().numpy()
        matrix = params[:9].transpose(1, 2, 0).reshape(SIDE, SIDE, 3, 3)
        predicted = np.einsum("hwij,hwj->hwi", matrix, image) + params[9:].transpose(1, 2, 0)
        # Mixed edge pixels already contain the photograph and would teach the
        # table to leave colours unchanged.
        solid = alpha > 0.9
        if solid.sum() < 24:
            solid = alpha > 0.5
        table, affine = colour_table(image[solid], np.clip(predicted[solid], 0, 1), alpha[solid])
        return np.rint(table * 255).astype(np.uint8), affine
