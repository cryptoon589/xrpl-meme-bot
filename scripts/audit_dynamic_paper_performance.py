#!/usr/bin/env python3
"""Read-only PAPER trade audit since the verified vNext pre-dynamic backup.

The closing trade win rate counts only *fully closed* positions. A TP1/TP2
partial fill is separately reported as realized PnL on the portion sold.
Unrealized PnL is unknown without a fresh, executable reserve-aware quote.

Nothing in this script connects to Telegram, the XRPL, or the running PM2 bot.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path
from contextlib import closing

PAPER_ENTRY_FEE_RATE = 0.003
TOLERANCE = 0.0001
NEEDED_COLUMNS = {
    "id", "token_currency", "token_issuer", "status", "entry_amount_xrp",
    "xrp_returned", "pnl_xrp", "remaining_position", "tp1_hit",
    "tp2_hit", "exit_reason", "trade_profile", "trade_source",
}

def open_read_only(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise RuntimeError(f"Missing verified PAPER database: {path}")
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        db.close()
        raise RuntimeError(f"Database integrity check failed: {path}")
    columns = {str(r[1]) for r in db.execute("PRAGMA table_info(paper_trades)")}
    if not NEEDED_COLUMNS.issubset(columns):
        db.close()
        raise RuntimeError(f"Unexpected PAPER schema in {path}: missing {NEEDED_COLUMNS-columns}")
    return db

def read_cash(db: sqlite3.Connection) -> float:
    row = db.execute("SELECT bankroll_xrp FROM paper_cash_state WHERE singleton_id=1").fetchone()
    if row is None or row[0] is None:
        raise RuntimeError("No reconciled PAPER cash checkpoint")
    return float(row[0])

def rows_by_id(db: sqlite3.Connection) -> dict[int, dict]:
    return {int(r["id"]): dict(r) for r in db.execute(
        """SELECT id,token_currency,token_issuer,status,entry_amount_xrp,
            xrp_returned,pnl_xrp,remaining_position,tp1_hit,tp2_hit,
            exit_reason,trade_profile,trade_source FROM paper_trades"""
    )}

def original_backup(active: Path) -> Path:
    backup_dir = active.parent.parent / "recovery-backups"
    # Choose the latest pre-dynamic candidate in the operator's *active* repo.
    for pattern in ("before-rpc-budget-*.db", "before-dynamic-meme-*.db"):
        candidates = sorted(backup_dir.glob(pattern), reverse=True)
        if candidates:
            return candidates[0]
    raise RuntimeError(
        "No pre-dynamic account backup found. Use --baseline with the verified 16-trade backup."
    )

def cash_and_outcome(trade: dict) -> tuple[float, float, float, float]:
    entry = float(trade["entry_amount_xrp"])
    returned = float(trade["xrp_returned"] or 0)
    remaining = float(trade["remaining_position"])
    status = trade["status"]
    if not 0 <= remaining <= 100 or not entry > 0 or returned < 0:
        raise RuntimeError(f"Corrupt cash/inventory fields for trade #{trade['id']}")
    if status not in {"open", "partial", "closed"}:
        raise RuntimeError(f"Unexpected trade status for #{trade['id']}: {status}")
    if status == "closed" and remaining > 0.000001:
        raise RuntimeError(f"Closed trade #{trade['id']} still has remaining inventory")
    if status == "partial" and not (0 < remaining < 100):
        raise RuntimeError(f"Partial trade #{trade['id']} has invalid remaining percentage")
    if status == "open" and (abs(remaining - 100) > 0.000001 or returned > TOLERANCE):
        raise RuntimeError(f"Unrealized trade #{trade['id']} has unexpected proceeds")
    realized_fraction = (100 - remaining) / 100
    realized = returned - entry * (1 + PAPER_ENTRY_FEE_RATE) * realized_fraction
    reported = trade["pnl_xrp"]
    if status in {"partial", "closed"} and reported is not None:
        if abs(float(reported) - realized) > TOLERANCE:
            raise RuntimeError(
                f"Trade #{trade['id']} P&L does not reconcile: stored {reported} vs {realized:.6f}"
            )
    if status == "open":
        realized = 0.0
    remaining_cost = entry * (1 + PAPER_ENTRY_FEE_RATE) * remaining / 100
    cash_return_floor = returned - entry * (1 + PAPER_ENTRY_FEE_RATE)
    return entry, returned, realized, remaining_cost

def audit(db_path: Path, baseline_path: Path) -> int:
    with closing(open_read_only(baseline_path)) as base, closing(open_read_only(db_path)) as now:
        initial = rows_by_id(base)
        current = rows_by_id(now)
        old_cash = read_cash(base)
        cash = read_cash(now)
        missing = set(initial) - set(current)
        if missing:
            raise RuntimeError(f"Historic trade IDs removed since baseline: {sorted(missing)}")
        if len(initial) != 16:
            raise RuntimeError(
                f"Wrong baseline: expected 16 pre-dynamic PAPER trades, got {len(initial)}"
            )
        new_ids = sorted(set(current) - set(initial))
        new = [current[tid] for tid in new_ids]
        proceeds_diff = sum(
            float(row["xrp_returned"] or 0) -
            float(initial[tid]["xrp_returned"] or 0) if tid in initial
            else float(row["xrp_returned"] or 0)
            for tid, row in current.items()
        )
        spent_since = sum(float(t["entry_amount_xrp"]) for t in new)
        # Opening a PAPER trade debits the buy amount PLUS the simulated
        # entry fee (0.3%). xrp_returned is already net of exit fees.
        # Omitting entry fees creates an apparent 0.003 * spend cash shortfall.
        entry_fees_since = spent_since * PAPER_ENTRY_FEE_RATE
        expected_cash = old_cash - spent_since - entry_fees_since + proceeds_diff
        print("=== HUNTERIX PAPER PERFORMANCE SINCE DYNAMIC ACTIVATION ===")
        print("Database:   ", db_path)
        print("Baseline:   ", baseline_path)
        print(f"Cash:       {cash:.6f} XRP (baseline {old_cash:.6f})")
        print(f"Trades:     {len(current)} total | {len(initial)} pre-dynamic | {len(new)} new")
        print(f"New entries: {spent_since:.6f} XRP + {entry_fees_since:.6f} XRP simulated entry fees")
        print(f"Cash check: expected {expected_cash:.6f}, delta {cash-expected_cash:+.8f} XRP")
        if abs(cash - expected_cash) > TOLERANCE:
            raise RuntimeError("Cash movements DO NOT reconcile with post-baseline trade mutations")
        print("PASS: cash reconciles with actual new entries and cumulative sale proceeds")
        if not new:
            print("No new trades after baseline.")
            return 0

        summaries = []
        total_realized = 0.0
        total_unsold_cost = 0.0
        closed = []
        partial = []
        opened = []
        warnings = []
        inventory = {int(r[0]):float(r[1]) for r in now.execute(
            "SELECT trade_id,tokens_held FROM paper_inventory"
        )}

        for t in new:
            entry, returned, realized, remaining_cost = cash_and_outcome(t)
            status = t["status"]
            if t["id"] not in inventory:
                warnings.append(f"Trade #{t['id']} lacks persisted inventory checkpoint")
            elif status in {"open", "partial"} and inventory[t["id"]] <= 0:
                warnings.append(f"Trade #{t['id']} has nonzero inventory status but zero held tokens")
            total_realized += realized
            total_unsold_cost += remaining_cost
            if status == "closed":
                closed.append((t,realized))
            elif status == "partial":
                partial.append((t,realized))
            else:
                opened.append(t)
            summaries.append((t,returned,realized,remaining_cost))

        wins=sum(1 for _t,pnl in closed if pnl>0)
        losses=sum(1 for _t,pnl in closed if pnl<=0)
        print()
        print(f"New trades: {len(new)} | fully closed: {len(closed)} "
              f"({wins} wins, {losses} non-wins) | partial: {len(partial)} | open: {len(opened)}")
        print(f"Completed-trade win rate: {wins/len(closed)*100:.1f}%" if closed
              else "Completed-trade win rate: N/A (no fully closed trades)")
        print(f"Fully closed P&L:  {sum(p for _,p in closed):+.6f} XRP")
        print(f"Partial realized:  {sum(p for _,p in partial):+.6f} XRP")
        print(f"Combined realized: {total_realized:+.6f} XRP")
        print(f"Remaining entry cost basis: {total_unsold_cost:.6f} XRP "
              "(NOT a live liquidation value)")
        print("Unrealized P&L: UNKNOWN — no live price/AMM reserve sell quote was requested")
        print()
        print("=== INDIVIDUAL NEW TRADES (recent first) ===")
        for t,ret,realized,remaining_cost in reversed(summaries):
            code=str(t["token_currency"])
            flags=(" TP1" if t["tp1_hit"] else "")+(" TP2" if t["tp2_hit"] else "")
            rem=float(t["remaining_position"])
            print(f"#{t['id']:>3} {code[:17]:17s} {t['status']:7s} "
                  f"in={float(t['entry_amount_xrp']):8.4f} "
                  f"out={ret:8.4f} "
                  f"realized={realized:+8.4f} "
                  f"left={rem:5.1f}%{flags}")
            if t["status"]=="partial":
                floor = ret - float(t["entry_amount_xrp"])*(1+PAPER_ENTRY_FEE_RATE)
                print(f"     remaining cost basis {remaining_cost:.4f} XRP | "
                      f"full trade P&L if unsold tokens become worthless: {floor:+.4f} XRP")
        if warnings:
            print("=== INVENTORY WARNINGS ===")
            for w in warnings: print("WARNING:", w)
        print("Note: realized sums exclude open inventory valuation and do not guarantee future net profit.")
        return 0

def main() -> int:
    parser=argparse.ArgumentParser(description="Read-only HUNTERIX simulated trade reconciliation")
    parser.add_argument("--db",default="data/meme_bot.paper-epoch-20261116-vnext.db",
                        type=Path,help="current PAPER epoch DB (read-only)")
    parser.add_argument("--baseline",type=Path,default=None,
                        help="verified 16-trade backup from before dynamic activation")
    args=parser.parse_args()
    try:
        return audit(args.db,args.baseline or original_backup(args.db))
    except (RuntimeError,sqlite3.Error) as exc:
        print(f"AUDIT BLOCKED: {exc}",file=sys.stderr)
        return 1

if __name__=="__main__":
    raise SystemExit(main())
