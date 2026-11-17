# Cross-agent evidence cards: phase eval2

Generated 2026-11-16T02:01:00.927Z. Recipient anthropic/claude-haiku-4-5; 3 donor(s) on anthropic/claude-haiku-4-5; budget 2 episode(s) per agent per cell; 9 families x 8 workspaces = 72 cells. Records: ~/bitterbot-skill-prior/cross-agent/records.jsonl.

Follow-up protocol hash 35710e02549aab13 (~/bitterbot-skill-prior/cross-agent/protocol-xa-eval2.json), written before the first follow-up run; first-study protocol 3ee5be341ebaccca. Same 144 instances and index order as the first study, so every contrast below is paired by cell. These arms were designed after an interim read of the first study.

## Donor checks against the recipient's own verified outcomes

A donor is dropped at 3 or more contradictions when they are at least 25% of the checks. The lying donor is d3 (the same one in every cell).

| Donor as seen by the recipient | Checks | Contradictions | Decision |
| --- | ---: | ---: | --- |
| d1 | 60 | 5 | kept |
| d2 | 58 | 4 | kept |
| d3 (lying) | 60 | 51 | DROPPED |
| d1 (misapplied pool) | 47 | 19 | DROPPED |
| d2 (misapplied pool) | 48 | 20 | DROPPED |
| d3 (misapplied pool) | 64 | 21 | DROPPED |

## Arms (first study and follow-up)

| Arm | Runs | Reference reader opens the right variant | Model opens it first | Model pass |
| --- | ---: | ---: | ---: | ---: |
| none | 144 | see first report | 25.7% | 19.4% |
| own-half | 144 | see first report | 38.2% | 31.9% |
| own | 144 | see first report | 59.0% | 51.4% |
| peer1 | 144 | see first report | 54.9% | 47.2% |
| peer | 144 | see first report | 61.8% | 56.9% |
| own-half+peer | 144 | see first report | 70.1% | 66.0% |
| own+peer | 144 | see first report | 75.0% | 68.8% |
| peer-liar | 144 | see first report | 12.5% | 10.4% |
| stale | 144 | see first report | 11.8% | 4.9% |
| own+stale | 144 | see first report | 44.4% | 41.0% |
| placebo | 144 | see first report | 31.3% | 23.6% |
| oracle | 144 | see first report | 99.3% | 81.3% |
| live | 144 | 79.2% | 69.4% | 62.5% |
| own+live | 144 | 83.7% | 77.8% | 71.5% |
| live-liar | 144 | 18.1% | 13.9% | 17.4% |
| live-liar-quorum | 144 | 60.5% | 58.3% | 54.9% |
| own+liar | 144 | 26.4% | 47.9% | 43.1% |
| own+liar-guarded | 144 | 77.4% | 72.2% | 67.4% |
| own+stale-guarded | 144 | 56.9% | 59.0% | 50.0% |

## Follow-up family (fixed order; the first failure makes the rest exploratory)

| Step | Claim | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| live | A live pool beats a one-off exchange built from the same number of episodes | 72 | 5.6 | [-7.6, 18.8] | 22 / 16 / 34 | 0.2088 | NOT CONFIRMED |
| quorum | A live pool with one lying donor, read by quorum, still beats no card | 72 | 35.4 | [17.4, 54.2] | 37 / 7 / 28 | 0.0000 | exploratory (meets its criterion) |
| guard | Checking donors against own outcomes removes the harm of a lying donor | 72 | 24.3 | [9.7, 39.6] | 30 / 4 / 38 | 0.0000 | exploratory (meets its criterion) |

## Exploratory contrasts

| Contrast | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p |
| --- | ---: | ---: | ---: | ---: | ---: |
| live minus none | 72 | 43.1 | [27.1, 58.3] | 43 / 6 / 23 | 0.0000 |
| live minus own (three peers sharing live against one's own experience) | 72 | 11.1 | [-0.7, 23.6] | 22 / 10 / 40 | 0.0251 |
| own+live minus own+peer | 72 | 2.8 | [-6.9, 13.2] | 13 / 11 / 48 | 0.4194 |
| own+live minus own | 72 | 20.1 | [6.9, 34.7] | 28 / 8 / 36 | 0.0006 |
| oracle minus own+live (room left) | 72 | 9.7 | [2.1, 17.4] | 18 / 4 / 50 | 0.0022 |
| live-liar minus none (live pool, one liar, counts summed) | 72 | -2.1 | [-12.5, 7.6] | 13 / 14 / 45 | 0.6494 |
| live-liar-quorum minus live-liar (what the quorum recovers) | 72 | 37.5 | [18.1, 56.3] | 36 / 4 / 32 | 0.0000 |
| live-liar-quorum minus live (what the liar still costs) | 72 | -7.6 | [-18.1, 3.5] | 10 / 17 / 45 | 0.9390 |
| own+liar minus own (harm of one lying donor on top of own experience) | 72 | -8.3 | [-22.9, 4.9] | 11 / 22 / 39 | 0.9825 |
| own+liar-guarded minus own (is the guarded pool still a net gain?) | 72 | 16.0 | [4.9, 29.2] | 24 / 7 / 41 | 0.0017 |
| own+liar-guarded minus own+peer (cost against an honest pool) | 72 | -1.4 | [-8.3, 6.9] | 9 / 12 / 51 | 0.8083 |
| own+stale-guarded minus own+stale | 72 | 9.0 | [-5.6, 22.2] | 22 / 11 / 39 | 0.0401 |
| own+stale-guarded minus own | 72 | -1.4 | [-12.5, 10.4] | 9 / 12 / 51 | 0.8083 |

Estimated spend in this output directory: $77.09 (list prices).
