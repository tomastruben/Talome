/**
 * App templates for AI-generated apps.
 *
 * Templates provide common patterns the AI can reference when creating apps.
 * Each template defines a base docker-compose structure, default env vars,
 * and recommended configuration for a class of application.
 *
 * The unified look-and-feel system (Talome theme, reverse proxy integration,
 * clean URLs) will be built on top of this foundation later.
 */

export interface AppTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  services: {
    name: string;
    image: string;
    ports: { host: number; container: number }[];
    volumes: { hostPath: string; containerPath: string }[];
    environment: Record<string, string>;
  }[];
}

export const APP_TEMPLATES: AppTemplate[] = [
  {
    id: "postgres-pgadmin",
    name: "PostgreSQL + pgAdmin",
    description: "PostgreSQL database with pgAdmin web management interface",
    category: "developer",
    services: [
      {
        name: "postgres",
        image: "postgres:16-alpine",
        ports: [{ host: 5432, container: 5432 }],
        volumes: [{ hostPath: "./data/postgres", containerPath: "/var/lib/postgresql/data" }],
        environment: {
          POSTGRES_USER: "talon",
          POSTGRES_PASSWORD: "talon",
          POSTGRES_DB: "talon",
        },
      },
      {
        name: "pgadmin",
        image: "dpage/pgadmin4:8.14",
        ports: [{ host: 5050, container: 80 }],
        volumes: [{ hostPath: "./data/pgadmin", containerPath: "/var/lib/pgadmin" }],
        environment: {
          PGADMIN_DEFAULT_EMAIL: "admin@talome.local",
          PGADMIN_DEFAULT_PASSWORD: "admin",
        },
      },
    ],
  },
  {
    id: "redis",
    name: "Redis",
    description: "In-memory data store, cache, and message broker",
    category: "developer",
    services: [
      {
        name: "redis",
        image: "redis:7-alpine",
        ports: [{ host: 6379, container: 6379 }],
        volumes: [{ hostPath: "./data", containerPath: "/data" }],
        environment: {},
      },
    ],
  },
  {
    id: "minio",
    name: "MinIO",
    description: "S3-compatible object storage server",
    category: "storage",
    services: [
      {
        name: "minio",
        image: "minio/minio:RELEASE.2025-02-28T09-55-16Z",
        ports: [
          { host: 9000, container: 9000 },
          { host: 9001, container: 9001 },
        ],
        volumes: [{ hostPath: "./data", containerPath: "/data" }],
        environment: {
          MINIO_ROOT_USER: "minioadmin",
          MINIO_ROOT_PASSWORD: "minioadmin",
        },
      },
    ],
  },
  {
    id: "grafana-prometheus",
    name: "Grafana + Prometheus",
    description: "Monitoring stack with Grafana dashboards and Prometheus metrics",
    category: "developer",
    services: [
      {
        name: "prometheus",
        image: "prom/prometheus:v3.2.1",
        ports: [{ host: 9090, container: 9090 }],
        volumes: [{ hostPath: "./config/prometheus.yml", containerPath: "/etc/prometheus/prometheus.yml" }],
        environment: {},
      },
      {
        name: "grafana",
        image: "grafana/grafana:11.5.2",
        ports: [{ host: 3000, container: 3000 }],
        volumes: [{ hostPath: "./data/grafana", containerPath: "/var/lib/grafana" }],
        environment: {
          GF_SECURITY_ADMIN_PASSWORD: "admin",
        },
      },
    ],
  },
  {
    id: "nginx",
    name: "Nginx",
    description: "Web server and reverse proxy",
    category: "networking",
    services: [
      {
        name: "nginx",
        image: "nginx:alpine",
        ports: [{ host: 8080, container: 80 }],
        volumes: [
          { hostPath: "./html", containerPath: "/usr/share/nginx/html" },
          { hostPath: "./config/nginx.conf", containerPath: "/etc/nginx/nginx.conf" },
        ],
        environment: {},
      },
    ],
  },
];

export function getTemplate(id: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((t) => t.id === id);
}

export function listTemplates(): AppTemplate[] {
  return APP_TEMPLATES;
}
