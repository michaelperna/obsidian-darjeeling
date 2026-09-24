/** Shapes returned by GET /api/host/status. */

export interface BatteryStatus {
  present: boolean;
  acOnline: boolean;
  status?: string;
  capacityPct?: number | null;
  healthPct?: number | null;
  energyNowWh?: number | null;
  energyFullWh?: number | null;
  energyDesignWh?: number | null;
  cycleCount?: number | null;
  watts?: number | null;
  voltageV?: number | null;
  psuOutrun?: boolean;
  chargeStartThreshold?: number | null;
  chargeEndThreshold?: number | null;
  thresholdWritable?: boolean;
  model?: string | null;
  device?: string;
}

export interface ThermalStatus {
  cpuCelsius?: number | null;
  fanRpm?: number | null;
  nvmeCelsius?: number | null;
  maxCelsius?: number | null;
  zones?: { name: string; celsius: number }[];
}

export interface CpuStatus {
  usagePct?: number | null;
  cores?: number;
  load1?: number | null;
  load5?: number | null;
  load15?: number | null;
  loadPerCore?: number | null;
  freqMhz?: number | null;
}

export interface MemoryStatus {
  totalMb?: number;
  availableMb?: number;
  usedMb?: number;
  usedPct?: number | null;
  swapTotalMb?: number;
  swapUsedMb?: number;
}

export interface AgentLoad {
  activeTurns: number;
  maxConcurrentTurns: number;
  atCapacity: boolean;
  interactiveAgents: number;
  turns: { pid: number; model?: string; agent?: string; startedAgo: number }[];
}

export interface HostAlert {
  level: "ok" | "warn" | "critical";
  title: string;
  detail: string;
}

export interface HostStatus {
  sampledAt: number;
  level: "ok" | "warn" | "critical";
  alerts: HostAlert[];
  battery?: BatteryStatus | null;
  thermal: ThermalStatus;
  cpu: CpuStatus;
  memory: MemoryStatus;
  pressure: Record<string, { avg10?: number | null; avg60?: number | null }>;
  disk: { path?: string; totalGb?: number; freeGb?: number; usedPct?: number | null };
  agents: AgentLoad;
  uptimeSeconds?: number | null;
  hostname?: string;
  kernel?: string;
}
