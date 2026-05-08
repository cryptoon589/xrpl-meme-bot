# Trade Analysis Report — 2026-05-06

**Trades analyzed:** 14 | **Win rate:** 7.1% | **Auto-apply:** ⏳ Pending

## Insights
- Overall: 14 trades | Win rate: 7.1% | Avg win: +2.1% | Avg loss: -17.5% | Total PnL: -9.30 XRP
- Not enough burst trades for analysis (2/5 needed)
- Scored ≥50: 12 trades | 0% win rate
- Scored ≥55: 12 trades | 0% win rate
- Scored ≥60: 11 trades | 0% win rate
- Scored ≥65: 3 trades | 0% win rate
- Scored TP1 hit rate: 50% | TP2 hit rate: 50%
- Score component [holder_growth_score]: high→0% win, low→0% win (delta: 0pp)
- Score component [buy_pressure_score]: high→0% win, low→0% win (delta: 0pp)
- 🔬 Best signal combo: liquidity_score + holder_growth_score → 0% win rate (7 trades)
-    2nd: liquidity_score + buy_pressure_score → 0% (6 trades)
- ✅ Entry timing: stop rate 0% — immediate entry is working
- 📏 Not enough wins yet for run-length analysis (1/5)
- 🚫 Worst trading hours (UTC): 2:00, 18:00 — consider pausing
- ⏳ Need 16 more trades + 50%+ win rate for auto-apply

## #1 Entry Timing
| Parameter | Value |
|---|---|
| Pullback wait | None (enter immediately) |
| Confirm bars | None |

## #2 Exit Sizing (learned run lengths)
| Metric | Value |
|---|---|
| Median winning run | +2.1% |
| 75th pct run | +2.1% |
| Burst median run | +2.1% |
| Scored median run | +0% |

## #3 Time-of-Day
| | Hours (UTC) |
|---|---|
| Best hours | Insufficient data |
| Worst hours | 2:00, 18:00 |
| Pause enabled | ❌ No (need 40+ trades) |

## Recommended Burst Parameters
| Parameter | Value |
|---|---|
| Min pool liquidity | 2000 XRP |
| Stop loss | -8% |
| TP1 | +15% |
| TP2 | +30% |
| Trail activation | +10% |
| Trail distance | 5% |

## Recommended Scored Trade Parameters
| Parameter | Value |
|---|---|
| Min score | 65 |
| TP1 | +35% |
| TP2 | +75% |
| Best signal combo | liquidity_score + holder_growth_score |

## Score Component Weights (learned)
| Component | Weight |
|---|---|
| Liquidity | 17 |
| Holder growth | 17 |
| Buy pressure | 17 |
| Volume accel | 17 |
| Dev safety | 17 |
| Spread | 15 |

## Apply
Tell the bot: `apply trade recommendations` to activate these params.