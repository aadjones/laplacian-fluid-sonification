import { describe, it, expect } from 'vitest';
import { Sediment } from './sediment';

describe('Sediment', () => {
  it('remembers only the modes a gesture excited, in proportion', () => {
    const s = new Sediment(4);
    s.deposit([0, 2, 1, 0], 0.5);
    expect(s.m[0]).toBe(0);
    expect(s.m[3]).toBe(0);
    expect(s.m[1]).toBeCloseTo(0.5, 10);
    expect(s.m[2]).toBeCloseTo(0.25, 10);
  });

  it('depends on the shape of the gesture, not its scale', () => {
    const a = new Sediment(3);
    const b = new Sediment(3);
    a.deposit([1, 3, 2], 0.3);
    b.deposit([100, 300, 200], 0.3);
    for (let k = 0; k < 3; k++) expect(a.m[k]).toBeCloseTo(b.m[k], 10);
  });

  it('saturates: repeated gestures approach 1 and never pass it', () => {
    const s = new Sediment(2);
    let previousGain = Infinity;
    for (let i = 0; i < 20; i++) {
      const before = s.m[0];
      s.deposit([1, 0.5], 0.2);
      const gain = s.m[0] - before;
      expect(gain).toBeLessThan(previousGain);
      previousGain = gain;
    }
    expect(s.m[0]).toBeLessThanOrEqual(1);
    expect(s.m[0]).toBeGreaterThan(0.98);
    expect(s.m[1]).toBeLessThanOrEqual(1);
  });

  it('fades to under a tenth after a minute left alone', () => {
    const s = new Sediment(2);
    s.deposit([1, 1], 1);
    for (let i = 0; i < 3600; i++) s.leak(1 / 60);
    expect(s.m[0]).toBeLessThan(0.1);
    expect(s.m[0]).toBeGreaterThan(0.05);
  });

  it('fades by the same amount whatever the frame rate', () => {
    const a = new Sediment(1);
    const b = new Sediment(1);
    a.deposit([1], 1);
    b.deposit([1], 1);
    for (let i = 0; i < 600; i++) a.leak(1 / 60);
    for (let i = 0; i < 300; i++) b.leak(1 / 30);
    expect(a.m[0]).toBeCloseTo(b.m[0], 9);
  });

  it('ignores an empty gesture and clears on request', () => {
    const s = new Sediment(2);
    s.deposit([0, 0], 1);
    expect(s.total).toBe(0);
    s.deposit([1, 1], 0.5);
    expect(s.total).toBeCloseTo(1, 10);
    s.clear();
    expect(s.total).toBe(0);
  });
});
