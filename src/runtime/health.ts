import { statfsSync } from 'node:fs';

export type ComponentState = 'ok' | 'degraded' | 'failed' | 'unknown';

export type HealthSnapshot = {
  status: 'healthy' | 'degraded' | 'failed';
  commit: string;
  configHash: string;
  schemaVersion: number;
  clockOffsetMs: number;
  components: Record<string, ComponentState>;
  disk: { freeBytes: number; usedPercent: number; highWater: boolean };
  generatedAt: number;
};

export type DegradationDecision = {
  allowDiscovery: boolean;
  allowG2: boolean;
  allowSignal: boolean;
  allowOutcome: boolean;
  allowOutbox: boolean;
  reasons: string[];
};

export function readDiskHealth(
  directory: string,
  highWaterPercent: number,
): HealthSnapshot['disk'] {
  if (!Number.isInteger(highWaterPercent) || highWaterPercent < 1 || highWaterPercent > 99)
    throw new Error('Invalid disk high-water percentage');
  const stats = statfsSync(directory);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const usedPercent = totalBytes === 0 ? 100 : ((totalBytes - freeBytes) / totalBytes) * 100;
  return { freeBytes, usedPercent, highWater: usedPercent >= highWaterPercent };
}

export function buildHealthSnapshot(input: {
  commit: string;
  configHash: string;
  schemaVersion: number;
  clockOffsetMs: number;
  components: Record<string, ComponentState>;
  disk: HealthSnapshot['disk'];
  generatedAt: number;
}): HealthSnapshot {
  const values = Object.values(input.components);
  const status =
    input.disk.highWater || values.includes('failed')
      ? 'failed'
      : values.some((value) => value !== 'ok')
        ? 'degraded'
        : 'healthy';
  return { ...input, status };
}

export function conservativeDegradation(snapshot: HealthSnapshot): DegradationDecision {
  const reasons: string[] = [];
  const failed = (name: string) => snapshot.components[name] === 'failed';
  const unavailable = (name: string) => failed(name) || snapshot.components[name] === 'unknown';
  if (snapshot.disk.highWater) reasons.push('disk:high_water');
  if (Math.abs(snapshot.clockOffsetMs) > 5_000) reasons.push('clock:skew');
  for (const name of Object.keys(snapshot.components)) {
    if (unavailable(name)) reasons.push(`${name}:unavailable`);
  }
  const storageReady = !snapshot.disk.highWater && !unavailable('sqlite');
  const dataReady = storageReady && !unavailable('provider');
  return {
    allowDiscovery: dataReady && !unavailable('safety') && !unavailable('level1'),
    allowG2: dataReady && !unavailable('g2'),
    allowSignal:
      dataReady && !unavailable('safety') && !unavailable('level1') && !unavailable('g2'),
    allowOutcome: storageReady,
    allowOutbox: storageReady && !unavailable('telegram'),
    reasons: [...new Set(reasons)],
  };
}

export function createStructuredLogger(sink: (line: string) => void = console.error) {
  return (
    level: 'info' | 'warn' | 'error',
    event: string,
    fields: Record<string, unknown> = {},
  ) => {
    sink(
      JSON.stringify({
        level,
        event,
        ...(redact(fields) as Record<string, unknown>),
        at: Date.now(),
      }),
    );
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /authorization|api[-_]?key|token|secret|password|url|header/i.test(key)
        ? '[REDACTED]'
        : redact(item),
    ]),
  );
}
