import { Command } from 'commander';
import { readConfig } from '../config';
import { fetchPaymentHistory } from '../api';

export const HEATMAP_DAYS = 30;

export interface DailyCount {
  date: string; // YYYY-MM-DD
  count: number;
}

export interface HeatmapCell {
  date: string;
  count: number;
  level: number; // 0-4
  char: string; // ANSI colored block
}

const BLOCK = '█';
const RESET = '\x1b[0m';
const COLORS: Record<number, string> = {
  0: '\x1b[38m5;24;24;24m',
  1: '\x1b[38m;0;100;0m',
  2: '\x1b[38m;0;180;0m',
  3: '\x1b[38m;0;255;50m',
  4: '\x1b[38m;0;255;150m',
};

export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildDailyCounts(
  payments: Array<{ createdAt?: string; timestamp?: string }>,
  days = HEATMAP_DAYS,
  now: Date = new Date(),
): DailyCount[] {
  const result: DailyCount[] = [];
  const byDate = new Map<string, number>();
  for (const p of payments) {
    const iso = p.createdAt ?? p.timestamp;
    if (!iso) continue;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) continue;
    const key = formatDate(d);
    byDate.set(key, (byDate.get(key) ?? 0) + 1);
  }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = formatDate(d);
    result.push({ date: key, count: byDate.get(key) ?? 0 });
  }
  return result;
}

export function countToLevel(count: number, max: number): number {
  if (count <= 0) return 0;
  if (max <= 0) return 1;
  const ratio = count / max;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

export function renderHeatmap(daily: DailyCount[]): { lines: string[]; total: number } {
  const max = daily.reduce((m, d) => Math.max(m, d.count), 0);
  const cells: HeatmapCell[] = daily.map((d) => {
    const level = countToLevel(d.count, max);
    return { date: d.date, count: d.count, level, char: `${COLORS[level]}${BLOCK}${RESET}` };
  });
  const lines: string[] = [];
  // 7 columns per week, align first day to its weekday column
  const first = new Date(cells[0]?.date ?? formatDate(new Date()));
  const lead = first.getDay();
  const grid: string[] = Array.from({ length: 7 }, () => ' ');
  for (let i = 0; i < lead; i++) grid[i] = ' ';
  for (const c of cells) {
    const d = new Date(c.date);
    const weekday = d.getDay();
    grid[weekday] += c.char;
  }
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = 0; i < 7; i++) {
    lines.push(`${labels[i]} ${grid[i]}`);
  }
  const total = daily.reduce((s, d) => s + d.count, 0);
  const legend = `Less ${[0, 1, 2, 3, 4].map((l) => `${COLORS[l]}${BLOCK}${RESET}`).join(' ')} More`;
  lines.push('');
  lines.push(legend);
  lines.push(`Total transactions (${daily.length} days): ${total}`);
  return { lines, total };
}

export const heatmapCommand = new Command('alerts heatmap')
  .description('Render a GitHub-style ANSI activity heatmap for the past 30 days')
  .action(async () => {
    try {
      const config = readConfig();
      if (!config.wallet) {
        console.error('No wallet configured. Run `alerts config` first.');
        process.exitCode = 1;
        return;
      }
      const payments = await fetchPaymentHistory(config.wallet, HEATMAP_DAYS);
      const daily = buildDailyCounts(payments);
      const { lines } = renderHeatmap(daily);
      for (const line of lines) console.log(line);
    } catch (err) {
      console.error(`Failed to render heatmap: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });
