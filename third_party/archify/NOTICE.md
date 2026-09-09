# Archify runtime

Vendored from Archify 2.16.0-dev.0 (MIT), the installed 2.16 skill release.
Copyright and license are retained in LICENSE.

This includes the architecture renderer, generated schema validators,
shared geometry, standalone viewer template, CLI delivery pipeline and checker.
Other diagram types, examples, development dependencies and brand downloads are
not included. AIMD only passes a bounded architecture specification without
remote brands or repository metadata. Local evidence is managed by AIMD, outside
Archify's public GitHub source-link contract.

The application does not read a user's skill directory at runtime. Upgrade this
copy deliberately and rerun architecture integration, geometry and browser checks.

AIMD's local patch increases architecture node label and subtitle preferred font
sizes to 18/13 for the embedded workbench. Geometry validation remains enabled.
The delivery receipt additionally exposes the existing ambiguous-corridor metric
so AIMD can reject visually merged relationship routes under the showcase profile.

Arki also uses 13px relationship labels with matching measured masks, 10px code
identifiers, and fixes the midpoint of straight vertical relationship labels.
Both rendering and layout reports use these dimensions; validation is retained.
