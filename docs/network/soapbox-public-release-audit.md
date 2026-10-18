# Public Compute release review — 2026-10-17

Soapbox and its desktop integration are intended to be public. Compute remains enabled
by default; paid jobs remain on Base Sepolia, using a separate Compute wallet.

## Material that must stay local

Never commit or package wallet signing keys or recovery phrases, CDP/API credentials,
gateway authentication tokens, coordinator/admin/worker tokens, enrollment credentials,
or the private libp2p node key. Local configuration, databases, job inputs/results, logs,
model caches and personal profile data are excluded from the release input list.

Public wallet/contract addresses, transaction hashes, job IDs, peer IDs, image/model
digests and source hashes are identifiers, not signing credentials. They can still reveal
activity or relationships; examples should disclose only the information needed to
reproduce a test.

## Scan status

Gitleaks 8.30.1 was run with redacted reports against both available repository histories.
The Soapbox scan reported 38 matches across 15 commits; reviewed matches were public token
addresses, escrow/job keys and idempotency identifiers. The desktop scan reported 298
matches across 1,032 scanned commits. Of those, 223 were hashes in `.secrets.baseline`.
Other reviewed matches include test credentials, public OAuth client IDs, public blockchain
identifiers, documentation placeholders and database key names. A staged Compute diff scan
flagged a literal list of `compute/v1/` RPC method names, not a credential.

One finding remains unresolved: an imported historical benchmark dataset contains a GitHub
OAuth-token-shaped value repeated in conversation examples. It is absent from the current
checkout and is not an rc5 package
input. Its validity and ownership have not been tested. Do not assume it is harmless or
copy it into release notes. Deleting a working-tree file does not remove historical copies;
if identified as a real credential, its owner must revoke it. Repository history rewriting
requires separate coordination with contributors and does not itself revoke a credential.

The unpacked candidate scan covered 128 MB and reported 116 matches. Review traced these
to public blockchain addresses, SDK examples/default provider identifiers, variable names,
PEM formatting templates that consume runtime secrets, and a WhatsApp protocol dictionary
constant already present in the installed base bundle. No local wallet, enrollment or gateway
credentials were identified in the package. The packaged operator completed private and
collective CPU jobs and GPU embeddings from a second local P2P identity.

This document is a scoped review record, not a guarantee that every historical string is
safe. Raw scan reports, the unresolved finding's exact location, and local test profiles
remain under ignored `reports/` and temporary directories. The release notes record final
artifact verification and installation/rollback results.
