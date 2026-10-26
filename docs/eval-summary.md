# AMP eval summary

Generated: 2026-10-26T19:27:06.874Z

> Fixture labels only; not an independent human study. Recorded n=40; replay n=12.

| Surface | Metric | Value |
|---|---|---|
| replay | accuracy | 66.7% |
| replay | annotator agreement | 83% |
| replay | Cohen's kappa | 0.571 |
| replay | Brier | 0.247 |
| recorded | accuracy | 82.5% |
| recorded | text ECE | 0.314 |
| recorded | calibrated ECE | 0.281 |
| recorded | calibration | activated (temperature T=0.25) |
| recorded | oracle ECE | 0.222 |
| labels | coverage | 100% |
| labels | disagreements | 2 |
| labels | kappa | 0.571 |
| labels | unresolved | 2 |

Calibration map is activated only when cross-validated ECE beats raw by the registry margin. A `raw` status means the data did not justify a map.
