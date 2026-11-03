"""Calorie estimate for jump rope, personalised to *your* body.

How it works
------------
1. **Intensity (MET) from your actual skip rate.** The Compendium of Physical
   Activities lists rope jumping as:
       slow   (< 100 skips/min)  →  8.8 MET
       moderate (100–120/min)    → 11.8 MET
       fast   (120–160/min)      → 12.3 MET
   We interpolate smoothly between those using the rate measured from the
   video (only the time you were actually jumping counts towards the rate).

2. **Personalised "1 MET".** A MET is a multiple of resting metabolism. The
   textbook value (3.5 ml O₂/kg/min) overestimates for most people — especially
   taller/heavier ones — so instead we compute *your* resting metabolic rate
   with the Mifflin-St Jeor equation (weight, height, age, sex) and multiply.
   This is the "corrected MET" method (Kozey et al., 2010) and is where your
   height enters the calculation.

       kcal/min while jumping = MET × RMR(kcal/day) / 1440

3. **Rests count too, but less.** Time between sets (picking the rope up,
   catching your breath) is billed at 2.0 MET — standing recovery with an
   elevated heart rate — not at full jumping intensity.

Reported "net" calories subtract what you'd have burned anyway sitting at rest
over the same time, which is the honest number for "how much extra did this
workout cost me".

Typical accuracy of any MET-based estimate is about ±15–20 % for an
individual; a chest-strap heart-rate monitor is the only cheap way to beat it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

# (skips/min, MET) anchor points from the Compendium of Physical Activities
# (codes 15551–15553), placed at the middle/edges of each published band.
_RATE_POINTS = [0.0, 90.0, 110.0, 140.0]
_MET_POINTS = [8.8, 8.8, 11.8, 12.3]
REST_MET = 2.0


def met_for_rate(skips_per_minute: float) -> float:
    return float(np.interp(skips_per_minute, _RATE_POINTS, _MET_POINTS))


def mifflin_st_jeor(weight_kg: float, height_cm: float, age: float, sex: str | None) -> float:
    """Resting metabolic rate in kcal/day."""
    base = 10.0 * weight_kg + 6.25 * height_cm - 5.0 * age
    s = (sex or "").lower()
    if s.startswith("m"):
        return base + 5.0
    if s.startswith("f"):
        return base - 161.0
    return base - 78.0  # unspecified: midpoint of the two


@dataclass
class CalorieEstimate:
    met: float
    rmr_kcal_day: float
    jumping_kcal: float
    rest_kcal: float
    total_kcal: float
    net_kcal: float
    low_kcal: float
    high_kcal: float


def estimate_calories(
    skips: int,
    jumping_seconds: float,
    rest_seconds: float,
    weight_kg: float,
    height_cm: float,
    age: float = 30.0,
    sex: str | None = None,
) -> CalorieEstimate:
    if weight_kg <= 0 or height_cm <= 0:
        raise ValueError("Weight and height must be positive.")
    rate = 60.0 * skips / jumping_seconds if jumping_seconds > 0 else 0.0
    met = met_for_rate(rate) if skips else 0.0
    rmr = mifflin_st_jeor(weight_kg, height_cm, age, sex)
    per_min_rest = rmr / 1440.0  # kcal/min at 1 MET (personalised)

    jumping = met * per_min_rest * jumping_seconds / 60.0
    rest = REST_MET * per_min_rest * rest_seconds / 60.0
    total = jumping + rest
    baseline = per_min_rest * (jumping_seconds + rest_seconds) / 60.0
    return CalorieEstimate(
        met=met,
        rmr_kcal_day=rmr,
        jumping_kcal=jumping,
        rest_kcal=rest,
        total_kcal=total,
        net_kcal=total - baseline,
        low_kcal=total * 0.85,
        high_kcal=total * 1.15,
    )


# --------------------------------------------------------------------------- unit parsing

def parse_weight(text: str) -> float:
    """'70', '70kg', '154lb', '154 lbs', '11st' → kg."""
    m = re.fullmatch(r"\s*([\d.]+)\s*([a-zA-Z]*)\s*", str(text))
    if not m:
        raise ValueError(f"Can't read weight {text!r}; try 70kg or 154lb")
    v, unit = float(m.group(1)), m.group(2).lower()
    if unit in ("", "kg", "kgs", "kilo", "kilos"):
        return v
    if unit in ("lb", "lbs", "pound", "pounds"):
        return v * 0.45359237
    if unit in ("st", "stone"):
        return v * 6.35029318
    raise ValueError(f"Unknown weight unit {unit!r}")


def parse_height(text: str) -> float:
    """'175', '175cm', '1.75m', '69in', "5'9", '5ft9in', '5ft 9' → cm."""
    s = str(text).strip().lower().replace('"', "").replace("’", "'")
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot)\s*(\d+(?:\.\d+)?)?\s*(?:in|inch|inches)?", s)
    if m:
        return float(m.group(1)) * 30.48 + float(m.group(2) or 0) * 2.54
    m = re.fullmatch(r"([\d.]+)\s*([a-z]*)", s)
    if not m:
        raise ValueError(f"Can't read height {text!r}; try 175cm or 5'9")
    v, unit = float(m.group(1)), m.group(2)
    if unit in ("", "cm"):
        return v * 100 if v < 3 else v  # bare "1.75" means metres
    if unit == "m":
        return v * 100
    if unit in ("in", "inch", "inches"):
        return v * 2.54
    raise ValueError(f"Unknown height unit {unit!r}")
