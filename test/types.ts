// Compile-only contract tests. No runtime imports execute this file.
import type { AttentionId, Report, RunId, WorkId } from '../src/domain.ts';
function distinctIdentifiers(work: WorkId, run: RunId, attention: AttentionId): void {
  // @ts-expect-error A run is not a work item.
  const wrongWork: WorkId = run;
  // @ts-expect-error An attention cannot be resumed as a run.
  const wrongRun: RunId = attention;
  void work; void wrongWork; void wrongRun;
}
// @ts-expect-error A human-input report requires question and options.
const invalidQuestion: Report = { kind: 'needs_input', summary: 'Need input' };
void distinctIdentifiers; void invalidQuestion;
