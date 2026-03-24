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

export interface ExportedConnection {
  alias: string;
  host: string;
  username: string;
  port: number;
  authMethod: "key" | "password";
  password?: string;
  keyContent?: string;
  keyFilename?: string;
}

export interface ExportFile {
  version: 1;
  exportedAt: string;
  connections: ExportedConnection[];
}
