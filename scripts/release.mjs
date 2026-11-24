import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function releaseFor(branch, base, run) {
  const tag = new Map([['main', 'latest'], ['alpha', 'alpha'], ['beta', 'beta']]).get(branch);
  if (!tag) throw Error('Publishing is limited to main, alpha and beta');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(base)) throw Error('Use a stable x.y.z base version');
  if (!/^[1-9]\d*$/.test(run)) throw Error('Invalid workflow run number');
  return { tag, version: tag === 'latest' ? base : base + '-' + tag + '.' + run };
}

async function main() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (pkg.private) throw Error('Package is marked private');
  const {tag,version} = releaseFor(process.env.GITHUB_REF_NAME, pkg.version, process.env.GITHUB_RUN_NUMBER);
  const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(pkg.name));
  if (!response.ok && response.status !== 404) throw Error('Registry lookup failed: ' + response.status);
  const meta = response.ok ? await response.json() : {};
  const existing = meta.versions?.[version];
  if (!existing && meta.time?.[version]) throw Error('This package version was previously published and removed');
  if (existing && existing.repository?.url !== pkg.repository.url) throw Error('Version belongs to a different repository');
  console.log(existing ? 'Already published: '+pkg.name+'@'+version : 'Publishing '+pkg.name+'@'+version+' with tag '+tag);
  appendFileSync(process.env.GITHUB_OUTPUT,`tag=${tag}\nversion=${version}\nskip=${Boolean(existing)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
