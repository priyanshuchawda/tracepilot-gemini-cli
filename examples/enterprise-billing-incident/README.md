# Enterprise Billing Incident

This fixture models a production billing outage where public happy-path tests
pass, but cross-region webhook retries, risk-cache reuse, failed reservations,
payload conflicts, and PII-safe telemetry fail under production conditions.
