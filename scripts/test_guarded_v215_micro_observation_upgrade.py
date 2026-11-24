#!/usr/bin/env python3
"""Offline fail-closed V2.1.4 -> V2.1.5 observation-only cutover regression."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
import tempfile

src=Path(__file__).with_name("guarded_v215_micro_observation_upgrade.py")
spec=importlib.util.spec_from_file_location("guarded_v215",src)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
def main():
    assert mod.BASE=="1fb418708a1e6df29dfe68a076fcd635af5cf04a"
    assert mod.REVIEW_DEFAULT.name=="hunterix-micro-shadow-review-20261124"
    assert mod.SENTINEL=="state/paper-entry-freeze.flag"
    for required in (
        ("node","scripts/test_micro_amm_shadow.js"),
        ("node","scripts/test_missed_currency_decoder.js"),
        ("python3","scripts/test_liquidity_exits.py"),
        ("python3","scripts/test_meme_evidence_age.py"),
        ("node","scripts/test_meme_entry_universe.js"),
        ("node","scripts/test_telegram_reporting_integrity.js"),
        ("python3","scripts/test_top_gainer_coverage.py")
    ):
        assert required in mod.CHECKS,required
    with tempfile.TemporaryDirectory() as td:
        p=Path(td)
        assert not mod.frozen(p)
        (p/"state").mkdir()
        sentinel=p/mod.SENTINEL
        sentinel.write_text("operator_freeze\n")
        sentinel.chmod(0o600)
        assert mod.frozen(p)
        sentinel.chmod(0o644)
        assert not mod.frozen(p)
        sentinel.chmod(0o600)
        assert mod.frozen(p)
        with patch.object(mod,"preflight",return_value=(1,144,92.0)):
            with patch.object(mod,"stage_tests",side_effect=AssertionError("must not build when non-flat")):
                with patch.object(mod,"acquire_stop_if_flat",
                                  side_effect=AssertionError("must not stop PM2 with positions")):
                    assert mod.run(p,p,"0"*40,False)==0
                    assert mod.run(p,p,"0"*40,True)==2
    print("PASS V2.1.5 flat/frozen guarded cutover, private sentinel and non-flat no-stop regression")
if __name__=="__main__":main()
