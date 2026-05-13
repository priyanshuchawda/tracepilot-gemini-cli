# Broken Node App Demo

This fixture intentionally fails because `src/config.js` defaults `API_BASE_URL`
to localhost. The TracePilot demo runner copies this fixture to a temporary
workspace, observes the failing test, records safe failure evidence, applies the
minimal config repair, reruns the test, and writes TracePilot eval JSON.
