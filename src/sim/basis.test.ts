import { describe, it, expect } from 'vitest';
import {
  buildIjPairs,
  buildIjReverse,
  buildVelocityBasis,
  buildStructureTensor,
  getSlabK,
} from './basis';

describe('buildIjPairs', () => {
  it('produces the correct number of pairs', () => {
    expect(buildIjPairs(16)).toHaveLength(16);
    expect(buildIjPairs(9)).toHaveLength(9);
    expect(buildIjPairs(1)).toHaveLength(1);
  });

  it('first pair is always (1,1)', () => {
    const pairs = buildIjPairs(16);
    expect(pairs[0]).toEqual({ k1: 1, k2: 1 });
  });

  it('matches C++ reference triangular ordering for rank=9', () => {
    // Expected from C++ buildIJPairs: (1,1), (2,1), (1,2), (2,2), (3,1), (1,3), (3,2), (2,3), (3,3)
    const pairs = buildIjPairs(9);
    const expected = [
      [1, 1], [2, 1], [1, 2], [2, 2], [3, 1], [1, 3], [3, 2], [2, 3], [3, 3],
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(pairs[i]).toEqual({ k1: expected[i][0], k2: expected[i][1] });
    }
  });

  it('all pairs have k1 >= 1 and k2 >= 1', () => {
    const pairs = buildIjPairs(16);
    for (const p of pairs) {
      expect(p.k1).toBeGreaterThanOrEqual(1);
      expect(p.k2).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('buildIjReverse', () => {
  it('round-trips: reverse[pairs[i]] === i', () => {
    const pairs = buildIjPairs(16);
    const reverse = buildIjReverse(pairs);
    for (let i = 0; i < pairs.length; i++) {
      expect(reverse.get(`${pairs[i].k1},${pairs[i].k2}`)).toBe(i);
    }
  });
});

describe('buildVelocityBasis', () => {
  const xRes = 16;
  const yRes = 16;
  const rank = 4;
  const pairs = buildIjPairs(rank);
  const U = buildVelocityBasis(pairs, xRes, yRes);
  const fieldSize = xRes * yRes;
  const rowCount = 2 * fieldSize;

  it('has correct dimensions', () => {
    expect(U.length).toBe(rowCount * rank);
  });

  it('eigenfunctions satisfy boundary conditions (Dirichlet-ish: zero at x=0)', () => {
    // At x=0: sin(k1*0) = 0, so u-component should be 0
    for (let col = 0; col < rank; col++) {
      const colOffset = col * rowCount;
      for (let iy = 0; iy < yRes; iy++) {
        const idx = iy * xRes + 0; // x=0
        expect(Math.abs(U[colOffset + idx])).toBeLessThan(1e-12);
      }
    }
  });

  it('eigenfunctions are divergence-free (numerical check)', () => {
    // ∂u/∂x + ∂v/∂y ≈ 0 at interior points
    const dx = Math.PI / (xRes - 1);
    const dy = Math.PI / (yRes - 1);
    for (let col = 0; col < rank; col++) {
      const colOffset = col * rowCount;
      let maxDiv = 0;
      for (let iy = 1; iy < yRes - 1; iy++) {
        for (let ix = 1; ix < xRes - 1; ix++) {
          const idx = iy * xRes + ix;
          const dudx = (U[colOffset + idx + 1] - U[colOffset + idx - 1]) / (2 * dx);
          const dvdy = (U[colOffset + fieldSize + idx + xRes] - U[colOffset + fieldSize + idx - xRes]) / (2 * dy);
          maxDiv = Math.max(maxDiv, Math.abs(dudx + dvdy));
        }
      }
      // Divergence should be near zero (not exact due to finite differences)
      expect(maxDiv).toBeLessThan(0.5);
    }
  });

  it('columns are orthogonal (inner product ≈ 0 for different modes)', () => {
    // Basis columns should be approximately orthogonal
    for (let i = 0; i < rank; i++) {
      for (let j = i + 1; j < rank; j++) {
        let dot = 0;
        const iOff = i * rowCount;
        const jOff = j * rowCount;
        for (let r = 0; r < rowCount; r++) {
          dot += U[iOff + r] * U[jOff + r];
        }
        // Normalize by column norms
        let normI = 0, normJ = 0;
        for (let r = 0; r < rowCount; r++) {
          normI += U[iOff + r] * U[iOff + r];
          normJ += U[jOff + r] * U[jOff + r];
        }
        const cosAngle = dot / (Math.sqrt(normI) * Math.sqrt(normJ));
        expect(Math.abs(cosAngle)).toBeLessThan(0.15); // roughly orthogonal
      }
    }
  });
});

describe('buildStructureTensor', () => {
  const rank = 9;
  const pairs = buildIjPairs(rank);
  const C = buildStructureTensor(pairs);

  it('has correct size', () => {
    expect(C.length).toBe(rank * rank * rank);
  });

  it('is mostly sparse (selection rules)', () => {
    let nonzero = 0;
    for (let i = 0; i < C.length; i++) {
      if (Math.abs(C[i]) > 1e-15) nonzero++;
    }
    // Structure tensor should be sparse due to trig selection rules
    expect(nonzero).toBeLessThan(C.length * 0.5);
  });

  it('C(0,0,0) is zero (mode (1,1) self-interaction)', () => {
    // Self-advection of mode (1,1) should be zero by antisymmetry
    expect(Math.abs(C[0])).toBeLessThan(1e-15);
  });

  it('getSlabK extracts correct slice', () => {
    const slab0 = getSlabK(C, rank, 0);
    expect(slab0.length).toBe(rank * rank);
    // Verify it matches direct indexing
    for (let b = 0; b < rank; b++) {
      for (let a = 0; a < rank; a++) {
        expect(slab0[b * rank + a]).toBe(C[b * rank * rank + a * rank + 0]);
      }
    }
  });

  it('advection step wDot = C·(w⊗w) produces nonzero output for nontrivial w', () => {
    // Set up a simple w with two active modes
    const w = new Float64Array(rank);
    w[0] = 1.0; // mode (1,1)
    w[1] = 0.5; // mode (2,1)

    const wDot = new Float64Array(rank);
    for (let k = 0; k < rank; k++) {
      const slab = getSlabK(C, rank, k);
      let dot = 0;
      for (let b = 0; b < rank; b++) {
        let row = 0;
        for (let a = 0; a < rank; a++) {
          row += slab[b * rank + a] * w[a];
        }
        dot += w[b] * row;
      }
      wDot[k] = dot;
    }

    // At least some wDot entries should be nonzero
    let maxWdot = 0;
    for (let k = 0; k < rank; k++) {
      maxWdot = Math.max(maxWdot, Math.abs(wDot[k]));
    }
    expect(maxWdot).toBeGreaterThan(0);
  });
});
