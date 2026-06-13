# LongMemEval contrastive report (PLAN-24 Phase 2)

Model: anthropic/claude-opus-4-7 · split: train · N=12

| Condition | Accuracy |
| --- | --- |
| H (full raw transcript) | 91.7% |
| H' (memory pipeline) | 83.3% |

Buckets: D_exo (H✓ H'✗) = 2 · D_end (H✗ H'✓) = 1 · both✓ = 9 · both✗ = 0

Token efficiency: H' context averages 2592 tokens vs H 8395 = **30.9% of baseline**.

Construction-feedback records emitted (D_exo): 2

## By question type

| Type | N | H acc | H' acc | D_exo | D_end |
| --- | --- | --- | --- | --- | --- |
| temporal-reasoning | 12 | 91.7% | 83.3% | 2 | 1 |