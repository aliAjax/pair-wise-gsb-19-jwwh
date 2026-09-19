// 持久化：localStorage 落盘，刷新后恢复鱼缸、检测、处置与换水链
import type { AppState } from "./domain";
import { seedState } from "./domain";

const STORAGE_KEY = "aquarium-water-tracker:v1";

export function isValidState(parsed: unknown): parsed is AppState {
  if (!parsed || typeof parsed !== "object") return false;
  const s = parsed as Record<string, unknown>;
  return Array.isArray(s.tanks) && Array.isArray(s.records) && Array.isArray(s.waterChanges);
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState();
    const parsed: unknown = JSON.parse(raw);
    if (!isValidState(parsed)) return seedState();
    return parsed;
  } catch {
    return seedState();
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储已满或被禁用时静默失败，界面状态仍可用
  }
}

export function resetState(): AppState {
  const fresh = seedState();
  saveState(fresh);
  return fresh;
}
