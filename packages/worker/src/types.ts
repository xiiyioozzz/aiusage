export type Env = Cloudflare.Env & {
  /** Optional canonical hostname for redirecting the workers.dev dashboard. */
  PUBLIC_HOST?: string;
};
