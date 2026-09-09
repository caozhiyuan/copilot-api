# Container image publishing

This workflow change is independent of the container runtime and Compose changes. It does not change the Dockerfile, startup behavior, mounts or server configuration. Maintainers can accept the runtime improvements without adopting this release-pipeline hardening.

## Events and validation

- Version tags matching `v*.*.*` and manual dispatches run the Docker workflow. Documentation-only tag pushes do not publish images. Branch pushes do not publish images; development builds remain a fork-level concern.
- Pull requests run validation only. They cannot log in to GHCR or publish packages. The publishing job alone requests `packages: write`; other jobs have read-only repository access.
- Linux AMD64 and ARM64 runners each install locked dependencies, run lint, root and desktop typechecks and the test suite, then build a native image before publishing can start.
- If `docker-compose.yaml` and `tests/docker-smoke.test.ts` have been merged separately, their Compose and container-lifecycle checks also run before publishing. Without those files, the corresponding steps are visibly skipped; a successful build alone is not a lifecycle-test result. The optional bind-mount variant is also validated when present.
- Publishing combines AMD64 and ARM64 in one GHCR manifest with build provenance and an SBOM. These do not replace vulnerability scanning, signatures or registry access controls. The previous workflow installed cosign but never signed images; this workflow removes that dead step and does not claim to add signatures.

## Image names and tags

Image names use the lowercased repository name: `ghcr.io/<owner>/copilot-api`. No personal registry is hard-coded.

| Source | Tags |
| --- | --- |
| Stable `v2.5.3` tag | `v2.5.3`, `v2.5`, `v2`, `2.5.3`, `2.5`, `2`, `latest`, `sha-<full commit SHA>` |
| Prerelease `v2.6.0-beta.1` | `v2.6.0-beta.1`, `2.6.0-beta.1`, `sha-<full commit SHA>`; no stable rolling aliases, no `latest` |

The existing `v`-prefixed version tags remain available, and unprefixed aliases are added. `latest` continues to follow the newest stable release only. Commit tags provide traceability; use an image digest when immutable deployment identity is required. The explicit `prefix=v` form keeps the `v` prefix on prereleases, which `docker/metadata-action` would otherwise drop.

Concurrency is isolated by Git ref so different version tags do not cancel each other; tag runs are never cancelled. Manually rerunning an older release or dispatching the workflow may republish older tags, so maintainers should treat dispatch/rerun permission as release authority.

## Maintainer decisions

Please confirm whether the added native ARM64 validation cost per release is acceptable, and whether unprefixed tag aliases are wanted. This proposal deliberately keeps the existing release-only scope: no development-branch images and no latest-channel configuration are introduced. No deployment is automatically switched to a new image or data directory by this workflow change.
