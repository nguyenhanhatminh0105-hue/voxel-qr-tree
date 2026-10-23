# UI audit, October 2026

Audited the live page at 1280×800 and 390×844, in light and dark mode, through the full reveal (tree → code → tree), with the impeccable detector and screenshots of both builds.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | P2 | Season labels on the tabs (SPRING, SUMMER…) were 10px, below the 11px floor for functional text. | 11px. |
| 2 | P2 | On phones the claim line ("Every voxel stands on a dark module…") was 11.5px. | 12.5px. |

Checked and fine: no horizontal scroll, every control at least 44px on phones, no console errors or warnings in either build (the old `toNonIndexed()` warning is gone), and both QR suites still pass (`test_qr_vs_segno.py`, `test_qr_decode.py`).

Detector notes: "cream palette" is a deliberate choice, not a default. The light ground is the QR quiet zone and part of the contrast floor (see PRODUCT.md). The opening flip to the code view is the page's scripted reveal, not a wrong initial state.
