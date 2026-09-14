"""Durable outbound export checkpoints, separate from provider revisions."""
import json
from services.external_calendar_store import assert_lease, row, transaction, uid
from services.external_calendar_domain import dumps


def send_export(item, client, lease, mapping, calendar_id, remote_id, body, revision):
    with transaction() as db:
        assert_lease(db, item['id'], lease)
        current = row(db, 'SELECT * FROM external_calendar_exports WHERE id=?', (mapping['id'],))
        if current['pending_body'] is None:
            # A fresh create after deletion needs a fresh key: deleted Google
            # event IDs cannot be reused. Retries of this operation keep the key.
            operation = current['operation_id'] or uid()
            if remote_id is None and current['initialized']:
                operation = uid()
            db.execute('UPDATE external_calendar_exports SET operation_id=?,pending_body=?,pending_revision=?,pending_remote_id=? WHERE id=?',
                       (operation, dumps(body), revision, remote_id, mapping['id']))
            current.update(operation_id=operation, pending_body=dumps(body), pending_revision=revision, pending_remote_id=remote_id)
    raw = client.write(calendar_id, current['pending_remote_id'], json.loads(current['pending_body']), current['operation_id'], current['pending_revision'])
    decoded = client.decode(raw, True) if raw else None
    with transaction() as db:
        assert_lease(db, item['id'], lease)
        if json.loads(current['pending_body']) is None:
            db.execute('DELETE FROM external_calendar_exports WHERE id=?', (mapping['id'],))
        else:
            # Keep the exact applied intent as baseline; later local changes are
            # reconciled against it instead of being silently acknowledged.
            db.execute('UPDATE external_calendar_exports SET remote_id=?,baseline=?,revision=?,initialized=1,pending_body=NULL,pending_revision=NULL,pending_remote_id=NULL WHERE id=?',
                       (raw['id'], current['pending_body'], decoded['revision'], mapping['id']))
    return raw


def reset_export(db, mapping):
    operation = uid()
    db.execute('UPDATE external_calendar_exports SET suppressed=0,initialized=0,baseline=NULL,revision=NULL,remote_id=?,operation_id=?,pending_body=NULL,pending_revision=NULL,pending_remote_id=NULL WHERE id=?',
               (operation, operation, mapping['id']))
