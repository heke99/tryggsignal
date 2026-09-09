import { describe, it } from 'vitest';
import { regressionCases } from '../support/h-i-consistency-cases';

describe('H/I cross-module consistency regressions', () => {
  for (const regression of regressionCases) {
    it(regression.name, regression.run, regression.timeoutMs ?? 5_000);
  }
});
