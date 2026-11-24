import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error The release script runs directly in Node, outside the package build.
import { releaseFor } from '../scripts/release.mjs';

test('publish channels use immutable prerelease versions and an explicit stable version', () => {
  assert.deepEqual(releaseFor('main','0.1.0','42'),{version:'0.1.0',tag:'latest'});
  for(const tag of ['alpha','beta'])assert.deepEqual(releaseFor(tag,'0.1.0','42'),{version:'0.1.0-'+tag+'.42',tag});
  for(const branch of ['feature/x','latest','v0.1.0','toString'])assert.throws(()=>releaseFor(branch,'0.1.0','42'));
  assert.throws(()=>releaseFor('beta','0.1.0-alpha.1','42'));
});
