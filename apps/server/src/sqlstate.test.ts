/**
 * Unit tests for the SOL-131 problem 3 mapping: an unexpected Postgres
 * SQLSTATE inside a route must surface as a typed Problem, never a bare 500.
 * `sqlStateOf` walks the drizzle-wrapped error chain; `sqlStateProblemShape`
 * maps each SQLSTATE to the Problem shape.
 */

import { describe, expect, it } from 'vitest';

import { sqlStateOf, sqlStateProblemShape } from './http';

describe('sqlStateOf', () => {
  it('reads the SQLSTATE from a bare pg-style error', () => {
    expect(sqlStateOf({ code: '22P02', message: 'invalid input' })).toBe('22P02');
  });

  it('walks the cause chain of a drizzle-style wrapper', () => {
    const wrapped = {
      message: 'Failed query',
      query: 'select 1',
      params: [],
      cause: { code: '40001', message: 'could not serialize access' },
    };
    expect(sqlStateOf(wrapped)).toBe('40001');
  });

  it('returns null for non-database errors', () => {
    expect(sqlStateOf(new Error('boom'))).toBeNull();
    expect(sqlStateOf(null)).toBeNull();
    expect(sqlStateOf('text')).toBeNull();
    expect(sqlStateOf({ code: 'not-a-sqlstate' })).toBeNull();
  });
});

describe('sqlStateProblemShape', () => {
  it('maps serialization failure to a retryable 409', () => {
    const shape = sqlStateProblemShape('40001');
    expect(shape.status).toBe(409);
    expect(shape.code).toBe('CONCURRENT_WRITE_CONFLICT');
  });

  it('maps a data-format error to a 422', () => {
    const shape = sqlStateProblemShape('22P02');
    expect(shape.status).toBe(422);
    expect(shape.code).toBe('INVALID_FIELD_FORMAT');
  });

  it('maps a unique violation to a 409', () => {
    const shape = sqlStateProblemShape('23505');
    expect(shape.status).toBe(409);
    expect(shape.code).toBe('ENTITY_ALREADY_EXISTS');
  });

  it('maps an unknown SQLSTATE to a typed 500, never a bare error', () => {
    const shape = sqlStateProblemShape('XX000');
    expect(shape.status).toBe(500);
    expect(shape.code).toBe('INTERNAL_ERROR');
  });
});
