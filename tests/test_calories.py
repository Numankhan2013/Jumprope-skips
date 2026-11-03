import pytest

from jumprope_counter.calories import (
    estimate_calories,
    met_for_rate,
    mifflin_st_jeor,
    parse_height,
    parse_weight,
)


def test_met_bands():
    assert met_for_rate(60) == pytest.approx(8.8)
    assert met_for_rate(110) == pytest.approx(11.8)
    assert met_for_rate(150) == pytest.approx(12.3)
    assert 8.8 < met_for_rate(100) < 11.8


def test_mifflin():
    # 70 kg, 175 cm, 30 y male: 700 + 1093.75 - 150 + 5
    assert mifflin_st_jeor(70, 175, 30, "male") == pytest.approx(1648.75)
    assert mifflin_st_jeor(70, 175, 30, "female") == pytest.approx(1482.75)


def test_ten_minutes_of_moderate_skipping():
    c = estimate_calories(1100, 600, 0, 70, 175, 30, "male")
    # 11.8 MET × 1648.75/1440 kcal/min × 10 min ≈ 135 kcal
    assert c.total_kcal == pytest.approx(11.8 * 1648.75 / 1440 * 10, rel=1e-6)
    assert c.net_kcal < c.total_kcal


def test_rest_is_cheaper_than_jumping():
    a = estimate_calories(500, 300, 0, 80, 180)
    b = estimate_calories(500, 300, 300, 80, 180)
    assert b.total_kcal > a.total_kcal
    assert b.rest_kcal < a.jumping_kcal


def test_taller_person_burns_more_at_same_weight():
    short = estimate_calories(1000, 600, 0, 75, 160)
    tall = estimate_calories(1000, 600, 0, 75, 190)
    assert tall.total_kcal > short.total_kcal


@pytest.mark.parametrize("text,kg", [("70", 70), ("70kg", 70), ("154lb", 69.85), ("154 lbs", 69.85), ("11st", 69.85)])
def test_parse_weight(text, kg):
    assert parse_weight(text) == pytest.approx(kg, abs=0.05)


@pytest.mark.parametrize("text,cm", [("175", 175), ("175cm", 175), ("1.75m", 175), ("1.75", 175),
                                     ("69in", 175.26), ("5'9", 175.26), ("5'9\"", 175.26),
                                     ("5ft9in", 175.26), ("5 ft 9", 175.26), ("6'", 182.88)])
def test_parse_height(text, cm):
    assert parse_height(text) == pytest.approx(cm, abs=0.05)
