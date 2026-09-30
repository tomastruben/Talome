# Launchpad app visibility

Launchpad shows approved Talome native apps and running containers with a detected browser interface. A published TCP port alone is not evidence of an app: databases, JSON APIs and discovery ports stay in Services. Native apps represent their whole stack once.

Discovery makes bounded, unauthenticated GET requests to local published ports, follows only same-origin redirects, and checks for an HTML application or login page. It does not sign in, execute scripts, or change service data. A VPN's published port may serve a different app; for example, qBittorrent behind Gluetun is named for the actual interface. Supabase Studio and Mailpit remain launchable and display project names when there are multiple instances. Host-network Home Assistant is checked at its standard port.

In Launchpad, **Customize** lets each user hide/show icons and reset visibility. These preferences are saved per user in the current browser. Hiding an icon does not stop its service, remove it from Services or change another user's Launchpad.

For apps that require explicit configuration (a non-root interface, authentication that discovery cannot inspect, or an unusual port), Compose labels can declare the UI:

```yaml
services:
  app:
    ports:
      - "18888:8888"
    labels:
      talome.ui.port: "8888"       # Container port, mapped above; host port for host networking
      talome.ui.path: "/admin"    # Optional, default /
      talome.ui.protocol: "http"  # Optional http or https
      talome.ui.name: "My app"    # Optional display name
```

An explicit port declares that a UI exists, so configuration must identify a browser interface rather than an API. URLs cannot set an arbitrary host; Talome uses the server's mapped port. Set `talome.ui.enabled: "false"` to exclude a container from automatic discovery. Compose label changes take effect when that service is recreated; Talome does not recreate services for you.

Automatic results are cached for five minutes. Unsuccessful discovery retries after thirty seconds. A temporary timeout can leave a new interface absent until the next check. Discovery establishes a browser entry point, not that every app workflow works or that embedding is allowed by its security headers. Unknown host-network apps need an explicit port label.
