import { describe, it, expect } from 'vitest';
import { buildIjPairs } from './basis';
import { buildFamilies, familyMask, strikeFamily, strikeWeights, strikeVector } from './families';

describe('buildFamilies', () => {
  it('names each family by a primitive pair and lists its harmonics in order', () => {
    const pairs = buildIjPairs(256);
    const families = buildFamilies(pairs, 2);

    for (const fam of families) {
      fam.members.forEach((k, i) => {
        const n = i + 1;
        expect(pairs[k].k1).toBe(n * fam.p);
        expect(pairs[k].k2).toBe(n * fam.q);
      });
    }
  });

  it('skips non-primitive pairs, which are already harmonics of another family', () => {
    const families = buildFamilies(buildIjPairs(256), 2);
    // (2,2) is the second harmonic of (1,1); it must not head a family of its own.
    expect(families.find((f) => f.p === 2 && f.q === 2)).toBeUndefined();
    expect(families.find((f) => f.p === 3 && f.q === 3)).toBeUndefined();
    expect(families.find((f) => f.p === 2 && f.q === 4)).toBeUndefined();
  });

  it('finds the expected stacks at rank 256, richest first', () => {
    const families = buildFamilies(buildIjPairs(256), 3);

    expect(families).toHaveLength(19);
    expect(families[0]).toMatchObject({ p: 1, q: 1, label: '(1,1)' });
    expect(families[0].members).toHaveLength(16);

    // Sorted by descending harmonic count.
    for (let i = 1; i < families.length; i++) {
      expect(families[i].members.length).toBeLessThanOrEqual(families[i - 1].members.length);
    }
  });

  it('keeps transpose twins as separate families at the same pitch', () => {
    const pairs = buildIjPairs(256);
    const families = buildFamilies(pairs, 3);
    const a = families.find((f) => f.p === 2 && f.q === 1)!;
    const b = families.find((f) => f.p === 1 && f.q === 2)!;

    expect(a.members).toHaveLength(b.members.length);
    // Degenerate in λ — identical frequencies, different spatial orientation.
    a.members.forEach((k, i) => {
      const j = b.members[i];
      expect(pairs[k].k1 ** 2 + pairs[k].k2 ** 2).toBe(pairs[j].k1 ** 2 + pairs[j].k2 ** 2);
      expect(k).not.toBe(j);
    });
  });

  it('honours minMembers', () => {
    const pairs = buildIjPairs(256);
    expect(buildFamilies(pairs, 2).length).toBeGreaterThan(buildFamilies(pairs, 3).length);
    for (const fam of buildFamilies(pairs, 4)) {
      expect(fam.members.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('truncates each stack to maxHarmonics, keeping the low harmonics', () => {
    const pairs = buildIjPairs(576);
    const uncapped = buildFamilies(pairs, 2);
    const capped = buildFamilies(pairs, 2, 8);

    // Same stacks, since truncation only shortens and 8 >= minMembers.
    expect(capped).toHaveLength(uncapped.length);

    for (let i = 0; i < capped.length; i++) {
      expect(capped[i].members.length).toBeLessThanOrEqual(8);
      // The harmonics kept are the lowest ones — those are the resolvable ones.
      expect(capped[i].members).toEqual(uncapped[i].members.slice(0, 8));
    }

    // (1,1) reaches 24 harmonics at rank 576, which is what the cap is for.
    expect(uncapped[0].members).toHaveLength(24);
    expect(capped.find((f) => f.p === 1 && f.q === 1)!.members).toHaveLength(8);
  });

  it('drops stacks that fall below minMembers once capped', () => {
    const pairs = buildIjPairs(576);
    expect(buildFamilies(pairs, 3, 2)).toHaveLength(0);
  });

  it('is empty when no pair has a multiple in range', () => {
    // Rank 3 holds (1,1),(2,1),(1,2) — none of them has a doubling present.
    expect(buildFamilies(buildIjPairs(3), 2)).toHaveLength(0);
  });
});

describe('harmonicity', () => {
  it('gives each family an exact harmonic series under the sqrt-lambda mapping', () => {
    const pairs = buildIjPairs(256);
    const lam = pairs.map((p) => p.k1 * p.k1 + p.k2 * p.k2);
    const lamMin = Math.min(...lam);
    const freq = lam.map((l) => 110 * Math.sqrt(l / lamMin));

    for (const fam of buildFamilies(pairs, 3)) {
      const f0 = freq[fam.members[0]];
      fam.members.forEach((k, i) => {
        // This is the whole reason stacks exist: λ(np,nq) = n²λ(p,q).
        expect(freq[k] / f0).toBeCloseTo(i + 1, 10);
      });
    }
  });
});

describe('familyMask', () => {
  it('passes exactly the family members', () => {
    const pairs = buildIjPairs(64);
    const fam = buildFamilies(pairs, 3)[0];
    const mask = familyMask(pairs.length, fam);

    expect(mask).toHaveLength(pairs.length);
    const members = new Set(fam.members);
    for (let k = 0; k < pairs.length; k++) {
      expect(mask[k]).toBe(members.has(k) ? 1 : 0);
    }
  });
});

describe('strikeFamily', () => {
  it('rolls off as 1/n and leaves other modes alone', () => {
    const pairs = buildIjPairs(256);
    const fam = buildFamilies(pairs, 3)[0];
    const w = new Float64Array(pairs.length);

    strikeFamily(w, fam, 300);

    fam.members.forEach((k, i) => expect(w[k]).toBeCloseTo(300 / (i + 1), 10));
    const members = new Set(fam.members);
    for (let k = 0; k < pairs.length; k++) {
      if (!members.has(k)) expect(w[k]).toBe(0);
    }
  });

  it('accumulates, so repeated strikes build up', () => {
    const pairs = buildIjPairs(64);
    const fam = buildFamilies(pairs, 3)[0];
    const w = new Float64Array(pairs.length);

    strikeFamily(w, fam, 100);
    strikeFamily(w, fam, 100);

    expect(w[fam.members[0]]).toBeCloseTo(200, 10);
  });
});

describe('strikeWeights', () => {
  it('is the plain 1/n series when the hammer is at the centre', () => {
    const fam = buildFamilies(buildIjPairs(256), 3)[0];
    const weights = strikeWeights(fam, 0);

    weights.forEach((wt, i) => expect(wt).toBeCloseTo(1 / (i + 1), 12));
  });

  it('notches the nth partial when struck at 1/n, the way a piano hammer does', () => {
    const fam = buildFamilies(buildIjPairs(576), 4)[0];
    const weights = strikeWeights(fam, 1 / 4);

    // A hammer landing on a node of the 4th partial cannot excite it.
    expect(Math.abs(weights[3])).toBeLessThan(1e-12);
    // Its neighbours survive; the notch is selective, not a lowpass.
    expect(weights[2]).toBeGreaterThan(0.1);
    expect(weights[0]).toBeGreaterThan(0.5);
  });

  it('never boosts a partial above its 1/n ceiling', () => {
    const fam = buildFamilies(buildIjPairs(576), 4)[0];
    for (const pos of [0.07, 0.13, 0.25, 0.4]) {
      strikeWeights(fam, pos).forEach((wt, i) => {
        expect(wt).toBeLessThanOrEqual(1 / (i + 1) + 1e-12);
        expect(wt).toBeGreaterThanOrEqual(0);
      });
    }
  });
});

describe('strikeVector', () => {
  it('carries the family spectrum into a rank-length vector and nothing else', () => {
    const pairs = buildIjPairs(256);
    const fam = buildFamilies(pairs, 3)[0];
    const v = strikeVector(pairs.length, fam, 0.13);
    const weights = strikeWeights(fam, 0.13);

    fam.members.forEach((k, i) => expect(v[k]).toBeCloseTo(weights[i], 12));
    const members = new Set(fam.members);
    for (let k = 0; k < pairs.length; k++) {
      if (!members.has(k)) expect(v[k]).toBe(0);
    }
  });

  it('agrees with what strikeFamily puts into w, so audio and fluid hear the same note', () => {
    const pairs = buildIjPairs(256);
    const fam = buildFamilies(pairs, 3)[0];
    const w = new Float64Array(pairs.length);

    strikeFamily(w, fam, 300, 0.13);
    const v = strikeVector(pairs.length, fam, 0.13);

    for (let k = 0; k < pairs.length; k++) expect(w[k]).toBeCloseTo(300 * v[k], 8);
  });
});
