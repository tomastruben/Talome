# Output Contract

Expected output set:

- `manifest.json`
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
