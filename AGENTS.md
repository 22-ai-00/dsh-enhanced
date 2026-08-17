# dsh-enhanced agent guide

## Mission

This repository is a pnpm monorepo of independently publishable DeepSeek Harness plugins. DSH composes a profile from bundle patch layers; each package under `plugins/*` must therefore remain a self-contained installable bundle, while `packages/*` contains ordinary shared libraries that are never auto-enabled.

## Start here

1. Read [docs/creating-a-plugin.md](docs/creating-a-plugin.md) when adding or restructuring a plugin. The step is complete when its package, patch, tests, README, and catalog row all exist.
2. Read [docs/architecture.md](docs/architecture.md) when changing package boundaries, adding shared code, or creating a Host/Web dual-face plugin. The step is complete when the change preserves independent package publication and DSH composition semantics.
3. Read [docs/compatibility.md](docs/compatibility.md) when changing DSH/Cordis dependencies or consuming a new upstream API. The step is complete when the declared baseline and every affected package agree.

## Repository contracts

- Put user-installable bundles in `plugins/<kebab-case-name>` and reusable, non-activating code in `packages/<kebab-case-name>`.
- Create plugins with `pnpm create:plugin <name>`; evolve the template and generator together when the common shape changes.
- Keep the plugin directory, package name suffix, Cordis row id, source plugin name, and catalog entry unambiguous and stable.
- Declare `dsh.bundle.patch` as `./cordis.patch.yml`. The patch must mount the package by its published package name.
- Ship `lib/`, `cordis.patch.yml`, `README.md`, and `LICENSE` in every plugin package. Use current DSH bundles; legacy `.dsh-plugin` metadata is invalid here.
- Treat DSH services supplied by the host as peer dependencies. Put libraries that must travel with the plugin in dependencies.
- Express deployment-specific values through a validated `Config` schema. Use Cordis injection for required services and Cordis effects/disposers for every external resource.
- Document filesystem, network, subprocess, credential, browser, and install-script authority in the plugin README.
- Update [plugins/README.md](plugins/README.md) whenever a plugin is added, renamed, deprecated, or removed.

## Verification

Run `pnpm check` from the repository root. Completion requires manifest validation, zero lint warnings, successful typechecking and tests, a clean build, and a successful dry-run pack for every plugin. Inspect the dry-run file list whenever package boundaries or `files` change.

Keep changes scoped to the requested plugin or shared contract. Generated output (`lib/`, coverage, tarballs, caches) stays untracked.
