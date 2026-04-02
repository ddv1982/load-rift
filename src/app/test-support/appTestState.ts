import { vi } from "vitest";
import {
  createImportHookState,
  createSmokeHookState,
  createTestHookState,
} from "./appTestUtils";

const FIXED_TEST_DATE = new Date("2026-03-25T15:13:32Z");

export const appHookTestState = {
  importHookState: createImportHookState(),
  testHookState: createTestHookState(),
  smokeHookState: createSmokeHookState(),
};

export function resetAppHookTestState() {
  appHookTestState.importHookState = createImportHookState();
  appHookTestState.testHookState = createTestHookState();
  appHookTestState.smokeHookState = createSmokeHookState();
}

export function resetAppTestEnvironment() {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_TEST_DATE);
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetAppHookTestState();
}
