#!/usr/bin/env python3
"""Fail-closed V2.1.2 -> V2.1.3 upgrade guard regression. No VPS or DB writes."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
import tempfile

path=Path(__file__).with_name("guarded_v213_amm_shadow_upgrade.py")
spec=importlib.util.spec_from_file_location("hunterix_v213_guard",path)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def main():
    assert mod.BASE=="34286e7f829db1c77b6d34ee0ac3ab730714f2bc"
    assert mod.REVIEW_DEFAULT.name=="hunterix-amm-pressure-review-20261122"
    for check in (
        ("node","scripts/test_xrpl_amm_flow_evidence.js"),
        ("node","scripts/test_amm_pressure_shadow.js"),
        ("node","scripts/test_buy_pressure_new_wallet.js"),
        ("python3","scripts/test_stream_issuer_quality.py")
    ):
        assert check in mod.CHECKS,check
    with tempfile.TemporaryDirectory() as d:
        root=Path(d)
        assert not mod.frozen(root),"missing freeze must fail closed"
        (root/"state").mkdir()
        sentinel=root/mod.SENTINEL
        sentinel.write_text("operator freeze\n")
        sentinel.chmod(0o600)
        assert mod.frozen(root),"private freeze expected"
        sentinel.chmod(0o644)
        assert not mod.frozen(root),"unsafe sentinel permissions must fail closed"
        sentinel.chmod(0o600)
        assert mod.frozen(root)
        with patch.object(mod,"preflight",return_value=(1,71,101.429441)):
            with patch.object(mod,"stage_tests",side_effect=AssertionError("must not test nonflat")):
                with patch.object(mod,"acquire_stop_if_flat",side_effect=AssertionError("must not stop nonflat PM2")):
                    assert mod.run(root,root,"0"*40,False)==0
                    assert mod.run(root,root,"0"*40,True)==2
    print("PASS v2.1.3 guarded upgrade: baseline pin, required shadow tests, "
          "private operator freeze and no stop when nonflat")

if __name__=="__main__":
    main()
