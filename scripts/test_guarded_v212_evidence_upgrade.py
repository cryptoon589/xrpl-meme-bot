#!/usr/bin/env python3
"""Synthetic fail-closed current V2.1->V2.1.2 release upgrade guards."""
import importlib.util
from pathlib import Path
from unittest.mock import patch
import tempfile

src=Path(__file__).with_name('guarded_v212_evidence_upgrade.py')
spec=importlib.util.spec_from_file_location('v212',src)
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def main():
    assert mod.BASE=='e2277a8f510423741cb890be57a78cd19b8170d2'
    assert ('node','scripts/test_xrpl_amm_flow_evidence.js') in mod.CHECKS
    assert mod.REVIEW_DEFAULT.name=='hunterix-buy-pressure-review-20261122'
    with tempfile.TemporaryDirectory() as t:
        root=Path(t)
        with patch.object(mod,'preflight',return_value=(1,71,101.429441)):
            with patch.object(mod,'stage_tests',side_effect=AssertionError('no tests when nonflat')):
                with patch.object(mod,'acquire_stop_if_flat',side_effect=AssertionError('no PM2 stop when nonflat')):
                    assert mod.run(root,root,'0'*40,False)==0
                    assert mod.run(root,root,'0'*40,True)==2
    print('PASS V2.1.2 guarded upgrade: exact baseline/pinned evidence and non-flat no-stop path')

if __name__=='__main__':main()
