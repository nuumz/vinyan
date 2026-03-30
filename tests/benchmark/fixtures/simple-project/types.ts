export interface User {
  id: number;
  name: string;
  email: string;
  active: boolean;
}

export interface Config {
  port: number;
  debug: boolean;
  database: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
