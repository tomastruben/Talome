# Output Contract

Expected output set:

- `.talome-creator/research/findings.md` with verified source and library decisions
- `.talome-creator/design/screen-spec.md` with research-resolved workflows and screens
- `.talome-creator/validation/report.md` with rendered and functional evidence
- `manifest.json`
- `talome-app.json` with the actual native surfaces, declared data sources and actions, validated against the shipped AppSpec schema
- `docker-compose.yml`
- creator metadata describing blueprint, validations, and provenance
- scaffold files when scaffold generation is enabled

The result must be coherent across:
- app id
- app name
- service names
- ports
- env vars
- exported metadata

If a scaffold is generated, it must include:
- a clear entry path
- a concise set of important files
- enough structure for the next tweak run to build on
