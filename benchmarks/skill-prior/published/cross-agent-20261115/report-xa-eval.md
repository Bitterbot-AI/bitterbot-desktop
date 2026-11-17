# Cross-agent evidence cards: phase eval

Generated 2026-11-15T15:47:44.272Z. Recipient anthropic/claude-haiku-4-5; 3 donor(s) on anthropic/claude-haiku-4-5; budget 2 episode(s) per agent per cell; 9 families x 8 workspaces = 72 cells. Records: ~/bitterbot-skill-prior/cross-agent/records.jsonl.

Protocol hash 3ee5be341ebaccca (~/bitterbot-skill-prior/cross-agent/protocol-xa-eval.json), written before the first evaluation run. Evaluation seeds 60000, 60001 (`final` split, never used for experience): 144 instances in 72 cells. An errored run counts as a failure.

## Bundles the recipient imported

| Donor | Origin | Cells with records | Records dropped (skill content mismatch) |
| --- | --- | ---: | ---: |
| d1 | ed25519:6df32768d5290b5e... | 72 | 0 |
| d2 | ed25519:8e1a34ff522f81e7... | 72 | 0 |
| d3 | ed25519:0379d89ec803a748... | 72 | 0 |

## Arms

| Arm | Trials | Pass | Read correct | Read decoy | Read any | Tokens/trial | Errors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| none | 144 | 19.4% | 25.7% | 72.2% | 97.9% | 59206 | 0 |
| own-half | 144 | 31.9% | 38.2% | 58.3% | 96.5% | 66402 | 0 |
| own | 144 | 51.4% | 59.0% | 37.5% | 96.5% | 58550 | 0 |
| peer1 | 144 | 47.2% | 54.9% | 42.4% | 97.2% | 67414 | 0 |
| peer | 144 | 56.9% | 61.8% | 33.3% | 95.1% | 71823 | 0 |
| own-half+peer | 144 | 66.0% | 70.1% | 29.2% | 99.3% | 56230 | 0 |
| own+peer | 144 | 68.8% | 75.0% | 24.3% | 99.3% | 65285 | 0 |
| peer-liar | 144 | 10.4% | 12.5% | 84.7% | 97.2% | 63643 | 0 |
| stale | 144 | 4.9% | 11.8% | 84.0% | 95.8% | 74553 | 0 |
| own+stale | 144 | 41.0% | 44.4% | 52.8% | 97.2% | 68855 | 0 |
| placebo | 144 | 23.6% | 31.3% | 64.6% | 95.8% | 58045 | 0 |
| oracle | 144 | 81.3% | 99.3% | 0.0% | 99.3% | 57812 | 0 |

| Arm | Reference reader opens the right variant | Model opens it first | Model pass |
| --- | ---: | ---: | ---: |
| none | 25.0% | 25.7% | 19.4% |
| own-half | 39.1% | 38.2% | 31.9% |
| own | 56.9% | 59.0% | 51.4% |
| peer1 | 56.3% | 54.9% | 47.2% |
| peer | 72.2% | 61.8% | 56.9% |
| own-half+peer | 75.7% | 70.1% | 66.0% |
| own+peer | 80.6% | 75.0% | 68.8% |
| peer-liar | 11.1% | 12.5% | 10.4% |
| stale | 10.4% | 11.8% | 4.9% |
| own+stale | 24.3% | 44.4% | 41.0% |
| placebo | 25.0% | 31.3% | 23.6% |
| oracle | 100.0% | 99.3% | 81.3% |

The reference reader uses the card perfectly (best accepted rate, else an untried variant, ties split), so its column is what the shown records can support and the gap to the model is what the model loses.

## Confirmatory family (fixed order; the first failure makes the rest exploratory)

| Step | Claim | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| primary | Pooled peer cards beat the recipient's own experience at equal per-agent budget | 72 | 5.6 | [-9.0, 20.1] | 21 / 14 / 37 | 0.1553 | NOT CONFIRMED |
| content | The gain comes from the outcomes, not from the presence of a peer line | 72 | 33.3 | [19.4, 48.6] | 34 / 3 / 35 | 0.0000 | exploratory (meets its criterion) |
| coverage | Peer cards help most when the recipient has no experience of its own | 72 | 20.1 | [2.1, 38.2] | 30 / 9 / 33 | 0.0005 | exploratory (meets its criterion) |
| liar | A pool with one lying donor still beats no card | 72 | -9.0 | [-19.4, 2.1] | 8 / 21 / 43 | 0.9959 | exploratory (misses its criterion) |

Unit: the cell. Interval: families resampled, then cells within family. A step is met when the interval lies above zero and, where a sign test applies, its one-sided exact p is below 0.025. The coverage step is a difference in differences and uses the interval alone.

## Coverage: what the pool adds as the recipient's own experience grows

| Contrast | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p |
| --- | ---: | ---: | ---: | ---: | ---: |
| pool added to no own experience (peer minus none) | 72 | 37.5 | [20.1, 55.6] | 38 / 3 / 31 | 0.0000 |
| pool added to half the own budget (own-half+peer minus own-half) | 72 | 34.0 | [19.4, 49.3] | 40 / 2 / 30 | 0.0000 |
| pool added to the full own budget (own+peer minus own) | 72 | 17.4 | [5.6, 31.3] | 25 / 6 / 41 | 0.0004 |

| Contrast | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p |
| --- | ---: | ---: | ---: | ---: | ---: |
| own+peer minus own, cells where the recipient had NOT found an accepted variant | 44 | 25.0 | [10.2, 43.3] | 20 / 2 / 22 | 0.0001 |
| own+peer minus own, cells where it HAD found one | 28 | 5.4 | [-10.4, 22.4] | 5 / 4 / 19 | 0.5000 |

The recipient had found an accepted variant in 28 of 72 cells before evaluation.

## Exploratory contrasts

| Contrast | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p |
| --- | ---: | ---: | ---: | ---: | ---: |
| peer minus none | 72 | 37.5 | [20.1, 55.6] | 38 / 3 / 31 | 0.0000 |
| own minus none | 72 | 31.9 | [18.1, 45.8] | 35 / 4 / 33 | 0.0000 |
| own+peer minus peer | 72 | 11.8 | [-1.4, 25.7] | 20 / 7 / 45 | 0.0096 |
| peer1 minus own (one peer's experience against the same amount of one's own) | 72 | -4.2 | [-18.1, 9.0] | 18 / 19 / 35 | 0.6286 |
| peer minus peer1 (more donors, same per-agent budget) | 72 | 9.7 | [-0.7, 21.5] | 16 / 7 / 49 | 0.0466 |
| peer-liar minus peer (cost of one lying donor) | 72 | -46.5 | [-63.2, -28.5] | 1 / 43 / 28 | 1.0000 |
| stale minus none (harm of a misapplied pool) | 72 | -14.6 | [-24.3, -5.6] | 4 / 21 / 47 | 0.9999 |
| own+stale minus own (does own experience protect?) | 72 | -10.4 | [-25.7, 4.9] | 11 / 23 / 38 | 0.9878 |
| oracle minus peer (room left above the pool) | 72 | 24.3 | [10.4, 38.9] | 27 / 4 / 41 | 0.0000 |

## Flips per task (negative transfer is the `down` column)

| Comparison | Fail to pass | Pass to fail | Unchanged |
| --- | ---: | ---: | ---: |
| peer against own | 27 | 19 | 98 |
| peer against none | 60 | 6 | 78 |
| peer-liar against peer | 2 | 69 | 73 |
| stale against none | 5 | 26 | 113 |
| own+stale against own | 15 | 30 | 99 |
| own+peer against own | 33 | 8 | 103 |

Estimated spend in this output directory: $47.36 (list prices).
