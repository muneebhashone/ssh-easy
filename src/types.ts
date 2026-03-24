export interface Connection {
  alias: string;
  host: string;
  username: string;
  port: number;
  keyPath?: string;
  password?: string;
  authMethod: "key" | "password";
}

export interface Config {
  connections: Connection[];
}
