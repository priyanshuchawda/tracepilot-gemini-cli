# Broken Idempotency Service

This fixture contains a deterministic duplicate-delivery race. The public test
reports only the violated settlement invariant. Use the benchmark trace probe to
identify the causal interleaving before changing `src/ledger.js`.
