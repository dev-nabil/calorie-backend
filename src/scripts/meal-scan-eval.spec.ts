import { join, resolve } from 'node:path';
import { FakeAiProvider } from '../modules/ai/ai.provider';
import { loadFixtures, runEval } from './meal-scan-eval';

describe('meal-scan eval harness (M4-T6)', () => {
  it('scores the committed fixtures with the fake provider', async () => {
    const fixtures = loadFixtures(join(resolve(__dirname, '../../evals/meal-scan'), 'fixtures'));
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    const report = await runEval(fixtures, new FakeAiProvider(), { model: 'fake', price: { inPerM: 1, cachedPerM: 0.1, outPerM: 4 } });
    expect(report).toMatchObject({ provider: 'fake', n: fixtures.length, nonFoodAccuracy: 1 });
    expect(report.itemRecall).toBeGreaterThan(0.6);
    expect(report.kcalMape).toBeLessThan(0.2);
    expect(report.costPerScanUsd).toBeGreaterThan(0);
    expect(report.rows.every((r) => r.ok)).toBe(true);
  });

  it('records a parse failure as a failed row', async () => {
    const report = await runEval([{ id: 'bad', expected: { isFood: true, kcal: 100, items: [] }, fakeOutput: { nope: 1 } }], new FakeAiProvider(), { model: 'fake' });
    expect(report.rows[0]).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
