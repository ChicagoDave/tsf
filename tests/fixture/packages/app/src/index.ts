import { greet, Config } from '@test/core';

export function main(): void {
  const config: Config = { name: 'test', version: '1.0.0' };
  console.log(greet(config.name));
}
