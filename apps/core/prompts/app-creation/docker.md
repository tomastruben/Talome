# Docker Rules

When generating Docker app definitions:

- use stable images and prefer official images
- verify that every public registry image and tag exists; never invent a plausible registry URL
- for custom scaffold code, use an explicit local image name such as `<app-id>:local` with a compose `build` definition until a real published image exists
- prefer smaller images when there is no downside
- use relative paths such as `./data`, `./config`, `./postgres`
- never use absolute host paths unless the user explicitly requires them
- include `restart: unless-stopped`
- include healthchecks when the app supports them
- expose the main web port as the clearest port
- keep environment variables minimal and clearly named
- separate secret env vars from non-secret values in the env schema
- use persistent volumes for stateful services
- make multi-service apps realistic, not toy examples

Default conventions:
- set `PUID=1000`, `PGID=1000`, and `TZ=America/New_York` when appropriate
- for databases and infrastructure services, favor official images first
- use clear service names and keep container names stable
