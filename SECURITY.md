# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/Inginnng/arki/security/advisories/new). Describe the affected version, reproduction and potential impact using a minimal public fixture. Do not post secrets, private source files or exploit details in a public issue. If private reporting is unavailable, open a minimal issue asking the maintainer for a private contact channel without disclosing the vulnerability.

There is no guaranteed response SLA. The latest published release receives fixes; older versions may need upgrading.

## Data and trust boundaries

Arki runs a loopback-only local server. Its browser application stores reading collections, diagrams and completed answers in that browser. AI requests send selected project excerpts and questions to the user's configured Codex service; **local operation does not mean AI inference is offline**. Do not analyze code you are not authorized to share with that service.

Checking updates makes a manual, anonymous request for this repository's public release metadata. It sends no source code, questions, local paths or account credentials. It never executes release text or automatically installs downloaded software.

The architecture workspace does not modify source files. The separate reviewed-document workflow can create a new `*.explained.md` only after approval bound to the exact source and diff. Project content is untrusted input. See the [technical threat model](docs/security.md) for implementation boundaries and the [capability report](docs/capability-report.md) for limitations.
