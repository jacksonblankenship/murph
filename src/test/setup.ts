import { afterEach } from 'bun:test';
import { mock } from 'bun:test';

afterEach(() => {
  mock.restore();
});
