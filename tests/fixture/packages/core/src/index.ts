export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export interface Config {
  name: string;
  version: string;
}
