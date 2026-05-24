# Broken Checkout Service

This small payment-webhook service is intentionally broken for the TracePilot
agent-repair demonstration. It contains independent configuration, security, and
diagnostic-output failures.

Run `npm test` from a copied workspace to expose the failures. The demo runner
must leave this source fixture unchanged and let the agent repair only its
disposable copy.
