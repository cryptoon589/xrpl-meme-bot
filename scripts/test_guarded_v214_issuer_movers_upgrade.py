#!/usr/bin/env python3
"""Offline fail-closed V2.1.3 -> V2.1.4 upgrade smoke regression."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
import tempfile

src=Path(__file__).with_name("guarded_v214_issuer_movers_upgrade.py")
spec=importlib.util.spec_from_file_location("guarded_v214",src)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
def main():
    assert mod.BASE=="199191637a27e233ad31705bf800182fd952d030"
    assert mod.REVIEW_DEFAULT.name=="hunterix-issuer-review-20261124"
    for required in (
        ("node","scripts/test_open_ticker_collision.js"),
        ("node","scripts/test_meme_entry_universe.js"),
        ("node","scripts/test_external_meme_gainer_capture.js"),
        ("node","scripts/test_telegram_reporting_integrity.js"),
        ("python3","scripts/test_paper_issuer_trades.py"),
        ("python3","scripts/test_external_gainer_timeline.py")
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
        with patch.object(mod,"preflight",return_value=(1,144,88.0)):
            with patch.object(mod,"stage_tests",side_effect=AssertionError("don't build when non-flat")):
                with patch.object(mod,"acquire_stop_if_flat",
                                  side_effect=AssertionError("don't stop PM2 when non-flat")):
                    assert mod.run(p,p,"0"*40,False)==0
                    assert mod.run(p,p,"0"*40,True)==2
    print("PASS V2.1.4 guarded cutover: pinned prior release, private operator freeze, non-flat no-stop, required regression gates")

if __name__=="__main__":main()
