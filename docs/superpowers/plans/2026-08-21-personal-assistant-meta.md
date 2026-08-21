# Personal Assistant Meta-Bundle Implementation Plan

**Goal:** Publish `@dsh-enhanced/personal-assistant` as a core-only convenience bundle that composes exactly policy, memory, Wiki and automations with conservative defaults.

- [x] Generate an independently publishable bundle and declare the four core plugins as runtime dependencies.
- [x] Make `cordis.patch.yml` insert one stable meta row whose nested config contains each package's documented private defaults.
- [x] Keep policy rules/budgets empty and automations scheduler disabled; do not include delivery, Lark, credentials or any P1 package.
- [x] Test dependency/config parity, one-row patch shape, sequential Cordis child-plugin activation, and absence of any fifth business service or database.
- [x] Document that installing the meta-bundle enables capabilities but grants no policy authorization.
- [x] Document that the meta row is a lifecycle owner, not a fifth business service: it awaits Policy, Memory, Wiki and Automations child plugins in dependency order.
- [x] Run focused tests, lint, typecheck, build, dry-run pack and an isolated rc.8 `--dump-config` smoke.
