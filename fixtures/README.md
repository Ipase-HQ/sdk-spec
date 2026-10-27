# Conformance fixtures

Each scenario lists the app actions a test harness drives and what the mock server must observe. Session 0.1 turns scenarios.json into one executable file per scenario. An SDK is published only when every scenario that applies to its platform passes in CI against the mock server.

Platforms: mobile (kotlin, swift), web (js), server (php). Scenarios list the platforms they apply to.
