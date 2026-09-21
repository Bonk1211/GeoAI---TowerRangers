import { Button } from '../ui/Panel';
import { toJsonl, toObservationRecords, type CorpusRow } from '../../lib/feedbackCorpus';

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * The page's primary action, and the reason it exists.
 *
 * It produces records in model/feedback.py's exact Observation schema — a copy
 * of the matched observation with label_status flipped and the label merged in
 * — appendable to data/observation_log.jsonl by hand. Rows with no observation
 * cannot be exported: Observation validates `source` against three satellite
 * values and there is none to invent.
 *
 * Lives in the PageHeader rather than inside a panel. It was a small control in
 * the third panel's header, which put the page's whole thesis below two other
 * readings; Tickets and Investigation both put their primary action here.
 */
export function ExportConfirmations({ rows }: { rows: CorpusRow[] }) {
  const records = toObservationRecords(rows);
  const none = records.length === 0;

  return (
    <Button
      tone="primary"
      disabled={none}
      title={none ? 'No closed verdict has an unlabeled observation to confirm' : undefined}
      onClick={() => download('confirmations.jsonl', toJsonl(records))}
    >
      Export {records.length} confirmation{records.length === 1 ? '' : 's'}
    </Button>
  );
}
