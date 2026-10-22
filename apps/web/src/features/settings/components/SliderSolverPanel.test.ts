import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const settingsPageSource = readFileSync(fileURLToPath(new URL('./SettingsPage.tsx', import.meta.url)), 'utf8');
const panelSource = readFileSync(fileURLToPath(new URL('./SliderSolverPanel.tsx', import.meta.url)), 'utf8');

describe('SliderSolverPanel wiring', () => {
  it('is reachable from a dedicated settings tab', () => {
    expect(settingsPageSource).toContain("{ id: 'solver', label: '滑块求解器'");
    expect(settingsPageSource).toContain("activeTab === 'solver' ? <SliderSolverPanel api={systemApi} />");
  });

  it('is read-only: it probes but never writes solver configuration', () => {
    expect(panelSource).toContain('getSliderSolverStatus');
    expect(panelSource).not.toMatch(/\.(post|patch|put|delete)\(/);
  });

  it('explains every probe failure code the API can return', () => {
    for (const code of ['TIMEOUT', 'UNREACHABLE', 'INVALID_URL', 'INVALID_JSON', 'HTTP_']) expect(panelSource).toContain(`'${code}'`);
  });
});
