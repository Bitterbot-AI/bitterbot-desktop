# Cross-agent evidence cards: phase rep

Generated 2026-11-16T17:06:23.602Z. Recipient anthropic/claude-haiku-4-5; 3 donor(s) on openai/gpt-5.4-mini; budget 2 episode(s) per agent per cell; 9 families x 8 workspaces = 72 cells. Records: ~/bitterbot-skill-prior/cross-agent-rep/records.jsonl.

Replication protocol hash 0e3179319500e977 (~/bitterbot-skill-prior/cross-agent-rep/protocol-xa-rep.json), written before the first run of this phase; first-study protocol none (stand-alon. Fresh instances (seed offset 5000), fresh recipient and donors; 144 instances, contrasts paired by cell.

## Donor checks against the recipient's own verified outcomes

A donor is dropped at 3 or more contradictions when they are at least 25% of the checks. The lying donor is d3 (the same one in every cell).

| Donor as seen by the recipient | Checks | Contradictions | Decision |
| --- | ---: | ---: | --- |
| d1 | 59 | 6 | kept |
| d2 | 63 | 8 | kept |
| d3 (lying) | 71 | 53 | DROPPED |
| d1 (misapplied pool) | 57 | 21 | DROPPED |
| d2 (misapplied pool) | 65 | 28 | DROPPED |
| d3 (misapplied pool) | 64 | 25 | DROPPED |

## Arms (first study and follow-up)

| Arm | Runs | Reference reader opens the right variant | Model opens it first | Model pass |
| --- | ---: | ---: | ---: | ---: |
| none | 144 | 25.0% | 31.3% | 28.5% |
| own | 144 | 52.3% | 49.3% | 47.9% |
| own+peer | 144 | 84.4% | 77.8% | 70.1% |
| own+liar | 144 | 33.3% | 45.1% | 45.8% |
| own+liar-guarded | 144 | 75.1% | 72.2% | 63.9% |
| live | 144 | 90.0% | 84.7% | 77.8% |
| live-liar | 144 | 27.5% | 17.4% | 16.0% |
| live-liar-quorum | 144 | 64.1% | 61.1% | 58.3% |

## Confirmatory family (fixed order; the first failure makes the rest exploratory)

| Step | Claim | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| guard | Checking donors against own outcomes removes the harm of a lying donor | 72 | 18.1 | [4.2, 31.9] | 26 / 9 / 37 | 0.0030 | CONFIRMED |
| quorum | A live pool with one lying donor, read by quorum, still beats no card | 72 | 29.9 | [10.4, 49.3] | 35 / 6 / 31 | 0.0000 | CONFIRMED |
| net-gain | A guarded pool containing a liar still adds to the recipient's own experience | 72 | 16.0 | [6.3, 26.4] | 24 / 4 / 44 | 0.0001 | CONFIRMED |

## Exploratory contrasts

| Contrast | Cells | Mean (pp) | 95% CI (pp) | Wins / losses / ties | Sign p |
| --- | ---: | ---: | ---: | ---: | ---: |
| own+peer minus own (honest pool added to own experience) | 72 | 22.2 | [9.7, 35.4] | 27 / 5 / 40 | 0.0001 |
| live minus none | 72 | 49.3 | [31.9, 65.3] | 49 / 3 / 20 | 0.0000 |
| live minus own (three peers sharing live against one's own experience) | 72 | 29.9 | [13.2, 46.5] | 33 / 7 / 32 | 0.0000 |
| live-liar minus none (live pool, one liar, counts summed) | 72 | -12.5 | [-23.6, -1.4] | 8 / 22 / 42 | 0.9974 |
| live-liar-quorum minus live-liar (what the quorum recovers) | 72 | 42.4 | [24.3, 61.1] | 37 / 1 / 34 | 0.0000 |
| live-liar-quorum minus live (what the liar still costs) | 72 | -19.4 | [-34.0, -4.9] | 6 / 26 / 40 | 0.9999 |
| own+liar minus own (harm of one lying donor on top of own experience) | 72 | -2.1 | [-17.4, 13.2] | 14 / 17 / 41 | 0.7634 |
| own+liar-guarded minus own (is the guarded pool still a net gain?) | 72 | 16.0 | [6.3, 26.4] | 24 / 4 / 44 | 0.0001 |
| own+liar-guarded minus own+peer (cost against an honest pool) | 72 | -6.3 | [-16.7, 3.5] | 8 / 12 / 52 | 0.8684 |

Estimated spend in this output directory: $32.02 (list prices).
