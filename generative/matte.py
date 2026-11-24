"""Extract generated clothes, hair and limbs using the geometric guide as a spatial prior."""

import cv2
import numpy as np
from PIL import Image


def extract_candidate(candidate, guide):
    """Return a full-canvas RGBA image, or None if the guide cannot support a matte."""
    if guide.size != candidate.size or "A" not in guide.getbands():
        return None
    source = np.asarray(candidate.convert("RGB"))
    w, h = candidate.size
    scale = min(1.0, 768 / max(w, h))
    work_size = (max(1, round(w * scale)), max(1, round(h * scale)))
    pixels = cv2.resize(source, work_size, interpolation=cv2.INTER_AREA)
    coverage = cv2.resize(np.asarray(guide.getchannel("A")), work_size, interpolation=cv2.INTER_AREA)
    prior = (coverage > 64).astype(np.uint8)
    prior_area = int(prior.sum())
    if not 32 <= prior_area < prior.size * 0.92:
        return None
    _, _, bw, bh = cv2.boundingRect(prior)
    span = max(bw, bh)
    inside = cv2.distanceTransform(prior, cv2.DIST_L2, 5)
    outside = cv2.distanceTransform(1 - prior, cv2.DIST_L2, 5)
    # Leave room around the entire target pose for newly generated fingers,
    # hair and clothing. Distant guide background supplies the color model.
    distant = outside > max(12, 0.12 * span)
    if distant.sum() < max(32, prior.size * 0.025):
        return None
    bg = np.median(pixels[distant], axis=0).astype(np.float32)
    delta = np.max(np.abs(pixels.astype(np.float32) - bg), axis=2)
    background_noise = float(np.percentile(delta[distant], 95))
    if background_noise > 44:
        # A generated detailed scene lacks the near-uniform studio backdrop
        # needed here. Defer to the semantic cutout in the browser.
        return None
    contrast = max(7, background_noise + 4)
    trimap = np.full(prior.shape, cv2.GC_PR_BGD, dtype=np.uint8)
    trimap[(prior > 0) | ((outside < max(8, 0.10 * span)) & (delta > contrast))] = cv2.GC_PR_FGD
    trimap[distant] = cv2.GC_BGD
    core = ((inside > max(3, span * 0.012)) & (delta > contrast)) | ((inside > 1.8) & (delta > contrast * 3))
    if core.sum() < 16:
        return None
    trimap[core] = cv2.GC_FGD
    try:
        bg_model, fg_model = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        cv2.grabCut(pixels, trimap, None, bg_model, fg_model, 4, cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        return None

    binary = (trimap & 1).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    near = np.bincount(labels[(outside < max(3, 0.025 * span))], minlength=count)
    areas = stats[:, cv2.CC_STAT_AREA]
    keep = (areas >= 4) & (near >= np.maximum(2, areas * 0.04))
    keep[0] = False
    binary = keep[labels].astype(np.uint8)
    overlap = np.count_nonzero(binary & prior)
    if not (0.5 * prior_area <= binary.sum() <= 1.9 * prior_area and overlap >= 0.45 * prior_area):
        return None

    # Feather only the inferred contour. Undo the original studio background's
    # contribution in fractional pixels to reduce gray fringes when pasted.
    matte = cv2.GaussianBlur(binary * 255, (3, 3), 0.65)
    alpha = cv2.resize(matte, (w, h), interpolation=cv2.INTER_LINEAR)
    rgba = np.empty((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = source
    rgba[:, :, 3] = alpha
    edge = (alpha > 0) & (alpha < 255)
    opacity = alpha[edge, None].astype(np.float32) / 255
    corrected = bg + (source[edge].astype(np.float32) - bg) / np.maximum(opacity, 0.25)
    rgba[edge, :3] = np.clip(corrected, 0, 255).astype(np.uint8)
    return Image.fromarray(rgba)
