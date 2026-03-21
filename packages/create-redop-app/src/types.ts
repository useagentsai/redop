export const TRANSPORTS = ["http", "stdio"] as const;
export const DEPLOY_TARGETS = ["none", "railway", "fly-io", "vercel"] as const;

export type Transport = (typeof TRANSPORTS)[number];
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

export interface ResolvedOptions {
  appName: string;
  components: string[];
  deploy: DeployTarget; // Add this
  packageManager: "bun" | "npm";
  targetDir: string;
  template: string;
  transport: Transport;
}

export interface GeneratedFile {
  content: string;
  path: string;
}
