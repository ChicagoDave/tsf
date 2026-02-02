let verboseEnabled = false;

export function setVerbose(enabled: boolean): void {
  verboseEnabled = enabled;
}

export function info(msg: string, context?: string): void {
  const prefix = context ? `[${context}] ` : '';
  console.log(`${prefix}${msg}`);
}

export function success(msg: string, context?: string): void {
  const prefix = context ? `[${context}] ` : '';
  console.log(`${prefix}✓ ${msg}`);
}

export function warn(msg: string, context?: string): void {
  const prefix = context ? `[${context}] ` : '';
  console.warn(`${prefix}⚠ ${msg}`);
}

export function error(msg: string, context?: string): void {
  const prefix = context ? `[${context}] ` : '';
  console.error(`${prefix}✗ ${msg}`);
}

export function verbose(msg: string, context?: string): void {
  if (!verboseEnabled) return;
  const prefix = context ? `[${context}] ` : '';
  console.log(`${prefix}  ${msg}`);
}
